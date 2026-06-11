import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { smartSummary } from '../src/tools/smart-summary.js';
import { smartTurn } from '../src/tools/smart-turn.js';
import { projectRoot, setProjectRoot } from '../src/utils/runtime-config.js';
import { getWorkflowMetrics, getWorkflowSummaryByType } from '../src/workflow-tracker.js';

const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
const SKIP_SQLITE_TESTS = nodeMajor < 22;
const previousWorkflowTracking = process.env.DEVCTX_WORKFLOW_TRACKING;

const originalProjectRoot = projectRoot;
let turnTestRoot = null;

before(() => {
  if (SKIP_SQLITE_TESTS) return;
  turnTestRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-turn-suite-'));
  setProjectRoot(turnTestRoot);
  execFileSync('git', ['init'], { cwd: turnTestRoot, stdio: 'ignore' });
});

after(() => {
  if (SKIP_SQLITE_TESTS) return;
  setProjectRoot(originalProjectRoot);
  if (previousWorkflowTracking === undefined) {
    delete process.env.DEVCTX_WORKFLOW_TRACKING;
  } else {
    process.env.DEVCTX_WORKFLOW_TRACKING = previousWorkflowTracking;
  }
  if (turnTestRoot) {
    fs.rmSync(turnTestRoot, { recursive: true, force: true });
  }
});

test('smart_turn start reuses aligned persisted context', { skip: SKIP_SQLITE_TESTS ? 'SQLite support requires Node 22+' : false }, async () => {
  await smartSummary({
    action: 'update',
    sessionId: 'turn-aligned',
    update: {
      goal: 'Implement runtime repo safety enforcement for smart metrics',
      status: 'in_progress',
      currentFocus: 'smart metrics repo safety',
      nextStep: 'Finish tests for smart metrics enforcement',
      touchedFiles: ['tools/devctx/src/tools/smart-metrics.js'],
    },
  });

  const result = await smartTurn({
    phase: 'start',
    sessionId: 'turn-aligned',
    prompt: 'Finish the smart metrics repo safety tests and keep runtime enforcement in place',
    verbosity: 'standard',
  });

  assert.strictEqual(result.phase, 'start');
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.sessionId, 'turn-aligned');
  assert.strictEqual(result.continuity.state, 'aligned');
  assert.strictEqual(result.continuity.shouldReuseContext, true);
  assert.ok(result.summary.goal.includes('repo safety'));
  assert.equal(result.refreshedContext, undefined);
  assert.equal(result.recommendedPath.mode, 'guided_context');
  assert.deepEqual(result.recommendedPath.nextTools, ['smart_context', 'smart_read', 'smart_turn']);
  assert.match(result.recommendedPath.next, /smart_context/i);

  await smartSummary({ action: 'reset', sessionId: 'turn-aligned' });
});

test('smart_turn start can auto-create a planning session for a substantial new prompt', { skip: SKIP_SQLITE_TESTS ? 'SQLite support requires Node 22+' : false }, async () => {
  const result = await smartTurn({
    phase: 'start',
    prompt: 'Design the final orchestration layer so every meaningful agent turn rehydrates context and checkpoints progress automatically',
    ensureSession: true,
    verbosity: 'standard',
  });

  assert.strictEqual(result.phase, 'start');
  assert.strictEqual(result.autoCreated, true);
  assert.strictEqual(result.found, true);
  assert.ok(typeof result.sessionId === 'string' && result.sessionId.length > 0);
  assert.strictEqual(result.continuity.shouldReuseContext, true);
  assert.ok(result.summary.goal.toLowerCase().includes('orchestration layer'));

  await smartSummary({ action: 'reset', sessionId: result.sessionId });
});

test('smart_turn start does not refresh prompt context for a trivial prompt without session orchestration', { skip: SKIP_SQLITE_TESTS ? 'SQLite support requires Node 22+' : false }, async () => {
  const result = await smartTurn({
    phase: 'start',
    prompt: 'Check auth',
  });

  assert.equal(result.refreshedContext, undefined);
  assert.equal(result.autoCreated, false);
  assert.equal(result.isolatedSession, false);
});

test('smart_turn start refreshes lightweight context for the new prompt', { skip: SKIP_SQLITE_TESTS ? 'SQLite support requires Node 22+' : false }, async () => {
  const srcDir = path.join(turnTestRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(
    path.join(srcDir, 'auth.js'),
    'export function loginHandler(token) {\n  if (!token) throw new Error("Missing token");\n  return token;\n}\n',
    'utf8',
  );

  const result = await smartTurn({
    phase: 'start',
    prompt: 'Fix the token error in loginHandler and continue the auth debugging flow',
    ensureSession: true,
    verbosity: 'standard',
  });

  assert.ok(result.refreshedContext);
  assert.ok(Array.isArray(result.refreshedContext.topFiles));
  assert.ok(result.refreshedContext.topFiles.some((item) => item.file.includes('src/auth.js')));
  assert.equal(result.recommendedPath.mode, 'guided_refresh');
  assert.deepEqual(result.recommendedPath.nextTools, ['smart_read', 'smart_turn']);
  assert.match(result.recommendedPath.next, /refreshedContext\.topFiles/i);

  await smartSummary({ action: 'reset', sessionId: result.sessionId });
});

test('smart_turn start isolates a new session when the prompt mismatches the active session', { skip: SKIP_SQLITE_TESTS ? 'SQLite support requires Node 22+' : false }, async () => {
  await smartSummary({
    action: 'update',
    sessionId: 'turn-existing',
    update: {
      goal: 'Implement runtime repo safety enforcement for metrics',
      status: 'in_progress',
      currentFocus: 'repo safety enforcement',
      nextStep: 'Finish the safety test matrix',
    },
  });

  const result = await smartTurn({
    phase: 'start',
    prompt: 'Document an unrelated headless wrapper onboarding flow for new sessions',
    ensureSession: true,
    verbosity: 'standard',
  });

  assert.strictEqual(result.found, true);
  assert.strictEqual(result.isolatedSession, true);
  assert.strictEqual(result.previousSessionId, 'turn-existing');
  assert.notStrictEqual(result.sessionId, 'turn-existing');
  assert.match(result.summary.goal.toLowerCase(), /headless wrapper onboarding flow/);
  assert.ok(['aligned', 'resume'].includes(result.continuity.state));

  await smartSummary({ action: 'reset', sessionId: 'turn-existing' });
  await smartSummary({ action: 'reset', sessionId: result.sessionId });
});

test('smart_turn start and end integrate workflow tracking when enabled', { skip: SKIP_SQLITE_TESTS ? 'SQLite support requires Node 22+' : false }, async () => {
  process.env.DEVCTX_WORKFLOW_TRACKING = 'true';

  try {
    const start = await smartTurn({
      phase: 'start',
      prompt: 'Fix the login error in the auth handler and verify the failing test',
      ensureSession: true,
      verbosity: 'standard',
    });

    assert.equal(start.workflow?.enabled, true);
    assert.equal(start.workflow?.workflowType, 'debugging');

    const active = await getWorkflowMetrics({ sessionId: start.sessionId, completed: false, limit: 1 });
    assert.equal(active.length, 1);
    assert.equal(active[0].workflow_type, 'debugging');
    assert.deepEqual(active[0].netMetricsCoverage, {
      available: false,
      source: 'none',
    });

    const end = await smartTurn({
      phase: 'end',
      sessionId: start.sessionId,
      event: 'milestone',
      update: {
        completed: ['Fixed the auth handler null-token bug'],
        nextStep: 'Run the authentication regression tests',
      },
    });

    assert.equal(end.workflow?.enabled, true);
    assert.equal(end.workflow?.ended, true);
    assert.equal(end.workflow?.summary?.workflowType, 'debugging');
    assert.ok(typeof end.workflow?.summary?.netSavedTokens === 'number');
    assert.ok(typeof end.workflow?.summary?.overheadTokens === 'number');

    const completed = await getWorkflowMetrics({ sessionId: start.sessionId, completed: true, limit: 1 });
    assert.equal(completed.length, 1);
    assert.ok(typeof completed[0].netSavedTokens === 'number');
    assert.ok(typeof completed[0].metadata.summary?.overheadTokens === 'number');
    assert.deepEqual(completed[0].netMetricsCoverage, {
      available: true,
      source: 'persisted',
    });

    const byType = await getWorkflowSummaryByType();
    const debuggingSummary = byType.find((entry) => entry.workflow_type === 'debugging');
    assert.ok(debuggingSummary);
    assert.ok(debuggingSummary.net_metrics_count >= 1);
    assert.ok(typeof debuggingSummary.total_net_saved_tokens === 'number');
    assert.deepEqual(debuggingSummary.netMetricsCoverage, {
      coveredWorkflows: debuggingSummary.net_metrics_count,
      totalWorkflows: debuggingSummary.count,
      uncoveredWorkflows: debuggingSummary.count - debuggingSummary.net_metrics_count,
      coveragePct: 100,
      complete: true,
    });

    await smartSummary({ action: 'reset', sessionId: start.sessionId });
  } finally {
    if (previousWorkflowTracking === undefined) {
      delete process.env.DEVCTX_WORKFLOW_TRACKING;
    } else {
      process.env.DEVCTX_WORKFLOW_TRACKING = previousWorkflowTracking;
    }
  }
});

test('smart_turn reports workflow tracking blocked when state sqlite is staged', { skip: SKIP_SQLITE_TESTS ? 'SQLite support requires Node 22+' : false }, async () => {
  process.env.DEVCTX_WORKFLOW_TRACKING = 'true';

  try {
    await smartSummary({
      action: 'update',
      sessionId: 'turn-workflow-blocked',
      update: {
        goal: 'Debug blocked workflow tracking',
        status: 'in_progress',
        currentFocus: 'Repo safety enforcement',
      },
    });

    fs.writeFileSync(path.join(turnTestRoot, '.gitignore'), '.devctx/\n', 'utf8');
    execFileSync('git', ['add', '-f', '.devctx/state.sqlite'], { cwd: turnTestRoot, stdio: 'ignore' });
    try {
      const result = await smartTurn({
        phase: 'start',
        sessionId: 'turn-workflow-blocked',
        prompt: 'Continue the blocked debugging workflow safely',
      });

      assert.equal(result.repoSafety?.isTracked, true);
      assert.equal(result.repoSafety?.isStaged, true);
      assert.deepEqual(result.mutationSafety, {
        blocked: true,
        blockedBy: ['tracked', 'staged'],
        stateDbPath: '.devctx/state.sqlite',
        recommendedActions: result.repoSafety.recommendedActions,
        message: 'Project-local context writes are blocked until git hygiene is fixed for .devctx/state.sqlite.',
      });
      assert.deepEqual(result.workflow, {
        enabled: true,
        blocked: true,
        workflowId: null,
        workflowType: null,
        autoTracked: false,
      });
      assert.equal(result.recommendedPath.mode, 'blocked_guided');
      assert.equal(result.recommendedPath.nextTools[0], 'repo_safety');
      assert.match(result.recommendedPath.next, /recommendedActions/i);

      const active = await getWorkflowMetrics({ sessionId: 'turn-workflow-blocked', completed: false, limit: 1 });
      assert.equal(active.length, 0);
    } finally {
      execFileSync('git', ['rm', '--cached', '-f', '.devctx/state.sqlite'], { cwd: turnTestRoot, stdio: 'ignore' });
      await smartSummary({ action: 'reset', sessionId: 'turn-workflow-blocked' });
    }
  } finally {
    if (previousWorkflowTracking === undefined) {
      delete process.env.DEVCTX_WORKFLOW_TRACKING;
    } else {
      process.env.DEVCTX_WORKFLOW_TRACKING = previousWorkflowTracking;
    }
  }
});

test('smart_turn start does not enable workflow tracking when the env flag is off', { skip: SKIP_SQLITE_TESTS ? 'SQLite support requires Node 22+' : false }, async () => {
  delete process.env.DEVCTX_WORKFLOW_TRACKING;

  const result = await smartTurn({
    phase: 'start',
    prompt: 'Fix the login error in the auth handler and verify the failing test',
    ensureSession: true,
  });

  assert.equal(result.workflow, undefined);

  await smartSummary({ action: 'reset', sessionId: result.sessionId });
});

test('smart_turn end exposes mutationSafety when checkpoint writes are blocked by repo safety', { skip: SKIP_SQLITE_TESTS ? 'SQLite support requires Node 22+' : false }, async () => {
  await smartSummary({
    action: 'update',
    sessionId: 'turn-end-blocked',
    update: {
      goal: 'Blocked end-turn checkpoint',
      status: 'in_progress',
      nextStep: 'Attempt blocked checkpoint',
    },
  });

  fs.writeFileSync(path.join(turnTestRoot, '.gitignore'), '.devctx/\n', 'utf8');
  execFileSync('git', ['add', '-f', '.devctx/state.sqlite'], { cwd: turnTestRoot, stdio: 'ignore' });

  try {
    const result = await smartTurn({
      phase: 'end',
      sessionId: 'turn-end-blocked',
      event: 'milestone',
      update: {
        completed: ['Blocked milestone write'],
        nextStep: 'Fix git hygiene first',
      },
    });

    assert.equal(result.checkpoint.blocked, true);
    assert.deepEqual(result.mutationSafety, {
      blocked: true,
      blockedBy: ['tracked', 'staged'],
      stateDbPath: '.devctx/state.sqlite',
      recommendedActions: result.repoSafety.recommendedActions,
      message: 'Project-local context writes are blocked until git hygiene is fixed for .devctx/state.sqlite.',
    });
    assert.equal(result.message, result.mutationSafety.message);
    assert.equal(result.recommendedPath.mode, 'blocked_guided');
    assert.equal(result.recommendedPath.nextTools[0], 'repo_safety');
  } finally {
    execFileSync('git', ['rm', '--cached', '-f', '.devctx/state.sqlite'], { cwd: turnTestRoot, stdio: 'ignore' });
    await smartSummary({ action: 'reset', sessionId: 'turn-end-blocked' });
  }
});

test('smart_turn end does not close workflow when checkpoint is skipped', { skip: SKIP_SQLITE_TESTS ? 'SQLite support requires Node 22+' : false }, async () => {
  process.env.DEVCTX_WORKFLOW_TRACKING = 'true';

  try {
    const start = await smartTurn({
      phase: 'start',
      prompt: 'Fix the login error in the auth handler and verify the failing test',
      ensureSession: true,
      verbosity: 'standard',
    });

    const end = await smartTurn({
      phase: 'end',
      sessionId: start.sessionId,
      event: 'file_change',
      update: {
        touchedFiles: ['src/auth.js'],
      },
    });

    assert.equal(end.checkpoint.skipped, true);
    assert.equal(end.workflow, undefined);
    assert.equal(end.recommendedPath.mode, 'continue_until_milestone');
    assert.deepEqual(end.recommendedPath.nextTools, ['smart_turn']);

    const active = await getWorkflowMetrics({ sessionId: start.sessionId, completed: false, limit: 1 });
    assert.equal(active.length, 1);

    await smartSummary({ action: 'reset', sessionId: start.sessionId });
  } finally {
    if (previousWorkflowTracking === undefined) {
      delete process.env.DEVCTX_WORKFLOW_TRACKING;
    } else {
      process.env.DEVCTX_WORKFLOW_TRACKING = previousWorkflowTracking;
    }
  }
});

test('smart_turn start refreshes context when the index is unavailable', { skip: SKIP_SQLITE_TESTS ? 'SQLite support requires Node 22+' : false }, async () => {
  const stateDir = path.join(turnTestRoot, '.devctx');
  fs.rmSync(path.join(stateDir, 'index.json'), { force: true });
  fs.rmSync(path.join(stateDir, 'index-meta.json'), { force: true });

  const srcDir = path.join(turnTestRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(
    path.join(srcDir, 'indexless.js'),
    'export function indexlessThing() { return 1; }\n',
    'utf8',
  );

  const result = await smartTurn({
    phase: 'start',
    prompt: 'Inspect the indexlessThing implementation and continue that task',
    ensureSession: true,
    verbosity: 'standard',
  });

  assert.ok(result.refreshedContext);
  // With the fixed ensureIndexReady auto-build, the index is built inside
  // smartContext before refreshPromptContext checks indexFreshness, so the
  // redundant rebuild path in refreshPromptContext no longer triggers.
  // The important invariant is that context is returned with a fresh index.
  const freshness = result.refreshedContext.indexFreshness;
  assert.ok(freshness === 'fresh' || result.refreshedContext.indexRefreshed === true,
    `Expected fresh index or indexRefreshed=true, got freshness=${freshness}`);

  await smartSummary({ action: 'reset', sessionId: result.sessionId });
});

test('smart_turn end checkpoints a meaningful turn update', { skip: SKIP_SQLITE_TESTS ? 'SQLite support requires Node 22+' : false }, async () => {
  await smartSummary({
    action: 'update',
    sessionId: 'turn-end',
    update: {
      goal: 'Close orchestration workflow',
      status: 'in_progress',
      currentFocus: 'turn orchestration',
    },
  });

  const result = await smartTurn({
    phase: 'end',
    sessionId: 'turn-end',
    event: 'milestone',
    verbosity: 'standard',
    update: {
      completed: ['Implemented smart_turn orchestration flow'],
      decisions: ['Use smart_turn as the default context entrypoint for non-trivial prompts'],
      nextStep: 'Update client rules to prefer smart_turn',
      touchedFiles: ['tools/devctx/src/tools/smart-turn.js'],
    },
  });

  assert.strictEqual(result.phase, 'end');
  assert.strictEqual(result.sessionId, 'turn-end');
  assert.strictEqual(result.checkpoint.skipped, false);
  assert.strictEqual(result.checkpoint.checkpoint.event, 'milestone');
  assert.strictEqual(result.checkpoint.checkpoint.shouldPersist, true);
  assert.ok(result.checkpoint.summary.recentCompleted.includes('Implemented smart_turn orchestration flow'));
  assert.equal(result.recommendedPath.mode, 'checkpointed');
  assert.deepEqual(result.recommendedPath.nextTools, ['smart_turn']);
  assert.match(result.recommendedPath.next, /restart with smart_turn\(start/i);

  await smartSummary({ action: 'reset', sessionId: 'turn-end' });
});

test('smart_turn start echoes normalized task budget when provided', { skip: SKIP_SQLITE_TESTS ? 'SQLite support requires Node 22+' : false }, async () => {
  const result = await smartTurn({
    phase: 'start',
    prompt: 'Review smart-turn orchestration and checkpoint behavior in this repo.',
    ensureSession: false,
    tokenBudget: { id: 'turn-budget', maxTokens: 250, shared: true },
  });

  assert.equal(result.taskBudget?.id, 'turn-budget');
  assert.equal(result.taskBudget?.maxTokens, 250);
  assert.equal(result.taskBudget?.shared, true);
});

test('smart_turn start skips continuity setup for a simple task prompt', { skip: SKIP_SQLITE_TESTS ? 'SQLite support requires Node 22+' : false }, async () => {
  const result = await smartTurn({
    phase: 'start',
    prompt: 'fix import',
    ensureSession: true,
  });

  assert.equal(result.skipSmartTurn, true);
  assert.equal(result.continuity?.state, 'simple_task_skip');
  assert.equal(result.sessionId, undefined);
  assert.equal(result.recommendedPath?.mode, 'simple_task_skip');
});
