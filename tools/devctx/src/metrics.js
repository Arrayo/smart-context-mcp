import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { enforceRepoSafety } from './repo-safety.js';
import { countTokens } from './tokenCounter.js';
import { projectRoot } from './utils/paths.js';
import {
  ACTIVE_SESSION_SCOPE,
  getStateDbPath,
  importLegacyState,
  insertMetricEvent,
  withStateDb,
  withStateDbSnapshot,
} from './storage/sqlite.js';

const defaultMetricsDir = () => path.join(projectRoot, '.devctx');
const defaultMetricsFile = () => path.join(defaultMetricsDir(), 'metrics.jsonl');
const resolveEnvMetricsFile = () => process.env.DEVCTX_METRICS_FILE?.trim() || null;
const HARD_BLOCK_REPO_SAFETY_REASONS = [
  ['tracked', 'isTracked'],
  ['staged', 'isStaged'],
];

export const getMetricsFilePath = () => resolveEnvMetricsFile() ?? defaultMetricsFile();

let lastEnsuredDir = null;

const ensureMetricsDir = async (filePath) => {
  const dir = path.dirname(filePath);
  if (dir === lastEnsuredDir) return;
  await fs.mkdir(dir, { recursive: true });
  lastEnsuredDir = dir;
};

export const buildMetrics = ({ tool, target, rawText, compressedText }) => {
  const rawTokens = countTokens(rawText);
  const compressedTokens = countTokens(compressedText);
  const savedTokens = Math.max(0, rawTokens - compressedTokens);
  const savingsPct = rawTokens === 0 ? 0 : Number(((savedTokens / rawTokens) * 100).toFixed(2));

  return {
    tool,
    target,
    rawTokens,
    compressedTokens,
    savedTokens,
    savingsPct,
    timestamp: new Date().toISOString(),
  };
};

export const getCompressedTokens = (entry) => Number(entry.compressedTokens ?? entry.finalTokens ?? 0);

export const getSavedTokens = (entry, compressedTokens = getCompressedTokens(entry)) => {
  if (entry.savedTokens !== undefined) {
    return Number(entry.savedTokens ?? 0);
  }

  return Math.max(0, Number(entry.rawTokens ?? 0) - compressedTokens);
};

export const getEntrySavingsPct = (
  entry,
  compressedTokens = getCompressedTokens(entry),
  savedTokens = getSavedTokens(entry, compressedTokens),
) => {
  const rawTokens = Number(entry.rawTokens ?? 0);
  return rawTokens > 0 ? Number(((savedTokens / rawTokens) * 100).toFixed(2)) : 0;
};

export const MAX_METRICS_BYTES = 1024 * 1024;
export const KEEP_LINES_AFTER_ROTATION = 500;

const rotateIfNeeded = async (filePath) => {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size <= MAX_METRICS_BYTES) return;

    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.trim().split('\n');
    const kept = lines.slice(-KEEP_LINES_AFTER_ROTATION).join('\n') + '\n';
    await fs.writeFile(filePath, kept, 'utf8');
  } catch {
    // file might not exist yet
  }
};

const readActiveSessionIdFromDb = (db) =>
  db.prepare('SELECT session_id FROM active_session WHERE scope = ?').get(ACTIVE_SESSION_SCOPE)?.session_id ?? null;

const getSqliteSafetyPolicy = () => {
  const repoSafety = enforceRepoSafety();
  const reasons = HARD_BLOCK_REPO_SAFETY_REASONS
    .filter(([, field]) => repoSafety[field])
    .map(([reason]) => reason);

  return {
    repoSafety,
    shouldBlock: reasons.length > 0,
    reasons,
  };
};

export const getActiveSessionId = async () => {
  const safety = getSqliteSafetyPolicy();
  const stateDbPath = getStateDbPath();
  if (safety.shouldBlock) {
    if (!fsSync.existsSync(stateDbPath)) {
      return null;
    }

    return withStateDbSnapshot((db) => readActiveSessionIdFromDb(db), { filePath: stateDbPath });
  }

  await importLegacyState();
  return withStateDb((db) => readActiveSessionIdFromDb(db));
};

const appendLegacyMetricsFile = async (entry) => {
  const envFile = resolveEnvMetricsFile();
  if (!envFile) {
    return;
  }

  const filePath = path.resolve(envFile);
  await ensureMetricsDir(filePath);
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  await rotateIfNeeded(filePath);
};

export const persistMetrics = async (entry) => {
  let enrichedEntry = entry;

  try {
    const resolvedInput = resolveMetricsInput();
    const safety = getSqliteSafetyPolicy();

    if (!safety.shouldBlock) {
      await importLegacyState();

      await withStateDb((db) => {
        const sessionId = entry.sessionId ?? readActiveSessionIdFromDb(db);
        enrichedEntry = sessionId ? { ...entry, sessionId } : entry;

        if (resolvedInput.kind === 'sqlite') {
          insertMetricEvent(db, enrichedEntry);
        }
      });
    }
  } catch {
    // best-effort — never fail a tool call for metrics
  }

  try {
    await appendLegacyMetricsFile(enrichedEntry);
  } catch {
    // best-effort — never fail a tool call for metrics
  }
};

export const resolveMetricsInput = ({ file } = {}) => {
  if (file) {
    return {
      kind: 'file',
      storagePath: path.resolve(file),
      filePath: path.resolve(file),
      source: 'explicit',
    };
  }

  const envFile = resolveEnvMetricsFile();
  if (envFile) {
    const filePath = path.resolve(envFile);
    return {
      kind: 'file',
      storagePath: filePath,
      filePath,
      source: 'env_file',
    };
  }

  const storagePath = getStateDbPath();
  return {
    kind: 'sqlite',
    storagePath,
    filePath: storagePath,
    source: 'sqlite',
  };
};

export const readMetricsEntries = (filePath) => {
  if (!fsSync.existsSync(filePath)) {
    throw new Error(`No metrics file found at ${filePath}`);
  }

  const lines = fsSync.readFileSync(filePath, 'utf8')
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

export const aggregateMetrics = (entries) => {
  const byTool = new Map();
  const overheadByTool = new Map();
  let rawTokens = 0;
  let compressedTokens = 0;
  let savedTokens = 0;
  let overheadTokens = 0;

  for (const entry of entries) {
    const tool = entry.tool ?? 'unknown';
    const compressedTokensForEntry = getCompressedTokens(entry);
    const savedTokensForEntry = getSavedTokens(entry, compressedTokensForEntry);
    const overheadTokensForEntry = Math.max(0, Number(entry.metadata?.overheadTokens ?? 0));
    const current = byTool.get(tool) ?? {
      tool,
      count: 0,
      rawTokens: 0,
      compressedTokens: 0,
      savedTokens: 0,
    };

    current.count += 1;
    current.rawTokens += Number(entry.rawTokens ?? 0);
    current.compressedTokens += compressedTokensForEntry;
    current.savedTokens += savedTokensForEntry;
    byTool.set(tool, current);

    const overheadCurrent = overheadByTool.get(tool) ?? {
      tool,
      count: 0,
      overheadTokens: 0,
    };
    if (overheadTokensForEntry > 0) {
      overheadCurrent.count += 1;
      overheadCurrent.overheadTokens += overheadTokensForEntry;
      overheadByTool.set(tool, overheadCurrent);
    }

    rawTokens += Number(entry.rawTokens ?? 0);
    compressedTokens += compressedTokensForEntry;
    savedTokens += savedTokensForEntry;
    overheadTokens += overheadTokensForEntry;
  }

  const tools = [...byTool.values()]
    .map((item) => ({
      ...item,
      savingsPct: item.rawTokens > 0 ? Number(((item.savedTokens / item.rawTokens) * 100).toFixed(2)) : 0,
    }))
    .sort((a, b) => b.savedTokens - a.savedTokens || b.count - a.count || a.tool.localeCompare(b.tool));

  const overheadTools = [...overheadByTool.values()]
    .sort((a, b) => b.overheadTokens - a.overheadTokens || b.count - a.count || a.tool.localeCompare(b.tool));

  return {
    count: entries.length,
    rawTokens,
    compressedTokens,
    savedTokens,
    savingsPct: rawTokens > 0 ? Number(((savedTokens / rawTokens) * 100).toFixed(2)) : 0,
    tools,
    overheadTokens,
    overheadPctOfRaw: rawTokens > 0 ? Number(((overheadTokens / rawTokens) * 100).toFixed(2)) : 0,
    overheadTools,
  };
};
