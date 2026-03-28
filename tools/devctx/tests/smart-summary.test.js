import { after, before, test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { smartSummary } from '../src/tools/smart-summary.js';
import { ACTIVE_SESSION_SCOPE, SQLITE_SCHEMA_VERSION, withStateDb } from '../src/storage/sqlite.js';
import { projectRoot, setProjectRoot } from '../src/utils/runtime-config.js';

const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
const SKIP_SQLITE_TESTS = nodeMajor < 22;

if (SKIP_SQLITE_TESTS) {
  test('smart_summary tests require Node 22+', { skip: 'SQLite support requires Node 22+' }, () => {});
  process.exit(0);
}

const originalProjectRoot = projectRoot;
let summaryTestRoot = null;
const getSessionsDir = () => path.join(projectRoot, '.devctx', 'sessions');
const getActiveSessionFile = () => path.join(getSessionsDir(), 'active.json');
const getStateDbPath = () => path.join(projectRoot, '.devctx', 'state.sqlite');
const TEST_SESSION_ID = 'test-session-cleanup';

const withProjectStateDb = (callback, options = {}) => withStateDb(callback, {
  filePath: getStateDbPath(),
  ...options,
});

const getActiveSessionId = () => withProjectStateDb(
  (db) => db.prepare('SELECT session_id FROM active_session WHERE scope = ?').get(ACTIVE_SESSION_SCOPE)?.session_id ?? null,
  { readOnly: true },
);

const clearActiveSession = () => withProjectStateDb((db) => {
  db.prepare('DELETE FROM active_session WHERE scope = ?').run(ACTIVE_SESSION_SCOPE);
});

const sessionExists = (sessionId) => withProjectStateDb(
  (db) => Boolean(db.prepare('SELECT 1 FROM sessions WHERE session_id = ?').get(sessionId)),
  { readOnly: true },
);

const getSessionEventCount = (sessionId) => withProjectStateDb(
  (db) => db.prepare('SELECT COUNT(*) AS count FROM session_events WHERE session_id = ?').get(sessionId).count,
  { readOnly: true },
);

const ageSession = (sessionId, updatedAt) => withProjectStateDb((db) => {
  const row = db.prepare('SELECT snapshot_json FROM sessions WHERE session_id = ?').get(sessionId);
  assert.ok(row, `Session ${sessionId} should exist before aging it`);

  const snapshot = JSON.parse(row.snapshot_json);
  snapshot.updatedAt = updatedAt;

  db.prepare(`
    UPDATE sessions
    SET updated_at = ?, snapshot_json = ?
    WHERE session_id = ?
  `).run(updatedAt, JSON.stringify(snapshot), sessionId);

  const activeSessionId = db.prepare('SELECT session_id FROM active_session WHERE scope = ?').get(ACTIVE_SESSION_SCOPE)?.session_id;
  if (activeSessionId === sessionId) {
    db.prepare('UPDATE active_session SET updated_at = ? WHERE scope = ?').run(updatedAt, ACTIVE_SESSION_SCOPE);
  }
});

before(() => {
  summaryTestRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-summary-suite-'));
  setProjectRoot(summaryTestRoot);
  fs.mkdirSync(getSessionsDir(), { recursive: true });
  execFileSync('git', ['init'], { cwd: summaryTestRoot, stdio: 'ignore' });
});

after(() => {
  setProjectRoot(originalProjectRoot);
  if (summaryTestRoot) {
    fs.rmSync(summaryTestRoot, { recursive: true, force: true });
  }
});

test('smart_summary - create new session with update', async () => {
  const result = await smartSummary({
    action: 'update',
    sessionId: TEST_SESSION_ID,
    update: {
      goal: 'Test feature implementation',
      status: 'in_progress',
      completed: ['setup', 'config'],
      decisions: ['use Redis for cache'],
      nextStep: 'implement auth',
      touchedFiles: ['src/auth.js'],
    },
  });

  assert.strictEqual(result.action, 'update');
  assert.strictEqual(result.sessionId, TEST_SESSION_ID);
  assert.ok(result.summary);
  assert.strictEqual(result.summary.goal, 'Test feature implementation');
  assert.strictEqual(result.schemaVersion, SQLITE_SCHEMA_VERSION);
  assert.strictEqual(result.compressionLevel, 'none');
  assert.ok(result.tokens > 0);
  assert.ok(result.updatedAt);
});

test('smart_summary - get existing session', async () => {
  const result = await smartSummary({
    action: 'get',
    sessionId: TEST_SESSION_ID,
  });

  assert.strictEqual(result.action, 'get');
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.sessionId, TEST_SESSION_ID);
  assert.ok(result.summary);
  assert.strictEqual(result.summary.goal, 'Test feature implementation');
  assert.strictEqual(result.schemaVersion, SQLITE_SCHEMA_VERSION);
});

test('smart_summary - append to existing session', async () => {
  const result = await smartSummary({
    action: 'append',
    sessionId: TEST_SESSION_ID,
    update: {
      pinnedContext: ['keep JWT expiry decision'],
      unresolvedQuestions: ['Should refresh tokens live in Redis?'],
      currentFocus: 'authentication',
      completed: ['auth middleware'],
      decisions: ['JWT with 1h expiry'],
      touchedFiles: ['src/middleware/auth.js'],
    },
  });

  assert.strictEqual(result.action, 'append');
  assert.deepStrictEqual(result.summary.pinnedContext, ['keep JWT expiry decision']);
  assert.deepStrictEqual(result.summary.unresolvedQuestions, ['Should refresh tokens live in Redis?']);
  assert.strictEqual(result.summary.currentFocus, 'authentication');
  assert.ok(result.summary.recentCompleted.includes('auth middleware'));
  assert.ok(result.summary.keyDecisions.includes('JWT with 1h expiry'));
  assert.ok(result.summary.hotFiles.includes('src/middleware/auth.js'));
});

test('smart_summary - update replaces prior session state', async () => {
  await smartSummary({
    action: 'update',
    sessionId: 'test-update-replace',
    update: {
      goal: 'Initial goal',
      status: 'blocked',
      pinnedContext: ['keep legacy auth shape'],
      unresolvedQuestions: ['Do we need Redis?'],
      currentFocus: 'auth migration',
      whyBlocked: 'Awaiting approval',
      completed: ['draft middleware'],
      decisions: ['use jwt'],
      blockers: ['Awaiting approval'],
      nextStep: 'Resume after approval',
      touchedFiles: ['src/auth.js'],
    },
  });

  const result = await smartSummary({
    action: 'update',
    sessionId: 'test-update-replace',
    update: {
      goal: 'Replacement goal',
      status: 'planning',
      completed: ['new plan'],
    },
  });

  assert.strictEqual(result.summary.goal, 'Replacement goal');
  assert.strictEqual(result.summary.status, 'planning');
  assert.deepStrictEqual(result.summary.recentCompleted, ['new plan']);
  assert.ok(!('pinnedContext' in result.summary));
  assert.ok(!('unresolvedQuestions' in result.summary));
  assert.ok(!('currentFocus' in result.summary));
  assert.ok(!('whyBlocked' in result.summary));
  assert.ok(!('keyDecisions' in result.summary));
  assert.ok(!('hotFiles' in result.summary));
  assert.ok(!('nextStep' in result.summary));
  assert.strictEqual(result.summary.completedCount, 1);
  assert.strictEqual(result.summary.decisionsCount, 0);
  assert.strictEqual(result.summary.touchedFilesCount, 0);

  await smartSummary({ action: 'reset', sessionId: 'test-update-replace' });
});

test('smart_summary - update allows clearing scalar fields explicitly', async () => {
  await smartSummary({
    action: 'update',
    sessionId: 'test-update-clear-scalars',
    update: {
      goal: 'Scalar clearing test',
      status: 'blocked',
      currentFocus: 'critical path',
      whyBlocked: 'Waiting on infra',
      nextStep: 'Retry deploy later',
    },
  });

  const result = await smartSummary({
    action: 'update',
    sessionId: 'test-update-clear-scalars',
    update: {
      goal: 'Scalar clearing test',
      status: 'in_progress',
      currentFocus: '',
      whyBlocked: '',
      nextStep: '',
    },
  });

  assert.strictEqual(result.summary.status, 'in_progress');
  assert.ok(!('currentFocus' in result.summary));
  assert.ok(!('whyBlocked' in result.summary));
  assert.ok(!('nextStep' in result.summary));

  await smartSummary({ action: 'reset', sessionId: 'test-update-clear-scalars' });
});

test('smart_summary - list sessions', async () => {
  const result = await smartSummary({
    action: 'list_sessions',
  });

  assert.strictEqual(result.action, 'list_sessions');
  assert.ok(Array.isArray(result.sessions));
  assert.ok(result.sessions.length > 0);
  assert.ok(result.sessions.some(s => s.sessionId === TEST_SESSION_ID));
});

test('smart_summary - auto-generate sessionId from goal', async () => {
  const result = await smartSummary({
    action: 'update',
    update: {
      goal: 'Add user authentication system',
      status: 'planning',
    },
  });

  assert.ok(result.sessionId);
  assert.ok(result.sessionId.includes('add-user-authentication'));

  await smartSummary({ action: 'reset', sessionId: result.sessionId });
});

test('smart_summary - compression under token budget', async () => {
  const largeUpdate = {
    goal: 'Large feature',
    status: 'in_progress',
    completed: Array.from({ length: 20 }, (_, i) => `step ${i}`),
    decisions: Array.from({ length: 10 }, (_, i) => `decision ${i}`),
    touchedFiles: Array.from({ length: 30 }, (_, i) => `file${i}.js`),
  };

  const result = await smartSummary({
    action: 'update',
    sessionId: 'test-compression',
    update: largeUpdate,
    maxTokens: 300,
  });

  assert.ok(result.tokens <= 300);
  assert.ok(result.summary.completedCount >= 20);
  assert.ok(result.summary.decisionsCount >= 10);
  assert.ok(result.summary.touchedFilesCount >= 30);
  assert.ok((result.summary.recentCompleted || []).length <= 3);
  assert.ok((result.summary.keyDecisions || []).length <= 2);
  assert.ok((result.summary.hotFiles || []).length <= 5);

  await smartSummary({ action: 'reset', sessionId: 'test-compression' });
});

test('smart_summary - reset session', async () => {
  const result = await smartSummary({
    action: 'reset',
    sessionId: TEST_SESSION_ID,
  });

  assert.strictEqual(result.action, 'reset');
  
  const getResult = await smartSummary({
    action: 'get',
    sessionId: TEST_SESSION_ID,
  });
  
  assert.strictEqual(getResult.found, false);
});

test('smart_summary - reset active session clears active session state', async () => {
  await smartSummary({
    action: 'update',
    sessionId: 'test-reset-active',
    update: { goal: 'Active to reset', status: 'in_progress' },
  });

  assert.strictEqual(await getActiveSessionId(), 'test-reset-active');

  await smartSummary({ action: 'reset', sessionId: 'test-reset-active' });

  assert.strictEqual(await getActiveSessionId(), null);

  const getResult = await smartSummary({ action: 'get' });
  assert.strictEqual(getResult.found, false, 'get without sessionId should return not found after active reset');
});

test('smart_summary - get non-existent session', async () => {
  const result = await smartSummary({
    action: 'get',
    sessionId: 'non-existent-session',
  });

  assert.strictEqual(result.found, false);
  assert.ok(result.message);
});

test('smart_summary - orphaned legacy active.json is ignored automatically', async () => {
  const activeFile = getActiveSessionFile();
  fs.writeFileSync(activeFile, JSON.stringify({
    sessionId: 'missing-session',
    updatedAt: new Date().toISOString(),
  }, null, 2), 'utf8');

  const result = await smartSummary({ action: 'get' });

  assert.strictEqual(result.found, false);
  assert.strictEqual(await getActiveSessionId(), null);
});

test('smart_summary - append without sessionId uses active session', async () => {
  const updateResult = await smartSummary({
    action: 'update',
    sessionId: 'test-active-append',
    update: {
      goal: 'Active session test',
      status: 'in_progress',
      completed: ['initial step'],
    },
  });

  assert.strictEqual(updateResult.sessionId, 'test-active-append');

  const appendResult = await smartSummary({
    action: 'append',
    update: {
      completed: ['appended step'],
      decisions: ['key decision'],
    },
  });

  assert.strictEqual(appendResult.sessionId, 'test-active-append');
  assert.ok(appendResult.summary.recentCompleted.includes('appended step'));
  assert.ok(appendResult.summary.keyDecisions.includes('key decision'));

  await smartSummary({ action: 'reset', sessionId: 'test-active-append' });
});

test('smart_summary - auto_append skips no-op updates', async () => {
  await smartSummary({
    action: 'update',
    sessionId: 'test-auto-append-skip',
    update: {
      goal: 'Auto append skip',
      status: 'in_progress',
      completed: ['initial'],
      nextStep: 'keep going',
    },
  });

  const beforeEvents = await getSessionEventCount('test-auto-append-skip');
  const result = await smartSummary({
    action: 'auto_append',
    sessionId: 'test-auto-append-skip',
    update: {
      completed: ['initial'],
      nextStep: 'keep going',
    },
  });
  const afterEvents = await getSessionEventCount('test-auto-append-skip');

  assert.strictEqual(result.action, 'auto_append');
  assert.strictEqual(result.skipped, true);
  assert.deepStrictEqual(result.changedFields, []);
  assert.strictEqual(afterEvents, beforeEvents);

  await smartSummary({ action: 'reset', sessionId: 'test-auto-append-skip' });
});

test('smart_summary - auto_append persists meaningful changes', async () => {
  await smartSummary({
    action: 'update',
    sessionId: 'test-auto-append-save',
    update: {
      goal: 'Auto append save',
      status: 'in_progress',
      completed: ['initial'],
    },
  });

  const beforeEvents = await getSessionEventCount('test-auto-append-save');
  const result = await smartSummary({
    action: 'auto_append',
    sessionId: 'test-auto-append-save',
    update: {
      completed: ['second'],
      nextStep: 'finish validation',
      touchedFiles: ['src/feature.js'],
    },
  });
  const afterEvents = await getSessionEventCount('test-auto-append-save');

  assert.strictEqual(result.skipped, false);
  assert.ok(result.changedFields.includes('completed'));
  assert.ok(result.changedFields.includes('nextStep'));
  assert.ok(result.summary.recentCompleted.includes('second'));
  assert.strictEqual(afterEvents, beforeEvents + 1);

  await smartSummary({ action: 'reset', sessionId: 'test-auto-append-save' });
});

test('smart_summary - checkpoint persists milestone events with relevant changes', async () => {
  await smartSummary({
    action: 'update',
    sessionId: 'test-checkpoint-milestone',
    update: {
      goal: 'Checkpoint milestone',
      status: 'in_progress',
      completed: ['initial'],
    },
  });

  const beforeEvents = await getSessionEventCount('test-checkpoint-milestone');
  const result = await smartSummary({
    action: 'checkpoint',
    event: 'milestone',
    sessionId: 'test-checkpoint-milestone',
    update: {
      completed: ['milestone reached'],
      touchedFiles: ['src/milestone.js'],
      nextStep: 'run verification',
    },
  });
  const afterEvents = await getSessionEventCount('test-checkpoint-milestone');

  assert.strictEqual(result.skipped, false);
  assert.strictEqual(result.checkpoint.event, 'milestone');
  assert.strictEqual(result.checkpoint.shouldPersist, true);
  assert.ok(result.changedFields.includes('completed'));
  assert.strictEqual(afterEvents, beforeEvents + 1);

  await smartSummary({ action: 'reset', sessionId: 'test-checkpoint-milestone' });
});

test('smart_summary - checkpoint suppresses read_only events', async () => {
  await smartSummary({
    action: 'update',
    sessionId: 'test-checkpoint-read-only',
    update: {
      goal: 'Checkpoint read only',
      status: 'in_progress',
      currentFocus: 'exploration',
    },
  });

  const beforeEvents = await getSessionEventCount('test-checkpoint-read-only');
  const result = await smartSummary({
    action: 'checkpoint',
    event: 'read_only',
    sessionId: 'test-checkpoint-read-only',
    update: {
      currentFocus: 'exploration',
      touchedFiles: ['src/explore.js'],
    },
  });
  const afterEvents = await getSessionEventCount('test-checkpoint-read-only');

  assert.strictEqual(result.skipped, true);
  assert.strictEqual(result.checkpoint.event, 'read_only');
  assert.strictEqual(result.checkpoint.shouldPersist, false);
  assert.match(result.checkpoint.reason, /Read-only exploration/);
  assert.strictEqual(afterEvents, beforeEvents);

  await smartSummary({ action: 'reset', sessionId: 'test-checkpoint-read-only' });
});

test('smart_summary - checkpoint force overrides suppressed events', async () => {
  await smartSummary({
    action: 'update',
    sessionId: 'test-checkpoint-force',
    update: {
      goal: 'Checkpoint force',
      status: 'in_progress',
    },
  });

  const beforeEvents = await getSessionEventCount('test-checkpoint-force');
  const result = await smartSummary({
    action: 'checkpoint',
    event: 'heartbeat',
    force: true,
    sessionId: 'test-checkpoint-force',
    update: {
      nextStep: 'force-save this state',
    },
  });
  const afterEvents = await getSessionEventCount('test-checkpoint-force');

  assert.strictEqual(result.skipped, false);
  assert.strictEqual(result.checkpoint.event, 'heartbeat');
  assert.strictEqual(result.checkpoint.shouldPersist, true);
  assert.match(result.checkpoint.reason, /forced/i);
  assert.strictEqual(afterEvents, beforeEvents + 1);

  await smartSummary({ action: 'reset', sessionId: 'test-checkpoint-force' });
});

test('smart_summary - checkpoint suppresses weak single-file changes', async () => {
  await smartSummary({
    action: 'update',
    sessionId: 'test-checkpoint-file-change-weak',
    update: {
      goal: 'Weak file change',
      status: 'in_progress',
    },
  });

  const beforeEvents = await getSessionEventCount('test-checkpoint-file-change-weak');
  const result = await smartSummary({
    action: 'checkpoint',
    event: 'file_change',
    sessionId: 'test-checkpoint-file-change-weak',
    update: {
      touchedFiles: ['src/only-one.js'],
    },
  });
  const afterEvents = await getSessionEventCount('test-checkpoint-file-change-weak');

  assert.strictEqual(result.skipped, true);
  assert.strictEqual(result.checkpoint.event, 'file_change');
  assert.strictEqual(result.checkpoint.shouldPersist, false);
  assert.match(result.checkpoint.reason, /single touched file/i);
  assert.strictEqual(result.checkpoint.score, 1);
  assert.strictEqual(result.checkpoint.threshold, 3);
  assert.strictEqual(afterEvents, beforeEvents);

  await smartSummary({ action: 'reset', sessionId: 'test-checkpoint-file-change-weak' });
});

test('smart_summary - checkpoint persists strong decision changes with score details', async () => {
  await smartSummary({
    action: 'update',
    sessionId: 'test-checkpoint-decision-strong',
    update: {
      goal: 'Strong decision checkpoint',
      status: 'in_progress',
    },
  });

  const beforeEvents = await getSessionEventCount('test-checkpoint-decision-strong');
  const result = await smartSummary({
    action: 'checkpoint',
    event: 'decision',
    sessionId: 'test-checkpoint-decision-strong',
    update: {
      decisions: ['Use SQLite-backed summaries as the primary context store'],
      pinnedContext: ['Project context must stay inside .devctx/state.sqlite'],
      nextStep: 'wire decision into orchestration rules',
    },
  });
  const afterEvents = await getSessionEventCount('test-checkpoint-decision-strong');

  assert.strictEqual(result.skipped, false);
  assert.strictEqual(result.checkpoint.event, 'decision');
  assert.strictEqual(result.checkpoint.shouldPersist, true);
  assert.ok(result.checkpoint.score >= result.checkpoint.threshold);
  assert.ok(result.checkpoint.scoreByField.decisions >= 4);
  assert.ok(result.checkpoint.scoreByField.pinnedContext >= 4);
  assert.strictEqual(afterEvents, beforeEvents + 1);

  await smartSummary({ action: 'reset', sessionId: 'test-checkpoint-decision-strong' });
});

test('smart_summary - repoSafety warns when state.sqlite is tracked', async () => {
  await smartSummary({
    action: 'update',
    sessionId: 'test-repo-safety',
    update: {
      goal: 'Repo safety',
      status: 'in_progress',
    },
  });

  fs.writeFileSync(path.join(summaryTestRoot, '.gitignore'), '.devctx/\n', 'utf8');
  execFileSync('git', ['add', '-f', '.devctx/state.sqlite'], { cwd: summaryTestRoot, stdio: 'ignore' });

  const result = await smartSummary({
    action: 'get',
    sessionId: 'test-repo-safety',
  });

  assert.strictEqual(result.repoSafety.available, true);
  assert.strictEqual(result.repoSafety.isGitRepo, true);
  assert.strictEqual(result.repoSafety.isTracked, true);
  assert.strictEqual(result.repoSafety.riskLevel, 'warning');
  assert.ok(result.repoSafety.warnings.some((warning) => warning.includes('tracked by git')));

  execFileSync('git', ['rm', '--cached', '-f', '.devctx/state.sqlite'], { cwd: summaryTestRoot, stdio: 'ignore' });
  await smartSummary({ action: 'reset', sessionId: 'test-repo-safety' });
});

test('smart_summary - mutating actions are blocked when state.sqlite is tracked or staged', async () => {
  await smartSummary({
    action: 'update',
    sessionId: 'test-repo-safety-blocked',
    update: {
      goal: 'Repo safety blocked',
      status: 'in_progress',
    },
  });

  fs.writeFileSync(path.join(summaryTestRoot, '.gitignore'), '.devctx/\n', 'utf8');
  execFileSync('git', ['add', '-f', '.devctx/state.sqlite'], { cwd: summaryTestRoot, stdio: 'ignore' });

  const beforeEvents = await getSessionEventCount('test-repo-safety-blocked');
  const blocked = await smartSummary({
    action: 'append',
    sessionId: 'test-repo-safety-blocked',
    update: {
      completed: ['should not persist'],
      nextStep: 'this write should be blocked',
    },
  });
  const afterEvents = await getSessionEventCount('test-repo-safety-blocked');
  const current = await smartSummary({
    action: 'get',
    sessionId: 'test-repo-safety-blocked',
  });

  assert.strictEqual(blocked.blocked, true);
  assert.strictEqual(blocked.mutationBlocked, true);
  assert.deepStrictEqual(blocked.blockedBy, ['tracked', 'staged']);
  assert.match(blocked.message, /tracked and staged/i);
  assert.strictEqual(afterEvents, beforeEvents);
  assert.strictEqual(current.sideEffectsSuppressed, true);
  assert.ok(!current.summary.recentCompleted?.includes('should not persist'));
  assert.ok(!current.summary.nextStep || current.summary.nextStep !== 'this write should be blocked');

  execFileSync('git', ['rm', '--cached', '-f', '.devctx/state.sqlite'], { cwd: summaryTestRoot, stdio: 'ignore' });
  await smartSummary({ action: 'reset', sessionId: 'test-repo-safety-blocked' });
});

test('smart_summary - reset non-active session preserves active.json', async () => {
  await smartSummary({
    action: 'update',
    sessionId: 'test-active-preserved',
    update: { goal: 'Active session', status: 'in_progress' },
  });

  await smartSummary({
    action: 'update',
    sessionId: 'test-old-session',
    update: { goal: 'Old session', status: 'completed' },
  });

  await smartSummary({
    action: 'update',
    sessionId: 'test-active-preserved',
    update: { goal: 'Active session', status: 'in_progress' },
  });

  await smartSummary({ action: 'reset', sessionId: 'test-old-session' });

  const activeResult = await smartSummary({ action: 'get' });
  assert.strictEqual(activeResult.found, true);
  assert.strictEqual(activeResult.sessionId, 'test-active-preserved');

  await smartSummary({ action: 'reset', sessionId: 'test-active-preserved' });
});

test('smart_summary - hard cap maxTokens with long strings', async () => {
  const veryLongGoal = 'A'.repeat(500);
  const veryLongNextStep = 'B'.repeat(500);
  const longBlockers = Array.from({ length: 10 }, (_, i) => 'C'.repeat(200));

  const result = await smartSummary({
    action: 'update',
    sessionId: 'test-hard-cap',
    update: {
      goal: veryLongGoal,
      status: 'blocked',
      nextStep: veryLongNextStep,
      blockers: longBlockers,
      completed: Array.from({ length: 20 }, (_, i) => `step ${i}`.repeat(20)),
      decisions: Array.from({ length: 15 }, (_, i) => `decision ${i}`.repeat(20)),
    },
    maxTokens: 400,
  });

  assert.ok(result.tokens <= 400, `Expected tokens <= 400, got ${result.tokens}`);
  assert.strictEqual(result.truncated, true);

  await smartSummary({ action: 'reset', sessionId: 'test-hard-cap' });
});

test('smart_summary - direct calls reject invalid status', async () => {
  await assert.rejects(
    () => smartSummary({
      action: 'update',
      sessionId: 'test-invalid-status',
      update: {
        goal: 'Invalid status test',
        status: 'totally_invalid',
      },
    }),
    /Invalid status/,
  );
});

test('smart_summary - hard cap with pathological touchedFiles', async () => {
  const longPaths = Array.from({ length: 50 }, (_, i) => 
    `src/very/deep/nested/directory/structure/module${i}/component${i}/subcomponent${i}/file${i}.tsx`
  );

  const result = await smartSummary({
    action: 'update',
    sessionId: 'test-long-paths',
    update: {
      goal: 'Test with many long file paths',
      status: 'in_progress',
      touchedFiles: longPaths,
      completed: Array.from({ length: 10 }, (_, i) => `step ${i}`.repeat(15)),
      decisions: Array.from({ length: 8 }, (_, i) => `decision ${i}`.repeat(15)),
    },
    maxTokens: 350,
  });

  assert.ok(result.tokens <= 350, `Expected tokens <= 350, got ${result.tokens}`);
  assert.strictEqual(result.truncated, true);
  assert.ok((result.summary.hotFiles || []).length <= 5);

  await smartSummary({ action: 'reset', sessionId: 'test-long-paths' });
});

test('smart_summary - extreme compression still respects hard cap', async () => {
  const massiveUpdate = {
    goal: 'X'.repeat(1000),
    status: 'in_progress',
    nextStep: 'Y'.repeat(1000),
    completed: Array.from({ length: 100 }, () => 'Z'.repeat(500)),
    decisions: Array.from({ length: 100 }, () => 'W'.repeat(500)),
    blockers: Array.from({ length: 50 }, () => 'Q'.repeat(500)),
    touchedFiles: Array.from({ length: 200 }, (_, i) => `${'path/'.repeat(20)}file${i}.js`),
  };

  const result = await smartSummary({
    action: 'update',
    sessionId: 'test-extreme',
    update: massiveUpdate,
    maxTokens: 200,
  });

  assert.ok(result.tokens <= 200, `Expected tokens <= 200, got ${result.tokens}`);
  assert.strictEqual(result.truncated, true);

  await smartSummary({ action: 'reset', sessionId: 'test-extreme' });
});

test('smart_summary - hard cap with pathological currentFocus string', async () => {
  const hugeFocus = 'F'.repeat(2000);
  
  const result = await smartSummary({
    action: 'update',
    sessionId: 'test-huge-focus',
    update: {
      goal: 'Test with huge currentFocus',
      status: 'in_progress',
      currentFocus: hugeFocus,
      nextStep: 'continue',
      completed: ['step1', 'step2'],
      decisions: ['decision1'],
      touchedFiles: ['file1.js', 'file2.js'],
    },
    maxTokens: 300,
  });

  assert.ok(result.tokens <= 300, `Expected tokens <= 300, got ${result.tokens}`);
  assert.strictEqual(result.truncated, true);

  await smartSummary({ action: 'reset', sessionId: 'test-huge-focus' });
});

test('smart_summary - all fields pathological still respects cap', async () => {
  const allHuge = {
    goal: 'G'.repeat(2000),
    status: 'blocked',
    nextStep: 'N'.repeat(2000),
    completed: Array.from({ length: 200 }, () => 'C'.repeat(1000)),
    decisions: Array.from({ length: 200 }, () => 'D'.repeat(1000)),
    blockers: Array.from({ length: 100 }, () => 'B'.repeat(1000)),
    touchedFiles: Array.from({ length: 500 }, (_, i) => `${'x/'.repeat(100)}f${i}.js`),
  };

  const result = await smartSummary({
    action: 'update',
    sessionId: 'test-all-huge',
    update: allHuge,
    maxTokens: 150,
  });

  assert.ok(result.tokens <= 150, `Expected tokens <= 150, got ${result.tokens}`);
  assert.strictEqual(result.truncated, true);
  assert.ok(Array.isArray(result.omitted));
  assert.ok(result.compressionLevel === 'reduced' || result.compressionLevel === 'status_only');

  await smartSummary({ action: 'reset', sessionId: 'test-all-huge' });
});

test('smart_summary - blocked sessions preserve whyBlocked and nextStep', async () => {
  const result = await smartSummary({
    action: 'update',
    sessionId: 'test-blocked-context',
    update: {
      goal: 'Ship access-control feature',
      status: 'blocked',
      pinnedContext: ['Security review is mandatory before deploy'],
      unresolvedQuestions: ['Do we need product sign-off too?'],
      currentFocus: 'RBAC wiring',
      whyBlocked: 'Waiting for security review',
      blockers: ['Waiting for security review', 'Missing approval'],
      nextStep: 'Resume once review is approved',
      completed: ['Drafted middleware'],
    },
    maxTokens: 250,
  });

  assert.strictEqual(result.summary.status, 'blocked');
  assert.deepStrictEqual(result.summary.pinnedContext, ['Security review is mandatory before deploy']);
  assert.deepStrictEqual(result.summary.unresolvedQuestions, ['Do we need product sign-off too?']);
  assert.strictEqual(result.summary.currentFocus, 'RBAC wiring');
  assert.strictEqual(result.summary.whyBlocked, 'Waiting for security review');
  assert.strictEqual(result.summary.nextStep, 'Resume once review is approved');

  await smartSummary({ action: 'reset', sessionId: 'test-blocked-context' });
});

test('smart_summary - duplicate append values are deduplicated in resume summary', async () => {
  await smartSummary({
    action: 'update',
    sessionId: 'test-dedup',
    update: {
      goal: 'Dedup session',
      status: 'in_progress',
      completed: ['setup'],
      decisions: ['use jwt'],
      touchedFiles: ['src/auth.js'],
    },
  });

  const result = await smartSummary({
    action: 'append',
    sessionId: 'test-dedup',
    update: {
      completed: ['setup', 'setup'],
      decisions: ['use jwt'],
      touchedFiles: ['src/auth.js', 'src/auth.js'],
    },
  });

  assert.deepStrictEqual(result.summary.recentCompleted, ['setup']);
  assert.deepStrictEqual(result.summary.keyDecisions, ['use jwt']);
  assert.deepStrictEqual(result.summary.hotFiles, ['src/auth.js']);

  await smartSummary({ action: 'reset', sessionId: 'test-dedup' });
});

test('smart_summary - empty fields are omitted from resume summary', async () => {
  const result = await smartSummary({
    action: 'update',
    sessionId: 'test-omit-empty',
    update: {
      goal: 'Minimal state',
      status: 'planning',
      currentFocus: '',
      whyBlocked: '',
      completed: [],
      decisions: [],
      blockers: [],
      nextStep: '',
      touchedFiles: [],
    },
    maxTokens: 150,
  });

  assert.strictEqual(result.summary.status, 'planning');
  assert.strictEqual(result.summary.goal, 'Minimal state');
  assert.ok(!('currentFocus' in result.summary));
  assert.ok(!('whyBlocked' in result.summary));
  assert.ok(!('recentCompleted' in result.summary));
  assert.ok(!('keyDecisions' in result.summary));
  assert.ok(!('hotFiles' in result.summary));
  assert.ok(!('nextStep' in result.summary));

  await smartSummary({ action: 'reset', sessionId: 'test-omit-empty' });
});

test('smart_summary - nextStep survives before goal under tight budget', async () => {
  const result = await smartSummary({
    action: 'update',
    sessionId: 'test-nextstep-priority',
    update: {
      goal: 'Long goal '.repeat(100),
      status: 'in_progress',
      nextStep: 'Run the production migration guardrail check',
      completed: Array.from({ length: 20 }, () => 'completed '.repeat(40)),
      decisions: Array.from({ length: 20 }, () => 'decision '.repeat(40)),
      touchedFiles: Array.from({ length: 20 }, (_, i) => `src/very/long/path/to/file-${i}.ts`),
    },
    maxTokens: 110,
  });

  assert.strictEqual(result.summary.status, 'in_progress');
  assert.ok(result.summary.nextStep, 'nextStep should be present');
  assert.ok(result.summary.nextStep.includes('Run'), 'nextStep should contain core content');

  await smartSummary({ action: 'reset', sessionId: 'test-nextstep-priority' });
});

test('smart_summary - legacy session without schemaVersion still loads', async () => {
  const legacySessionId = 'test-legacy-session';
  const legacyPath = path.join(getSessionsDir(), `${legacySessionId}.json`);
  fs.writeFileSync(legacyPath, JSON.stringify({
    sessionId: legacySessionId,
    goal: 'Legacy session',
    status: 'in_progress',
    completed: ['legacy step'],
    nextStep: 'continue legacy work',
    touchedFiles: ['src/legacy/file.js'],
    updatedAt: new Date().toISOString(),
  }, null, 2), 'utf8');

  const result = await smartSummary({
    action: 'get',
    sessionId: legacySessionId,
  });

  assert.strictEqual(result.found, true);
  assert.strictEqual(result.schemaVersion, 1);
  assert.strictEqual(result.summary.nextStep, 'continue legacy work');
  assert.strictEqual(result.summary.completedCount, 1);
  assert.strictEqual(result.summary.touchedFilesCount, 1);
  assert.ok(result.summary.hotFiles.includes('src/legacy/file.js') || result.summary.hotFiles.includes('.../src/legacy/file.js'));

  await smartSummary({ action: 'reset', sessionId: legacySessionId });
});

test('smart_summary - counts stay available when history is compressed away', async () => {
  const result = await smartSummary({
    action: 'update',
    sessionId: 'test-counts-survive',
    update: {
      goal: 'Count-heavy session',
      status: 'in_progress',
      nextStep: 'Resume after trimming',
      completed: Array.from({ length: 40 }, (_, i) => `completed-${i}`),
      decisions: Array.from({ length: 25 }, (_, i) => `decision-${i}`),
      touchedFiles: Array.from({ length: 60 }, (_, i) => `src/module/file-${i}.ts`),
    },
    maxTokens: 120,
  });

  assert.ok(result.tokens <= 120);
  assert.strictEqual(result.summary.completedCount, 40);
  assert.strictEqual(result.summary.decisionsCount, 25);
  assert.strictEqual(result.summary.touchedFilesCount, 60);

  await smartSummary({ action: 'reset', sessionId: 'test-counts-survive' });
});

test('smart_summary - token-dense pathological strings still respect cap', async () => {
  const denseText = Array.from(
    { length: 400 },
    (_, i) => `token_${i}_alpha_${(i * 17) % 97}_beta_${(i * 31) % 89}`,
  ).join(' ');

  const result = await smartSummary({
    action: 'update',
    sessionId: 'test-token-dense',
    update: {
      goal: denseText,
      status: 'in_progress',
      currentFocus: denseText,
      nextStep: denseText,
      completed: [denseText],
      decisions: [denseText],
      blockers: [denseText],
      touchedFiles: [denseText],
    },
    maxTokens: 100,
  });

  assert.ok(result.tokens <= 100, `Expected tokens <= 100, got ${result.tokens}`);
  assert.strictEqual(result.truncated, true);

  await smartSummary({ action: 'reset', sessionId: 'test-token-dense' });
});

test('smart_summary - stale sessions are auto-deleted on list', async () => {
  const staleSessionId = 'test-stale-session';
  const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();

  await smartSummary({
    action: 'update',
    sessionId: staleSessionId,
    update: {
      goal: 'Stale session',
      status: 'completed',
    },
  });
  await ageSession(staleSessionId, oldDate);
  await clearActiveSession();

  const listResult = await smartSummary({ action: 'list_sessions' });

  assert.ok(!listResult.sessions.some(s => s.sessionId === staleSessionId));
  assert.strictEqual(await sessionExists(staleSessionId), false);
});

test('smart_summary - stale active session is preserved', async () => {
  const staleActiveId = 'test-stale-but-active';
  const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  
  await smartSummary({
    action: 'update',
    sessionId: staleActiveId,
    update: {
      goal: 'Old but active session',
      status: 'in_progress',
    },
  });

  await ageSession(staleActiveId, oldDate);

  await smartSummary({ action: 'list_sessions' });

  assert.strictEqual(await sessionExists(staleActiveId), true, 'Active session should not be deleted even if stale');

  const getResult = await smartSummary({ action: 'get' });
  assert.strictEqual(getResult.found, true);
  assert.strictEqual(getResult.sessionId, staleActiveId);

  await smartSummary({ action: 'reset', sessionId: staleActiveId });
});

test('smart_summary - get auto-resumes a single saved session without active.json', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-summary-auto-single-'));
  const previousRoot = projectRoot;

  try {
    setProjectRoot(tmpRoot);
    await smartSummary({
      action: 'update',
      sessionId: 'auto-single',
      update: {
        goal: 'Resume single session',
        status: 'in_progress',
        nextStep: 'continue work',
      },
    });

    await clearActiveSession();

    const result = await smartSummary({ action: 'get' });
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.sessionId, 'auto-single');
    assert.strictEqual(result.autoResumed, true);
    assert.strictEqual(result.resumeSource, 'latest_only');
  } finally {
    setProjectRoot(previousRoot);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('smart_summary - get returns candidates when multiple recent sessions are ambiguous', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-summary-auto-many-'));
  const previousRoot = projectRoot;

  try {
    setProjectRoot(tmpRoot);
    await smartSummary({
      action: 'update',
      sessionId: 'auto-a',
      update: {
        goal: 'First active task',
        status: 'in_progress',
      },
    });
    await smartSummary({
      action: 'update',
      sessionId: 'auto-b',
      update: {
        goal: 'Second active task',
        status: 'planning',
      },
    });

    await clearActiveSession();

    const result = await smartSummary({ action: 'get' });
    assert.strictEqual(result.found, false);
    assert.strictEqual(result.ambiguous, true);
    assert.ok(Array.isArray(result.candidates));
    assert.ok(result.candidates.length >= 2);
    assert.ok(['auto-a', 'auto-b'].includes(result.recommendedSessionId));
  } finally {
    setProjectRoot(previousRoot);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('smart_summary - get with sessionId auto accepts the recommended session', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-summary-auto-force-'));
  const previousRoot = projectRoot;

  try {
    setProjectRoot(tmpRoot);
    await smartSummary({
      action: 'update',
      sessionId: 'auto-force-a',
      update: {
        goal: 'First candidate',
        status: 'in_progress',
      },
    });
    await smartSummary({
      action: 'update',
      sessionId: 'auto-force-b',
      update: {
        goal: 'Second candidate',
        status: 'planning',
      },
    });

    await clearActiveSession();

    const result = await smartSummary({ action: 'get', sessionId: 'auto' });
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.autoResumed, true);
    assert.strictEqual(result.ambiguous, true);
    assert.strictEqual(result.sessionId, result.recommendedSessionId);
    assert.ok(Array.isArray(result.candidates));
    assert.ok(result.candidates.length >= 2);
  } finally {
    setProjectRoot(previousRoot);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('smart_summary - compact prunes retained events and stale non-active sessions', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-summary-compact-'));
  const previousRoot = projectRoot;

  try {
    setProjectRoot(tmpRoot);
    fs.mkdirSync(getSessionsDir(), { recursive: true });

    await smartSummary({
      action: 'update',
      sessionId: 'compact-active',
      update: { goal: 'Active session', status: 'in_progress' },
    });
    await smartSummary({
      action: 'update',
      sessionId: 'compact-stale',
      update: { goal: 'Stale session', status: 'completed' },
    });
    await smartSummary({
      action: 'append',
      sessionId: 'compact-active',
      update: { completed: ['step-1'] },
    });
    await smartSummary({
      action: 'append',
      sessionId: 'compact-active',
      update: { completed: ['step-2'] },
    });

    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    await ageSession('compact-active', oldDate);
    await ageSession('compact-stale', oldDate);
    await withProjectStateDb((db) => {
      db.prepare('UPDATE session_events SET created_at = ? WHERE session_id = ?').run(oldDate, 'compact-active');
    });

    const result = await smartSummary({
      action: 'compact',
      retentionDays: 30,
      keepLatestEventsPerSession: 1,
      keepLatestMetrics: 1,
    });

    assert.strictEqual(result.sessions.deleted, 1);
    assert.ok(result.sessionEvents.deleted >= 1);

    const snapshot = await withProjectStateDb((db) => ({
      sessions: db.prepare('SELECT session_id FROM sessions ORDER BY session_id').all(),
      active: db.prepare('SELECT session_id FROM active_session WHERE scope = ?').get(ACTIVE_SESSION_SCOPE),
    }));
    assert.deepStrictEqual(
      snapshot.sessions.map((row) => row.session_id),
      ['compact-active'],
    );
    assert.strictEqual(snapshot.active.session_id, 'compact-active');

    await smartSummary({ action: 'reset', sessionId: 'compact-active' });
  } finally {
    setProjectRoot(previousRoot);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('smart_summary - cleanup_legacy supports dry-run and apply for imported files', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-summary-cleanup-legacy-'));
  const previousRoot = projectRoot;
  const legacySessionId = 'cleanup-legacy-session';
  try {
    setProjectRoot(tmpRoot);
    fs.mkdirSync(getSessionsDir(), { recursive: true });

    const legacyPath = path.join(getSessionsDir(), `${legacySessionId}.json`);
    const activeFile = getActiveSessionFile();
    const metricsFile = path.join(projectRoot, '.devctx', 'metrics.jsonl');

    fs.writeFileSync(legacyPath, JSON.stringify({
      sessionId: legacySessionId,
      goal: 'Legacy cleanup',
      status: 'in_progress',
      updatedAt: '2026-03-28T09:00:00.000Z',
    }, null, 2), 'utf8');
    fs.writeFileSync(activeFile, JSON.stringify({
      sessionId: legacySessionId,
      updatedAt: '2026-03-28T09:00:00.000Z',
    }, null, 2), 'utf8');
    fs.writeFileSync(metricsFile, `${JSON.stringify({
      tool: 'smart_read',
      sessionId: legacySessionId,
      rawTokens: 100,
      compressedTokens: 40,
      savedTokens: 60,
      timestamp: '2026-03-28T09:10:00.000Z',
    })}\n`, 'utf8');

    const getResult = await smartSummary({ action: 'get', sessionId: legacySessionId });
    assert.strictEqual(getResult.found, true);

    const dryRun = await smartSummary({ action: 'cleanup_legacy' });
    assert.strictEqual(dryRun.apply, false);
    assert.strictEqual(dryRun.sessions.deletable, 1);
    assert.strictEqual(dryRun.activeSession.eligible, true);
    assert.strictEqual(dryRun.metrics.eligible, true);
    assert.ok(fs.existsSync(legacyPath));
    assert.ok(fs.existsSync(activeFile));
    assert.ok(fs.existsSync(metricsFile));

    const applied = await smartSummary({ action: 'cleanup_legacy', apply: true });
    assert.strictEqual(applied.sessions.deleted, 1);
    assert.strictEqual(applied.activeSession.deleted, true);
    assert.strictEqual(applied.metrics.deleted, true);
    assert.ok(!fs.existsSync(legacyPath));
    assert.ok(!fs.existsSync(activeFile));
    assert.ok(!fs.existsSync(metricsFile));

    await smartSummary({ action: 'reset', sessionId: legacySessionId });
  } finally {
    setProjectRoot(previousRoot);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
