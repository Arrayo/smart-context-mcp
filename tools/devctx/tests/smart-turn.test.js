import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { smartSummary } from '../src/tools/smart-summary.js';
import { smartTurn } from '../src/tools/smart-turn.js';
import { projectRoot, setProjectRoot } from '../src/utils/runtime-config.js';

const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
const SKIP_SQLITE_TESTS = nodeMajor < 22;

if (SKIP_SQLITE_TESTS) {
  test('smart_turn tests require Node 22+', { skip: 'SQLite support requires Node 22+' }, () => {});
  process.exit(0);
}

const originalProjectRoot = projectRoot;
let turnTestRoot = null;

before(() => {
  turnTestRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-turn-suite-'));
  setProjectRoot(turnTestRoot);
  execFileSync('git', ['init'], { cwd: turnTestRoot, stdio: 'ignore' });
});

after(() => {
  setProjectRoot(originalProjectRoot);
  if (turnTestRoot) {
    fs.rmSync(turnTestRoot, { recursive: true, force: true });
  }
});

test('smart_turn start reuses aligned persisted context', async () => {
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
  });

  assert.strictEqual(result.phase, 'start');
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.sessionId, 'turn-aligned');
  assert.strictEqual(result.continuity.state, 'aligned');
  assert.strictEqual(result.continuity.shouldReuseContext, true);
  assert.ok(result.summary.goal.includes('repo safety'));

  await smartSummary({ action: 'reset', sessionId: 'turn-aligned' });
});

test('smart_turn start can auto-create a planning session for a substantial new prompt', async () => {
  const result = await smartTurn({
    phase: 'start',
    prompt: 'Design the final orchestration layer so every meaningful agent turn rehydrates context and checkpoints progress automatically',
    ensureSession: true,
  });

  assert.strictEqual(result.phase, 'start');
  assert.strictEqual(result.autoCreated, true);
  assert.strictEqual(result.found, true);
  assert.ok(typeof result.sessionId === 'string' && result.sessionId.length > 0);
  assert.strictEqual(result.continuity.shouldReuseContext, true);
  assert.ok(result.summary.goal.toLowerCase().includes('orchestration layer'));

  await smartSummary({ action: 'reset', sessionId: result.sessionId });
});

test('smart_turn end checkpoints a meaningful turn update', async () => {
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

  await smartSummary({ action: 'reset', sessionId: 'turn-end' });
});
