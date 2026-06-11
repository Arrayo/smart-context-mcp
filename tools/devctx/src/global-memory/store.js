import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scrubContent, hashProjectPath } from './scrub.js';
import { embed, cosineSimilarity, buildCorpusIdf } from '../embeddings/hashing.js';

const DEFAULT_GLOBAL_DIR = path.join(os.homedir(), '.devctx');
const DEFAULT_GLOBAL_DB = path.join(DEFAULT_GLOBAL_DIR, 'global.db');
const SCHEMA_VERSION = 2;

let sqliteModulePromise = null;

const loadSqliteModule = async () => {
  if (!sqliteModulePromise) {
    sqliteModulePromise = import('node:sqlite')
      .catch(() => {
        throw new Error('Global memory requires Node 22+ (node:sqlite)');
      });
  }
  return sqliteModulePromise;
};

export const getGlobalDbPath = () => {
  const override = process.env.DEVCTX_GLOBAL_DB?.trim();
  return override && override.length > 0 ? override : DEFAULT_GLOBAL_DB;
};

export const isGlobalMemoryEnabled = () => {
  const value = String(process.env.DEVCTX_GLOBAL_MEMORY ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
};

const ensureDir = (filePath) => {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT,
  project_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_entries_kind ON entries(kind);
CREATE INDEX IF NOT EXISTS idx_entries_project ON entries(project_hash);
CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at DESC);

CREATE TABLE IF NOT EXISTS noise_hints (
  project_hash TEXT NOT NULL,
  hint_key TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'search_noise',
  hits INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(project_hash, hint_key)
);

CREATE INDEX IF NOT EXISTS idx_noise_hints_project ON noise_hints(project_hash, hits DESC, updated_at DESC);
`;

const VALID_KINDS = new Set(['decision', 'pattern', 'playbook', 'note']);

const withDb = async (fn, { filePath = getGlobalDbPath(), readOnly = false } = {}) => {
  const { DatabaseSync } = await loadSqliteModule();
  if (!readOnly) ensureDir(filePath);

  if (readOnly && !fs.existsSync(filePath)) {
    return fn(null);
  }

  const db = new DatabaseSync(filePath, { readOnly });
  try {
    if (!readOnly) {
      db.exec(SCHEMA_SQL);
      const meta = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
      if (!meta) {
        db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run('schema_version', String(SCHEMA_VERSION));
      }
    }
    return fn(db);
  } finally {
    db.close();
  }
};

const normalizeTags = (tags) => {
  if (!tags) return null;
  if (typeof tags === 'string') return tags;
  if (Array.isArray(tags)) return JSON.stringify(tags.filter((t) => typeof t === 'string'));
  return null;
};

const parseTags = (raw) => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return typeof raw === 'string' ? raw.split(',').map((t) => t.trim()).filter(Boolean) : [];
  }
};

export const saveEntry = async ({
  kind,
  content,
  tags,
  projectPath,
  filePath = getGlobalDbPath(),
} = {}) => {
  if (!VALID_KINDS.has(kind)) {
    throw new Error(`Invalid kind: ${kind}. Must be one of: ${[...VALID_KINDS].join(', ')}`);
  }
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('content must be a non-empty string');
  }

  const scrubbed = scrubContent(content);
  const projectHash = projectPath ? hashProjectPath(projectPath) : null;
  const tagsJson = normalizeTags(tags);
  const now = Date.now();

  return withDb((db) => {
    const stmt = db.prepare(`
      INSERT INTO entries (kind, content, tags, project_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(kind, scrubbed, tagsJson, projectHash, now, now);
    return {
      id: Number(result.lastInsertRowid),
      kind,
      contentLength: scrubbed.length,
      projectHash,
      tags: parseTags(tagsJson),
      createdAt: now,
    };
  }, { filePath });
};

export const recallEntries = async ({
  kind,
  query,
  limit = 10,
  projectPath,
  filePath = getGlobalDbPath(),
} = {}) => {
  return withDb((db) => {
    if (!db) return { hits: [], total: 0 };
    const conditions = [];
    const params = [];
    if (kind) {
      conditions.push('kind = ?');
      params.push(kind);
    }
    if (projectPath) {
      conditions.push('project_hash = ?');
      params.push(hashProjectPath(projectPath));
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = db.prepare(`
      SELECT id, kind, content, tags, project_hash, created_at, updated_at, usage_count
      FROM entries
      ${where}
      ORDER BY created_at DESC
      LIMIT 500
    `).all(...params);

    if (!query || query.trim().length === 0) {
      return {
        hits: rows.slice(0, limit).map((r) => ({
          id: r.id,
          kind: r.kind,
          content: r.content,
          tags: parseTags(r.tags),
          createdAt: r.created_at,
          usageCount: r.usage_count,
          score: 0,
        })),
        total: rows.length,
      };
    }

    const idf = buildCorpusIdf(rows.map((r) => r.content));
    const queryVec = embed(query, { idf });
    const ranked = rows
      .map((r) => {
        const docVec = embed(r.content, { idf });
        const score = cosineSimilarity(queryVec, docVec);
        return { row: r, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return {
      hits: ranked.map(({ row, score }) => ({
        id: row.id,
        kind: row.kind,
        content: row.content,
        tags: parseTags(row.tags),
        createdAt: row.created_at,
        usageCount: row.usage_count,
        score: Number(score.toFixed(4)),
      })),
      total: rows.length,
    };
  }, { filePath, readOnly: true });
};

export const markEntryUsed = async ({
  id,
  filePath = getGlobalDbPath(),
} = {}) => {
  const now = Date.now();
  return withDb((db) => {
    const result = db.prepare(`
      UPDATE entries
      SET usage_count = usage_count + 1, last_used_at = ?
      WHERE id = ?
    `).run(now, id);
    return { id, updated: Number(result.changes) > 0, lastUsedAt: now };
  }, { filePath });
};

export const deleteEntry = async ({ id, filePath = getGlobalDbPath() } = {}) => {
  return withDb((db) => {
    const result = db.prepare('DELETE FROM entries WHERE id = ?').run(id);
    return { id, deleted: Number(result.changes) > 0 };
  }, { filePath });
};

export const listKinds = async ({ filePath = getGlobalDbPath() } = {}) => {
  return withDb((db) => {
    if (!db) return { kinds: [], total: 0 };
    const rows = db.prepare(`
      SELECT kind, COUNT(*) as count, MAX(created_at) as latest
      FROM entries
      GROUP BY kind
      ORDER BY count DESC
    `).all();
    return {
      kinds: rows.map((r) => ({ kind: r.kind, count: Number(r.count), latest: r.latest })),
      total: rows.reduce((sum, r) => sum + Number(r.count), 0),
    };
  }, { filePath, readOnly: true });
};

export const recordNoiseHint = async ({
  projectPath,
  hintKey,
  reason = 'search_noise',
  filePath = getGlobalDbPath(),
} = {}) => {
  if (!projectPath || !hintKey) {
    return null;
  }

  const projectHash = hashProjectPath(projectPath);
  const now = Date.now();
  return withDb((db) => {
    db.prepare(`
      INSERT INTO noise_hints(project_hash, hint_key, reason, hits, created_at, updated_at)
      VALUES(?, ?, ?, 1, ?, ?)
      ON CONFLICT(project_hash, hint_key) DO UPDATE SET
        reason = excluded.reason,
        hits = noise_hints.hits + 1,
        updated_at = excluded.updated_at
    `).run(projectHash, hintKey, reason, now, now);

    const row = db.prepare(`
      SELECT hits, updated_at
      FROM noise_hints
      WHERE project_hash = ? AND hint_key = ?
    `).get(projectHash, hintKey);

    return {
      projectHash,
      hintKey,
      hits: Number(row?.hits ?? 0),
      updatedAt: Number(row?.updated_at ?? now),
    };
  }, { filePath });
};

export const getNoiseHints = async ({
  projectPath,
  limit = 50,
  filePath = getGlobalDbPath(),
} = {}) => {
  if (!projectPath) {
    return { hints: [], total: 0 };
  }

  const projectHash = hashProjectPath(projectPath);
  return withDb((db) => {
    if (!db) return { hints: [], total: 0 };
    const rows = db.prepare(`
      SELECT hint_key, reason, hits, updated_at
      FROM noise_hints
      WHERE project_hash = ?
      ORDER BY hits DESC, updated_at DESC
      LIMIT ?
    `).all(projectHash, limit);

    return {
      hints: rows.map((row) => ({
        hintKey: row.hint_key,
        reason: row.reason,
        hits: Number(row.hits),
        penalty: Math.min(Number(row.hits) * 2, 12),
        updatedAt: Number(row.updated_at),
      })),
      total: rows.length,
    };
  }, { filePath, readOnly: true });
};

export const resetNoiseHints = async ({
  projectPath,
  hintKey,
  filePath = getGlobalDbPath(),
} = {}) => {
  if (!projectPath) {
    return { deleted: 0 };
  }

  const projectHash = hashProjectPath(projectPath);
  return withDb((db) => {
    const result = hintKey
      ? db.prepare('DELETE FROM noise_hints WHERE project_hash = ? AND hint_key = ?').run(projectHash, hintKey)
      : db.prepare('DELETE FROM noise_hints WHERE project_hash = ?').run(projectHash);
    return { deleted: Number(result.changes) };
  }, { filePath });
};

export const getStats = async ({ filePath = getGlobalDbPath() } = {}) => {
  return withDb((db) => {
    if (!db) {
      return {
        exists: false,
        filePath,
        enabled: isGlobalMemoryEnabled(),
        totalEntries: 0,
        byKind: {},
      };
    }
    const total = db.prepare('SELECT COUNT(*) as c FROM entries').get();
    const byKindRows = db.prepare('SELECT kind, COUNT(*) as c FROM entries GROUP BY kind').all();
    const byKind = {};
    for (const r of byKindRows) byKind[r.kind] = Number(r.c);
    const sizeBytes = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    return {
      exists: true,
      filePath,
      enabled: isGlobalMemoryEnabled(),
      totalEntries: Number(total.c),
      byKind,
      sizeBytes,
    };
  }, { filePath, readOnly: true });
};

export const VALID_GLOBAL_KINDS = VALID_KINDS;
