import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildWrappedPrompt,
  resolveManagedStart,
  finalizeManagedRun,
  computeContextOverhead,
  buildChildEndUpdate,
  inferChildEndEvent,
  DEFAULT_ORCHESTRATION_EVENT,
} from '../src/orchestration/base-orchestrator.js';
import { smartSummary } from '../src/tools/smart-summary.js';
import { projectRoot, setProjectRoot } from '../src/utils/runtime-config.js';

const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
const SKIP_SQLITE_TESTS = nodeMajor < 22;

const originalProjectRoot = projectRoot;
let testRoot = null;

before(() => {
  if (SKIP_SQLITE_TESTS) return;
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-base-orchestrator-'));
  setProjectRoot(testRoot);
  execFileSync('git', ['init'], { cwd: testRoot, stdio: 'ignore' });
});

after(() => {
  if (SKIP_SQLITE_TESTS) return;
  setProjectRoot(originalProjectRoot);
  if (testRoot) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test('buildWrappedPrompt returns original prompt when no context available', { skip: SKIP_SQLITE_TESTS ? 'SQLite support requires Node 22+' : false }, () => {
  const prompt = 'Test the orchestration layer';
  const startResult = { summary: {} };
  const wrapped = buildWrappedPrompt({ prompt, startResult });
  assert.equal(wrapped, prompt);
});

test('buildWrappedPrompt includes context lines when available', { skip: SKIP_SQLITE_TESTS ? 'SQLite support requires Node 22+' : false }, async () => {
  await smartSummary({
    action: 'update',
    sessionId: 'wrapper-prompt-test',
    update: {
      goal: 'Test wrapper prompt',
      status: 'in_progress',
      currentFocus: 'Implementing base orchestrator',
      nextStep: 'Add unit tests',
    },
  });

  const prompt = 'Continue the task';
  const startResult = {
    found: true,
    sessionId: 'wrapper-prompt-test',
    summary: {
      goal: 'Test wrapper prompt',
      status: 'in_progress',
      currentFocus: 'Implementing base orchestrator',
      nextStep: 'Add unit tests',
    },
    recommendedPath: {
      nextTools: ['smart_read', 'smart_edit'],
    },
    continuity: {
      state: 'aligned',
    },
  };
  const wrapped = buildWrappedPrompt({ prompt, startResult });
  assert.match(wrapped, /persisted devctx project context/i);
  assert.match(wrapped, /User request:/);
  assert.match(wrapped, /Continue the task/);

  await smartSummary({ action: 'reset', sessionId: 'wrapper-prompt-test' });
});

test('resolveManagedStart returns preparedStartResult when provided', { skip: SKIP_SQLITE_TESTS ? 'SQLite support requires Node 22+' : false }, async () => {
  const preparedStart = {
    sessionId: 'test-session',
    isolatedSession: false,
    continuity: { state: 'aligned' },
  };

  const result = await resolveManagedStart({
    prompt: 'Test prompt',
    sessionId: null,
    preparedStartResult: preparedStart,
    ensureSession: false,
    allowIsolation: false,
  });

  assert.equal(result.startResult.sessionId, 'test-session');
  assert.equal(result.isolated, false);
  assert.equal(result.autoStarted, false);
});

test('resolveManagedStart calls smartTurn when no preparedStartResult', { skip: SKIP_SQLITE_TESTS ? 'SQLite support requires Node 22+' : false }, async () => {
  let startTurnCalled = false;
  const mockStartTurn = async () => {
    startTurnCalled = true;
    return {
      sessionId: 'auto-created-session',
      isolatedSession: false,
      continuity: { state: 'aligned' },
    };
  };

  const result = await resolveManagedStart({
    prompt: 'Test auto-start',
    sessionId: null,
    preparedStartResult: null,
    ensureSession: true,
    allowIsolation: false,
    startTurn: mockStartTurn,
  });

  assert.equal(startTurnCalled, true);
  assert.equal(result.autoStarted, true);
  assert.equal(result.startResult.sessionId, 'auto-created-session');
});

test('resolveManagedStart skips smartTurn entirely for simple tasks on fast path', { skip: SKIP_SQLITE_TESTS ? 'SQLite support requires Node 22+' : false }, async () => {
  let startTurnCalled = false;
  const mockStartTurn = async () => {
    startTurnCalled = true;
    return {};
  };

  const result = await resolveManagedStart({
    prompt: 'fix import',
    ensureSession: true,
    allowIsolation: false,
    startTurn: mockStartTurn,
  });

  assert.equal(startTurnCalled, false);
  assert.equal(result.fastPath, true);
  assert.equal(result.startResult.skipSmartTurn, true);
  assert.equal(result.startResult.recommendedPath?.mode, 'simple_task_skip');
});

test('resolveManagedStart isolates session when allowIsolation=true and continuity is unsafe', { skip: SKIP_SQLITE_TESTS ? 'SQLite support requires Node 22+' : false }, async () => {
  await smartSummary({
    action: 'update',
    sessionId: 'existing-session',
    update: {
      goal: 'Previous task',
      status: 'in_progress',
      currentFocus: 'Old focus',
      nextStep: 'Old next step',
    },
  });

  let summaryUpdateCalled = false;
  let isolatedStartCalled = false;

  const mockSummaryTool = async ({ action, update }) => {
    if (action === 'update') {
      summaryUpdateCalled = true;
      assert.match(update.goal, /Test isolation/);
      return { sessionId: 'isolated-session' };
    }
  };

  const mockStartTurn = async ({ sessionId, phase }) => {
    if (phase === 'start') {
      if (sessionId === 'isolated-session') {
        isolatedStartCalled = true;
        return {
          sessionId: 'isolated-session',
          isolatedSession: true,
          previousSessionId: 'existing-session',
          continuity: { state: 'cold_start' },
        };
      }
      return {
        sessionId: 'existing-session',
        isolatedSession: false,
        continuity: { state: 'possible_shift' },
      };
    }
  };

  const result = await resolveManagedStart({
    prompt: 'Test isolation prompt',
    sessionId: null,
    preparedStartResult: null,
    ensureSession: true,
    allowIsolation: true,
    summaryTool: mockSummaryTool,
    startTurn: mockStartTurn,
  });

  assert.equal(summaryUpdateCalled, true);
  assert.equal(isolatedStartCalled, true);
  assert.equal(result.isolated, true);
  assert.equal(result.previousSessionId, 'existing-session');
  assert.equal(result.startResult.sessionId, 'isolated-session');

  await smartSummary({ action: 'reset', sessionId: 'existing-session' });
});

test('computeContextOverhead returns difference in token count', { skip: SKIP_SQLITE_TESTS ? 'SQLite support requires Node 22+' : false }, () => {
  const prompt = 'Short prompt';
  const wrappedPrompt = 'Short prompt\n\nAdditional context lines here\nMore context\nEven more context';
  const overhead = computeContextOverhead({ prompt, wrappedPrompt });
  assert.ok(overhead > 0);
  assert.ok(overhead < 100);
});

test('buildChildEndUpdate extracts next step from child output', { skip: SKIP_SQLITE_TESTS ? 'SQLite support requires Node 22+' : false }, () => {
  const prompt = 'Run the command';
  const childResult = {
    exitCode: 0,
    stdout: 'Command completed. Next step: validate the output and checkpoint.',
    stderr: '',
  };

  const update = buildChildEndUpdate({ prompt, childResult });
  assert.match(update.nextStep, /validate the output/i);
  assert.match(update.currentFocus, /Run the command/);
});

test('buildChildEndUpdate sets blocked status on non-zero exit', { skip: SKIP_SQLITE_TESTS ? 'SQLite support requires Node 22+' : false }, () => {
  const prompt = 'Run failing command';
  const childResult = {
    exitCode: 1,
    stdout: '',
    stderr: 'Error: command failed',
  };

  const update = buildChildEndUpdate({ prompt, childResult });
  assert.equal(update.status, 'blocked');
  assert.match(update.whyBlocked, /exited with code 1/);
  assert.match(update.nextStep, /Review the headless agent stderr/);
});

test('inferChildEndEvent returns success event on exitCode 0', { skip: SKIP_SQLITE_TESTS ? 'SQLite support requires Node 22+' : false }, () => {
  const event = inferChildEndEvent({
    requestedEvent: null,
    childResult: { exitCode: 0 },
    successEvent: 'milestone',
  });
  assert.equal(event, 'milestone');
});

test('inferChildEndEvent returns blocker event on non-zero exit', { skip: SKIP_SQLITE_TESTS ? 'SQLite support requires Node 22+' : false }, () => {
  const event = inferChildEndEvent({
    requestedEvent: null,
    childResult: { exitCode: 1 },
    successEvent: 'milestone',
  });
  assert.equal(event, 'blocker');
});

test('inferChildEndEvent respects requestedEvent override', { skip: SKIP_SQLITE_TESTS ? 'SQLite support requires Node 22+' : false }, () => {
  const event = inferChildEndEvent({
    requestedEvent: 'custom_event',
    childResult: { exitCode: 0 },
    successEvent: 'milestone',
  });
  assert.equal(event, 'custom_event');
});

test('finalizeManagedRun checkpoints with inferred event', { skip: SKIP_SQLITE_TESTS ? 'SQLite support requires Node 22+' : false }, async () => {
  await smartSummary({
    action: 'update',
    sessionId: 'finalize-test-session',
    update: {
      goal: 'Test finalization',
      status: 'in_progress',
      currentFocus: 'Running finalize test',
      nextStep: 'Validate checkpoint',
    },
  });

  let endTurnCalled = false;
  const mockEndTurn = async ({ phase, event, update }) => {
    endTurnCalled = true;
    assert.equal(phase, 'end');
    assert.equal(event, 'milestone');
    assert.match(update.nextStep, /validate the finalize output/i);
    return {
      phase: 'end',
      checkpoint: { skipped: false, event: 'milestone' },
    };
  };

  const result = await finalizeManagedRun({
    prompt: 'Test finalize',
    childResult: {
      exitCode: 0,
      stdout: 'Next step: validate the finalize output',
      stderr: '',
    },
    sessionId: 'finalize-test-session',
    requestedEvent: 'milestone',
    endTurn: mockEndTurn,
  });

  assert.equal(endTurnCalled, true);
  assert.equal(result.resolvedEvent, 'milestone');
  assert.equal(result.endResult.checkpoint.event, 'milestone');

  await smartSummary({ action: 'reset', sessionId: 'finalize-test-session' });
});
