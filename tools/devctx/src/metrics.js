import fs from 'node:fs/promises';
import path from 'node:path';
import { countTokens } from './tokenCounter.js';
import { devctxRoot, projectRoot } from './utils/paths.js';

const defaultMetricsDir = () => path.join(projectRoot, '.devctx');
const defaultMetricsFile = () => path.join(defaultMetricsDir(), 'metrics.jsonl');
const legacyMetricsFile = path.join(devctxRoot, '.devctx', 'metrics.jsonl');

export const getMetricsFilePath = () => process.env.DEVCTX_METRICS_FILE ?? defaultMetricsFile();
export const getLegacyMetricsFilePath = () => legacyMetricsFile;

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

export const persistMetrics = async (entry) => {
  try {
    const filePath = getMetricsFilePath();
    await ensureMetricsDir(filePath);
    await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    await rotateIfNeeded(filePath);
  } catch {
    // best-effort — never fail a tool call for metrics
  }
};
