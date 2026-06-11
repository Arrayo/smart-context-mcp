import path from 'node:path';
import fs from 'node:fs';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { smartSearch, VALID_INTENTS } from './smart-search.js';
import { smartRead } from './smart-read.js';
import { smartReadBatch } from './smart-read-batch.js';
import { loadIndex, queryRelated, getGraphCoverage } from '../index.js';
import { ensureIndexReady } from '../index-manager.js';
import { buildPathsResult } from '../graph-paths.js';
import { projectRoot } from '../utils/paths.js';
import { resolveSafePath } from '../utils/fs.js';
import { countTokens } from '../tokenCounter.js';
import { consumeTokenBudget, normalizeTokenBudget, resolveTokenBudgetWindow } from '../utils/task-budget.js';
import { persistMetrics } from '../metrics.js';
import { predictContextFiles, recordContextAccess } from '../context-patterns.js';
import { recordToolUsage } from '../usage-feedback.js';
import { recordDecision, DECISION_REASONS, EXPECTED_BENEFITS } from '../decision-explainer.js';
import { recordDevctxOperation } from '../missed-opportunities.js';
import { createProgressReporter } from '../streaming.js';
import { 
  getDetailedDiff, 
  analyzeChangeImpact, 
  expandChangedContext, 
  generateDiffSummary as generateDetailedDiffSummary,
  getChangedSymbols,
} from '../diff-analysis.js';
import {
  inferIntent,
  extractSymbolCandidates,
  extractSearchQueries,
  extractExpandedQueries,
  extractFallbackSearchQuery,
  extractKeywordQueries,
  extractLiteralPatterns,
} from '../utils/query-extraction.js';
import {
  dedupeEvidence,
  buildSymbolPreviews,
  attachSymbolEvidence,
  computeStaticUtility,
  inferRelatedRole,
  computePrimarySignal,
  computePrimaryPromotionScore,
  normalizePrimaryCandidate,
  computeMarginalPenalty,
  scorePrimarySeed,
  rerankPrimarySeeds,
  ROLE_RANK,
  ROLE_BASE_SCORE,
  EVIDENCE_BASE_SCORE,
} from '../utils/context-scoring.js';

const execFile = promisify(execFileCallback);

const uniqueList = (items = []) => [...new Set(items.filter(Boolean))];

const expandWithGraph = (primarySeeds, index, root) => {
  const files = new Map();

  const upsert = (rel, next) => {
    const absPath = next.absPath ?? path.join(root, rel);
    const existing = files.get(rel);

    if (!existing) {
      files.set(rel, {
        absPath,
        role: next.role,
        evidence: dedupeEvidence(next.evidence ?? []),
        ...(next.matchedSymbols?.length ? { matchedSymbols: uniqueList(next.matchedSymbols).slice(0, 3) } : {}),
      });
      return;
    }

    const role = (ROLE_RANK[next.role] ?? 99) < (ROLE_RANK[existing.role] ?? 99) ? next.role : existing.role;
    const evidence = dedupeEvidence([...(existing.evidence ?? []), ...(next.evidence ?? [])]);
    const matchedSymbols = uniqueList([...(existing.matchedSymbols ?? []), ...(next.matchedSymbols ?? [])]).slice(0, 3);

    files.set(rel, {
      ...existing,
      absPath,
      role,
      evidence,
      ...(matchedSymbols.length ? { matchedSymbols } : {}),
    });
  };

  for (const seed of primarySeeds) {
    const rel = seed.rel ?? path.relative(root, seed.absPath).replace(/\\/g, '/');
    upsert(rel, { role: 'primary', absPath: seed.absPath, evidence: seed.evidence });
  }

  if (!index) return { files, neighbors: [] };

  const allNeighbors = new Set();

  for (const seed of primarySeeds) {
    const rel = seed.rel ?? path.relative(root, seed.absPath).replace(/\\/g, '/');
    if (!index.files?.[rel]) continue;

    const related = queryRelated(index, rel);

    for (const p of related.imports) {
      upsert(p, { role: 'dependency', evidence: [{ type: 'dependencyOf', via: rel }] });
    }
    for (const p of related.importedBy) {
      upsert(p, { role: 'dependent', evidence: [{ type: 'dependentOf', via: rel }] });
    }
    for (const p of related.tests) {
      upsert(p, { role: 'test', evidence: [{ type: 'testOf', via: rel }] });
    }
    for (const p of related.neighbors) {
      if (!files.has(p)) allNeighbors.add(p);
    }
  }

  return { files, neighbors: [...allNeighbors] };
};

const checkIndexFreshness = (idx, absPaths, root) => {
  if (!idx) return 'unavailable';
  for (const abs of absPaths) {
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    const entry = idx.files?.[rel];
    if (!entry) continue;
    try {
      const diskMtime = Math.floor(fs.statSync(abs).mtimeMs);
      if (diskMtime !== entry.mtime) return 'stale';
    } catch { /* file gone or unreadable */ }
  }
  return 'fresh';
};

const mergeIndexFreshness = (values) => {
  if (values.includes('stale')) return 'stale';
  if (values.includes('fresh')) return 'fresh';
  return 'unavailable';
};

const getPreviewOptions = (item, detailMode) => {
  if (detailMode === 'minimal') {
    return { includeFallback: true, maxItems: item.role === 'primary' ? 3 : 2 };
  }

  if ((item.matchedSymbols?.length ?? 0) > 0) {
    return { includeFallback: true, maxItems: 3 };
  }

  if (item.role === 'primary') {
    return { includeFallback: true, maxItems: 2 };
  }

  if (item.role === 'dependency' || item.role === 'test') {
    return { includeFallback: true, maxItems: 1 };
  }

  return { includeFallback: false, maxItems: 0 };
};

export const allocateReads = (files, maxTokens, intent, detailMode = 'balanced') => {
  const maxFiles = Math.min(10, Math.ceil(maxTokens / 800));
  const tightBudget = maxTokens < 4000;

  const roleLimits = {
    primary: 5,
    test: intent === 'tests' ? 3 : 2,
    dependency: 3,
    dependent: 2,
  };

  const candidates = [...files.entries()].map(([rel, info]) => ({
    rel,
    ...info,
    evidence: dedupeEvidence(info.evidence ?? []),
    matchedSymbols: uniqueList(info.matchedSymbols ?? []).slice(0, 3),
  }));

  const selected = [];
  const plan = [];

  while (plan.length < maxFiles) {
    let best = null;

    for (const candidate of candidates) {
      if (selected.some((item) => item.rel === candidate.rel)) continue;
      if ((roleLimits[candidate.role] ?? 0) <= 0) continue;

      const utility = computeStaticUtility(candidate, intent) - computeMarginalPenalty(candidate, selected);
      if (!best
        || utility > best.utility
        || (utility === best.utility && (ROLE_RANK[candidate.role] ?? 99) < (ROLE_RANK[best.role] ?? 99))
        || (utility === best.utility && candidate.rel < best.rel)) {
        best = { ...candidate, utility };
      }
    }

    if (!best) break;

    const mode = detailMode === 'deep'
      ? 'full'
      : 'signatures';

    roleLimits[best.role]--;
    selected.push(best);
    plan.push({ ...best, mode });
  }

  return plan;
};

const getFileSymbolEntries = (index, rel) => index?.files?.[rel]?.symbols ?? [];

const getSymbolListLimit = (item, detailMode) => {
  if (detailMode === 'minimal') return item.role === 'primary' ? 4 : 2;
  return item.role === 'primary' ? 6 : 3;
};

const getSymbolSignatureLimit = (item, detailMode, readMode) => {
  if (detailMode === 'minimal') return item.role === 'primary' ? 4 : 2;
  if (readMode === 'full') return item.role === 'primary' ? 8 : 4;
  return item.role === 'primary' ? 6 : 3;
};

const getSymbolSignatures = (entries, maxItems = 10) =>
  entries.filter((entry) => entry.signature).slice(0, maxItems).map((entry) => entry.signature);

const shouldIncludeSymbolNames = (item, symbolPreviews, readMode) => {
  if (item.role === 'primary') return true;
  if (readMode === 'full') return true;
  return symbolPreviews.length === 0;
};

const shouldIncludeSymbolSignatures = (item, symbolPreviews) => {
  if (item.role === 'primary') return true;
  return symbolPreviews.length === 0;
};

const buildContextItemPayload = (item, index, detailMode, readMode = 'index-only', content = null) => {
  const fileSymbolEntries = getFileSymbolEntries(index, item.rel);
  const symbolPreviews = buildSymbolPreviews(
    fileSymbolEntries,
    item.matchedSymbols ?? [],
    getPreviewOptions(item, detailMode),
  );
  const fileSymbols = shouldIncludeSymbolNames(item, symbolPreviews, readMode)
    ? fileSymbolEntries.map((entry) => entry.name).slice(0, getSymbolListLimit(item, detailMode))
    : [];
  const symbolSignatures = shouldIncludeSymbolSignatures(item, symbolPreviews)
    ? getSymbolSignatures(fileSymbolEntries, getSymbolSignatureLimit(item, detailMode, readMode))
    : [];

  return {
    file: item.rel,
    role: item.role,
    ...(fileSymbols.length > 0 ? { symbols: fileSymbols } : {}),
    ...(symbolSignatures.length > 0 ? { symbolSignatures } : {}),
    ...(symbolPreviews.length > 0 ? { symbolPreviews } : {}),
    ...(typeof content === 'string' && content.length > 0 ? { content } : {}),
  };
};

const hasStrongIndexSignal = (payload) =>
  (payload.symbolPreviews?.length ?? 0) > 0 || (payload.symbolSignatures?.length ?? 0) > 0;

const shouldReadContentForItem = (item, payload, detailMode, includeSet, intent) => {
  if (!includeSet.has('content') || detailMode === 'minimal') return false;
  if (detailMode === 'deep') return true;

  const strongIndexSignal = hasStrongIndexSignal(payload);

  if (item.role === 'primary') {
    return true;
  }

  if (item.role === 'test' && intent === 'tests') {
    return !strongIndexSignal;
  }

  if (item.role === 'dependency') {
    if ((item.matchedSymbols?.length ?? 0) > 0) return true;
    return !strongIndexSignal && (payload.symbols?.length ?? 0) === 0;
  }

  return false;
};

const BLOCKED_REF_RE = /[|&;<>`\n\r$(){}]/;

export const getChangedFiles = async (diff, root) => {
  const ref = diff === true ? 'HEAD' : String(diff);

  if (BLOCKED_REF_RE.test(ref)) {
    return { ref, files: [], skippedDeleted: 0, error: 'Invalid ref: contains shell metacharacters' };
  }

  try {
    const { stdout } = await execFile('git', ['diff', '--name-only', ref], {
      cwd: root,
      timeout: 10000,
    });

    const allPaths = stdout.split('\n').map((l) => l.trim()).filter(Boolean);

    if (ref === 'HEAD') {
      try {
        const { stdout: untrackedOut } = await execFile(
          'git', ['ls-files', '--others', '--exclude-standard'],
          { cwd: root, timeout: 10000 },
        );
        const pathSet = new Set(allPaths);
        for (const u of untrackedOut.split('\n').map((l) => l.trim()).filter(Boolean)) {
          if (!pathSet.has(u)) {
            allPaths.push(u);
            pathSet.add(u);
          }
        }
      } catch { /* ignore — untracked listing is best-effort */ }
    }

    let skippedDeleted = 0;
    const files = [];

    for (const rel of allPaths) {
      const abs = path.join(root, rel);
      if (fs.existsSync(abs)) {
        files.push(rel);
      } else {
        skippedDeleted++;
      }
    }

    return { ref, files, skippedDeleted };
  } catch (err) {
    const msg = err.stderr?.trim() || err.message || 'git diff failed';
    return { ref, files: [], skippedDeleted: 0, error: msg };
  }
};

const filterFoundSymbols = (content, candidates) => {
  if (candidates.length <= 1) {
    return content.includes('Symbol not found') ? null : content;
  }

  const sections = content.split(/(?=^--- )/m);
  const kept = sections.filter((s) => !s.includes('Symbol not found'));
  if (kept.length === 0) return null;
  return kept.join('').trim();
};

const VALID_DETAIL_MODES = new Set(['minimal', 'balanced', 'deep']);
const DEFAULT_INCLUDE = ['content', 'graph', 'hints', 'symbolDetail'];

const PATH_MODE_MAX_HOPS = 5;

const runPathsMode = async ({ from, to, maxHops, directed, progress, startTime }) => {
  const root = projectRoot;
  await ensureIndexReady({ root });
  const index = loadIndex(root);

  if (!index) {
    return {
      success: false,
      mode: 'paths',
      paths: {
        from,
        to,
        found: false,
        reason: 'index-unavailable',
        path: [],
        hops: null,
        fallback: null,
      },
      hints: ['Run build_index before requesting paths.'],
    };
  }

  const result = buildPathsResult(index, from, to, {
    maxHops: maxHops ?? PATH_MODE_MAX_HOPS,
    directed: !!directed,
  });

  recordDevctxOperation();
  recordToolUsage({ tool: 'smart_context', savedTokens: 0, target: `paths(${from}→${to})` });
  recordDecision({
    tool: 'smart_context',
    action: `find path "${from}" → "${to}"`,
    reason: DECISION_REASONS.RELATED_FILES ?? 'graph traversal',
    alternative: 'Multiple smart_search/smart_read across import graph',
    expectedBenefit: 'Single-call graph traversal with signatures per hop',
    context: result.found ? `${result.hops} hops` : 'no path; fallback neighbors',
  });

  if (progress) {
    progress.complete({
      mode: 'paths',
      from,
      to,
      hops: result.hops,
      found: result.found,
      latencyMs: Date.now() - startTime,
    });
  }

  return {
    success: true,
    mode: 'paths',
    paths: result,
  };
};

export const smartContext = async ({
  task,
  intent,
  maxTokens = 12000,
  tokenBudget,
  entryFile,
  diff,
  detail = 'balanced',
  include = DEFAULT_INCLUDE,
  prefetch = false,
  paths,
  pathMaxHops,
  pathDirected,
  progress: enableProgress = false,
}) => {
  const progress = enableProgress ? createProgressReporter('smart_context') : null;
  const startTime = Date.now();
  const normalizedTokenBudget = normalizeTokenBudget(tokenBudget);
  const budgetWindow = resolveTokenBudgetWindow({ tokenBudget: normalizedTokenBudget, maxTokens });
  const effectiveMaxTokens = budgetWindow.effectiveMaxTokens ?? 12000;

  if (paths && typeof paths === 'object' && paths.from && paths.to && !task) {
    if (progress) {
      progress.report({ phase: 'paths', from: paths.from, to: paths.to });
    }
    return runPathsMode({
      from: paths.from,
      to: paths.to,
      maxHops: pathMaxHops,
      directed: pathDirected,
      progress,
      startTime,
    });
  }

  if (!task) {
    return {
      success: false,
      error: 'task is required (or paths.from + paths.to for paths mode)',
    };
  }

  if (progress) {
    progress.report({ phase: 'planning', task: task.substring(0, 80) });
  }
  
  const resolvedIntent = (intent && VALID_INTENTS.has(intent)) ? intent : inferIntent(task);
  const root = projectRoot;
  const detailMode = VALID_DETAIL_MODES.has(detail) ? detail : 'balanced';
  const includeSet = new Set(Array.isArray(include) ? include : DEFAULT_INCLUDE);

  let primarySeeds = [];
  let searchIndexFreshness;
  let diffSummary = null;
  let prefetchResult = null;

  if (diff) {
    const changed = await getChangedFiles(diff, root);
    
    await ensureIndexReady({ root });
    
    const detailedChanges = await getDetailedDiff(changed.ref, root);
    const index = loadIndex(root);
    const prioritized = analyzeChangeImpact(detailedChanges, index);
    const expandedFiles = expandChangedContext(changed.files, index, 10);

    primarySeeds = Array.from(expandedFiles).map(rel => {
      const changeInfo = prioritized.find(c => c.file === rel);
      const evidence = [{ 
        type: 'diffHit', 
        ref: changed.ref, 
        priority: changeInfo?.priority || 'related',
        impact: changeInfo?.impactScore || 0,
      }];
      
      if (!changed.files.includes(rel)) {
        evidence[0].expanded = true;
      }
      
      return {
        rel,
        absPath: path.join(root, rel),
        evidence,
      };
    });
    
    primarySeeds.sort((a, b) => {
      const impactA = a.evidence[0].impact || 0;
      const impactB = b.evidence[0].impact || 0;
      return impactB - impactA;
    });
    
    if (progress) {
      progress.report({ 
        phase: 'diff-analysis', 
        changedFiles: changed.files.length,
        expandedFiles: expandedFiles.size,
      });
    }
    
    diffSummary = {
      ref: changed.ref,
      totalChanged: changed.files.length + changed.skippedDeleted,
      included: Math.min(primarySeeds.length, maxTokens > 4000 ? 10 : 5),
      expanded: expandedFiles.size - changed.files.length,
      skippedDeleted: changed.skippedDeleted,
      summary: generateDetailedDiffSummary(prioritized.slice(0, 10)),
      topImpact: prioritized.slice(0, 3).map(c => ({
        file: c.file,
        priority: c.priority,
        changes: `+${c.additions}/-${c.deletions}`,
        type: c.changeType,
      })),
    };
    
    if (changed.error) diffSummary.error = changed.error;
    searchIndexFreshness = null;
  } else {
    const literalPatterns = extractLiteralPatterns(task);
    const queries = extractSearchQueries(task);
    const expandedQueries = extractExpandedQueries(task);
    const fallbackKeywords = extractKeywordQueries(task, { allowIntentKeywords: true });
    const queryCandidates = uniqueList([
      ...literalPatterns,
      ...expandedQueries,
      ...queries,
      ...fallbackKeywords,
      extractFallbackSearchQuery(task),
    ]).slice(0, 6);
    if (progress) {
      progress.report({ phase: 'searching', queries: queryCandidates.length });
    }
    
    const searchResults = await Promise.all(
      queryCandidates.map((query) => smartSearch({ query, cwd: '.', intent: resolvedIntent }))
    );
    const seedMap = new Map();

    for (let queryIdx = 0; queryIdx < searchResults.length; queryIdx++) {
      const searchResult = searchResults[queryIdx];
      const query = queryCandidates[queryIdx];
      for (let rankIdx = 0; rankIdx < Math.min(searchResult.topFiles.length, 5); rankIdx++) {
        const file = searchResult.topFiles[rankIdx];
        const rel = path.relative(root, file.file).replace(/\\/g, '/');
        const existing = seedMap.get(rel);
        const nextEvidence = dedupeEvidence([
          ...(existing?.evidence ?? []),
          { type: 'searchHit', query, rank: rankIdx + 1 },
        ]);

        if (!existing) {
          seedMap.set(rel, {
            rel,
            absPath: file.file,
            evidence: nextEvidence,
            queryIdx,
            rankIdx,
          });
          continue;
        }

        const better = queryIdx < existing.queryIdx
          || (queryIdx === existing.queryIdx && rankIdx < existing.rankIdx);

        seedMap.set(rel, {
          ...existing,
          absPath: file.file,
          evidence: nextEvidence,
          ...(better ? { queryIdx, rankIdx } : {}),
        });
      }
    }

    primarySeeds = [...seedMap.values()]
      .sort((a, b) => a.queryIdx - b.queryIdx || a.rankIdx - b.rankIdx || a.rel.localeCompare(b.rel))
      .map(({ queryIdx: _queryIdx, rankIdx: _rankIdx, ...seed }) => seed);
    searchIndexFreshness = mergeIndexFreshness(searchResults.map((result) => result.indexFreshness));
  }

  if (entryFile) {
    try {
      const abs = resolveSafePath(entryFile);
      if (fs.existsSync(abs)) {
        const rel = path.relative(root, abs).replace(/\\/g, '/');
        const idx = primarySeeds.findIndex((seed) => seed.absPath === abs);
        if (idx >= 0) {
          const updated = {
            ...primarySeeds[idx],
            evidence: dedupeEvidence([...(primarySeeds[idx].evidence ?? []), { type: 'entryFile' }]),
          };
          primarySeeds.splice(idx, 1);
          primarySeeds.unshift(updated);
        } else {
          primarySeeds.unshift({ rel, absPath: abs, evidence: [{ type: 'entryFile' }] });
        }
      }
    } catch (err) { process.stderr.write(`[devctx] smart_context: entryFile "${entryFile}" skipped: ${err.message}\n`); }
  }

  await ensureIndexReady({ root });
  
  const index = loadIndex(root);

  if (prefetch && !diff) {
    try {
      prefetchResult = await predictContextFiles({ task, intent: resolvedIntent, maxFiles: 8 });
      
      if (prefetchResult.confidence >= 0.6 && prefetchResult.predicted.length > 0) {
        for (const predicted of prefetchResult.predicted) {
          try {
            const abs = resolveSafePath(predicted.path);
            if (fs.existsSync(abs)) {
              const rel = path.relative(root, abs).replace(/\\/g, '/');
              const alreadyIncluded = primarySeeds.some(seed => seed.absPath === abs);
              
              if (!alreadyIncluded) {
                primarySeeds.push({
                  rel,
                  absPath: abs,
                  evidence: [{
                    type: 'prefetch',
                    confidence: predicted.confidence,
                    accessCount: predicted.accessCount
                  }]
                });
              }
            }
          } catch (err) { process.stderr.write(`[devctx] smart_context: prefetch path "${predicted.path}" skipped: ${err.message}\n`); }
        }
      }
    } catch (error) {
      prefetchResult = { error: error.message, predicted: [] };
    }
  }

  primarySeeds = rerankPrimarySeeds(primarySeeds, task, resolvedIntent);

  const primarySeedsLimited = primarySeeds.slice(0, 5);
  const primaryFiles = primarySeedsLimited.map((seed) => seed.absPath);

  const indexFreshness = searchIndexFreshness ?? checkIndexFreshness(index, primaryFiles, root);

  const { files: expanded, neighbors } = expandWithGraph(primarySeedsLimited, index, root);
  const symbolCandidates = extractSymbolCandidates(task);
  attachSymbolEvidence(expanded, index, symbolCandidates);
  normalizePrimaryCandidate(expanded, task, resolvedIntent);

  const readPlan = allocateReads(expanded, effectiveMaxTokens, resolvedIntent, detailMode);

  const context = [];
  let totalRawTokens = 0;
  let totalCompressedTokens = 0;
  const filesWithContent = new Set();
  const pendingReads = [];

  for (const item of readPlan) {
    const basePayload = buildContextItemPayload(item, index, detailMode);
    const baseTokens = countTokens(JSON.stringify(basePayload));
    if (totalCompressedTokens + baseTokens > effectiveMaxTokens && context.length > 0) break;

    const contextIndex = context.length;
    context.push(basePayload);
    totalCompressedTokens += baseTokens;

    if (shouldReadContentForItem(item, basePayload, detailMode, includeSet, resolvedIntent)) {
      pendingReads.push({ contextIndex, item });
    }
  }

  if (pendingReads.length > 0) {
    if (progress) {
      progress.report({ phase: 'reading', files: pendingReads.length });
    }
    
    const batchResults = await smartReadBatch({
      files: pendingReads.map(({ item }) => ({ path: item.absPath, mode: item.mode })),
    });

    for (let i = 0; i < pendingReads.length; i++) {
      const pending = pendingReads[i];
      const readResult = batchResults.results?.[i];
      if (!readResult?.content) continue;

      const existing = context[pending.contextIndex];
      if (!existing) continue;

      const enrichedPayload = buildContextItemPayload(
        pending.item,
        index,
        detailMode,
        pending.item.mode,
        readResult.content,
      );
      const oldTokens = countTokens(JSON.stringify(existing));
      const newTokens = countTokens(JSON.stringify(enrichedPayload));
      const tokenDelta = newTokens - oldTokens;

      if (totalCompressedTokens + tokenDelta > effectiveMaxTokens && pending.contextIndex > 0) continue;

      context[pending.contextIndex] = enrichedPayload;
      filesWithContent.add(pending.item.rel);
      totalRawTokens += readResult.metrics?.rawTokens ?? 0;
      totalCompressedTokens += tokenDelta;
    }
  }

  if (includeSet.has('symbolDetail') && symbolCandidates.length > 0 && readPlan.length > 0) {
    const topPrimary = readPlan.find((p) => p.role === 'primary');
    if (topPrimary) {
      try {
        const symbolResult = await smartRead({
          filePath: topPrimary.absPath,
          mode: 'symbol',
          symbol: symbolCandidates.slice(0, 3),
        });

        const filtered = filterFoundSymbols(symbolResult.content, symbolCandidates);
        if (filtered) {
          const symbolPayload = {
            file: topPrimary.rel,
            role: 'symbolDetail',
            content: filtered,
          };
          const symbolTokens = countTokens(JSON.stringify(symbolPayload));
          if (totalCompressedTokens + symbolTokens <= effectiveMaxTokens) {
            context.push(symbolPayload);
            totalCompressedTokens += symbolTokens;

            if (detailMode === 'minimal') {
              const existingIdx = context.findIndex((c) => c.file === topPrimary.rel && c.role === 'primary');
              if (existingIdx !== -1) {
                const existing = context[existingIdx];
                const signaturesOnly = {
                  ...existing,
                  content: '(omitted — see symbolDetail)',
                };
                const oldTokens = countTokens(JSON.stringify(existing));
                const newTokens = countTokens(JSON.stringify(signaturesOnly));
                context[existingIdx] = signaturesOnly;
                totalCompressedTokens += newTokens - oldTokens;
              }
            }
          }
        }
      } catch { /* skip */ }
    }
  }

  const graphSummary = {
    primaryImports: [],
    tests: [],
    dependents: [],
    neighbors,
  };

  for (const [rel, info] of expanded) {
    if (info.role === 'dependency') graphSummary.primaryImports.push(rel);
    else if (info.role === 'test') graphSummary.tests.push(rel);
    else if (info.role === 'dependent') graphSummary.dependents.push(rel);
  }

  const hints = [];
  const excludedNeighbors = neighbors.filter((n) => !expanded.has(n));
  if (excludedNeighbors.length > 0) {
    hints.push(`${excludedNeighbors.length} neighbor file(s) available: ${excludedNeighbors.slice(0, 3).join(', ')}`);
  }
  if (indexFreshness === 'stale') {
    hints.push('Index is stale — run build_index for better results');
  }
  if (indexFreshness === 'unavailable') {
    hints.push('No symbol index — run build_index for graph expansion and ranking boosts');
  }
  if (diff && context.length === 0) {
    hints.push(diffSummary?.error || 'No changed files found for the given diff ref');
  }
  if (context.length > 0 && symbolCandidates.length === 0) {
    const topCtx = context[0];
    if (topCtx.symbols?.length) {
      hints.push(`Inspect symbols with smart_read: ${topCtx.symbols.slice(0, 3).join(', ')}`);
    }
  }

  const savingsPct = totalRawTokens > 0
    ? Math.round(((totalRawTokens - totalCompressedTokens) / totalRawTokens) * 100)
    : 0;

  const contentTokens = countTokens(context.map((c) => c.content).join('\n'));
  const previewTokens = context.reduce((sum, item) => sum + countTokens(JSON.stringify(item.symbolPreviews ?? [])), 0);
  const contentItems = context.filter((item) => typeof item.content === 'string' && item.content.length > 0).length;
  const primaryItem = context.find((item) => item.role === 'primary');

  const savedTokens = Math.max(0, totalRawTokens - totalCompressedTokens);
  
  await persistMetrics({
    tool: 'smart_context',
    target: `${root} :: ${task}`,
    rawTokens: totalRawTokens,
    compressedTokens: totalCompressedTokens,
    savedTokens,
    savingsPct,
    timestamp: new Date().toISOString(),
  });
  
  recordToolUsage({
    tool: 'smart_context',
    savedTokens,
    target: task,
  });
  recordDevctxOperation();

  let reason = DECISION_REASONS.TASK_CONTEXT;
  if (diff) {
    reason = DECISION_REASONS.DIFF_ANALYSIS;
  } else if (context.some(c => c.role === 'caller' || c.role === 'test')) {
    reason = DECISION_REASONS.RELATED_FILES;
  }
  
  recordDecision({
    tool: 'smart_context',
    action: `build context for "${task}"`,
    reason,
    alternative: 'Multiple smart_read + smart_search calls',
    expectedBenefit: `${EXPECTED_BENEFITS.TOKEN_SAVINGS(savedTokens)}, ${EXPECTED_BENEFITS.COMPLETE_CONTEXT}`,
    context: `${context.length} files, ${totalCompressedTokens} tokens (${savingsPct}% compression)`,
  });

  if (prefetch && context.length > 0) {
    try {
      await recordContextAccess({
        task,
        intent: resolvedIntent,
        files: context.map((item, idx) => ({
          path: item.file,
          relevance: item.role === 'primary' ? 1.0 : (item.role === 'test' ? 0.9 : 0.7),
          order: idx
        }))
      });
    } catch (err) { process.stderr.write(`[devctx] smart_context: recordContextAccess failed: ${err.message}\n`); }
  }

  const COVERAGE_RANK = { full: 2, partial: 1, none: 0 };
  const coverageMin = (vals) => {
    if (vals.length === 0) return 'none';
    let min = 2;
    for (const v of vals) min = Math.min(min, COVERAGE_RANK[v] ?? 0);
    return ['none', 'partial', 'full'][min];
  };
  const uniqueExts = [...new Set(context.map((c) => path.extname(c.file).toLowerCase()))];
  const perFile = uniqueExts.map((e) => getGraphCoverage(e));

  const graphCov = {
    imports: coverageMin(perFile.map((c) => c.imports)),
    tests: coverageMin(perFile.map((c) => c.tests)),
  };

  const filesIncluded = new Set(context.map((c) => c.file)).size;

  if (progress) {
    progress.complete({
      task: task.substring(0, 80),
      files: filesIncluded,
      savedTokens,
      savingsPct: totalRawTokens > 0 ? ((savedTokens / totalRawTokens) * 100).toFixed(1) : null,
    });
  }

  const result = {
    success: true,
    task,
    intent: resolvedIntent,
    indexFreshness,
    confidence: { indexFreshness, graphCoverage: graphCov },
    context,
    ...(includeSet.has('graph') ? { graph: graphSummary, graphCoverage: graphCov } : {}),
    stats: {
      filesIncluded,
      filesEvaluated: expanded.size,
      detailMode,
      maxTokens: effectiveMaxTokens,
      totalTokens: countTokens(context.map((c) => c.content || '').join('')),
      ...(prefetchResult ? {
        prefetch: {
          enabled: true,
          confidence: prefetchResult.confidence || 0,
          predictedFiles: prefetchResult.predicted?.length || 0,
          matchedPattern: prefetchResult.matchedPattern || null,
        },
      } : {}),
    },
    ...(includeSet.has('hints') ? { hints } : {}),
  };

  if (normalizedTokenBudget) {
    result.taskBudget = normalizedTokenBudget;
    result.remainingBudget = consumeTokenBudget({
      tokenBudget: normalizedTokenBudget,
      usedTokens: totalCompressedTokens,
    });
  }

  if (diffSummary) {
    diffSummary.included = context.filter((c) => c.role === 'primary').length;
    result.diffSummary = diffSummary;
  }

  return result;
};
