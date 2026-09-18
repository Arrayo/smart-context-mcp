import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyLine,
  excerptOutput,
  summarizeOutput,
  truncateForStorage,
} from '../src/outputs/summarize.js';
import {
  captureOutput,
  getOutputPolicy,
  inferKindFromCommand,
  resetPruneThrottle,
} from '../src/outputs/store.js';
import { smartOutput } from '../src/tools/smart-output.js';

const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
const SKIP_SQLITE_TESTS = nodeMajor < 22 ? 'SQLite support requires Node 22+' : false;

describe('output summarize helpers', () => {
  it('classifies error, warning, stack and info lines', () => {
    assert.equal(classifyLine('not ok 3 - should pass'), 'error');
    assert.equal(classifyLine('AssertionError [ERR_ASSERTION]: failed'), 'error');
    assert.equal(classifyLine('TypeError: x is not a function'), 'error');
    assert.equal(classifyLine('npm warn deprecated foo@1.0.0'), 'warning');
    assert.equal(classifyLine('    at Module._compile (node:internal/x:1:2)'), 'stack');
    assert.equal(classifyLine('building bundle'), 'info');
  });

  it('summarizes counts, error lines, head and tail', () => {
    const content = [
      'start build',
      'compiling',
      'npm warn deprecated left-pad',
      'TypeError: boom',
      '    at run (file.js:1:1)',
      'done',
    ].join('\n');

    const summary = summarizeOutput(content, { headLines: 2, tailLines: 2 });

    assert.equal(summary.counts.total, 6);
    assert.equal(summary.counts.errors, 1);
    assert.equal(summary.counts.warnings, 1);
    assert.equal(summary.counts.stackFrames, 1);
    assert.deepEqual(summary.errorLines, [{ line: 4, text: 'TypeError: boom' }]);
    assert.equal(summary.head.length, 2);
    assert.equal(summary.head[0].line, 1);
    assert.equal(summary.tail.at(-1).line, 6);
  });

  it('excerpts around a query and merges overlapping windows', () => {
    const content = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n');

    const byQuery = excerptOutput(content, { query: 'line 15', before: 2, after: 2 });
    assert.equal(byQuery.length, 1);
    assert.equal(byQuery[0].startLine, 13);
    assert.equal(byQuery[0].endLine, 17);
    assert.equal(byQuery[0].lines[0].text, 'line 13');

    const byLine = excerptOutput(content, { line: 5, before: 1, after: 1 });
    assert.equal(byLine[0].startLine, 4);
    assert.equal(byLine[0].endLine, 6);

    const merged = excerptOutput('err a\nb\nc\nerr d', { query: 'err', before: 2, after: 2 });
    assert.equal(merged.length, 1, 'overlapping windows should merge into one');
  });

  it('falls back to the first error line when no selector is given', () => {
    const windows = excerptOutput('ok\nok\nError: nope\nok', { before: 1, after: 1 });
    assert.equal(windows[0].startLine, 2);
    assert.equal(windows[0].endLine, 4);
  });

  it('truncates by keeping head and tail with an explicit marker', () => {
    const content = Array.from({ length: 500 }, (_, index) => `line ${index + 1}`).join('\n');
    const full = truncateForStorage(content, 1024 * 1024);
    assert.equal(full.truncated, false);
    assert.equal(full.content, content);

    const cut = truncateForStorage(content, 500);
    assert.equal(cut.truncated, true);
    assert.ok(cut.bytes <= 500 + 80, 'truncated payload stays near the byte budget');
    assert.match(cut.content, /devctx truncated \d+ line\(s\); tail preserved/);
    assert.match(cut.content, /^line 1\n/, 'head is preserved');
    assert.match(cut.content, /line 500$/, 'failing tail is preserved');
  });
});

describe('output kind inference and policy', () => {
  it('infers kind from the command', () => {
    assert.equal(inferKindFromCommand('npm test -- tests/a.test.js'), 'test');
    assert.equal(inferKindFromCommand('npx eslint src'), 'lint');
    assert.equal(inferKindFromCommand('npm run build'), 'build');
    assert.equal(inferKindFromCommand('git diff --stat'), 'diff');
    assert.equal(inferKindFromCommand('git status'), 'shell');
  });

  it('exposes retention, size and privacy policy defaults', () => {
    const policy = getOutputPolicy();
    assert.equal(policy.maxBytesPerOutput, 256 * 1024);
    assert.equal(policy.retentionDays, 14);
    assert.equal(policy.maxPerKind, 50);
    assert.equal(policy.scrubbed, true);
    assert.deepEqual(policy.kinds, ['shell', 'test', 'build', 'lint', 'diff']);
  });

  it('keeps automatic capture opt-in', async () => {
    const original = process.env.DEVCTX_OUTPUT_STORE;
    delete process.env.DEVCTX_OUTPUT_STORE;

    const result = await captureOutput({ kind: 'shell', content: 'hello' });
    assert.equal(result.saved, false);
    assert.match(result.reason, /DEVCTX_OUTPUT_STORE=true/);

    if (original !== undefined) process.env.DEVCTX_OUTPUT_STORE = original;
  });
});

describe('smart_output validation', () => {
  it('rejects unknown actions, kinds and statuses', async () => {
    const badAction = await smartOutput({ action: 'nope' });
    assert.equal(badAction.success, false);
    assert.match(badAction.error, /Invalid action/);

    const badKind = await smartOutput({ action: 'list', kind: 'screenshot' });
    assert.equal(badKind.success, false);
    assert.match(badKind.error, /Invalid kind/);

    const badStatus = await smartOutput({ action: 'list', status: 'flaky' });
    assert.equal(badStatus.success, false);
    assert.match(badStatus.error, /Invalid status/);
  });

  it('requires an id for excerpt and summary', async () => {
    const excerpt = await smartOutput({ action: 'excerpt' });
    assert.equal(excerpt.success, false);
    assert.match(excerpt.error, /numeric id/);

    const summary = await smartOutput({ action: 'summary' });
    assert.equal(summary.success, false);
    assert.match(summary.error, /numeric id/);
  });
});

describe('smart_output store lifecycle', { skip: SKIP_SQLITE_TESTS }, () => {
  let tempDir;
  let originalDbPath;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-outputs-'));
    originalDbPath = process.env.DEVCTX_STATE_DB_PATH;
    process.env.DEVCTX_STATE_DB_PATH = path.join(tempDir, 'state.sqlite');
  });

  after(() => {
    if (originalDbPath !== undefined) {
      process.env.DEVCTX_STATE_DB_PATH = originalDbPath;
    } else {
      delete process.env.DEVCTX_STATE_DB_PATH;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetPruneThrottle();
  });

  const failingOutput = [
    'running 3 tests',
    'ok 1 - alpha',
    'not ok 2 - beta',
    '  AssertionError: expected 1 to equal 2',
    '    at Test.run (/tmp/beta.test.js:10:5)',
    'ok 3 - gamma',
  ].join('\n');

  it('saves, searches, excerpts and summarizes an output', async () => {
    const saved = await smartOutput({
      action: 'save',
      kind: 'test',
      command: 'npm test -- beta',
      label: 'beta suite',
      exitCode: 1,
      content: failingOutput,
    });

    assert.equal(saved.success, true);
    assert.equal(saved.entry.kind, 'test');
    assert.equal(saved.entry.status, 'fail');
    assert.equal(saved.entry.lines, 6);
    assert.equal(saved.truncated, false);
    assert.ok(Number.isInteger(saved.entry.id));

    const found = await smartOutput({ action: 'search', query: 'AssertionError', kind: 'test' });
    assert.equal(found.success, true);
    assert.equal(found.total, 1);
    assert.equal(found.results[0].content, undefined, 'search must not return full bodies');
    assert.equal(found.results[0].matches.length, 1);
    assert.match(found.results[0].matches[0].text, /AssertionError/);

    const excerpt = await smartOutput({
      action: 'excerpt',
      id: saved.entry.id,
      query: 'not ok 2',
      before: 1,
      after: 2,
    });
    assert.equal(excerpt.success, true);
    assert.equal(excerpt.windows[0].startLine, 2);
    assert.equal(excerpt.windows[0].endLine, 5);

    const summary = await smartOutput({ action: 'summary', id: saved.entry.id });
    assert.equal(summary.success, true);
    assert.ok(summary.summary.counts.errors >= 2);
    assert.equal(summary.summary.counts.stackFrames, 1);
    assert.match(summary.hint, /excerpt/);
  });

  it('dedupes identical output into repeat_count instead of new rows', async () => {
    const first = await smartOutput({
      action: 'save', kind: 'build', command: 'npm run build', exitCode: 0, content: 'build ok',
    });
    const second = await smartOutput({
      action: 'save', kind: 'build', command: 'npm run build', exitCode: 0, content: 'build ok',
    });

    assert.equal(first.entry.id, second.entry.id);
    assert.equal(second.entry.repeatCount, first.entry.repeatCount + 1);

    const listed = await smartOutput({ action: 'list', kind: 'build' });
    assert.equal(listed.total, 1);
  });

  it('scrubs likely secrets before persisting', async () => {
    const saved = await smartOutput({
      action: 'save',
      kind: 'shell',
      command: 'printenv',
      content: 'api_key: "sk-abcdefghijklmnopqrstuvwxyz123456"\ndeploying',
    });

    assert.equal(saved.scrubbed, true);

    const summary = await smartOutput({ action: 'summary', id: saved.entry.id });
    const text = JSON.stringify(summary);
    assert.doesNotMatch(text, /sk-abcdefghijklmnopqrstuvwxyz/);
    assert.match(text, /REDACTED/);
  });

  it('reports stats and enforces retention on prune', async () => {
    const stats = await smartOutput({ action: 'stats' });
    assert.equal(stats.success, true);
    assert.ok(stats.stats.entries >= 2);
    assert.ok(stats.stats.byKind.some((item) => item.kind === 'build'));
    assert.equal(stats.policy.retentionDays, 14);

    const pruned = await smartOutput({ action: 'prune' });
    assert.equal(pruned.success, true);
    assert.equal(typeof pruned.pruned.removed, 'number');
  });

  it('caps stored entries per kind', async () => {
    const original = process.env.DEVCTX_OUTPUT_MAX_PER_KIND;
    process.env.DEVCTX_OUTPUT_MAX_PER_KIND = '3';

    for (let index = 0; index < 5; index += 1) {
      resetPruneThrottle();
      await smartOutput({
        action: 'save', kind: 'lint', command: `eslint run ${index}`, exitCode: 0, content: `lint pass ${index}`,
      });
    }

    const listed = await smartOutput({ action: 'list', kind: 'lint', limit: 50 });
    assert.ok(listed.total <= 3, `expected at most 3 lint entries, got ${listed.total}`);

    if (original !== undefined) {
      process.env.DEVCTX_OUTPUT_MAX_PER_KIND = original;
    } else {
      delete process.env.DEVCTX_OUTPUT_MAX_PER_KIND;
    }
  });

  it('truncates oversized output while keeping the failing tail', async () => {
    const original = process.env.DEVCTX_OUTPUT_MAX_BYTES;
    process.env.DEVCTX_OUTPUT_MAX_BYTES = '400';

    const huge = [
      ...Array.from({ length: 200 }, (_, index) => `noise line ${index}`),
      'Error: the real failure',
    ].join('\n');

    const saved = await smartOutput({ action: 'save', kind: 'shell', command: 'noisy', content: huge });
    assert.equal(saved.truncated, true);
    assert.equal(saved.entry.truncated, true);

    const summary = await smartOutput({ action: 'summary', id: saved.entry.id });
    const errorTexts = summary.summary.errorLines.map((item) => item.text).join('\n');
    assert.match(errorTexts, /the real failure/);

    if (original !== undefined) {
      process.env.DEVCTX_OUTPUT_MAX_BYTES = original;
    } else {
      delete process.env.DEVCTX_OUTPUT_MAX_BYTES;
    }
  });

  it('returns a not-found error for unknown ids', async () => {
    const missing = await smartOutput({ action: 'excerpt', id: 999999 });
    assert.equal(missing.success, false);
    assert.match(missing.error, /No output found/);
  });
});
