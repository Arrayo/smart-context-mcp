import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { projectRoot } from '../utils/runtime-config.js';

export const STATE_DB_FILENAME = 'state.sqlite';
export const SQLITE_SCHEMA_VERSION = 8;
export const ACTIVE_SESSION_SCOPE = 'project';
export const STATE_DB_SOFT_MAX_BYTES = 32 * 1024 * 1024;
const STATE_DB_BUSY_TIMEOUT_MS = 1000;
const STATE_DB_LOCK_RETRY_ATTEMPTS = 3;
const STATE_DB_LOCK_RETRY_DELAY_MS = 75;
export const EXPECTED_TABLES = [
  'active_session',
  'agent_runs',
  'context_access',
  'explain_cache',
  'hook_turn_state',
  'meta',
  'metrics_events',
  'read_cache',
  'session_events',
  'sessions',
  'summary_cache',
  'task_handoffs',
  'tasks',
  'workflow_metrics',
];

const MIGRATIONS = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        goal TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'in_progress',
        current_focus TEXT NOT NULL DEFAULT '',
        why_blocked TEXT NOT NULL DEFAULT '',
        next_step TEXT NOT NULL DEFAULT '',
        pinned_context_json TEXT NOT NULL DEFAULT '[]',
        unresolved_questions_json TEXT NOT NULL DEFAULT '[]',
        blockers_json TEXT NOT NULL DEFAULT '[]',
        snapshot_json TEXT NOT NULL DEFAULT '{}',
        completed_count INTEGER NOT NULL DEFAULT 0,
        decisions_count INTEGER NOT NULL DEFAULT 0,
        touched_files_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS session_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        token_cost INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS metrics_events (
        metric_id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool TEXT NOT NULL,
        action TEXT,
        session_id TEXT,
        target TEXT,
        raw_tokens INTEGER NOT NULL DEFAULT 0,
        compressed_tokens INTEGER NOT NULL DEFAULT 0,
        saved_tokens INTEGER NOT NULL DEFAULT 0,
        savings_pct REAL NOT NULL DEFAULT 0,
        latency_ms INTEGER,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS active_session (
        scope TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS summary_cache (
        session_id TEXT PRIMARY KEY,
        summary_json TEXT NOT NULL,
        tokens INTEGER NOT NULL DEFAULT 0,
        compression_level TEXT NOT NULL DEFAULT 'none',
        omitted_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_session_events_session_created
        ON session_events(session_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_metrics_events_tool_created
        ON metrics_events(tool, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_metrics_events_session_created
        ON metrics_events(session_id, created_at DESC)`,
    ],
  },
  {
    version: 2,
    statements: [
      'ALTER TABLE session_events ADD COLUMN legacy_key TEXT',
      'ALTER TABLE metrics_events ADD COLUMN legacy_key TEXT',
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_session_events_legacy_key
        ON session_events(legacy_key)
        WHERE legacy_key IS NOT NULL`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_metrics_events_legacy_key
        ON metrics_events(legacy_key)
        WHERE legacy_key IS NOT NULL`,
    ],
  },
  {
    version: 3,
    statements: [
      `CREATE TABLE IF NOT EXISTS hook_turn_state (
        hook_key TEXT PRIMARY KEY,
        client TEXT NOT NULL,
        claude_session_id TEXT NOT NULL,
        project_session_id TEXT,
        turn_id TEXT NOT NULL,
        prompt_preview TEXT NOT NULL DEFAULT '',
        continuity_state TEXT NOT NULL DEFAULT '',
        require_checkpoint INTEGER NOT NULL DEFAULT 0,
        prompt_meaningful INTEGER NOT NULL DEFAULT 0,
        checkpointed INTEGER NOT NULL DEFAULT 0,
        checkpoint_event TEXT,
        touched_files_json TEXT NOT NULL DEFAULT '[]',
        meaningful_write_count INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_hook_turn_state_claude_session
        ON hook_turn_state(claude_session_id, updated_at DESC)`,
    ],
  },
  {
    version: 4,
    statements: [
      `CREATE TABLE IF NOT EXISTS context_access (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        task TEXT NOT NULL,
        intent TEXT,
        file_path TEXT NOT NULL,
        relevance REAL,
        access_order INTEGER,
        timestamp TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_context_access_file_timestamp
        ON context_access(file_path, timestamp DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_context_access_session
        ON context_access(session_id, timestamp DESC)`,
    ],
  },
  {
    version: 5,
    statements: [
      `CREATE TABLE IF NOT EXISTS workflow_metrics (
        workflow_id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_type TEXT NOT NULL,
        session_id TEXT,
        start_time TEXT NOT NULL,
        end_time TEXT,
        duration_ms INTEGER,
        tools_used_json TEXT NOT NULL DEFAULT '[]',
        steps_count INTEGER NOT NULL DEFAULT 0,
        raw_tokens INTEGER NOT NULL DEFAULT 0,
        compressed_tokens INTEGER NOT NULL DEFAULT 0,
        saved_tokens INTEGER NOT NULL DEFAULT 0,
        savings_pct REAL NOT NULL DEFAULT 0,
        baseline_tokens INTEGER NOT NULL DEFAULT 0,
        vs_baseline_pct REAL NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE SET NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_metrics_type_created
        ON workflow_metrics(workflow_type, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_metrics_session
        ON workflow_metrics(session_id, created_at DESC)`,
    ],
  },
  {
    version: 6,
    statements: [
      'ALTER TABLE sessions ADD COLUMN task_id TEXT',
      'ALTER TABLE sessions ADD COLUMN agent_id TEXT',
      'ALTER TABLE sessions ADD COLUMN branch_name TEXT',
      'ALTER TABLE sessions ADD COLUMN worktree_path TEXT',
      'ALTER TABLE session_events ADD COLUMN task_id TEXT',
      'ALTER TABLE session_events ADD COLUMN agent_id TEXT',
      'ALTER TABLE session_events ADD COLUMN event_kind TEXT',
      'ALTER TABLE summary_cache ADD COLUMN task_id TEXT',
      'ALTER TABLE hook_turn_state ADD COLUMN task_id TEXT',
      'ALTER TABLE hook_turn_state ADD COLUMN agent_id TEXT',
      'ALTER TABLE hook_turn_state ADD COLUMN parent_agent_id TEXT',
      'ALTER TABLE hook_turn_state ADD COLUMN conversation_id TEXT',
      `CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        project_scope TEXT NOT NULL,
        canonical_goal TEXT NOT NULL DEFAULT '',
        normalized_goal TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'planning',
        branch_name TEXT,
        worktree_path TEXT,
        last_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS task_handoffs (
        handoff_id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        session_id TEXT,
        from_agent_id TEXT,
        to_agent_id TEXT,
        trigger TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS agent_runs (
        run_id TEXT PRIMARY KEY,
        task_id TEXT,
        agent_id TEXT NOT NULL,
        parent_agent_id TEXT,
        client TEXT NOT NULL,
        conversation_id TEXT,
        session_id TEXT,
        role TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_task_updated
        ON sessions(task_id, updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_session_events_task_created
        ON session_events(task_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_summary_cache_task_updated
        ON summary_cache(task_id, updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_updated
        ON tasks(updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_task_handoffs_task_created
        ON task_handoffs(task_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_runs_task_updated
        ON agent_runs(task_id, updated_at DESC)`,
    ],
  },
  {
    version: 7,
    statements: [
      `CREATE TABLE IF NOT EXISTS explain_cache (
        cache_key TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        symbol TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        explanation_json TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'structural',
        tokens INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_explain_cache_file_symbol
        ON explain_cache(file_path, symbol, updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_explain_cache_updated
        ON explain_cache(updated_at DESC)`,
    ],
  },
  {
    version: 8,
    statements: [
      `CREATE TABLE IF NOT EXISTS read_cache (
        cache_key TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        mode TEXT NOT NULL,
        selector TEXT NOT NULL DEFAULT '',
        content_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        tokens INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_read_cache_file_mode
        ON read_cache(file_path, mode, updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_read_cache_updated
        ON read_cache(updated_at DESC)`,
    ],
  },
];

let sqliteModulePromise = null;

export const getStateDir = () => path.join(projectRoot, '.devctx');
export const getStateDbPath = () => process.env.DEVCTX_STATE_DB_PATH || path.join(getStateDir(), STATE_DB_FILENAME);
export const getLegacySessionsDir = () => path.join(getStateDir(), 'sessions');
export const getLegacyMetricsPath = () => path.join(getStateDir(), 'metrics.jsonl');
export const getLegacyActiveSessionPath = () => path.join(getLegacySessionsDir(), 'active.json');

const ensureStateDir = (filePath) => {
  if (filePath === ':memory:') {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
};

const toRelativeStatePath = (filePath) =>
  path.relative(projectRoot, filePath).replace(/\\/g, '/') || path.basename(filePath);

const buildStorageDiagnostic = ({
  filePath,
  issue,
  status,
  exists,
  sizeBytes,
  walExists,
  shmExists,
  message,
  recommendedActions,
  integrity = null,
  details = {},
}) => ({
  filePath,
  relativePath: toRelativeStatePath(filePath),
  issue,
  status,
  exists,
  sizeBytes,
  walExists,
  shmExists,
  softMaxBytes: STATE_DB_SOFT_MAX_BYTES,
  message,
  recommendedActions,
  integrity,
  ...details,
});

export const getStateStorageHealth = ({ filePath = getStateDbPath() } = {}) => {
  const exists = fs.existsSync(filePath);
  const sizeBytes = exists ? fs.statSync(filePath).size : 0;
  const walExists = fs.existsSync(`${filePath}-wal`);
  const shmExists = fs.existsSync(`${filePath}-shm`);

  if (!exists) {
    return buildStorageDiagnostic({
      filePath,
      issue: 'missing',
      status: 'warning',
      exists,
      sizeBytes,
      walExists,
      shmExists,
      message: 'Project-local SQLite state does not exist yet.',
      recommendedActions: [
        'Run a persisted devctx action such as smart_summary update or smart_turn end to initialize state.sqlite.',
        'If you expected prior context, verify DEVCTX_STATE_DB_PATH / project root and that .devctx/ was not deleted.',
      ],
    });
  }

  if (sizeBytes > STATE_DB_SOFT_MAX_BYTES) {
    return buildStorageDiagnostic({
      filePath,
      issue: 'oversized',
      status: 'warning',
      exists,
      sizeBytes,
      walExists,
      shmExists,
      message: 'Project-local SQLite state is larger than the recommended soft limit.',
      recommendedActions: [
        'Run smart_summary compact to prune retained events and metrics.',
        'Archive or remove old local state after backing it up if the repository has become long-lived.',
      ],
    });
  }

  return buildStorageDiagnostic({
    filePath,
    issue: 'ok',
    status: 'ok',
    exists,
    sizeBytes,
    walExists,
    shmExists,
    message: 'Project-local SQLite state is present and within the recommended size range.',
    recommendedActions: [],
  });
};

export const classifyStateDbError = (error, { filePath = getStateDbPath(), readOnly = false } = {}) => {
  const base = getStateStorageHealth({ filePath });
  const message = String(error?.message ?? error ?? '');

  if (/node:sqlite support|Node 22\+/i.test(message)) {
    return buildStorageDiagnostic({
      ...base,
      filePath,
      issue: 'unavailable',
      status: 'error',
      message: 'SQLite runtime support is unavailable in this Node.js process.',
      recommendedActions: [
        'Use Node 22+ for SQLite-backed state.',
        'If you must stay on an older runtime, fall back to legacy JSON/JSONL storage paths only.',
      ],
      details: { errorMessage: message, readOnly },
    });
  }

  if (/database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(message)) {
    return buildStorageDiagnostic({
      ...base,
      filePath,
      issue: 'locked',
      status: 'error',
      message: 'Project-local SQLite state is locked by another process or unfinished transaction.',
      recommendedActions: [
        'Close other devctx processes or wait for the active write to finish, then retry.',
        'Use snapshot-backed reads temporarily if you only need diagnostics while the lock clears.',
      ],
      details: { errorMessage: message, readOnly, retriable: true },
    });
  }

  if (/file is not a database|database disk image is malformed|malformed/i.test(message)) {
    return buildStorageDiagnostic({
      ...base,
      filePath,
      issue: 'corrupted',
      status: 'error',
      message: 'Project-local SQLite state appears corrupted or unreadable as a database.',
      recommendedActions: [
        'Back up .devctx/state.sqlite before removing or replacing it.',
        'Delete the corrupted state file and let devctx recreate it, then re-import any legacy state if available.',
      ],
      details: { errorMessage: message, readOnly, retriable: false },
    });
  }

  if (!base.exists && (readOnly || /ENOENT|no such file|unable to open database file/i.test(message))) {
    return buildStorageDiagnostic({
      ...base,
      filePath,
      issue: 'missing',
      status: 'warning',
      message: 'Project-local SQLite state is missing for a read-only/open request.',
      recommendedActions: [
        'Run a persisted devctx action to initialize state.sqlite.',
        'Verify the configured state path if the file should already exist.',
      ],
      details: { errorMessage: message, readOnly },
    });
  }

  return buildStorageDiagnostic({
    ...base,
    filePath,
    issue: 'unknown',
    status: 'error',
    message: 'Project-local SQLite state failed an unexpected storage operation.',
    recommendedActions: [
      'Retry once to rule out a transient failure.',
      'If the problem persists, inspect or back up .devctx/state.sqlite before removing it.',
    ],
    details: { errorMessage: message, readOnly },
  });
};

export const diagnoseStateStorage = async ({
  filePath = getStateDbPath(),
  verifyIntegrity = true,
} = {}) => {
  const base = getStateStorageHealth({ filePath });
  if (!verifyIntegrity || !base.exists) {
    return base;
  }

  try {
    const { DatabaseSync } = await loadSqliteModule();
    const db = new DatabaseSync(filePath, { readOnly: true });

    try {
      const quickCheckRows = db.prepare('PRAGMA quick_check(1)').all();
      const integrity = quickCheckRows?.[0]?.quick_check ?? quickCheckRows?.[0]?.quickCheck ?? 'unknown';
      const tables = listStateTables(db);
      const missingTables = EXPECTED_TABLES.filter((table) => !tables.includes(table));

      if (integrity !== 'ok' || missingTables.length > 0) {
        return buildStorageDiagnostic({
          ...base,
          filePath,
          issue: 'corrupted',
          status: 'error',
          message: integrity !== 'ok'
            ? 'Project-local SQLite state failed integrity checks.'
            : 'Project-local SQLite state is missing expected schema tables.',
          recommendedActions: [
            'Back up .devctx/state.sqlite before attempting recovery.',
            'Delete and recreate the local state if integrity issues persist after retrying.',
          ],
          integrity,
          details: { missingTables },
        });
      }

      return {
        ...base,
        integrity: 'ok',
        tableCount: tables.length,
        missingTables: [],
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return classifyStateDbError(error, { filePath, readOnly: true });
  }
};

const enrichStateDbError = (error, { filePath = getStateDbPath(), readOnly = false } = {}) => {
  const storageHealth = classifyStateDbError(error, { filePath, readOnly });
  const enriched = new Error(`${storageHealth.message} Original error: ${String(error?.message ?? error ?? 'unknown')}`);
  enriched.cause = error;
  enriched.code = error?.code ?? null;
  enriched.storageHealth = storageHealth;
  enriched.stateDbIssue = storageHealth.issue;
  return enriched;
};

const loadSqliteModule = async () => {
  if (!sqliteModulePromise) {
    sqliteModulePromise = import('node:sqlite')
      .catch(() => {
        throw new Error(
          'SQLite storage requires a Node.js runtime with node:sqlite support. Use Node 22+ for the SQLite-backed workflow.',
        );
      });
  }

  return sqliteModulePromise;
};

const setMeta = (db, key, value) => {
  db.prepare(`
    INSERT INTO meta(key, value)
    VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
};

export const getMeta = (db, key) => {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row?.value ?? null;
};

const DEFAULT_GC_RETENTION_DAYS = 30;
const DEFAULT_GC_THROTTLE_MS = 24 * 60 * 60 * 1000;
const STORAGE_GC_META_KEY = 'last_storage_gc_at';

const sanitizeRetentionDays = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_GC_RETENTION_DAYS;
  return Math.min(365, Math.max(1, Math.floor(parsed)));
};

const getSchemaVersion = (db) => Number(getMeta(db, 'schema_version') ?? 0);
const VALID_STATUSES = new Set(['planning', 'in_progress', 'blocked', 'completed']);

const isStateDbLockError = (error) =>
  /database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(String(error?.message ?? error ?? ''));

const withStateDbLockRetry = async (operation) => {
  for (let attempt = 1; attempt <= STATE_DB_LOCK_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isStateDbLockError(error) || attempt === STATE_DB_LOCK_RETRY_ATTEMPTS) {
        throw error;
      }

      await delay(STATE_DB_LOCK_RETRY_DELAY_MS * attempt);
    }
  }

  throw new Error('SQLite lock retry exhausted unexpectedly.');
};

const applyPragmas = (db, { readOnly = false } = {}) => {
  db.exec(`PRAGMA busy_timeout = ${STATE_DB_BUSY_TIMEOUT_MS}`);

  if (readOnly) {
    return;
  }

  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
};

const safeExec = (db, statement) => {
  try {
    db.exec(statement);
  } catch (error) {
    if (!/duplicate column name/i.test(error.message)) {
      throw error;
    }
  }
};

export const runStateMigrations = (db) => {
  db.exec('BEGIN');

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    let currentVersion = getSchemaVersion(db);
    for (const migration of MIGRATIONS) {
      if (migration.version <= currentVersion) {
        continue;
      }

      for (const statement of migration.statements) {
        safeExec(db, statement);
      }

      currentVersion = migration.version;
      setMeta(db, 'schema_version', currentVersion);
    }

    setMeta(db, 'project_root', projectRoot);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return getSchemaVersion(db);
};

export const listStateTables = (db) =>
  db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => row.name);

export const openStateDb = async ({ filePath = getStateDbPath(), readOnly = false } = {}) => {
  try {
    return await withStateDbLockRetry(async () => {
      const { DatabaseSync } = await loadSqliteModule();
      if (!readOnly) {
        ensureStateDir(filePath);
      }

      let db = null;

      try {
        db = new DatabaseSync(filePath, readOnly ? { readOnly: true } : {});
        applyPragmas(db, { readOnly });
        if (!readOnly) {
          runStateMigrations(db);
        }
        return db;
      } catch (error) {
        try {
          db?.close();
        } catch {}
        throw error;
      }
    });
  } catch (error) {
    throw enrichStateDbError(error, { filePath, readOnly });
  }
};

export const initializeStateDb = async ({ filePath = getStateDbPath() } = {}) => {
  const db = await openStateDb({ filePath });
  try {
    return {
      filePath,
      schemaVersion: getSchemaVersion(db),
      tables: listStateTables(db),
    };
  } finally {
    db.close();
  }
};

export const withStateDb = async (callback, { filePath = getStateDbPath(), readOnly = false } = {}) => {
  const db = await openStateDb({ filePath, readOnly });
  try {
    return await callback(db);
  } finally {
    db.close();
  }
};

const copyIfExists = (sourcePath, targetPath) => {
  if (fs.existsSync(sourcePath)) {
    fs.copyFileSync(sourcePath, targetPath);
  }
};

export const withStateDbSnapshot = async (callback, { filePath = getStateDbPath() } = {}) => {
  const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-sqlite-snapshot-'));
  const snapshotPath = path.join(snapshotDir, path.basename(filePath));

  try {
    copyIfExists(filePath, snapshotPath);
    copyIfExists(`${filePath}-wal`, `${snapshotPath}-wal`);
    copyIfExists(`${filePath}-shm`, `${snapshotPath}-shm`);

    return await withStateDb(callback, { filePath: snapshotPath, readOnly: true });
  } finally {
    fs.rmSync(snapshotDir, { recursive: true, force: true });
  }
};

const normalizeStringArray = (items) => {
  if (!Array.isArray(items)) {
    return [];
  }

  return [...new Set(items.filter((item) => typeof item === 'string' && item.trim().length > 0))];
};

const normalizeStatus = (status) => (VALID_STATUSES.has(status) ? status : 'in_progress');

const readJsonFile = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
};

const readMetricsEntries = (filePath) => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`No metrics file found at ${filePath}`);
  }

  const lines = fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const entries = [];
  const invalidLines = [];

  lines.forEach((line, index) => {
    try {
      entries.push(JSON.parse(line));
    } catch {
      invalidLines.push(index + 1);
    }
  });

  return { entries, invalidLines };
};

const toIsoString = (value, fallback = new Date().toISOString()) => {
  if (typeof value !== 'string') {
    return fallback;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
};

const getTimestamp = (value, fallback = Date.now()) => {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toJsonText = (value, fallback = {}) => JSON.stringify(value ?? fallback);
const parseJsonText = (value, fallback = {}) => {
  try {
    return JSON.parse(value ?? '');
  } catch {
    return fallback;
  }
};

const hashLegacyPayload = (prefix, payload) =>
  `${prefix}:${createHash('sha1').update(payload).digest('hex')}`;

const normalizeTaskText = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const slugTaskText = (value) =>
  normalizeTaskText(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'task';

export const deriveTaskId = ({ goal, branchName = '', worktreePath = '' } = {}) => {
  const canonicalGoal = String(goal ?? '').trim();
  const slug = slugTaskText(canonicalGoal);
  const identity = JSON.stringify({
    goal: normalizeTaskText(canonicalGoal),
    branchName: normalizeTaskText(branchName),
    worktreePath: normalizeTaskText(worktreePath),
  });
  const digest = createHash('sha1').update(identity).digest('hex').slice(0, 10);
  return `${slug}-${digest}`;
};

const deriveTaskFields = ({
  taskId = null,
  goal = '',
  branchName = '',
  worktreePath = projectRoot,
} = {}) => {
  const canonicalGoal = typeof goal === 'string' ? goal.trim() : '';
  const normalizedGoal = normalizeTaskText(canonicalGoal);
  const resolvedBranchName = typeof branchName === 'string' && branchName.trim().length > 0
    ? branchName.trim()
    : null;
  const resolvedWorktreePath = typeof worktreePath === 'string' && worktreePath.trim().length > 0
    ? worktreePath.trim()
    : projectRoot;

  return {
    taskId: typeof taskId === 'string' && taskId.trim().length > 0
      ? taskId.trim()
      : deriveTaskId({
          goal: canonicalGoal,
          branchName: resolvedBranchName ?? '',
          worktreePath: resolvedWorktreePath,
        }),
    canonicalGoal,
    normalizedGoal,
    branchName: resolvedBranchName,
    worktreePath: resolvedWorktreePath,
  };
};

const buildSessionRecord = (sessionId, data) => {
  const completed = normalizeStringArray(data.completed);
  const decisions = normalizeStringArray(data.decisions);
  const touchedFiles = normalizeStringArray(data.touchedFiles);
  const pinnedContext = normalizeStringArray(data.pinnedContext);
  const unresolvedQuestions = normalizeStringArray(data.unresolvedQuestions);
  const blockers = normalizeStringArray(data.blockers);
  const updatedAt = toIsoString(data.updatedAt);
  const createdAt = toIsoString(data.createdAt, updatedAt);
  const taskFields = deriveTaskFields({
    taskId: data.taskId,
    goal: data.goal,
    branchName: data.branchName,
    worktreePath: data.worktreePath,
  });

  return {
    sessionId,
    goal: typeof data.goal === 'string' ? data.goal : '',
    taskId: taskFields.taskId,
    agentId: typeof data.agentId === 'string' && data.agentId.trim().length > 0 ? data.agentId : null,
    branchName: taskFields.branchName,
    worktreePath: taskFields.worktreePath,
    status: normalizeStatus(data.status),
    currentFocus: typeof data.currentFocus === 'string' ? data.currentFocus : '',
    whyBlocked: typeof data.whyBlocked === 'string' ? data.whyBlocked : '',
    nextStep: typeof data.nextStep === 'string' ? data.nextStep : '',
    pinnedContext,
    unresolvedQuestions,
    blockers,
    snapshot: data,
    completedCount: Number.isInteger(data.completedCount) ? data.completedCount : completed.length,
    decisionsCount: Number.isInteger(data.decisionsCount) ? data.decisionsCount : decisions.length,
    touchedFilesCount: Number.isInteger(data.touchedFilesCount) ? data.touchedFilesCount : touchedFiles.length,
    createdAt,
    updatedAt,
  };
};

const upsertSession = (db, record) => {
  db.prepare(`
    INSERT INTO sessions(
      session_id,
      goal,
      status,
      current_focus,
      why_blocked,
      next_step,
      task_id,
      agent_id,
      branch_name,
      worktree_path,
      pinned_context_json,
      unresolved_questions_json,
      blockers_json,
      snapshot_json,
      completed_count,
      decisions_count,
      touched_files_count,
      created_at,
      updated_at
    )
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      goal = excluded.goal,
      status = excluded.status,
      current_focus = excluded.current_focus,
      why_blocked = excluded.why_blocked,
      next_step = excluded.next_step,
      task_id = excluded.task_id,
      agent_id = excluded.agent_id,
      branch_name = excluded.branch_name,
      worktree_path = excluded.worktree_path,
      pinned_context_json = excluded.pinned_context_json,
      unresolved_questions_json = excluded.unresolved_questions_json,
      blockers_json = excluded.blockers_json,
      snapshot_json = excluded.snapshot_json,
      completed_count = excluded.completed_count,
      decisions_count = excluded.decisions_count,
      touched_files_count = excluded.touched_files_count,
      updated_at = excluded.updated_at,
      created_at = sessions.created_at
  `).run(
    record.sessionId,
    record.goal,
    record.status,
    record.currentFocus,
    record.whyBlocked,
    record.nextStep,
    record.taskId,
    record.agentId,
    record.branchName,
    record.worktreePath,
    toJsonText(record.pinnedContext, []),
    toJsonText(record.unresolvedQuestions, []),
    toJsonText(record.blockers, []),
    toJsonText(record.snapshot),
    record.completedCount,
    record.decisionsCount,
    record.touchedFilesCount,
    record.createdAt,
    record.updatedAt,
  );
};

const insertLegacySessionEvent = (db, record, sourceFile) => {
  const legacyKey = `session:${record.sessionId}`;
  db.prepare(`
    INSERT OR IGNORE INTO session_events(
      session_id,
      event_type,
      task_id,
      agent_id,
      event_kind,
      payload_json,
      token_cost,
      created_at,
      legacy_key
    )
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.sessionId,
    'legacy_import',
    record.taskId,
    record.agentId,
    'legacy_import',
    JSON.stringify({ source: sourceFile, updatedAt: record.updatedAt }),
    0,
    record.updatedAt,
    legacyKey,
  );
};

const normalizeMetricEntry = (entry) => {
  const compressedTokens = Number(entry.compressedTokens ?? entry.finalTokens ?? 0);
  const savedTokens = entry.savedTokens !== undefined
    ? Number(entry.savedTokens ?? 0)
    : Math.max(0, Number(entry.rawTokens ?? 0) - compressedTokens);
  const rawTokens = Number(entry.rawTokens ?? 0);
  const savingsPct = rawTokens > 0
    ? Number((((savedTokens || 0) / rawTokens) * 100).toFixed(2))
    : Number(entry.savingsPct ?? 0);
  const createdAt = toIsoString(entry.timestamp);
  const {
    tool,
    action = null,
    sessionId = null,
    target = null,
    latencyMs = null,
    metadata: explicitMetadata = {},
    ...metadata
  } = entry;

  return {
    tool: tool ?? 'unknown',
    action,
    sessionId,
    target,
    rawTokens,
    compressedTokens,
    savedTokens,
    savingsPct,
    latencyMs,
    metadata: {
      ...(explicitMetadata && typeof explicitMetadata === 'object' ? explicitMetadata : {}),
      ...metadata,
    },
    createdAt,
  };
};

export const insertMetricEvent = (db, entry, { legacyKey = null, ignoreDuplicates = false } = {}) => {
  const metric = normalizeMetricEntry(entry);
  const insertVerb = ignoreDuplicates ? 'INSERT OR IGNORE' : 'INSERT';

  db.prepare(`
    ${insertVerb} INTO metrics_events(
      tool,
      action,
      session_id,
      target,
      raw_tokens,
      compressed_tokens,
      saved_tokens,
      savings_pct,
      latency_ms,
      metadata_json,
      created_at,
      legacy_key
    )
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    metric.tool,
    metric.action,
    metric.sessionId,
    metric.target,
    metric.rawTokens,
    metric.compressedTokens,
    metric.savedTokens,
    metric.savingsPct,
    metric.latencyMs,
    JSON.stringify(metric.metadata),
    metric.createdAt,
    legacyKey,
  );
};

const insertLegacyMetric = (db, entry) => {
  const legacyKey = hashLegacyPayload('metric', JSON.stringify(entry));
  insertMetricEvent(db, entry, { legacyKey, ignoreDuplicates: true });
};

const upsertActiveSession = (db, sessionId, updatedAt) => {
  db.prepare(`
    INSERT INTO active_session(scope, session_id, updated_at)
    VALUES(?, ?, ?)
    ON CONFLICT(scope) DO UPDATE SET
      session_id = excluded.session_id,
      updated_at = excluded.updated_at
  `).run(ACTIVE_SESSION_SCOPE, sessionId, updatedAt);
};

const upsertTaskRow = (db, {
  taskId,
  canonicalGoal,
  normalizedGoal,
  status = 'planning',
  branchName = null,
  worktreePath = projectRoot,
  lastSessionId = null,
  createdAt = new Date().toISOString(),
  updatedAt = createdAt,
} = {}) => {
  db.prepare(`
    INSERT INTO tasks(
      task_id,
      project_scope,
      canonical_goal,
      normalized_goal,
      status,
      branch_name,
      worktree_path,
      last_session_id,
      created_at,
      updated_at
    )
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      canonical_goal = excluded.canonical_goal,
      normalized_goal = excluded.normalized_goal,
      status = excluded.status,
      branch_name = excluded.branch_name,
      worktree_path = excluded.worktree_path,
      last_session_id = excluded.last_session_id,
      updated_at = excluded.updated_at,
      created_at = tasks.created_at
  `).run(
    taskId,
    projectRoot,
    canonicalGoal,
    normalizedGoal,
    normalizeStatus(status, 'planning'),
    branchName,
    worktreePath,
    lastSessionId,
    createdAt,
    updatedAt,
  );
};

const getTaskRow = (db, taskId) => db.prepare(`
  SELECT
    task_id,
    project_scope,
    canonical_goal,
    normalized_goal,
    status,
    branch_name,
    worktree_path,
    last_session_id,
    created_at,
    updated_at
  FROM tasks
  WHERE task_id = ?
`).get(taskId);

const normalizeTaskRow = (row) => {
  if (!row) {
    return null;
  }

  return {
    taskId: row.task_id,
    projectScope: row.project_scope,
    canonicalGoal: row.canonical_goal,
    normalizedGoal: row.normalized_goal,
    status: row.status,
    branchName: row.branch_name ?? null,
    worktreePath: row.worktree_path ?? null,
    lastSessionId: row.last_session_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const insertTaskHandoffRow = (db, {
  taskId,
  sessionId = null,
  fromAgentId = null,
  toAgentId = null,
  trigger,
  summary = {},
  createdAt = new Date().toISOString(),
} = {}) => {
  const result = db.prepare(`
    INSERT INTO task_handoffs(
      task_id,
      session_id,
      from_agent_id,
      to_agent_id,
      trigger,
      summary_json,
      created_at
    )
    VALUES(?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    sessionId,
    fromAgentId,
    toAgentId,
    trigger,
    JSON.stringify(summary ?? {}),
    createdAt,
  );

  return result.lastInsertRowid;
};

const getLatestTaskHandoffRow = (db, taskId) => db.prepare(`
  SELECT
    handoff_id,
    task_id,
    session_id,
    from_agent_id,
    to_agent_id,
    trigger,
    summary_json,
    created_at
  FROM task_handoffs
  WHERE task_id = ?
  ORDER BY datetime(created_at) DESC, handoff_id DESC
  LIMIT 1
`).get(taskId);

const normalizeTaskHandoffRow = (row) => {
  if (!row) {
    return null;
  }

  return {
    handoffId: Number(row.handoff_id),
    taskId: row.task_id,
    sessionId: row.session_id ?? null,
    fromAgentId: row.from_agent_id ?? null,
    toAgentId: row.to_agent_id ?? null,
    trigger: row.trigger,
    summary: parseJsonText(row.summary_json, {}),
    createdAt: row.created_at,
  };
};

const upsertAgentRunRow = (db, {
  runId,
  taskId = null,
  agentId,
  parentAgentId = null,
  client,
  conversationId = null,
  sessionId = null,
  role = 'main',
  startedAt = new Date().toISOString(),
  updatedAt = startedAt,
} = {}) => {
  db.prepare(`
    INSERT INTO agent_runs(
      run_id,
      task_id,
      agent_id,
      parent_agent_id,
      client,
      conversation_id,
      session_id,
      role,
      started_at,
      updated_at
    )
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      task_id = excluded.task_id,
      agent_id = excluded.agent_id,
      parent_agent_id = excluded.parent_agent_id,
      client = excluded.client,
      conversation_id = excluded.conversation_id,
      session_id = excluded.session_id,
      role = excluded.role,
      updated_at = excluded.updated_at,
      started_at = agent_runs.started_at
  `).run(
    runId,
    taskId,
    agentId,
    parentAgentId,
    client,
    conversationId,
    sessionId,
    role,
    startedAt,
    updatedAt,
  );
};

const buildHookTurnRecord = (hookKey, state = {}) => {
  const startedAt = toIsoString(state.startedAt);
  const updatedAt = toIsoString(state.updatedAt, startedAt);
  const conversationId = typeof state.conversationId === 'string' && state.conversationId.trim().length > 0
    ? state.conversationId
    : typeof state.cursorConversationId === 'string' && state.cursorConversationId.trim().length > 0
      ? state.cursorConversationId
      : typeof state.claudeSessionId === 'string' && state.claudeSessionId.trim().length > 0
        ? state.claudeSessionId
        : '';

  return {
    hookKey,
    client: typeof state.client === 'string' && state.client.trim().length > 0 ? state.client : 'claude',
    claudeSessionId: conversationId,
    conversationId,
    projectSessionId: typeof state.projectSessionId === 'string' && state.projectSessionId.trim().length > 0
      ? state.projectSessionId
      : null,
    taskId: typeof state.taskId === 'string' && state.taskId.trim().length > 0 ? state.taskId : null,
    agentId: typeof state.agentId === 'string' && state.agentId.trim().length > 0 ? state.agentId : null,
    parentAgentId: typeof state.parentAgentId === 'string' && state.parentAgentId.trim().length > 0
      ? state.parentAgentId
      : null,
    turnId: typeof state.turnId === 'string' && state.turnId.trim().length > 0
      ? state.turnId
      : `turn-${Date.now()}`,
    promptPreview: typeof state.promptPreview === 'string' ? state.promptPreview : '',
    continuityState: typeof state.continuityState === 'string' ? state.continuityState : '',
    requireCheckpoint: state.requireCheckpoint ? 1 : 0,
    promptMeaningful: state.promptMeaningful ? 1 : 0,
    checkpointed: state.checkpointed ? 1 : 0,
    checkpointEvent: typeof state.checkpointEvent === 'string' && state.checkpointEvent.trim().length > 0
      ? state.checkpointEvent
      : null,
    touchedFiles: normalizeStringArray(state.touchedFiles),
    meaningfulWriteCount: Number.isInteger(state.meaningfulWriteCount)
      ? Math.max(0, state.meaningfulWriteCount)
      : 0,
    startedAt,
    updatedAt,
  };
};

const normalizeHookTurnRow = (row) => {
  if (!row) {
    return null;
  }

  return {
    hookKey: row.hook_key,
    client: row.client,
    claudeSessionId: row.claude_session_id,
    conversationId: row.conversation_id ?? row.claude_session_id,
    projectSessionId: row.project_session_id ?? null,
    taskId: row.task_id ?? null,
    agentId: row.agent_id ?? null,
    parentAgentId: row.parent_agent_id ?? null,
    turnId: row.turn_id,
    promptPreview: row.prompt_preview,
    continuityState: row.continuity_state,
    requireCheckpoint: Boolean(row.require_checkpoint),
    promptMeaningful: Boolean(row.prompt_meaningful),
    checkpointed: Boolean(row.checkpointed),
    checkpointEvent: row.checkpoint_event ?? null,
    touchedFiles: normalizeStringArray(parseJsonText(row.touched_files_json, [])),
    meaningfulWriteCount: Number(row.meaningful_write_count ?? 0),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
};

const readHookTurnRow = (db, hookKey) => db.prepare(`
  SELECT
    hook_key,
    client,
    claude_session_id,
    project_session_id,
    task_id,
    agent_id,
    parent_agent_id,
    conversation_id,
    turn_id,
    prompt_preview,
    continuity_state,
    require_checkpoint,
    prompt_meaningful,
    checkpointed,
    checkpoint_event,
    touched_files_json,
    meaningful_write_count,
    started_at,
    updated_at
  FROM hook_turn_state
  WHERE hook_key = ?
`).get(hookKey);

const upsertHookTurnRow = (db, record) => {
  db.prepare(`
    INSERT INTO hook_turn_state(
      hook_key,
      client,
      claude_session_id,
      project_session_id,
      task_id,
      agent_id,
      parent_agent_id,
      conversation_id,
      turn_id,
      prompt_preview,
      continuity_state,
      require_checkpoint,
      prompt_meaningful,
      checkpointed,
      checkpoint_event,
      touched_files_json,
      meaningful_write_count,
      started_at,
      updated_at
    )
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(hook_key) DO UPDATE SET
      client = excluded.client,
      claude_session_id = excluded.claude_session_id,
      project_session_id = excluded.project_session_id,
      task_id = excluded.task_id,
      agent_id = excluded.agent_id,
      parent_agent_id = excluded.parent_agent_id,
      conversation_id = excluded.conversation_id,
      turn_id = excluded.turn_id,
      prompt_preview = excluded.prompt_preview,
      continuity_state = excluded.continuity_state,
      require_checkpoint = excluded.require_checkpoint,
      prompt_meaningful = excluded.prompt_meaningful,
      checkpointed = excluded.checkpointed,
      checkpoint_event = excluded.checkpoint_event,
      touched_files_json = excluded.touched_files_json,
      meaningful_write_count = excluded.meaningful_write_count,
      updated_at = excluded.updated_at,
      started_at = hook_turn_state.started_at
  `).run(
    record.hookKey,
    record.client,
    record.claudeSessionId,
    record.projectSessionId,
    record.taskId,
    record.agentId,
    record.parentAgentId,
    record.conversationId,
    record.turnId,
    record.promptPreview,
    record.continuityState,
    record.requireCheckpoint,
    record.promptMeaningful,
    record.checkpointed,
    record.checkpointEvent,
    toJsonText(record.touchedFiles, []),
    record.meaningfulWriteCount,
    record.startedAt,
    record.updatedAt,
  );
};

export const getHookTurnState = async ({ filePath = getStateDbPath(), hookKey, readOnly = false } = {}) => {
  const reader = readOnly ? withStateDbSnapshot : withStateDb;
  return reader((db) => normalizeHookTurnRow(readHookTurnRow(db, hookKey)), { filePath });
};

export const setHookTurnState = async ({ filePath = getStateDbPath(), hookKey, state } = {}) => withStateDb((db) => {
  const record = buildHookTurnRecord(hookKey, state);
  upsertHookTurnRow(db, record);
  return normalizeHookTurnRow(readHookTurnRow(db, hookKey));
}, { filePath });

export const deleteHookTurnState = async ({ filePath = getStateDbPath(), hookKey } = {}) => withStateDb((db) => {
  const existing = normalizeHookTurnRow(readHookTurnRow(db, hookKey));
  db.prepare('DELETE FROM hook_turn_state WHERE hook_key = ?').run(hookKey);
  return existing;
}, { filePath });

export const getTask = async ({ filePath = getStateDbPath(), taskId, readOnly = false } = {}) => {
  const reader = readOnly ? withStateDbSnapshot : withStateDb;
  return reader((db) => normalizeTaskRow(getTaskRow(db, taskId)), { filePath });
};

export const persistTaskHandoff = async ({ filePath = getStateDbPath(), taskId, sessionId = null, fromAgentId = null, toAgentId = null, trigger, summary = {} } = {}) =>
  withStateDb((db) => {
    const createdAt = new Date().toISOString();
    const handoffId = insertTaskHandoffRow(db, {
      taskId,
      sessionId,
      fromAgentId,
      toAgentId,
      trigger,
      summary,
      createdAt,
    });
    return normalizeTaskHandoffRow(getLatestTaskHandoffRow(db, taskId)) ?? {
      handoffId,
      taskId,
      sessionId,
      fromAgentId,
      toAgentId,
      trigger,
      summary,
      createdAt,
    };
  }, { filePath });

export const getLatestTaskHandoff = async ({ filePath = getStateDbPath(), taskId, readOnly = false } = {}) => {
  const reader = readOnly ? withStateDbSnapshot : withStateDb;
  return reader((db) => normalizeTaskHandoffRow(getLatestTaskHandoffRow(db, taskId)), { filePath });
};

export const upsertAgentRun = async ({ filePath = getStateDbPath(), runId, taskId = null, agentId, parentAgentId = null, client, conversationId = null, sessionId = null, role = 'main' } = {}) =>
  withStateDb((db) => {
    const now = new Date().toISOString();
    upsertAgentRunRow(db, {
      runId,
      taskId,
      agentId,
      parentAgentId,
      client,
      conversationId,
      sessionId,
      role,
      startedAt: now,
      updatedAt: now,
    });
    return {
      runId,
      taskId,
      agentId,
      parentAgentId,
      client,
      conversationId,
      sessionId,
      role,
      startedAt: now,
      updatedAt: now,
    };
  }, { filePath });

export const runStorageMaintenance = async ({
  filePath = getStateDbPath(),
  retentionDays = DEFAULT_GC_RETENTION_DAYS,
  throttleMs = DEFAULT_GC_THROTTLE_MS,
  force = false,
} = {}) => withStateDb((db) => {
  const now = Date.now();
  const lastRun = Number(getMeta(db, STORAGE_GC_META_KEY) ?? 0);
  if (!force && now - lastRun < throttleMs) {
    return { skipped: true, reason: 'throttled', lastRunAt: lastRun || null };
  }

  const days = sanitizeRetentionDays(retentionDays);
  const cutoffIso = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

  const removeOlder = (sql) => db.prepare(sql).run(cutoffIso).changes;

  const removed = {
    metricsEvents: removeOlder('DELETE FROM metrics_events WHERE created_at < ?'),
    sessionEvents: removeOlder('DELETE FROM session_events WHERE created_at < ?'),
    taskHandoffs: removeOlder('DELETE FROM task_handoffs WHERE created_at < ?'),
    agentRuns: removeOlder('DELETE FROM agent_runs WHERE updated_at < ?'),
    workflowMetrics: removeOlder('DELETE FROM workflow_metrics WHERE created_at < ?'),
    contextAccess: removeOlder('DELETE FROM context_access WHERE timestamp < ?'),
    explainCache: removeOlder('DELETE FROM explain_cache WHERE updated_at < ?'),
    readCache: removeOlder('DELETE FROM read_cache WHERE updated_at < ?'),
  };

  setMeta(db, STORAGE_GC_META_KEY, String(now));

  return {
    skipped: false,
    runAt: now,
    retentionDays: days,
    removed,
  };
}, { filePath });

const listLegacySessionFiles = (sessionsDir) => {
  if (!fs.existsSync(sessionsDir)) {
    return [];
  }

  return fs.readdirSync(sessionsDir)
    .filter((file) => file.endsWith('.json') && file !== 'active.json')
    .sort();
};

export const importLegacyState = async ({
  filePath = getStateDbPath(),
  sessionsDir = getLegacySessionsDir(),
  metricsFile = getLegacyMetricsPath(),
  activeSessionFile = getLegacyActiveSessionPath(),
} = {}) => withStateDb((db) => {
  const report = {
    filePath,
    sessions: { imported: 0, skipped: 0, invalid: 0 },
    metrics: { imported: 0, skipped: 0, invalid: 0 },
    activeSession: { imported: false, sessionId: null },
  };

  const sessionFiles = listLegacySessionFiles(sessionsDir);
  for (const fileName of sessionFiles) {
    const payload = readJsonFile(path.join(sessionsDir, fileName));
    if (!payload || typeof payload !== 'object') {
      report.sessions.invalid += 1;
      continue;
    }

    const sessionId = typeof payload.sessionId === 'string' && payload.sessionId.trim().length > 0
      ? payload.sessionId
      : fileName.replace(/\.json$/i, '');
    const exists = db.prepare('SELECT 1 FROM sessions WHERE session_id = ?').get(sessionId);
    const record = buildSessionRecord(sessionId, payload);

    upsertSession(db, record);
    upsertTaskRow(db, {
      taskId: record.taskId,
      canonicalGoal: record.goal,
      normalizedGoal: normalizeTaskText(record.goal),
      status: record.status,
      branchName: record.branchName,
      worktreePath: record.worktreePath,
      lastSessionId: sessionId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
    insertLegacySessionEvent(db, record, fileName);
    report.sessions[exists ? 'skipped' : 'imported'] += 1;
  }

  if (fs.existsSync(activeSessionFile)) {
    const active = readJsonFile(activeSessionFile);
    const activeSessionId = typeof active?.sessionId === 'string' ? active.sessionId : null;
    if (activeSessionId) {
      const exists = db.prepare('SELECT 1 FROM sessions WHERE session_id = ?').get(activeSessionId);
      if (exists) {
        upsertActiveSession(db, activeSessionId, toIsoString(active.updatedAt));
        report.activeSession = { imported: true, sessionId: activeSessionId };
      }
    }
  }

  if (fs.existsSync(metricsFile)) {
    const { entries, invalidLines } = readMetricsEntries(metricsFile);
    report.metrics.invalid = invalidLines.length;

    for (const entry of entries) {
      const legacyKey = hashLegacyPayload('metric', JSON.stringify(entry));
      const exists = db.prepare('SELECT 1 FROM metrics_events WHERE legacy_key = ?').get(legacyKey);
      insertLegacyMetric(db, entry);
      report.metrics[exists ? 'skipped' : 'imported'] += 1;
    }
  }

  setMeta(db, 'legacy_sessions_imported_at', new Date().toISOString());
  setMeta(db, 'legacy_sessions_import_count', report.sessions.imported + report.sessions.skipped);
  setMeta(db, 'legacy_metrics_imported_at', new Date().toISOString());
  setMeta(db, 'legacy_metrics_import_count', report.metrics.imported + report.metrics.skipped);

  return report;
}, { filePath });

const getActiveSessionRow = (db) => db.prepare(`
  SELECT session_id, updated_at
  FROM active_session
  WHERE scope = ?
`).get(ACTIVE_SESSION_SCOPE);

const getSessionIdFromLegacyPayload = (fileName, payload) =>
  typeof payload?.sessionId === 'string' && payload.sessionId.trim().length > 0
    ? payload.sessionId
    : fileName.replace(/\.json$/i, '');

const buildSessionCleanupCandidate = (db, sessionsDir, fileName) => {
  const filePath = path.join(sessionsDir, fileName);
  const payload = readJsonFile(filePath);

  if (!payload || typeof payload !== 'object') {
    const sizeBytes = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    return {
      type: 'session',
      path: filePath,
      fileName,
      eligible: false,
      reason: 'invalid_json',
      sessionId: null,
      sizeBytes,
    };
  }

  const sessionId = getSessionIdFromLegacyPayload(fileName, payload);
  const sessionRow = db.prepare(`
    SELECT session_id, updated_at
    FROM sessions
    WHERE session_id = ?
  `).get(sessionId);
  if (!sessionRow) {
    const sizeBytes = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    return {
      type: 'session',
      path: filePath,
      fileName,
      eligible: false,
      reason: 'missing_in_sqlite',
      sessionId,
      sizeBytes,
    };
  }

  const fileUpdatedAt = toIsoString(payload.updatedAt, sessionRow.updated_at);
  const sqliteUpdatedAt = toIsoString(sessionRow.updated_at);
  const eligible = getTimestamp(sqliteUpdatedAt) >= getTimestamp(fileUpdatedAt);

  const sizeBytes = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;

  return {
    type: 'session',
    path: filePath,
    fileName,
    eligible,
    reason: eligible ? 'imported_and_not_newer_than_sqlite' : 'legacy_file_newer_than_sqlite',
    sessionId,
    sizeBytes,
    fileUpdatedAt,
    sqliteUpdatedAt,
  };
};

const buildActiveCleanupCandidate = (db, activeSessionFile) => {
  if (!fs.existsSync(activeSessionFile)) {
    return null;
  }

  const payload = readJsonFile(activeSessionFile);
  if (!payload || typeof payload !== 'object') {
    const sizeBytes = fs.statSync(activeSessionFile).size;
    return {
      type: 'active_session',
      path: activeSessionFile,
      eligible: false,
      reason: 'invalid_json',
      sessionId: null,
      sizeBytes,
    };
  }

  const legacySessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null;
  const activeRow = getActiveSessionRow(db);
  if (!legacySessionId) {
    const sizeBytes = fs.statSync(activeSessionFile).size;
    return {
      type: 'active_session',
      path: activeSessionFile,
      eligible: true,
      reason: 'orphaned_legacy_file',
      sessionId: null,
      sizeBytes,
    };
  }

  if (!activeRow) {
    const sizeBytes = fs.statSync(activeSessionFile).size;
    return {
      type: 'active_session',
      path: activeSessionFile,
      eligible: true,
      reason: 'sqlite_has_no_active_session',
      sessionId: legacySessionId,
      sizeBytes,
    };
  }

  const fileUpdatedAt = toIsoString(payload.updatedAt, activeRow.updated_at);
  const sqliteUpdatedAt = toIsoString(activeRow.updated_at);
  const eligible = activeRow.session_id === legacySessionId
    && getTimestamp(sqliteUpdatedAt) >= getTimestamp(fileUpdatedAt);

  const sizeBytes = fs.existsSync(activeSessionFile) ? fs.statSync(activeSessionFile).size : 0;

  return {
    type: 'active_session',
    path: activeSessionFile,
    eligible,
    reason: eligible ? 'sqlite_active_session_matches' : 'sqlite_active_session_differs',
    sessionId: legacySessionId,
    sizeBytes,
    fileUpdatedAt,
    sqliteUpdatedAt,
  };
};

const buildMetricsCleanupCandidate = (db, metricsFile) => {
  if (!fs.existsSync(metricsFile)) {
    return null;
  }

  const { entries, invalidLines } = readMetricsEntries(metricsFile);
  if (invalidLines.length > 0) {
    const sizeBytes = fs.statSync(metricsFile).size;
    return {
      type: 'metrics',
      path: metricsFile,
      eligible: false,
      reason: 'invalid_jsonl',
      entryCount: entries.length,
      sizeBytes,
      invalidLines,
      missingEntries: [],
    };
  }

  const missingEntries = [];
  for (const entry of entries) {
    const legacyKey = hashLegacyPayload('metric', JSON.stringify(entry));
    const exists = db.prepare('SELECT 1 FROM metrics_events WHERE legacy_key = ?').get(legacyKey);
    if (!exists) {
      missingEntries.push({
        tool: entry.tool ?? 'unknown',
        timestamp: entry.timestamp ?? null,
        legacyKey,
      });
    }
  }

  const sizeBytes = fs.existsSync(metricsFile) ? fs.statSync(metricsFile).size : 0;

  return {
    type: 'metrics',
    path: metricsFile,
    eligible: missingEntries.length === 0,
    reason: missingEntries.length === 0 ? 'all_entries_imported' : 'sqlite_missing_entries',
    entryCount: entries.length,
    sizeBytes,
    invalidLines,
    missingEntries,
  };
};

export const compactState = async ({
  filePath = getStateDbPath(),
  retentionDays = 30,
  keepLatestEventsPerSession = 20,
  keepLatestMetrics = 1000,
  vacuum = false,
} = {}) => withStateDb((db) => {
  const HOOK_TURN_RETENTION_HOURS = 48;
  const normalizedRetentionDays = Math.max(1, Number(retentionDays) || 30);
  const normalizedKeepLatestEventsPerSession = Math.max(0, Number(keepLatestEventsPerSession) || 0);
  const normalizedKeepLatestMetrics = Math.max(0, Number(keepLatestMetrics) || 0);
  const cutoff = new Date(Date.now() - normalizedRetentionDays * 24 * 60 * 60 * 1000).toISOString();
  const hookTurnCutoff = new Date(Date.now() - HOOK_TURN_RETENTION_HOURS * 60 * 60 * 1000).toISOString();
  const activeSessionId = getActiveSessionRow(db)?.session_id ?? null;

  const report = {
    filePath,
    retentionDays: normalizedRetentionDays,
    cutoff,
    hookTurnRetentionHours: HOOK_TURN_RETENTION_HOURS,
    sessions: { before: 0, deleted: 0, after: 0 },
    sessionEvents: { before: 0, deleted: 0, after: 0, keepLatestPerSession: normalizedKeepLatestEventsPerSession },
    metricsEvents: { before: 0, deleted: 0, after: 0, keepLatest: normalizedKeepLatestMetrics },
    hookTurnState: { before: 0, deleted: 0, after: 0 },
    vacuumed: false,
  };

  report.sessions.before = db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count;
  report.sessionEvents.before = db.prepare('SELECT COUNT(*) AS count FROM session_events').get().count;
  report.metricsEvents.before = db.prepare('SELECT COUNT(*) AS count FROM metrics_events').get().count;
  report.hookTurnState.before = db.prepare('SELECT COUNT(*) AS count FROM hook_turn_state').get().count;

  db.exec('BEGIN');
  try {
    const staleSessions = db.prepare(`
      SELECT session_id
      FROM sessions
      WHERE updated_at < ?
    `).all(cutoff);

    for (const row of staleSessions) {
      if (row.session_id === activeSessionId) {
        continue;
      }

      db.prepare('DELETE FROM sessions WHERE session_id = ?').run(row.session_id);
      report.sessions.deleted += 1;
    }

    const sessionEventRows = db.prepare(`
      SELECT event_id, session_id, created_at
      FROM session_events
      ORDER BY session_id ASC, datetime(created_at) DESC, event_id DESC
    `).all();
    const sessionEventKeepCounts = new Map();
    for (const row of sessionEventRows) {
      const current = sessionEventKeepCounts.get(row.session_id) ?? 0;
      const shouldKeep = current < normalizedKeepLatestEventsPerSession || getTimestamp(row.created_at) >= getTimestamp(cutoff);
      if (shouldKeep) {
        sessionEventKeepCounts.set(row.session_id, current + 1);
        continue;
      }
      db.prepare('DELETE FROM session_events WHERE event_id = ?').run(row.event_id);
      report.sessionEvents.deleted += 1;
    }

    const metricRows = db.prepare(`
      SELECT metric_id, created_at
      FROM metrics_events
      ORDER BY datetime(created_at) DESC, metric_id DESC
    `).all();
    let keptMetrics = 0;
    for (const row of metricRows) {
      const shouldKeep = keptMetrics < normalizedKeepLatestMetrics || getTimestamp(row.created_at) >= getTimestamp(cutoff);
      if (shouldKeep) {
        keptMetrics += 1;
        continue;
      }
      db.prepare('DELETE FROM metrics_events WHERE metric_id = ?').run(row.metric_id);
      report.metricsEvents.deleted += 1;
    }

    const deletedHookTurns = db.prepare(`
      DELETE FROM hook_turn_state
      WHERE updated_at < ?
    `).run(hookTurnCutoff);
    report.hookTurnState.deleted = deletedHookTurns.changes ?? 0;

    setMeta(db, 'state_compacted_at', new Date().toISOString());
    setMeta(db, 'state_compaction_retention_days', normalizedRetentionDays);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  if (vacuum && (report.sessions.deleted > 0 || report.sessionEvents.deleted > 0 || report.metricsEvents.deleted > 0)) {
    db.exec('VACUUM');
    report.vacuumed = true;
  }

  report.sessions.after = db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count;
  report.sessionEvents.after = db.prepare('SELECT COUNT(*) AS count FROM session_events').get().count;
  report.metricsEvents.after = db.prepare('SELECT COUNT(*) AS count FROM metrics_events').get().count;
  report.hookTurnState.after = db.prepare('SELECT COUNT(*) AS count FROM hook_turn_state').get().count;

  return report;
}, { filePath });

export const cleanupLegacyState = async ({
  filePath = getStateDbPath(),
  sessionsDir = getLegacySessionsDir(),
  metricsFile = getLegacyMetricsPath(),
  activeSessionFile = getLegacyActiveSessionPath(),
  apply = false,
} = {}) => withStateDb((db) => {
  const sessionCandidates = listLegacySessionFiles(sessionsDir).map((fileName) =>
    buildSessionCleanupCandidate(db, sessionsDir, fileName)
  );
  const activeCandidate = buildActiveCleanupCandidate(db, activeSessionFile);
  const metricsCandidate = buildMetricsCleanupCandidate(db, metricsFile);

  const report = {
    filePath,
    apply,
    sessions: {
      candidates: sessionCandidates,
      deletable: sessionCandidates.filter((candidate) => candidate.eligible).length,
      deleted: 0,
    },
    activeSession: activeCandidate,
    metrics: metricsCandidate,
    deletedPaths: [],
  };

  if (!apply) {
    return report;
  }

  for (const candidate of sessionCandidates) {
    if (!candidate.eligible) {
      continue;
    }
    fs.unlinkSync(candidate.path);
    report.sessions.deleted += 1;
    report.deletedPaths.push(candidate.path);
  }

  if (activeCandidate?.eligible) {
    fs.unlinkSync(activeCandidate.path);
    report.deletedPaths.push(activeCandidate.path);
    report.activeSession = { ...activeCandidate, deleted: true };
  }

  if (metricsCandidate?.eligible) {
    fs.unlinkSync(metricsCandidate.path);
    report.deletedPaths.push(metricsCandidate.path);
    report.metrics = { ...metricsCandidate, deleted: true };
  }

  if (fs.existsSync(sessionsDir) && fs.readdirSync(sessionsDir).length === 0) {
    fs.rmdirSync(sessionsDir);
  }

  return report;
}, { filePath });

const buildExplainCacheKey = ({ filePath, symbol, contentHash }) =>
  createHash('sha256').update(`${filePath}\u241F${symbol}\u241F${contentHash}`).digest('hex');

const buildReadCacheKey = ({ filePath, mode, selector = '', contentHash }) =>
  createHash('sha256').update(`${filePath}\u241F${mode}\u241F${selector}\u241F${contentHash}`).digest('hex');

export const getExplainCache = async ({
  filePath: dbPath = getStateDbPath(),
  relPath,
  symbol,
  contentHash,
} = {}) => withStateDb((db) => {
  if (!relPath || !symbol || !contentHash) return null;
  const cacheKey = buildExplainCacheKey({ filePath: relPath, symbol, contentHash });
  const row = db.prepare(`
    SELECT explanation_json, provider, tokens, updated_at
    FROM explain_cache
    WHERE cache_key = ?
  `).get(cacheKey);
  if (!row) return null;
  return {
    explanation: parseJsonText(row.explanation_json, null),
    provider: row.provider,
    tokens: row.tokens,
    updatedAt: row.updated_at,
  };
}, { filePath: dbPath });

export const setExplainCache = async ({
  filePath: dbPath = getStateDbPath(),
  relPath,
  symbol,
  contentHash,
  explanation,
  provider = 'structural',
  tokens = 0,
} = {}) => withStateDb((db) => {
  if (!relPath || !symbol || !contentHash || !explanation) return null;
  const cacheKey = buildExplainCacheKey({ filePath: relPath, symbol, contentHash });
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO explain_cache(cache_key, file_path, symbol, content_hash, explanation_json, provider, tokens, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      explanation_json = excluded.explanation_json,
      provider = excluded.provider,
      tokens = excluded.tokens,
      updated_at = excluded.updated_at
  `).run(cacheKey, relPath, symbol, contentHash, toJsonText(explanation), provider, tokens, now, now);
  return { cacheKey, updatedAt: now };
}, { filePath: dbPath });

export const clearExplainCache = async ({ filePath = getStateDbPath() } = {}) => withStateDb((db) => {
  return db.prepare('DELETE FROM explain_cache').run().changes;
}, { filePath });

export const getReadCache = async ({
  filePath: dbPath = getStateDbPath(),
  relPath,
  mode,
  selector = '',
  contentHash,
} = {}) => withStateDb((db) => {
  if (!relPath || !mode || !contentHash) return null;
  const cacheKey = buildReadCacheKey({ filePath: relPath, mode, selector, contentHash });
  const row = db.prepare(`
    SELECT payload_json, tokens, updated_at
    FROM read_cache
    WHERE cache_key = ?
  `).get(cacheKey);
  if (!row) return null;
  return {
    payload: parseJsonText(row.payload_json, null),
    tokens: row.tokens,
    updatedAt: row.updated_at,
  };
}, { filePath: dbPath });

export const setReadCache = async ({
  filePath: dbPath = getStateDbPath(),
  relPath,
  mode,
  selector = '',
  contentHash,
  payload,
  tokens = 0,
} = {}) => withStateDb((db) => {
  if (!relPath || !mode || !contentHash || !payload) return null;
  const cacheKey = buildReadCacheKey({ filePath: relPath, mode, selector, contentHash });
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO read_cache(cache_key, file_path, mode, selector, content_hash, payload_json, tokens, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      payload_json = excluded.payload_json,
      tokens = excluded.tokens,
      updated_at = excluded.updated_at
  `).run(cacheKey, relPath, mode, selector, contentHash, toJsonText(payload), tokens, now, now);
  return { cacheKey, updatedAt: now };
}, { filePath: dbPath });

export const clearReadCachePersistent = async ({ filePath = getStateDbPath() } = {}) => withStateDb((db) => {
  return db.prepare('DELETE FROM read_cache').run().changes;
}, { filePath });

const LAST_TEST_FAILURE_META_KEY = 'last_test_failure';

export const setLastTestFailure = async ({
  filePath = getStateDbPath(),
  payload,
} = {}) => withStateDb((db) => {
  if (!payload) return null;
  const record = {
    ...payload,
    recordedAt: payload.recordedAt ?? new Date().toISOString(),
  };
  setMeta(db, LAST_TEST_FAILURE_META_KEY, toJsonText(record));
  return record;
}, { filePath });

export const getLastTestFailure = async ({
  filePath = getStateDbPath(),
} = {}) => withStateDb((db) => {
  const raw = getMeta(db, LAST_TEST_FAILURE_META_KEY);
  if (!raw) return null;
  return parseJsonText(raw, null);
}, { filePath, readOnly: true });

export const clearLastTestFailure = async ({
  filePath = getStateDbPath(),
} = {}) => withStateDb((db) => {
  db.prepare('DELETE FROM meta WHERE key = ?').run(LAST_TEST_FAILURE_META_KEY);
}, { filePath });
