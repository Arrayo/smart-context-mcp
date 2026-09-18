import path from 'node:path';
import { resolveSafePath } from '../utils/fs.js';
import { projectRoot } from '../utils/paths.js';
import { createSemanticProvider, normalizeSemanticRequest } from '../semantic/semantic-provider.js';
import { SMART_CODE_ACTIONS } from '../semantic/types.js';
import { analyzeSemanticImpact } from '../semantic/impact.js';
import { applyRename, planRename } from '../semantic/rename.js';
import { recordToolUsage } from '../usage-feedback.js';
import { recordDecision, DECISION_REASONS, EXPECTED_BENEFITS } from '../decision-explainer.js';
import { recordDevctxOperation } from '../missed-opportunities.js';

const DEFAULT_MAX_RESULTS = 20;
const TEST_PATH_RE = /(?:^|[/\\])(?:__tests__|tests?|specs?)[/\\]|(?:\.|\b)(?:test|spec)\.[^.]+$/i;
const PROVIDER_ACTIONS = new Set(['definition', 'references', 'implementations', 'diagnostics']);

const isTestPath = (filePath) => TEST_PATH_RE.test(String(filePath ?? ''));

const confidenceFor = (providerName, resultCount) => {
  if (providerName === 'fallback') return 'none';
  if (resultCount > 0) return 'high';
  return 'low';
};

const resolveRequestLocation = (provider, { location, symbol, filePath }) => {
  if (symbol && typeof provider.resolveSymbol === 'function') {
    const byName = provider.resolveSymbol({
      symbol,
      filePath: filePath ?? location?.filePath ?? null,
    });
    if (byName) return { location: byName, resolvedSymbol: symbol, resolution: 'symbol' };
  }

  if (location?.filePath) {
    return {
      location,
      resolvedSymbol: symbol ?? null,
      resolution: symbol ? 'position-fallback' : 'position',
    };
  }

  return { location: null, resolvedSymbol: symbol ?? null, resolution: 'unresolved' };
};

const filterResults = (results, { includeTests, maxResults }) => {
  const filtered = includeTests ? results : results.filter((item) => !isTestPath(item.filePath));
  const truncated = filtered.length > maxResults;
  return {
    results: filtered.slice(0, maxResults),
    total: filtered.length,
    returned: Math.min(filtered.length, maxResults),
    truncated,
  };
};

const emptyImpactPayload = ({ action, symbol, provider, resolution, message }) => ({
  success: true,
  action,
  symbol,
  provider: provider.provider,
  ...(provider.reason ? { providerReason: provider.reason } : {}),
  confidence: 'none',
  resolution,
  definition: null,
  impact: {
    direct: {
      source: 'semantic',
      files: [],
      locations: [],
      counts: { definitions: 0, references: 0, implementations: 0, files: 0 },
      truncated: false,
    },
    transitive: {
      source: 'import-graph',
      basis: 'heuristic-expansion',
      hops: 0,
      files: [],
      truncated: false,
      note: 'Transitive files come from the import graph, not LanguageService certainty.',
    },
    tests: { source: 'semantic+import-graph', files: [], total: 0, truncated: false },
    coverage: {
      hasDefinition: false,
      hasReferences: false,
      hasImplementations: false,
      hasTests: false,
      indexAvailable: false,
    },
    risk: {
      level: 'low',
      basis: 'heuristic',
      score: 0,
      reasons: [message],
      note: 'Risk is an estimate from counts and coverage signals, not a semantic certainty.',
    },
  },
  totals: { directFiles: 0, transitiveFiles: 0, tests: 0 },
  message,
});

export const smartCode = async ({
  action,
  filePath,
  symbol,
  line,
  character,
  includeTests = true,
  maxResults = DEFAULT_MAX_RESULTS,
  maxHops = 2,
  newName,
  dryRun = true,
  strict = false,
  maxFiles = 50,
  cwd,
  _provider,
} = {}) => {
  if (!SMART_CODE_ACTIONS.includes(action)) {
    return {
      success: false,
      error: `Unsupported action: ${action}`,
      availableActions: [...SMART_CODE_ACTIONS],
    };
  }

  const root = cwd ? path.resolve(cwd) : projectRoot;
  let safeFilePath = null;
  if (filePath) {
    try {
      const absolute = resolveSafePath(filePath, root);
      safeFilePath = path.relative(root, absolute).replace(/\\/g, '/');
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  const provider = _provider ?? createSemanticProvider({ root });
  const shouldDispose = !_provider && typeof provider.dispose === 'function';

  try {
    let request;
    try {
      request = normalizeSemanticRequest({
        action: action === 'impact' || action === 'rename' ? 'references' : action,
        symbol,
        filePath: safeFilePath,
        location: safeFilePath && Number.isInteger(line)
          ? { filePath: safeFilePath, line, character: Number.isInteger(character) ? character : 0 }
          : (safeFilePath ? { filePath: safeFilePath } : null),
      });
    } catch (error) {
      return { success: false, error: error.message };
    }

    const resolved = resolveRequestLocation(provider, {
      location: request.location,
      symbol: request.symbol,
      filePath: safeFilePath,
    });

    if (!resolved.location && action !== 'diagnostics') {
      if (action === 'rename') {
        return {
          success: false,
          action: 'rename',
          symbol: request.symbol,
          provider: provider.provider,
          dryRun: dryRun !== false,
          applied: false,
          conflicts: [{
            type: 'unresolved-target',
            severity: 'error',
            message: request.symbol
              ? `Symbol not found: ${request.symbol}`
              : 'Unable to resolve semantic location',
          }],
          plan: null,
        };
      }

      if (action === 'impact') {
        return emptyImpactPayload({
          action,
          symbol: request.symbol,
          provider,
          resolution: resolved.resolution,
          message: request.symbol
            ? `Symbol not found: ${request.symbol}`
            : 'Unable to resolve semantic location',
        });
      }

      return {
        success: true,
        action,
        symbol: request.symbol,
        provider: provider.provider,
        confidence: confidenceFor(provider.provider, 0),
        resolution: resolved.resolution,
        definition: null,
        results: [],
        total: 0,
        returned: 0,
        truncated: false,
        message: request.symbol
          ? `Symbol not found: ${request.symbol}`
          : 'Unable to resolve semantic location',
      };
    }

    const location = resolved.location ?? request.location;
    const limitedMax = Number.isInteger(maxResults) && maxResults > 0 ? maxResults : DEFAULT_MAX_RESULTS;

    if (action === 'rename') {
      const isDryRun = dryRun !== false;
      const planned = await planRename({
        provider,
        location,
        symbol: resolved.resolvedSymbol,
        newName,
        root,
        maxFiles: Number.isInteger(maxFiles) && maxFiles > 0 ? maxFiles : 50,
      });

      const blockingConflicts = planned.conflicts.filter((conflict) =>
        conflict.severity === 'error' || (strict === true && conflict.severity === 'warning'));
      const canApply = planned.ok && blockingConflicts.length === 0;

      let applied = null;
      if (!isDryRun && canApply) {
        applied = await applyRename({ provider, files: planned._files, root });
      }

      recordToolUsage({ tool: 'smart_code', savedTokens: 0, target: `rename:${resolved.resolvedSymbol ?? ''}` });
      recordDevctxOperation();
      recordDecision({
        tool: 'smart_code',
        action: `rename "${resolved.resolvedSymbol}" → "${newName}"${isDryRun ? ' (dryRun)' : ''}`,
        reason: DECISION_REASONS.RELATED_FILES ?? 'semantic refactor',
        alternative: 'Manual find/replace across call sites with no scope awareness',
        expectedBenefit: `${EXPECTED_BENEFITS.TOKEN_SAVINGS(0)}, scope-aware edits with planned diff before writing`,
        context: `provider=${provider.provider}, files=${planned.plan?.filesAffected ?? 0}, edits=${planned.plan?.totalEdits ?? 0}, applied=${Boolean(applied)}`,
      });

      return {
        success: canApply || isDryRun,
        action: 'rename',
        symbol: resolved.resolvedSymbol,
        newName: planned.newName ?? newName ?? null,
        provider: provider.provider,
        ...(provider.reason ? { providerReason: provider.reason } : {}),
        resolution: resolved.resolution,
        queryLocation: location,
        dryRun: isDryRun,
        canApply,
        applied: Boolean(applied),
        conflicts: planned.conflicts,
        plan: planned.plan,
        ...(applied ? {
          written: applied.written,
          diagnosticsAfter: applied.diagnostics,
        } : {}),
        ...(isDryRun && canApply
          ? { message: 'Dry run only — re-run with dryRun:false to write these edits.' }
          : {}),
        ...(!isDryRun && !canApply
          ? { message: 'Rename blocked by conflicts; nothing was written.' }
          : {}),
      };
    }

    if (action === 'impact') {
      const analyzed = await analyzeSemanticImpact({
        provider,
        location,
        symbol: resolved.resolvedSymbol,
        root,
        includeTests: includeTests !== false,
        maxResults: limitedMax,
        maxHops: Number.isInteger(maxHops) && maxHops > 0 ? maxHops : 2,
      });

      recordToolUsage({ tool: 'smart_code', savedTokens: 0, target: `impact:${request.symbol ?? safeFilePath ?? ''}` });
      recordDevctxOperation();
      recordDecision({
        tool: 'smart_code',
        action: 'impact via semantic + import-graph',
        reason: DECISION_REASONS.RELATED_FILES ?? 'semantic impact',
        alternative: 'Manual references + import walk + test discovery',
        expectedBenefit: `${EXPECTED_BENEFITS.TOKEN_SAVINGS(0)}, compact impact map without file bodies`,
        context: `provider=${provider.provider}, direct=${analyzed.totals.directFiles}, transitive=${analyzed.totals.transitiveFiles}, tests=${analyzed.totals.tests}`,
      });

      return {
        success: true,
        action: 'impact',
        symbol: resolved.resolvedSymbol,
        provider: provider.provider,
        ...(provider.reason ? { providerReason: provider.reason } : {}),
        confidence: analyzed.confidence,
        resolution: resolved.resolution,
        queryLocation: location,
        definition: analyzed.definition,
        impact: analyzed.impact,
        totals: analyzed.totals,
      };
    }

    let rawResults = [];
    let definition = null;

    if (action === 'diagnostics') {
      rawResults = await provider.diagnostics(location);
    } else if (PROVIDER_ACTIONS.has(action)) {
      rawResults = await provider[action](location);
      if (action !== 'definition') {
        const definitions = await provider.definition(location);
        definition = definitions[0] ?? null;
      } else {
        definition = rawResults[0] ?? null;
      }
    }

    const limited = filterResults(rawResults, {
      includeTests: includeTests !== false,
      maxResults: limitedMax,
    });

    recordToolUsage({ tool: 'smart_code', savedTokens: 0, target: `${action}:${request.symbol ?? safeFilePath ?? ''}` });
    recordDevctxOperation();
    recordDecision({
      tool: 'smart_code',
      action: `${action} via semantic provider`,
      reason: DECISION_REASONS.RELATED_FILES ?? 'semantic navigation',
      alternative: 'Manual Grep + full-file reads across call sites',
      expectedBenefit: `${EXPECTED_BENEFITS.TOKEN_SAVINGS(0)}, locations only without file bodies`,
      context: `provider=${provider.provider}, returned=${limited.returned}/${limited.total}`,
    });

    return {
      success: true,
      action,
      symbol: resolved.resolvedSymbol,
      provider: provider.provider,
      ...(provider.reason ? { providerReason: provider.reason } : {}),
      confidence: confidenceFor(provider.provider, limited.total),
      resolution: resolved.resolution,
      queryLocation: location,
      definition,
      ...limited,
    };
  } finally {
    if (shouldDispose) provider.dispose();
  }
};
