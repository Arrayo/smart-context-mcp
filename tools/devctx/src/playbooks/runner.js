import { smartContext } from '../tools/smart-context.js';
import { smartSearch } from '../tools/smart-search.js';
import { smartRead } from '../tools/smart-read.js';
import { smartReadBatch } from '../tools/smart-read-batch.js';
import { smartTest } from '../tools/smart-test.js';
import { smartReview } from '../tools/smart-review.js';
import { smartCode } from '../tools/smart-code.js';
import { smartOutput } from '../tools/smart-output.js';
import { smartShell } from '../tools/smart-shell.js';
import { smartSummary } from '../tools/smart-summary.js';
import { smartTurn } from '../tools/smart-turn.js';
import { smartStatus } from '../tools/smart-status.js';
import { smartDoctor } from '../tools/smart-doctor.js';
import { smartMetrics } from '../tools/smart-metrics.js';

const TOOL_REGISTRY = {
  smart_context: smartContext,
  smart_search: smartSearch,
  smart_read: smartRead,
  smart_read_batch: smartReadBatch,
  smart_test: smartTest,
  smart_review: smartReview,
  smart_code: smartCode,
  smart_output: smartOutput,
  smart_shell: smartShell,
  smart_summary: smartSummary,
  smart_turn: smartTurn,
  smart_status: smartStatus,
  smart_doctor: smartDoctor,
  smart_metrics: smartMetrics,
};

const TEMPLATE_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g;

const resolvePath = (obj, dottedKey) => {
  const segments = dottedKey.split('.');
  let current = obj;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    current = current[seg];
  }
  return current;
};

export const interpolate = (value, scope) => {
  if (typeof value === 'string') {
    const full = value.match(/^\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}$/);
    if (full) {
      const resolved = resolvePath(scope, full[1]);
      return resolved === undefined ? value : resolved;
    }
    return value.replace(TEMPLATE_RE, (match, key) => {
      const resolved = resolvePath(scope, key);
      if (resolved === undefined || resolved === null) return '';
      if (typeof resolved === 'object') return JSON.stringify(resolved);
      return String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolate(item, scope));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, scope);
    return out;
  }
  return value;
};

const evaluateWhen = (whenExpr, scope) => {
  if (!whenExpr) return true;
  const expanded = interpolate(whenExpr, scope);
  if (typeof expanded === 'boolean') return expanded;
  if (expanded === null || expanded === undefined) return false;
  if (typeof expanded === 'string') {
    const lower = expanded.trim().toLowerCase();
    if (lower === 'false' || lower === '0' || lower === '' || lower === 'no') return false;
    return true;
  }
  return Boolean(expanded);
};

export const runPlaybook = async (playbook, args = {}, { dryRun = false, toolRegistry = TOOL_REGISTRY } = {}) => {
  const scope = { args: { ...playbook.defaults, ...args } };
  const steps = [];
  const startedAt = Date.now();
  let failed = false;

  for (const [i, rawStep] of playbook.steps.entries()) {
    const stepStart = Date.now();
    const skipped = !evaluateWhen(rawStep.when, scope);

    if (skipped) {
      steps.push({
        index: i,
        tool: rawStep.tool,
        label: rawStep.label,
        args: rawStep.args,
        ok: true,
        skipped: true,
        result: null,
        elapsedMs: 0,
      });
      continue;
    }

    const tool = toolRegistry[rawStep.tool];
    if (!tool) {
      steps.push({
        index: i,
        tool: rawStep.tool,
        label: rawStep.label,
        args: rawStep.args,
        ok: false,
        skipped: false,
        error: `Tool not allowed in playbooks: ${rawStep.tool}`,
        elapsedMs: 0,
      });
      failed = true;
      if (playbook.stopOnFail) break;
      continue;
    }

    const resolvedArgs = interpolate(rawStep.args, scope);

    if (dryRun) {
      steps.push({
        index: i,
        tool: rawStep.tool,
        label: rawStep.label,
        args: resolvedArgs,
        ok: true,
        skipped: false,
        dryRun: true,
        elapsedMs: 0,
      });
      continue;
    }

    try {
      const result = await tool(resolvedArgs);
      const ok = result?.success !== false;
      steps.push({
        index: i,
        tool: rawStep.tool,
        label: rawStep.label,
        args: resolvedArgs,
        ok,
        skipped: false,
        result,
        elapsedMs: Date.now() - stepStart,
      });
      if (!ok) {
        failed = true;
        if (playbook.stopOnFail) break;
      }
      scope[`step${i}`] = result;
      if (rawStep.label) scope[rawStep.label] = result;
    } catch (err) {
      steps.push({
        index: i,
        tool: rawStep.tool,
        label: rawStep.label,
        args: resolvedArgs,
        ok: false,
        skipped: false,
        error: err?.message ?? String(err),
        elapsedMs: Date.now() - stepStart,
      });
      failed = true;
      if (playbook.stopOnFail) break;
    }
  }

  return {
    name: playbook.name,
    description: playbook.description,
    success: !failed,
    steps,
    stepCount: playbook.steps.length,
    executed: steps.filter((s) => !s.skipped && !s.dryRun).length,
    skipped: steps.filter((s) => s.skipped).length,
    totalElapsedMs: Date.now() - startedAt,
    dryRun: !!dryRun,
  };
};

export const _internal = { TOOL_REGISTRY, resolvePath, evaluateWhen };
