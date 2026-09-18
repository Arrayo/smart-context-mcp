import crypto from 'node:crypto';
import { scrubContent } from '../global-memory/scrub.js';
import { truncateForStorage } from './summarize.js';
import {
  getOutput,
  getOutputStats,
  insertOutput,
  listOutputs,
  pruneOutputs,
  searchOutputs,
} from '../storage/sqlite.js';

export const OUTPUT_KINDS = ['shell', 'test', 'build', 'lint', 'diff'];
export const OUTPUT_STATUSES = ['pass', 'fail', 'unknown'];

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_MAX_PER_KIND = 50;
const PRUNE_THROTTLE_MS = 60_000;

let lastPruneAt = 0;

const readPositiveInt = (raw, fallback) => {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const isOutputCaptureEnabled = () => process.env.DEVCTX_OUTPUT_STORE === 'true';

export const getOutputPolicy = () => ({
  captureEnabled: isOutputCaptureEnabled(),
  maxBytesPerOutput: readPositiveInt(process.env.DEVCTX_OUTPUT_MAX_BYTES, DEFAULT_MAX_BYTES),
  retentionDays: readPositiveInt(process.env.DEVCTX_OUTPUT_RETENTION_DAYS, DEFAULT_RETENTION_DAYS),
  maxPerKind: readPositiveInt(process.env.DEVCTX_OUTPUT_MAX_PER_KIND, DEFAULT_MAX_PER_KIND),
  scrubbed: true,
  kinds: OUTPUT_KINDS,
});

export const normalizeKind = (kind) => (OUTPUT_KINDS.includes(kind) ? kind : null);

export const inferKindFromCommand = (command = '') => {
  const text = String(command).toLowerCase();
  if (/\b(test|vitest|jest|mocha|pytest)\b/.test(text)) return 'test';
  if (/\b(lint|eslint|prettier|ruff|clippy)\b/.test(text)) return 'lint';
  if (/\b(build|tsc|compile|webpack|vite|rollup)\b/.test(text)) return 'build';
  if (/\bdiff\b/.test(text)) return 'diff';
  return 'shell';
};

export const deriveStatus = ({ status, exitCode }) => {
  if (OUTPUT_STATUSES.includes(status)) return status;
  if (exitCode === 0) return 'pass';
  if (Number.isInteger(exitCode)) return 'fail';
  return 'unknown';
};

const hashContent = (content) => crypto.createHash('sha1').update(content).digest('hex');

export const safeStoreCall = async (operation, { fallback = null } = {}) => {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return {
      ok: false,
      value: fallback,
      degraded: true,
      reason: error?.message ?? 'output store unavailable',
    };
  }
};

const maybePrune = async ({ force = false } = {}) => {
  const now = Date.now();
  if (!force && now - lastPruneAt < PRUNE_THROTTLE_MS) {
    return { skipped: true, reason: 'throttled' };
  }
  lastPruneAt = now;

  const policy = getOutputPolicy();
  const result = await safeStoreCall(() => pruneOutputs({
    retentionDays: policy.retentionDays,
    maxPerKind: policy.maxPerKind,
  }));

  return result.ok ? { skipped: false, ...result.value } : { skipped: true, reason: result.reason };
};

export const resetPruneThrottle = () => { lastPruneAt = 0; };

export const saveOutput = async ({
  kind,
  label = '',
  command = '',
  exitCode = null,
  status,
  content,
  sessionId = null,
  taskId = null,
} = {}) => {
  const normalizedKind = normalizeKind(kind);
  if (!normalizedKind) {
    return { saved: false, reason: `invalid kind: ${kind}. Valid kinds: ${OUTPUT_KINDS.join(', ')}` };
  }
  if (typeof content !== 'string' || content.length === 0) {
    return { saved: false, reason: 'content is required' };
  }

  const policy = getOutputPolicy();
  const scrubbed = scrubContent(content);
  const { content: stored, bytes, truncated } = truncateForStorage(scrubbed, policy.maxBytesPerOutput);

  const result = await safeStoreCall(() => insertOutput({
    kind: normalizedKind,
    label: label.slice(0, 200),
    command: command.slice(0, 500),
    exitCode,
    status: deriveStatus({ status, exitCode }),
    content: stored,
    contentHash: hashContent(stored),
    bytes,
    lines: stored.split('\n').length,
    truncated,
    sessionId,
    taskId,
  }));

  if (!result.ok) {
    return { saved: false, degraded: true, reason: result.reason };
  }

  const pruned = await maybePrune();

  return {
    saved: true,
    entry: result.value,
    truncated,
    scrubbed: scrubbed !== content,
    ...(pruned.skipped ? {} : { pruned }),
  };
};

export const captureOutput = async (payload) => {
  if (!isOutputCaptureEnabled()) {
    return { saved: false, reason: 'capture disabled (set DEVCTX_OUTPUT_STORE=true)' };
  }
  return saveOutput(payload);
};

export const findOutputs = (params) => safeStoreCall(() => searchOutputs(params), { fallback: [] });
export const readOutput = (params) => safeStoreCall(() => getOutput(params));
export const recentOutputs = (params) => safeStoreCall(() => listOutputs(params), { fallback: [] });
export const outputStats = () => safeStoreCall(() => getOutputStats(), { fallback: null });
export const pruneNow = () => maybePrune({ force: true });
