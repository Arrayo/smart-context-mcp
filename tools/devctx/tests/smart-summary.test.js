import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { smartSummary } from '../src/tools/smart-summary.js';
import { projectRoot } from '../src/utils/runtime-config.js';

const SESSIONS_DIR = path.join(projectRoot, '.devctx', 'sessions');
const TEST_SESSION_ID = 'test-session-cleanup';

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
  assert.strictEqual(result.schemaVersion, 2);
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
  assert.strictEqual(result.schemaVersion, 2);
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
  
  const sessionPath = path.join(SESSIONS_DIR, `${result.sessionId}.json`);
  if (fs.existsSync(sessionPath)) {
    fs.unlinkSync(sessionPath);
  }
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
  
  const sessionPath = path.join(SESSIONS_DIR, 'test-compression.json');
  if (fs.existsSync(sessionPath)) {
    fs.unlinkSync(sessionPath);
  }
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

test('smart_summary - reset active session clears active.json', async () => {
  await smartSummary({
    action: 'update',
    sessionId: 'test-reset-active',
    update: { goal: 'Active to reset', status: 'in_progress' },
  });

  const activeFile = path.join(projectRoot, '.devctx', 'sessions', 'active.json');
  assert.ok(fs.existsSync(activeFile), 'active.json should exist before reset');

  await smartSummary({ action: 'reset', sessionId: 'test-reset-active' });

  assert.ok(!fs.existsSync(activeFile), 'active.json should be deleted after resetting active session');

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

test('smart_summary - orphaned active.json is cleaned up automatically', async () => {
  const activeFile = path.join(projectRoot, '.devctx', 'sessions', 'active.json');
  fs.writeFileSync(activeFile, JSON.stringify({
    sessionId: 'missing-session',
    updatedAt: new Date().toISOString(),
  }, null, 2), 'utf8');

  const result = await smartSummary({ action: 'get' });

  assert.strictEqual(result.found, false);
  assert.ok(!fs.existsSync(activeFile), 'orphaned active.json should be removed automatically');
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
  const legacyPath = path.join(SESSIONS_DIR, `${legacySessionId}.json`);
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
  const sessionPath = path.join(projectRoot, '.devctx', 'sessions', `${staleSessionId}.json`);
  
  const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(sessionPath, JSON.stringify({
    sessionId: staleSessionId,
    goal: 'Stale session',
    status: 'completed',
    updatedAt: oldDate,
  }), 'utf8');

  const listResult = await smartSummary({ action: 'list_sessions' });

  assert.ok(!listResult.sessions.some(s => s.sessionId === staleSessionId));
  assert.ok(!fs.existsSync(sessionPath));
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

  const sessionPath = path.join(projectRoot, '.devctx', 'sessions', `${staleActiveId}.json`);
  const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  sessionData.updatedAt = oldDate;
  fs.writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2), 'utf8');

  const activeFile = path.join(projectRoot, '.devctx', 'sessions', 'active.json');
  fs.writeFileSync(activeFile, JSON.stringify({ sessionId: staleActiveId, updatedAt: oldDate }, null, 2), 'utf8');

  await smartSummary({ action: 'list_sessions' });

  assert.ok(fs.existsSync(sessionPath), 'Active session should not be deleted even if stale');

  const getResult = await smartSummary({ action: 'get' });
  assert.strictEqual(getResult.found, true);
  assert.strictEqual(getResult.sessionId, staleActiveId);

  await smartSummary({ action: 'reset', sessionId: staleActiveId });
});
