import { test } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  cleanupLegacyState,
  compactState,
  EXPECTED_TABLES,
  getMeta,
  initializeStateDb,
  importLegacyState,
  SQLITE_SCHEMA_VERSION,
  withStateDb,
} from '../src/storage/sqlite.js';

const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
const SKIP_SQLITE_TESTS = nodeMajor < 22;

if (SKIP_SQLITE_TESTS) {
  test('sqlite-storage tests require Node 22+', { skip: 'SQLite support requires Node 22+' }, () => {});
  process.exit(0);
}

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('sqlite storage - initializes state.sqlite under .devctx with expected schema', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-sqlite-init-'));
  const filePath = path.join(tmpRoot, '.devctx', 'state.sqlite');

  try {
    const info = await initializeStateDb({ filePath });

    assert.strictEqual(info.filePath, filePath);
    assert.ok(fs.existsSync(info.filePath), 'state.sqlite should be created');
    assert.strictEqual(info.schemaVersion, SQLITE_SCHEMA_VERSION);
    assert.deepStrictEqual(info.tables, EXPECTED_TABLES);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('sqlite storage - migrations are idempotent and persist metadata', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-sqlite-idempotent-'));
  const filePath = path.join(tmpRoot, '.devctx', 'state.sqlite');

  try {
    const first = await initializeStateDb({ filePath });
    const second = await initializeStateDb({ filePath });

    assert.strictEqual(second.schemaVersion, first.schemaVersion);
    assert.deepStrictEqual(second.tables, first.tables);

    const projectRootMeta = await withStateDb((db) => getMeta(db, 'project_root'), { filePath });
    const schemaVersionMeta = await withStateDb((db) => getMeta(db, 'schema_version'), { filePath });

    assert.ok(projectRootMeta);
    assert.strictEqual(schemaVersionMeta, String(SQLITE_SCHEMA_VERSION));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('sqlite storage - imports legacy sessions, metrics, and active session idempotently', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-sqlite-import-'));
  const sessionsDir = path.join(tmpRoot, '.devctx', 'sessions');
  const metricsFile = path.join(tmpRoot, '.devctx', 'metrics.jsonl');
  const activeSessionFile = path.join(sessionsDir, 'active.json');
  const filePath = path.join(tmpRoot, '.devctx', 'state.sqlite');

  try {
    const runnerFile = path.join(tmpRoot, 'import-legacy-state.mjs');
    const resultFile = path.join(tmpRoot, 'legacy-import-result.json');
    const script = `
      import fs from 'node:fs';
      import path from 'node:path';
      import { getMeta, importLegacyState, withStateDb } from '${path.resolve(__dirname, '..', 'src', 'storage', 'sqlite.js').replace(/\\/g, '\\\\')}';

      const sessionsDir = ${JSON.stringify(sessionsDir)};
      const metricsFile = ${JSON.stringify(metricsFile)};
      const activeSessionFile = ${JSON.stringify(activeSessionFile)};
      const filePath = ${JSON.stringify(filePath)};
      const resultFile = ${JSON.stringify(resultFile)};

      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(path.join(sessionsDir, 'sess-a.json'), JSON.stringify({
        sessionId: 'sess-a',
        goal: 'Legacy A',
        status: 'in_progress',
        completed: ['setup'],
        decisions: ['use redis'],
        touchedFiles: ['src/a.js'],
        updatedAt: '2026-03-28T09:00:00.000Z',
      }, null, 2), 'utf8');
      fs.writeFileSync(path.join(sessionsDir, 'sess-b.json'), JSON.stringify({
        sessionId: 'sess-b',
        goal: 'Legacy B',
        status: 'blocked',
        blockers: ['approval pending'],
        nextStep: 'wait for approval',
        updatedAt: '2026-03-28T09:05:00.000Z',
      }, null, 2), 'utf8');
      fs.writeFileSync(activeSessionFile, JSON.stringify({
        sessionId: 'sess-b',
        updatedAt: '2026-03-28T09:05:00.000Z',
      }, null, 2), 'utf8');
      fs.writeFileSync(metricsFile, [
        JSON.stringify({ tool: 'smart_read', target: 'src/a.js', sessionId: 'sess-a', rawTokens: 100, compressedTokens: 40, savedTokens: 60, timestamp: '2026-03-28T09:10:00.000Z' }),
        JSON.stringify({ tool: 'smart_summary', action: 'get', sessionId: 'sess-b', rawTokens: 80, finalTokens: 50, timestamp: '2026-03-28T09:11:00.000Z' }),
      ].join('\\n') + '\\n', 'utf8');

      const first = await importLegacyState({ filePath, sessionsDir, metricsFile, activeSessionFile });
      const second = await importLegacyState({ filePath, sessionsDir, metricsFile, activeSessionFile });
      const snapshot = await withStateDb((db) => ({
        sessions: db.prepare('SELECT session_id, goal, status, completed_count, decisions_count, touched_files_count FROM sessions ORDER BY session_id').all(),
        metrics: db.prepare('SELECT tool, session_id, target, raw_tokens, compressed_tokens, saved_tokens FROM metrics_events ORDER BY metric_id').all(),
        active: db.prepare('SELECT scope, session_id FROM active_session').all(),
        sessionEvents: db.prepare('SELECT event_type, legacy_key FROM session_events ORDER BY event_id').all(),
        legacySessionCount: getMeta(db, 'legacy_sessions_import_count'),
        legacyMetricsCount: getMeta(db, 'legacy_metrics_import_count'),
      }), { filePath });

      fs.writeFileSync(resultFile, JSON.stringify({ first, second, snapshot }), 'utf8');
    `;

    fs.writeFileSync(runnerFile, script, 'utf8');

    const { stderr } = await execFileAsync(process.execPath, [runnerFile], {
      cwd: path.resolve('.'),
    });
    const output = fs.readFileSync(resultFile, 'utf8');
    assert.ok(output.trim().length > 0, stderr || 'legacy import runner should emit JSON output');
    const { first, second, snapshot } = JSON.parse(output.trim());

    assert.deepStrictEqual(first.sessions, { imported: 2, skipped: 0, invalid: 0 });
    assert.deepStrictEqual(first.metrics, { imported: 2, skipped: 0, invalid: 0 });
    assert.deepStrictEqual(first.activeSession, { imported: true, sessionId: 'sess-b' });
    assert.deepStrictEqual(second.sessions, { imported: 0, skipped: 2, invalid: 0 });
    assert.deepStrictEqual(second.metrics, { imported: 0, skipped: 2, invalid: 0 });
    assert.deepStrictEqual(snapshot.sessions, [
      { session_id: 'sess-a', goal: 'Legacy A', status: 'in_progress', completed_count: 1, decisions_count: 1, touched_files_count: 1 },
      { session_id: 'sess-b', goal: 'Legacy B', status: 'blocked', completed_count: 0, decisions_count: 0, touched_files_count: 0 },
    ]);
    assert.deepStrictEqual(snapshot.metrics, [
      { tool: 'smart_read', session_id: 'sess-a', target: 'src/a.js', raw_tokens: 100, compressed_tokens: 40, saved_tokens: 60 },
      { tool: 'smart_summary', session_id: 'sess-b', target: null, raw_tokens: 80, compressed_tokens: 50, saved_tokens: 30 },
    ]);
    assert.deepStrictEqual(snapshot.active, [{ scope: 'project', session_id: 'sess-b' }]);
    assert.deepStrictEqual(snapshot.sessionEvents, [
      { event_type: 'legacy_import', legacy_key: 'session:sess-a' },
      { event_type: 'legacy_import', legacy_key: 'session:sess-b' },
    ]);
    assert.strictEqual(snapshot.legacySessionCount, '2');
    assert.strictEqual(snapshot.legacyMetricsCount, '2');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('sqlite storage - compactState prunes stale sessions and old events while preserving active session', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-sqlite-compact-'));
  const filePath = path.join(tmpRoot, '.devctx', 'state.sqlite');
  const cutoffOld = '2026-01-01T00:00:00.000Z';
  const cutoffNew = '2026-03-28T10:00:00.000Z';

  try {
    await initializeStateDb({ filePath });
    await withStateDb((db) => {
      db.prepare(`
        INSERT INTO sessions(
          session_id, goal, status, current_focus, why_blocked, next_step,
          pinned_context_json, unresolved_questions_json, blockers_json, snapshot_json,
          completed_count, decisions_count, touched_files_count, created_at, updated_at
        ) VALUES(?, ?, ?, '', '', '', '[]', '[]', '[]', ?, 0, 0, 0, ?, ?)
      `).run(
        'stale-inactive',
        'Stale inactive',
        'completed',
        JSON.stringify({ goal: 'Stale inactive', status: 'completed', updatedAt: cutoffOld }),
        cutoffOld,
        cutoffOld,
      );
      db.prepare(`
        INSERT INTO sessions(
          session_id, goal, status, current_focus, why_blocked, next_step,
          pinned_context_json, unresolved_questions_json, blockers_json, snapshot_json,
          completed_count, decisions_count, touched_files_count, created_at, updated_at
        ) VALUES(?, ?, ?, '', '', '', '[]', '[]', '[]', ?, 0, 0, 0, ?, ?)
      `).run(
        'stale-active',
        'Stale active',
        'in_progress',
        JSON.stringify({ goal: 'Stale active', status: 'in_progress', updatedAt: cutoffOld }),
        cutoffOld,
        cutoffOld,
      );
      db.prepare(`
        INSERT INTO sessions(
          session_id, goal, status, current_focus, why_blocked, next_step,
          pinned_context_json, unresolved_questions_json, blockers_json, snapshot_json,
          completed_count, decisions_count, touched_files_count, created_at, updated_at
        ) VALUES(?, ?, ?, '', '', '', '[]', '[]', '[]', ?, 0, 0, 0, ?, ?)
      `).run(
        'event-session',
        'Event session',
        'in_progress',
        JSON.stringify({ goal: 'Event session', status: 'in_progress', updatedAt: cutoffNew }),
        cutoffOld,
        cutoffNew,
      );

      db.prepare(`
        INSERT INTO active_session(scope, session_id, updated_at)
        VALUES('project', 'stale-active', ?)
      `).run(cutoffOld);

      for (const createdAt of [cutoffOld, '2026-01-02T00:00:00.000Z', '2026-01-03T00:00:00.000Z']) {
        db.prepare(`
          INSERT INTO session_events(session_id, event_type, payload_json, token_cost, created_at)
          VALUES('event-session', 'append', '{}', 0, ?)
        `).run(createdAt);
      }
      for (const createdAt of [cutoffOld, '2026-01-02T00:00:00.000Z', '2026-01-03T00:00:00.000Z']) {
        db.prepare(`
          INSERT INTO metrics_events(
            tool, action, session_id, target, raw_tokens, compressed_tokens, saved_tokens,
            savings_pct, latency_ms, metadata_json, created_at, legacy_key
          ) VALUES('smart_read', 'range', 'event-session', 'file.js', 100, 50, 50, 50, 10, '{}', ?, NULL)
        `).run(createdAt);
      }
      db.prepare(`
        INSERT INTO hook_turn_state(
          hook_key, client, claude_session_id, project_session_id, turn_id, prompt_preview,
          continuity_state, require_checkpoint, prompt_meaningful, checkpointed, checkpoint_event,
          touched_files_json, meaningful_write_count, started_at, updated_at
        ) VALUES
          ('hook-fresh', 'claude', 'claude-fresh', 'event-session', 'turn-fresh', 'fresh prompt', 'aligned', 1, 1, 0, NULL, '[]', 1, ?, ?),
          ('hook-stale', 'claude', 'claude-stale', 'stale-active', 'turn-stale', 'stale prompt', 'aligned', 1, 1, 0, NULL, '[]', 1, ?, ?)
      `).run(cutoffNew, cutoffNew, cutoffOld, cutoffOld);
    }, { filePath });

    const report = await compactState({
      filePath,
      retentionDays: 30,
      keepLatestEventsPerSession: 1,
      keepLatestMetrics: 1,
    });

    assert.strictEqual(report.sessions.deleted, 1);
    assert.strictEqual(report.sessionEvents.deleted, 2);
    assert.strictEqual(report.metricsEvents.deleted, 2);
    assert.strictEqual(report.hookTurnState.deleted, 1);
    assert.strictEqual(report.sessions.after, 2);

    const snapshot = await withStateDb((db) => ({
      sessions: db.prepare('SELECT session_id FROM sessions ORDER BY session_id').all(),
      active: db.prepare('SELECT session_id FROM active_session WHERE scope = ?').get('project'),
      sessionEvents: db.prepare('SELECT COUNT(*) AS count FROM session_events WHERE session_id = ?').get('event-session').count,
      metrics: db.prepare('SELECT COUNT(*) AS count FROM metrics_events').get().count,
      hookTurnKeys: db.prepare('SELECT hook_key FROM hook_turn_state ORDER BY hook_key').all(),
      compactedAt: getMeta(db, 'state_compacted_at'),
    }), { filePath });

    assert.deepStrictEqual(
      snapshot.sessions.map((row) => row.session_id),
      ['event-session', 'stale-active'],
    );
    assert.strictEqual(snapshot.active.session_id, 'stale-active');
    assert.strictEqual(snapshot.sessionEvents, 1);
    assert.strictEqual(snapshot.metrics, 1);
    assert.deepStrictEqual(snapshot.hookTurnKeys.map((row) => row.hook_key), ['hook-fresh']);
    assert.ok(snapshot.compactedAt);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('sqlite storage - cleanupLegacyState deletes only imported legacy artifacts when apply=true', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-sqlite-cleanup-'));
  const sessionsDir = path.join(tmpRoot, '.devctx', 'sessions');
  const metricsFile = path.join(tmpRoot, '.devctx', 'metrics.jsonl');
  const activeSessionFile = path.join(sessionsDir, 'active.json');
  const filePath = path.join(tmpRoot, '.devctx', 'state.sqlite');

  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'legacy-a.json'), JSON.stringify({
      sessionId: 'legacy-a',
      goal: 'Legacy A',
      status: 'in_progress',
      updatedAt: '2026-03-28T09:00:00.000Z',
    }, null, 2), 'utf8');
    fs.writeFileSync(activeSessionFile, JSON.stringify({
      sessionId: 'legacy-a',
      updatedAt: '2026-03-28T09:00:00.000Z',
    }, null, 2), 'utf8');
    fs.writeFileSync(metricsFile, `${JSON.stringify({
      tool: 'smart_read',
      sessionId: 'legacy-a',
      rawTokens: 100,
      compressedTokens: 40,
      savedTokens: 60,
      timestamp: '2026-03-28T09:10:00.000Z',
    })}\n`, 'utf8');

    await importLegacyState({ filePath, sessionsDir, metricsFile, activeSessionFile });

    const dryRun = await cleanupLegacyState({ filePath, sessionsDir, metricsFile, activeSessionFile, apply: false });
    assert.strictEqual(dryRun.sessions.deletable, 1);
    assert.strictEqual(dryRun.activeSession.eligible, true);
    assert.strictEqual(dryRun.metrics.eligible, true);
    assert.ok(fs.existsSync(path.join(sessionsDir, 'legacy-a.json')));
    assert.ok(fs.existsSync(activeSessionFile));
    assert.ok(fs.existsSync(metricsFile));

    const applied = await cleanupLegacyState({ filePath, sessionsDir, metricsFile, activeSessionFile, apply: true });
    assert.strictEqual(applied.sessions.deleted, 1);
    assert.strictEqual(applied.activeSession.deleted, true);
    assert.strictEqual(applied.metrics.deleted, true);
    assert.ok(!fs.existsSync(path.join(sessionsDir, 'legacy-a.json')));
    assert.ok(!fs.existsSync(activeSessionFile));
    assert.ok(!fs.existsSync(metricsFile));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
