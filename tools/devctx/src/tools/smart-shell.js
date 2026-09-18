import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { rgPath } from '@vscode/ripgrep';
import { buildMetrics, persistMetrics } from '../metrics.js';
import { projectRoot } from '../utils/paths.js';
import { pickRelevantLines, truncate, uniqueLines } from '../utils/text.js';
import { recordToolUsage } from '../usage-feedback.js';
import { recordDecision, DECISION_REASONS, EXPECTED_BENEFITS } from '../decision-explainer.js';
import { recordDevctxOperation } from '../missed-opportunities.js';
import { captureOutput, inferKindFromCommand } from '../outputs/store.js';
const execFile = promisify(execFileCallback);
const isShellDisabled = () => process.env.DEVCTX_SHELL_DISABLED === 'true';
const DEFAULT_TIMEOUT_MS = 15000;
const getTimeoutMs = () => {
  const env = parseInt(process.env.DEVCTX_SHELL_TIMEOUT_MS, 10);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_TIMEOUT_MS;
};
const allowedCommands = new Set(['pwd', 'ls', 'find', 'rg', 'git', 'npm', 'pnpm', 'yarn', 'bun']);
const allowedGitSubcommands = new Set(['status', 'diff', 'show', 'log', 'branch', 'rev-parse', 'blame']);
const allowedPackageManagerSubcommands = new Set(['test', 'run', 'lint', 'build', 'typecheck', 'check']);
const safeRunScriptPattern = /^(test|lint|build|typecheck|check|smoke|verify|eval)(:|$)/;
const dangerousPatterns = [
  /rm\s+-rf/i,
  /sudo/i,
  /curl.*\|/i,
  /wget.*\|/i,
  /(^|\s)eval(\s|$)/i,
  /(^|\s)exec(\s|$)/i,
];
const MAX_COMMAND_LENGTH = 500;

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

const hasUnquotedShellOperators = (command) => {
  let inQuote = null;
  let prevWasEscape = false;

  for (const char of command) {
    if (prevWasEscape) {
      prevWasEscape = false;
      continue;
    }

    if (char === '\\') {
      prevWasEscape = true;
      continue;
    }

    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inQuote = char;
      continue;
    }

    if (/[|&;<>`\n\r$]/.test(char)) {
      return true;
    }

    if (char === '(' || char === ')') {
      return true;
    }
  }

  return false;
};

const validateCommand = (command, tokens) => {
  if (isShellDisabled()) {
    return 'Shell execution is disabled (DEVCTX_SHELL_DISABLED=true)';
  }

  if (!command.trim()) {
    return 'Command is empty';
  }

  if (command.length > MAX_COMMAND_LENGTH) {
    return `Command too long (max ${MAX_COMMAND_LENGTH} chars)`;
  }

  if (hasUnquotedShellOperators(command)) {
    return 'Shell operators are not allowed outside quotes (|, &, ;, <, >, `, $, (, ))';
  }

  for (const pattern of dangerousPatterns) {
    if (pattern.test(command)) {
      return `Dangerous pattern detected: ${pattern.source}`;
    }
  }

  if (tokens.length === 0) {
    return 'Command is empty';
  }

  const [baseCommand, subcommand, thirdToken] = tokens;

  if (!allowedCommands.has(baseCommand)) {
    return `Command not allowed: ${baseCommand}. Allowed: ${[...allowedCommands].join(', ')}`;
  }

  if (baseCommand === 'git' && !allowedGitSubcommands.has(subcommand)) {
    return `Git subcommand not allowed: ${subcommand ?? '(missing)'}. Allowed: ${[...allowedGitSubcommands].join(', ')}`;
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
      return `Package manager subcommand not allowed: ${subcommand ?? '(missing)'}. Allowed: ${[...allowedPackageManagerSubcommands].join(', ')}`;
    }

    if (subcommand === 'run' && (!thirdToken || !safeRunScriptPattern.test(thirdToken))) {
      return `Package manager script not allowed: ${thirdToken ?? '(missing)'}. Allowed pattern: ${safeRunScriptPattern.source}`;
    }
  }

  return null;
};

const DIFF_FILE_HEADER = /^diff --git a\/.+ b\/.+/;
const DIFF_HUNK_HEADER = /^@@ /;
const MAX_DIFF_FILES = 8;
const MAX_LINES_PER_FILE = 60;
const DIFF_TOTAL_LIMIT = 4000;

const TAP_HEADER = /^TAP version/;
const TAP_OK_LINE = /^\s*ok\s+\d+/;
const TAP_NOT_OK_LINE = /^\s*not ok\s+\d+/;
const TAP_SUBTEST_LINE = /^\s*#\s+Subtest:/;
const TAP_YAML_FENCE = /^\s*(---|\.\.\.)\s*$/;
const TAP_SUMMARY_LINE = /^\s*#\s+(tests|pass|fail|skipped|todo|duration_ms|cancelled|suites)\b/;
const TAP_DETECT = /(^|\n)(TAP version |# tests \d+)/;
const TAP_FAIL_CONTEXT = 4;

const GIT_LOG_COMMIT_HEADER = /^commit [0-9a-f]{40}/;
const GIT_LOG_DETECT = /^commit [0-9a-f]{40}\nAuthor:/m;
const MAX_GIT_LOG_COMMITS = 40;

const splitDiffByFile = (text) => {
  const files = [];
  let current = null;

  for (const line of text.split('\n')) {
    if (DIFF_FILE_HEADER.test(line)) {
      if (current) files.push(current);
      current = { header: line, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) files.push(current);
  return files;
};

export const compressTapOutput = (text) => {
  const lines = text.split('\n');
  const summary = [];
  const failures = [];
  const headerLines = [];
  let inYaml = false;
  let yamlFailureBuffer = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (TAP_HEADER.test(line) && headerLines.length === 0) {
      headerLines.push(line);
      continue;
    }

    if (TAP_SUMMARY_LINE.test(line)) {
      summary.push(line);
      continue;
    }

    if (TAP_NOT_OK_LINE.test(line)) {
      failures.push(line);
      yamlFailureBuffer = failures;
      inYaml = false;
      continue;
    }

    if (TAP_YAML_FENCE.test(line)) {
      if (yamlFailureBuffer) yamlFailureBuffer.push(line);
      inYaml = !inYaml;
      if (!inYaml) yamlFailureBuffer = null;
      continue;
    }

    if (inYaml && yamlFailureBuffer) {
      if (yamlFailureBuffer.length - failures.indexOf(yamlFailureBuffer[0]) <= TAP_FAIL_CONTEXT + 6) {
        yamlFailureBuffer.push(line);
      }
      continue;
    }

    if (TAP_OK_LINE.test(line) || TAP_SUBTEST_LINE.test(line)) {
      continue;
    }

    if (line.trim().startsWith('#') && failures.length > 0 && failures.length < 200) {
      failures.push(line);
    }
  }

  const parts = [];
  if (headerLines.length > 0) parts.push(headerLines.join('\n'));
  if (failures.length > 0) {
    parts.push(`# ${failures.filter((l) => TAP_NOT_OK_LINE.test(l)).length} failure(s):`);
    parts.push(failures.join('\n'));
  } else {
    parts.push('# all tests passed (ok lines collapsed)');
  }
  if (summary.length > 0) parts.push(summary.join('\n'));

  return parts.join('\n');
};

export const compressGitLog = (text) => {
  const lines = text.split('\n');
  const commits = [];
  let current = null;

  for (const line of lines) {
    if (GIT_LOG_COMMIT_HEADER.test(line)) {
      if (current) commits.push(current);
      current = { sha: line.split(' ')[1], subject: '' };
    } else if (current && !current.subject && line.trim() && !/^(Author|Date|Merge|commit):/i.test(line)) {
      current.subject = line.trim();
    }
  }
  if (current) commits.push(current);

  if (commits.length === 0) return text;

  const shown = commits.slice(0, MAX_GIT_LOG_COMMITS);
  const skipped = commits.length - shown.length;
  const body = shown.map(({ sha, subject }) => `${sha.slice(0, 7)} ${subject}`).join('\n');
  return skipped > 0
    ? `${body}\n# ${skipped} more commit(s) not shown — narrow with --since/--until or git log -n <N>`
    : body;
};

const compressDiff = (text) => {
  if (!DIFF_FILE_HEADER.test(text)) return text;

  const files = splitDiffByFile(text);
  if (files.length === 0) return text;

  const shown = files.slice(0, MAX_DIFF_FILES);
  const skipped = files.length - shown.length;

  const parts = shown.map(({ header, lines }) => {
    const truncatedLines = lines.slice(0, MAX_LINES_PER_FILE);
    const skippedLines = lines.length - truncatedLines.length;
    const hunkCount = lines.filter((l) => DIFF_HUNK_HEADER.test(l)).length;
    const suffix = skippedLines > 0 ? [`... (${skippedLines} more lines — use smart_read(symbol) for full body)`] : [];
    return [header, `# ${hunkCount} hunk(s)`, ...truncatedLines, ...suffix].join('\n');
  });

  const footer = skipped > 0
    ? `\n# ${skipped} more file(s) not shown — run git show -- <file> for each`
    : '';

  return truncate(parts.join('\n\n'), DIFF_TOTAL_LIMIT) + footer;
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
  const timeoutMs = getTimeoutMs();
  const execution = await execFile(resolvedFile, args, {
    cwd: projectRoot,
    maxBuffer: 1024 * 1024 * 10,
    timeout: timeoutMs,
  }).then(
    ({ stdout, stderr }) => ({ stdout, stderr, code: 0 }),
    (error) => ({
      stdout: error.stdout ?? '',
      stderr: error.killed
        ? `Command timed out after ${timeoutMs / 1000}s: ${command}`
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
  const isTap = TAP_DETECT.test(rawText);
  const isGitLog = !isTap && GIT_LOG_DETECT.test(rawText);
  let stagedCompression;

  if (isTap) {
    stagedCompression = compressTapOutput(rawText);
  } else if (isGitLog) {
    stagedCompression = compressGitLog(rawText);
  } else {
    const compressedSource = shouldPrioritizeRelevant && relevant ? relevant : rawText;
    stagedCompression = compressDiff(uniqueLines(compressedSource));
  }

  const compressedText = truncate(stagedCompression, 5000);
  const metrics = buildMetrics({
    tool: 'smart_shell',
    target: command,
    rawText,
    compressedText,
  });

  await persistMetrics(metrics);
  
  recordToolUsage({
    tool: 'smart_shell',
    savedTokens: metrics.savedTokens,
    target: command,
  });
  recordDevctxOperation();
  const outputLines = rawText.split('\n').length;
  let reason = DECISION_REASONS.COMMAND_OUTPUT;
  if (shouldPrioritizeRelevant && relevant) {
    reason = DECISION_REASONS.RELEVANT_LINES;
  }
  
  recordDecision({
    tool: 'smart_shell',
    action: `execute "${command}"`,
    reason,
    alternative: 'Shell (uncompressed output)',
    expectedBenefit: EXPECTED_BENEFITS.TOKEN_SAVINGS(metrics.savedTokens),
    context: `${outputLines} lines → ${compressedText.split('\n').length} lines (relevant only)`,
  });

  const captured = await captureOutput({
    kind: inferKindFromCommand(command),
    label: command.slice(0, 120),
    command,
    exitCode: execution.code,
    content: rawText,
  });

  const result = {
    command,
    exitCode: execution.code,
    blocked: false,
    output: compressedText,
    ...(execution.timedOut ? { timedOut: true } : {}),
    ...(captured.saved
      ? { outputRef: { id: captured.entry.id, kind: captured.entry.kind, lines: captured.entry.lines } }
      : {}),
  };

  return result;
};
