import path from 'node:path';
import fs from 'node:fs';
import { loadIndex, isTestFile, queryRelated } from '../index.js';
import { ensureIndexReady } from '../index-manager.js';
import { projectRoot } from '../utils/paths.js';
import { getChangedFiles } from './smart-context.js';
import { smartShell } from './smart-shell.js';
import {
  getLastTestFailure,
  setLastTestFailure,
  clearLastTestFailure,
} from '../storage/sqlite.js';
import { recordToolUsage } from '../usage-feedback.js';
import { recordDecision, DECISION_REASONS, EXPECTED_BENEFITS } from '../decision-explainer.js';
import { recordDevctxOperation } from '../missed-opportunities.js';

const VALID_ACTIONS = new Set(['affected', 'run', 'last_failure']);
const DEFAULT_MAX_FILES = 50;
const DEFAULT_HOPS = 2;

const ALLOWED_RUNNERS = new Map([
  ['npm-test', 'npm test'],
  ['npm-run', 'npm run'],
  ['pnpm-test', 'pnpm test'],
  ['pnpm-run', 'pnpm run'],
  ['yarn-test', 'yarn test'],
  ['yarn-run', 'yarn run'],
  ['bun-test', 'bun test'],
  ['bun-run', 'bun run'],
  ['node-test', 'node --test'],
  ['vitest', 'npx vitest run'],
  ['jest', 'npx jest'],
]);

const detectAffectedTests = (index, changedFiles, { maxHops = DEFAULT_HOPS, maxFiles = DEFAULT_MAX_FILES } = {}) => {
  if (!index?.files) return { tests: [], reachableFrom: {}, expanded: new Set() };

  const expanded = new Set();
  const reachableFrom = {};
  const queue = changedFiles.map((file) => ({ file, depth: 0, origin: file }));

  while (queue.length > 0 && expanded.size < maxFiles * 4) {
    const { file, depth, origin } = queue.shift();
    if (expanded.has(file)) continue;
    expanded.add(file);

    if (!reachableFrom[file]) reachableFrom[file] = origin;

    if (depth >= maxHops) continue;

    const related = queryRelated(index, file);
    for (const next of [...related.importedBy, ...related.tests]) {
      if (!expanded.has(next)) queue.push({ file: next, depth: depth + 1, origin });
    }
  }

  const tests = [...expanded].filter((rel) => isTestFile(rel)).slice(0, maxFiles);
  return { tests, reachableFrom, expanded };
};

const buildShellCommand = ({ runner, script, files }) => {
  const base = ALLOWED_RUNNERS.get(runner);
  if (!base) throw new Error(`runner not allowed: ${runner}`);

  const sanitizeArg = (arg) => {
    if (!arg || typeof arg !== 'string') return null;
    if (/[\s"';|&`$<>\\]/.test(arg)) return null;
    if (arg.includes('..')) return null;
    return arg;
  };

  const parts = [base];

  if ((runner === 'npm-run' || runner === 'pnpm-run' || runner === 'yarn-run' || runner === 'bun-run')) {
    const safeScript = sanitizeArg(script);
    if (!safeScript) throw new Error(`invalid script: ${script}`);
    parts.push(safeScript);
  }

  if (Array.isArray(files) && files.length > 0) {
    const safeFiles = files.map(sanitizeArg).filter(Boolean);
    if (safeFiles.length !== files.length) throw new Error('one or more file targets contain unsafe characters');
    if (safeFiles.length > 0) parts.push(...safeFiles);
  }

  return parts.join(' ');
};

const parseFailureFromOutput = (output) => {
  if (typeof output !== 'string') return [];
  const lines = output.split(/\r?\n/);
  const failures = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^not ok\s+\d+/i.test(line) || /^\s*✗\s+/.test(line) || /\bFAIL\b/.test(line)) {
      const context = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 4)).join('\n');
      failures.push({ line: i + 1, context: context.slice(0, 400) });
      if (failures.length >= 5) break;
    }
  }

  return failures;
};

const runAffected = async ({ diff, maxHops, maxFiles }) => {
  const root = projectRoot;
  await ensureIndexReady({ root });
  const index = loadIndex(root);
  if (!index) {
    return { success: false, action: 'affected', error: 'index unavailable; run build_index first' };
  }

  const ref = diff === false ? null : (diff === true || !diff ? 'HEAD' : diff);
  const changed = ref ? await getChangedFiles(ref, root) : { files: [], ref: null, skippedDeleted: 0 };

  const { tests, expanded } = detectAffectedTests(index, changed.files ?? [], { maxHops, maxFiles });

  const explicitChangedTests = (changed.files ?? []).filter(isTestFile);
  const merged = [...new Set([...explicitChangedTests, ...tests])].slice(0, maxFiles);

  recordToolUsage({ tool: 'smart_test', savedTokens: 0, target: 'affected' });
  recordDevctxOperation();
  recordDecision({
    tool: 'smart_test',
    action: 'list affected tests',
    reason: DECISION_REASONS.DIFF_ANALYSIS,
    alternative: 'Run full test suite (slow) or grep tests manually',
    expectedBenefit: `${EXPECTED_BENEFITS.TOKEN_SAVINGS(0)}, target only affected tests`,
    context: `${changed.files?.length ?? 0} changed → ${merged.length} affected tests`,
  });

  return {
    success: true,
    action: 'affected',
    ref: changed.ref ?? null,
    changedFiles: changed.files ?? [],
    affectedTests: merged,
    stats: {
      changedFiles: changed.files?.length ?? 0,
      expandedFiles: expanded.size,
      affectedTests: merged.length,
      maxHops: maxHops ?? DEFAULT_HOPS,
    },
    hints: merged.length === 0
      ? ['No affected tests detected; consider running the full suite or inspect graph coverage.']
      : [`Run with action='run' to execute these ${merged.length} test files.`],
  };
};

const runRun = async ({ runner = 'npm-test', script, files, ref, persistFailure = true }) => {
  let command;
  try {
    command = buildShellCommand({ runner, script, files });
  } catch (error) {
    return { success: false, action: 'run', error: error.message };
  }

  const shellResult = await smartShell({ command });
  const stdout = shellResult.compressed ?? shellResult.output ?? '';
  const stderr = shellResult.stderr ?? '';
  const code = shellResult.exitCode ?? shellResult.code ?? (shellResult.blocked ? -1 : 0);
  const passed = code === 0 && !shellResult.timedOut && !shellResult.blocked;

  const failures = passed ? [] : parseFailureFromOutput(`${stdout}\n${stderr}`);

  let savedFailure = null;
  if (!passed && persistFailure) {
    try {
      savedFailure = await setLastTestFailure({
        payload: {
          command,
          runner,
          script: script ?? null,
          files: files ?? [],
          exitCode: code,
          ref: ref ?? null,
          failures,
          output: typeof stdout === 'string' ? stdout.slice(0, 4000) : '',
          stderr: typeof stderr === 'string' ? stderr.slice(0, 2000) : '',
        },
      });
    } catch { /* best effort */ }
  } else if (passed) {
    try { await clearLastTestFailure(); } catch { /* ignore */ }
  }

  recordToolUsage({ tool: 'smart_test', savedTokens: 0, target: 'run' });
  recordDevctxOperation();
  recordDecision({
    tool: 'smart_test',
    action: `run tests (${runner})`,
    reason: passed ? DECISION_REASONS.SAFE_EXECUTION : DECISION_REASONS.COMMAND_OUTPUT,
    alternative: 'Manual shell invocation without context capture',
    expectedBenefit: 'Compressed output, persisted last_failure on red',
    context: `${command} → exit ${code}, failures: ${failures.length}`,
  });

  return {
    success: true,
    action: 'run',
    command,
    runner,
    exitCode: code,
    passed,
    failuresFound: failures.length,
    failures,
    output: stdout,
    stderr,
    savedFailureAt: savedFailure?.recordedAt ?? null,
    ...(shellResult.outputRef ? { outputRef: shellResult.outputRef } : {}),
  };
};

const runLastFailure = async () => {
  const record = await getLastTestFailure();
  if (!record) {
    return {
      success: true,
      action: 'last_failure',
      hasFailure: false,
      hints: ['No previous failure recorded. Run smart_test action="run" first.'],
    };
  }

  recordToolUsage({ tool: 'smart_test', savedTokens: 0, target: 'last_failure' });
  recordDevctxOperation();

  return {
    success: true,
    action: 'last_failure',
    hasFailure: true,
    record,
  };
};

export const smartTest = async ({
  action = 'affected',
  diff,
  maxHops,
  maxFiles,
  runner,
  script,
  files,
  ref,
} = {}) => {
  if (!VALID_ACTIONS.has(action)) {
    return { success: false, error: `Invalid action: ${action}. Allowed: ${[...VALID_ACTIONS].join(', ')}` };
  }

  if (action === 'affected') return runAffected({ diff, maxHops, maxFiles });
  if (action === 'run') return runRun({ runner, script, files, ref });
  if (action === 'last_failure') return runLastFailure();

  return { success: false, error: `Unsupported action: ${action}` };
};

export const _internal = {
  detectAffectedTests,
  buildShellCommand,
  parseFailureFromOutput,
};
