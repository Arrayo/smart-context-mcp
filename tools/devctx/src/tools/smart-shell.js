import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { rgPath } from '@vscode/ripgrep';
import { buildMetrics, persistMetrics } from '../metrics.js';
import { projectRoot } from '../utils/paths.js';
import { pickRelevantLines, truncate, uniqueLines } from '../utils/text.js';

const execFile = promisify(execFileCallback);
const blockedPattern = /[|&;<>`\n\r]/;
const allowedCommands = new Set(['pwd', 'ls', 'find', 'rg', 'git', 'npm', 'pnpm', 'yarn', 'bun']);
const allowedGitSubcommands = new Set(['status', 'diff', 'show', 'log', 'branch', 'rev-parse']);
const allowedPackageManagerSubcommands = new Set(['test', 'run', 'lint', 'build', 'typecheck', 'check']);
const safeRunScriptPattern = /^(test|lint|build|typecheck|check|smoke|verify)(:|$)/;

const tokenize = (command) => {
  const tokens = [];
  let current = '';
  let quote = null;
  let escape = false;

  for (const char of command.trim()) {
    if (escape) {
      current += char;
      escape = false;
      continue;
    }

    if (char === '\\') {
      escape = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escape || quote) {
    throw new Error('Unterminated escape or quote sequence');
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
};

const validateCommand = (command, tokens) => {
  if (!command.trim()) {
    return 'Command is empty';
  }

  if (blockedPattern.test(command) || command.includes('$(')) {
    return 'Shell operators are not allowed';
  }

  if (tokens.length === 0) {
    return 'Command is empty';
  }

  const [baseCommand, subcommand, thirdToken] = tokens;

  if (!allowedCommands.has(baseCommand)) {
    return `Command not allowed: ${baseCommand}`;
  }

  if (baseCommand === 'git' && !allowedGitSubcommands.has(subcommand)) {
    return `Git subcommand not allowed: ${subcommand ?? '(missing)'}`;
  }

  if (baseCommand === 'find') {
    const dangerousArgs = ['-exec', '-execdir', '-delete', '-ok', '-okdir'];
    const hasDangerous = tokens.some((t) => dangerousArgs.includes(t));
    if (hasDangerous) {
      return `find argument not allowed: ${tokens.find((t) => dangerousArgs.includes(t))}`;
    }
  }

  if (['npm', 'pnpm', 'yarn', 'bun'].includes(baseCommand)) {
    if (!subcommand || !allowedPackageManagerSubcommands.has(subcommand)) {
      return `Package manager subcommand not allowed: ${subcommand ?? '(missing)'}`;
    }

    if (subcommand === 'run' && (!thirdToken || !safeRunScriptPattern.test(thirdToken))) {
      return `Package manager script not allowed: ${thirdToken ?? '(missing)'}`;
    }
  }

  return null;
};

const buildBlockedResult = async (command, message) => {
  const metrics = buildMetrics({
    tool: 'smart_shell',
    target: command,
    rawText: command,
    compressedText: message,
  });

  await persistMetrics(metrics);

  return {
    command,
    exitCode: 126,
    blocked: true,
    output: message,
    confidence: { blocked: true, timedOut: false },
    metrics,
  };
};

export const smartShell = async ({ command }) => {
  let tokens;

  try {
    tokens = tokenize(command);
  } catch (error) {
    return await buildBlockedResult(command, error.message);
  }

  const validationError = validateCommand(command, tokens);

  if (validationError) {
    return await buildBlockedResult(command, validationError);
  }

  const [file, ...args] = tokens;

  if (file === 'find' && !args.includes('-maxdepth')) {
    const findGlobalOptions = new Set(['-L', '-H', '-P', '-O0', '-O1', '-O2', '-O3', '-D']);
    let insertAt = 0;
    while (insertAt < args.length && findGlobalOptions.has(args[insertAt])) {
      insertAt += 1;
      if (args[insertAt - 1] === '-D' && insertAt < args.length) insertAt += 1;
    }
    while (insertAt < args.length && !args[insertAt].startsWith('-')) {
      insertAt += 1;
    }
    args.splice(insertAt, 0, '-maxdepth', '8');
  }

  const resolvedFile = file === 'rg' ? rgPath : file;
  const execution = await execFile(resolvedFile, args, {
    cwd: projectRoot,
    maxBuffer: 1024 * 1024 * 10,
    timeout: 15000,
  }).then(
    ({ stdout, stderr }) => ({ stdout, stderr, code: 0 }),
    (error) => ({
      stdout: error.stdout ?? '',
      stderr: error.killed
        ? `Command timed out after 15s: ${command}`
        : (error.stderr ?? error.message ?? ''),
      code: Number.isInteger(error.code) ? error.code : 1,
      timedOut: !!error.killed,
    }),
  );

  const rawText = [execution.stdout, execution.stderr].filter(Boolean).join('\n');
  const relevant = pickRelevantLines(rawText, [
    'error',
    'warning',
    'failed',
    'exception',
    'maximum update depth',
    'entity not found',
  ]);
  const shouldPrioritizeRelevant = execution.code !== 0 || execution.timedOut;
  const compressedSource = shouldPrioritizeRelevant && relevant ? relevant : rawText;
  const compressedText = truncate(uniqueLines(compressedSource), 5000);
  const metrics = buildMetrics({
    tool: 'smart_shell',
    target: command,
    rawText,
    compressedText,
  });

  await persistMetrics(metrics);

  const result = {
    command,
    exitCode: execution.code,
    blocked: false,
    output: compressedText,
    confidence: { blocked: false, timedOut: !!execution.timedOut },
    metrics,
  };

  if (execution.timedOut) result.timedOut = true;

  return result;
};
