import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { persistMetrics } from '../src/metrics.js';
import { smartMetrics } from '../src/tools/smart-metrics.js';
import { withStateDb } from '../src/storage/sqlite.js';
import { projectRoot, setProjectRoot } from '../src/utils/runtime-config.js';

const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
const SKIP_SQLITE_TESTS = nodeMajor < 22;

test('smart_metrics - aggregates totals for an explicit session filter', { skip: SKIP_SQLITE_TESTS ? 'SQLite support requires Node 22+' : false }, async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-metrics-tool-'));
  const metricsFile = path.join(tmpRoot, '.devctx', 'metrics.jsonl');
  const previousMetricsFile = process.env.DEVCTX_METRICS_FILE;

  try {
    process.env.DEVCTX_METRICS_FILE = metricsFile;
    await persistMetrics({
      tool: 'smart_read',
      target: 'file-a.js',
      sessionId: 'metrics-session',
      rawTokens: 100,
      compressedTokens: 40,
      savedTokens: 60,
      timestamp: '2026-03-28T10:00:00.000Z',
    });
    await persistMetrics({
      tool: 'smart_search',
      target: 'query-b',
      sessionId: 'metrics-session',
      rawTokens: 80,
      compressedTokens: 50,
      savedTokens: 30,
      timestamp: '2026-03-28T11:00:00.000Z',
    });

    const result = await smartMetrics({ window: 'all', latest: 5, sessionId: 'metrics-session' });
    assert.strictEqual(result.filePath, metricsFile);
    assert.strictEqual(result.filters.sessionId, 'metrics-session');
    assert.strictEqual(result.summary.count, 2);
    assert.ok(result.summary.tools.some((entry) => entry.tool === 'smart_read'));
    assert.ok(result.summary.tools.some((entry) => entry.tool === 'smart_search'));
    assert.ok(result.latestEntries.every((entry) => entry.sessionId === 'metrics-session'));
  } finally {
    if (previousMetricsFile === undefined) {
      delete process.env.DEVCTX_METRICS_FILE;
    } else {
      process.env.DEVCTX_METRICS_FILE = previousMetricsFile;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('smart_metrics - supports tool filtering and recent entry ordering', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-metrics-filter-'));
  const metricsFile = path.join(tmpRoot, '.devctx', 'metrics.jsonl');

  try {
    const metricsDir = path.join(tmpRoot, '.devctx');
    fs.mkdirSync(metricsDir, { recursive: true });
    fs.writeFileSync(
      metricsFile,
      [
        { tool: 'smart_read', target: 'a', rawTokens: 50, compressedTokens: 20, savedTokens: 30, timestamp: '2026-03-28T09:00:00.000Z' },
        { tool: 'smart_read', target: 'b', rawTokens: 30, compressedTokens: 10, savedTokens: 20, timestamp: '2026-03-28T12:00:00.000Z' },
        { tool: 'smart_search', target: 'c', rawTokens: 40, compressedTokens: 25, savedTokens: 15, timestamp: '2026-03-28T11:00:00.000Z' },
      ].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
      'utf8',
    );

    const result = await smartMetrics({ file: metricsFile, tool: 'smart_read', window: 'all', latest: 2 });
    assert.strictEqual(result.summary.count, 2);
    assert.strictEqual(result.summary.savedTokens, 50);
    assert.strictEqual(result.latestEntries.length, 2);
    assert.strictEqual(result.latestEntries[0].target, 'b');
    assert.strictEqual(result.latestEntries[1].target, 'a');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('smart_metrics - uses SQLite storage by default when no metrics file override is set', { skip: SKIP_SQLITE_TESTS ? 'SQLite support requires Node 22+' : false }, async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-metrics-sqlite-'));
  const previousProjectRoot = projectRoot;
  const previousMetricsFile = process.env.DEVCTX_METRICS_FILE;

  try {
    setProjectRoot(tmpRoot);
    delete process.env.DEVCTX_METRICS_FILE;

    await persistMetrics({
      tool: 'smart_read',
      target: 'sqlite-a.js',
      sessionId: 'sqlite-session',
      rawTokens: 120,
      compressedTokens: 30,
      savedTokens: 90,
      timestamp: '2026-03-28T13:00:00.000Z',
    });
    await persistMetrics({
      tool: 'smart_summary',
      action: 'get',
      target: 'sqlite-b',
      sessionId: 'sqlite-session',
      rawTokens: 70,
      compressedTokens: 35,
      savedTokens: 35,
      timestamp: '2026-03-28T14:00:00.000Z',
    });

    const result = await smartMetrics({ window: 'all', latest: 5, sessionId: 'sqlite-session' });
    assert.strictEqual(result.source, 'sqlite');
    assert.strictEqual(result.filters.sessionId, 'sqlite-session');
    assert.strictEqual(result.summary.count, 2);
    assert.strictEqual(result.summary.savedTokens, 125);
    assert.ok(result.storagePath.endsWith(path.join('.devctx', 'state.sqlite')));
    assert.ok(result.latestEntries.every((entry) => entry.sessionId === 'sqlite-session'));
  } finally {
    setProjectRoot(previousProjectRoot);
    if (previousMetricsFile === undefined) {
      delete process.env.DEVCTX_METRICS_FILE;
    } else {
      process.env.DEVCTX_METRICS_FILE = previousMetricsFile;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('smart_metrics - suppresses SQLite side effects and global metric writes when state sqlite is tracked or staged', { skip: SKIP_SQLITE_TESTS ? 'SQLite support requires Node 22+' : false }, async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-metrics-blocked-'));
  const previousProjectRoot = projectRoot;
  const previousMetricsFile = process.env.DEVCTX_METRICS_FILE;
  const stateDbPath = path.join(tmpRoot, '.devctx', 'state.sqlite');

  try {
    setProjectRoot(tmpRoot);
    delete process.env.DEVCTX_METRICS_FILE;
    execFileSync('git', ['init'], { cwd: tmpRoot, stdio: 'ignore' });

    await persistMetrics({
      tool: 'smart_read',
      target: 'sqlite-a.js',
      sessionId: 'blocked-session',
      rawTokens: 120,
      compressedTokens: 30,
      savedTokens: 90,
      timestamp: '2026-03-28T13:00:00.000Z',
    });

    const beforeCount = await withStateDb(
      (db) => db.prepare('SELECT COUNT(*) AS count FROM metrics_events').get().count,
      { filePath: stateDbPath, readOnly: true },
    );

    fs.writeFileSync(path.join(tmpRoot, '.gitignore'), '.devctx/\n', 'utf8');
    execFileSync('git', ['add', '-f', '.devctx/state.sqlite'], { cwd: tmpRoot, stdio: 'ignore' });

    await persistMetrics({
      tool: 'smart_search',
      target: 'should-skip',
      sessionId: 'blocked-session',
      rawTokens: 50,
      compressedTokens: 20,
      savedTokens: 30,
      timestamp: '2026-03-28T14:00:00.000Z',
    });

    const afterCount = await withStateDb(
      (db) => db.prepare('SELECT COUNT(*) AS count FROM metrics_events').get().count,
      { filePath: stateDbPath, readOnly: true },
    );

    const result = await smartMetrics({ window: 'all', latest: 5, sessionId: 'blocked-session' });
    assert.strictEqual(afterCount, beforeCount);
    assert.strictEqual(result.sideEffectsSuppressed, true);
    assert.strictEqual(result.repoSafety.isTracked, true);
    assert.strictEqual(result.repoSafety.isStaged, true);
    assert.strictEqual(result.summary.count, 1);
    assert.strictEqual(result.latestEntries.length, 1);
    assert.strictEqual(result.latestEntries[0].tool, 'smart_read');
  } finally {
    setProjectRoot(previousProjectRoot);
    if (previousMetricsFile === undefined) {
      delete process.env.DEVCTX_METRICS_FILE;
    } else {
      process.env.DEVCTX_METRICS_FILE = previousMetricsFile;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('smart_metrics - reports context overhead from hook and wrapper metrics metadata', { skip: SKIP_SQLITE_TESTS ? 'SQLite support requires Node 22+' : false }, async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-metrics-overhead-'));
  const previousProjectRoot = projectRoot;
  const previousMetricsFile = process.env.DEVCTX_METRICS_FILE;

  try {
    setProjectRoot(tmpRoot);
    delete process.env.DEVCTX_METRICS_FILE;

    await persistMetrics({
      tool: 'smart_read',
      target: 'file-a.js',
      sessionId: 'overhead-session',
      rawTokens: 100,
      compressedTokens: 40,
      savedTokens: 60,
      timestamp: '2026-03-28T13:00:00.000Z',
    });
    await persistMetrics({
      tool: 'claude_hook',
      action: 'UserPromptSubmit',
      sessionId: 'overhead-session',
      rawTokens: 0,
      compressedTokens: 0,
      savedTokens: 0,
      metadata: {
        isContextOverhead: true,
        overheadTokens: 18,
      },
      timestamp: '2026-03-28T13:05:00.000Z',
    });
    await persistMetrics({
      tool: 'agent_wrapper',
      action: 'codex:start',
      sessionId: 'overhead-session',
      rawTokens: 0,
      compressedTokens: 0,
      savedTokens: 0,
      metadata: {
        isContextOverhead: true,
        overheadTokens: 12,
      },
      timestamp: '2026-03-28T13:10:00.000Z',
    });

    const result = await smartMetrics({ window: 'all', latest: 5, sessionId: 'overhead-session' });
    assert.strictEqual(result.summary.count, 3);
    assert.strictEqual(result.summary.overheadTokens, 30);
    assert.ok(result.summary.overheadTools.some((entry) => entry.tool === 'claude_hook' && entry.overheadTokens === 18));
    assert.ok(result.summary.overheadTools.some((entry) => entry.tool === 'agent_wrapper' && entry.overheadTokens === 12));
    assert.ok(result.latestEntries.some((entry) => entry.tool === 'claude_hook' && entry.overheadTokens === 18));
  } finally {
    setProjectRoot(previousProjectRoot);
    if (previousMetricsFile === undefined) {
      delete process.env.DEVCTX_METRICS_FILE;
    } else {
      process.env.DEVCTX_METRICS_FILE = previousMetricsFile;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
