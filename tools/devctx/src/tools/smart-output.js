import {
  OUTPUT_KINDS,
  OUTPUT_STATUSES,
  findOutputs,
  getOutputPolicy,
  outputStats,
  pruneNow,
  readOutput,
  recentOutputs,
  saveOutput,
} from '../outputs/store.js';
import { excerptOutput, summarizeOutput } from '../outputs/summarize.js';
import { recordDevctxOperation } from '../missed-opportunities.js';
import { recordDecision, DECISION_REASONS, EXPECTED_BENEFITS } from '../decision-explainer.js';

const VALID_ACTIONS = new Set(['save', 'search', 'excerpt', 'summary', 'list', 'stats', 'prune']);

const degraded = (action, reason) => ({
  success: false,
  action,
  degraded: true,
  reason,
  hint: 'The output store needs SQLite (Node 22+) and a writable .devctx directory. Other devctx tools keep working.',
});

const toMatchSnippet = (entry, query) => {
  if (!query || !entry.content) return [];
  const windows = excerptOutput(entry.content, { query, before: 1, after: 2, maxMatches: 2, maxChars: 200 });
  return windows.flatMap((window) => window.lines.filter((item) => item.text.toLowerCase().includes(query.toLowerCase())));
};

const stripContent = ({ content: _content, ...rest }) => rest;

export const smartOutput = async ({
  action = 'list',
  id,
  kind,
  status,
  query,
  content,
  command,
  label,
  exitCode,
  line,
  before,
  after,
  limit = 10,
} = {}) => {
  if (!VALID_ACTIONS.has(action)) {
    return { success: false, error: `Invalid action: ${action}. Must be one of: ${[...VALID_ACTIONS].join(', ')}` };
  }
  if (kind && !OUTPUT_KINDS.includes(kind)) {
    return { success: false, error: `Invalid kind: ${kind}. Must be one of: ${OUTPUT_KINDS.join(', ')}` };
  }
  if (status && !OUTPUT_STATUSES.includes(status)) {
    return { success: false, error: `Invalid status: ${status}. Must be one of: ${OUTPUT_STATUSES.join(', ')}` };
  }

  recordDevctxOperation();
  const policy = getOutputPolicy();

  switch (action) {
    case 'save': {
      const result = await saveOutput({ kind, label, command, exitCode, content });
      if (!result.saved) {
        return result.degraded
          ? degraded('save', result.reason)
          : { success: false, action: 'save', error: result.reason };
      }

      recordDecision({
        tool: 'smart_output',
        action: `persisted ${kind} output (${result.entry.bytes} bytes)`,
        reason: DECISION_REASONS.RELATED_FILES ?? 'output persistence',
        alternative: 'Re-running the command later to see the same output again',
        expectedBenefit: `${EXPECTED_BENEFITS.TOKEN_SAVINGS(0)}, recoverable output without a rerun`,
        context: `kind=${kind}, truncated=${result.truncated}, repeats=${result.entry.repeatCount}`,
      });

      return {
        success: true,
        action: 'save',
        entry: result.entry,
        truncated: result.truncated,
        scrubbed: result.scrubbed,
        ...(result.pruned ? { pruned: result.pruned } : {}),
        policy,
      };
    }

    case 'search': {
      const result = await findOutputs({ query, kind, status, limit });
      if (!result.ok) return degraded('search', result.reason);

      return {
        success: true,
        action: 'search',
        query: query ?? null,
        total: result.value.length,
        results: result.value.map((entry) => ({
          ...stripContent(entry),
          matches: toMatchSnippet(entry, query),
        })),
        hint: 'Use action="excerpt" with the entry id to pull surrounding lines, or action="summary" for error lines only.',
      };
    }

    case 'excerpt': {
      if (!Number.isInteger(id)) return { success: false, action: 'excerpt', error: 'excerpt requires a numeric id' };
      const result = await readOutput({ id });
      if (!result.ok) return degraded('excerpt', result.reason);
      if (!result.value) return { success: false, action: 'excerpt', error: `No output found with id ${id}` };

      const entry = result.value;
      return {
        success: true,
        action: 'excerpt',
        entry: stripContent(entry),
        windows: excerptOutput(entry.content, { query, line, before, after }),
      };
    }

    case 'summary': {
      if (!Number.isInteger(id)) return { success: false, action: 'summary', error: 'summary requires a numeric id' };
      const result = await readOutput({ id });
      if (!result.ok) return degraded('summary', result.reason);
      if (!result.value) return { success: false, action: 'summary', error: `No output found with id ${id}` };

      const entry = result.value;
      const summary = summarizeOutput(entry.content);
      return {
        success: true,
        action: 'summary',
        entry: stripContent(entry),
        summary,
        hint: summary.counts.errors > 0
          ? 'Use action="excerpt" with line=<errorLine> to expand any error in context.'
          : 'No error-like lines detected; head/tail shown instead.',
      };
    }

    case 'list': {
      const result = await recentOutputs({ kind, status, limit });
      if (!result.ok) return degraded('list', result.reason);
      return {
        success: true,
        action: 'list',
        total: result.value.length,
        results: result.value,
        policy,
      };
    }

    case 'stats': {
      const result = await outputStats();
      if (!result.ok) return degraded('stats', result.reason);
      return { success: true, action: 'stats', stats: result.value, policy };
    }

    case 'prune': {
      const result = await pruneNow();
      if (result.skipped) return degraded('prune', result.reason ?? 'prune skipped');
      return { success: true, action: 'prune', pruned: result, policy };
    }

    default:
      return { success: false, error: `Unhandled action: ${action}` };
  }
};
