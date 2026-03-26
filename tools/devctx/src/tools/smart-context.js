import path from 'node:path';
import fs from 'node:fs';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { smartSearch, VALID_INTENTS } from './smart-search.js';
import { smartRead } from './smart-read.js';
import { smartReadBatch } from './smart-read-batch.js';
import { loadIndex, queryRelated, getGraphCoverage } from '../index.js';
import { projectRoot } from '../utils/paths.js';
import { resolveSafePath } from '../utils/fs.js';
import { countTokens } from '../tokenCounter.js';
import { persistMetrics } from '../metrics.js';

const execFile = promisify(execFileCallback);

const INTENT_KEYWORDS = {
  debug: ['debug', 'fix', 'error', 'bug', 'crash', 'fail', 'broken', 'issue', 'trace'],
  tests: ['test', 'spec', 'coverage', 'assert', 'mock', 'jest', 'vitest'],
  config: ['config', 'env', 'setup', 'deploy', 'docker', 'ci', 'terraform', 'yaml', 'secret', 'secrets', 'settings', 'database'],
  docs: ['doc', 'readme', 'explain', 'document', 'guide'],
  implementation: ['implement', 'add', 'create', 'build', 'feature', 'refactor', 'update', 'modify'],
};

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'is', 'are',
  'was', 'were', 'be', 'been', 'and', 'or', 'but', 'not', 'this', 'that', 'it',
  'how', 'what', 'where', 'when', 'why', 'which', 'who', 'do', 'does', 'did',
  'has', 'have', 'had', 'from', 'by', 'about', 'into', 'my', 'our', 'your',
  'can', 'could', 'will', 'would', 'should', 'may', 'might', 'i', 'we', 'you',
  'all', 'each', 'every', 'me', 'us', 'them', 'its',
]);

const LOW_SIGNAL_QUERY_WORDS = new Set([
  'find', 'show', 'list', 'get', 'search', 'locate', 'lookup', 'look', 'check',
  'inspect', 'review', 'analyze', 'analyse', 'understand', 'explore', 'read',
  'open', 'walk', 'help', 'need', 'want', 'please', 'context', 'preview',
  'recall', 'stuff', 'thing', 'things', 'happen', 'happens', 'handle', 'handles',
  'handling', 'wired', 'declare', 'declared', 'defined', 'owns', 'owner', 'existing',
  'exercise', 'exercises', 'before', 'main', 'shared', 'related', 'across', 'split',
  'live', 'lives', 'surface', 'public', 'entry', 'point', 'path', 'logic', 'covers',
  'api', 'apis', 'flow', 'flows', 'file', 'files', 'onboarding', 'app', 'application', 'load', 'loads', 'loaded',
]);

const IDENTIFIER_RE = /\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b|\b[A-Z][a-zA-Z0-9]{2,}\b|\b[a-z]{2,}_[a-z_]+\b/g;
const QUERY_TOKEN_RE = /[a-zA-Z0-9_]+/g;

const ROLE_PRIORITY = ['primary', 'test', 'dependency', 'dependent'];
const ROLE_RANK = Object.fromEntries(ROLE_PRIORITY.map((role, idx) => [role, idx]));
const EVIDENCE_PRIORITY = {
  entryFile: 0,
  diffHit: 1,
  searchHit: 2,
  symbolMatch: 3,
  symbolDetail: 4,
  testOf: 5,
  dependencyOf: 6,
  dependentOf: 7,
};
const ROLE_BASE_SCORE = { primary: 130, test: 85, dependency: 60, dependent: 50 };
const EVIDENCE_BASE_SCORE = {
  entryFile: 120,
  diffHit: 100,
  searchHit: 70,
  symbolMatch: 90,
  symbolDetail: 95,
  testOf: 40,
  dependencyOf: 25,
  dependentOf: 22,
};

const uniqueList = (items = []) => [...new Set(items.filter(Boolean))];

const evidenceKey = (evidence) => JSON.stringify([
  evidence.type,
  evidence.via ?? null,
  evidence.ref ?? null,
  evidence.rank ?? null,
  evidence.query ?? null,
  Array.isArray(evidence.symbols) ? evidence.symbols.join('|') : null,
]);

const dedupeEvidence = (items = []) => {
  const map = new Map();
  for (const item of items) {
    if (!item?.type) continue;
    const normalized = { ...item };
    if (Array.isArray(normalized.symbols)) {
      normalized.symbols = uniqueList(normalized.symbols).slice(0, 3);
      if (normalized.symbols.length === 0) delete normalized.symbols;
    }
    const key = evidenceKey(normalized);
    if (!map.has(key)) map.set(key, normalized);
  }
  return [...map.values()].sort((a, b) => {
    const priorityDiff = (EVIDENCE_PRIORITY[a.type] ?? 99) - (EVIDENCE_PRIORITY[b.type] ?? 99);
    if (priorityDiff !== 0) return priorityDiff;
    return (a.rank ?? 999) - (b.rank ?? 999);
  });
};

const formatReasonIncluded = (evidence = []) => {
  const primary = evidence[0];
  if (!primary) return 'selected';

  switch (primary.type) {
    case 'entryFile':
      return 'entry';
    case 'diffHit':
      return primary.ref ? `diff: ${primary.ref}` : 'diff';
    case 'searchHit':
      return primary.query ? `search: ${primary.query}` : 'search';
    case 'symbolMatch':
      return `symbol: ${(primary.symbols ?? []).slice(0, 2).join(', ')}`;
    case 'symbolDetail':
      return `detail: ${(primary.symbols ?? []).slice(0, 2).join(', ')}`;
    case 'testOf':
      return primary.via ? `test: ${primary.via}` : 'test';
    case 'dependencyOf':
      return primary.via ? `imported-by: ${primary.via}` : 'imported-by';
    case 'dependentOf':
      return primary.via ? `imports: ${primary.via}` : 'imports';
    default:
      return 'selected';
  }
};

const HIGH_SIGNAL_PREVIEW_KINDS = new Set([
  'actor', 'class', 'enum', 'function', 'interface', 'method',
  'protocol', 'struct', 'trait', 'type',
]);

const getPreviewKindPriority = (kind) => {
  switch (kind) {
    case 'class':
    case 'function':
    case 'method':
      return 4;
    case 'interface':
    case 'type':
    case 'protocol':
    case 'trait':
    case 'struct':
    case 'enum':
    case 'actor':
      return 3;
    default:
      return 0;
  }
};

const compactSymbolPreview = (entry) => ({
  name: entry.name,
  kind: entry.kind,
  ...(entry.signature ? { signature: entry.signature } : entry.snippet ? { snippet: entry.snippet } : {}),
});

const buildSymbolPreviews = (entries = [], matchedSymbols = [], { includeFallback = false, maxItems = 3 } = {}) => {
  if (maxItems <= 0) return [];

  const matchedSet = new Set(matchedSymbols.map((symbol) => symbol.toLowerCase()));
  const candidates = entries
    .filter((entry) => includeFallback || matchedSet.has(entry.name.toLowerCase()))
    .sort((a, b) => {
      const aMatched = matchedSet.has(a.name.toLowerCase()) ? 1 : 0;
      const bMatched = matchedSet.has(b.name.toLowerCase()) ? 1 : 0;
      if (aMatched !== bMatched) return bMatched - aMatched;
      const aKind = getPreviewKindPriority(a.kind);
      const bKind = getPreviewKindPriority(b.kind);
      if (aKind !== bKind) return bKind - aKind;
      const aRich = Number(Boolean(a.signature)) + Number(Boolean(a.snippet));
      const bRich = Number(Boolean(b.signature)) + Number(Boolean(b.snippet));
      if (aRich !== bRich) return bRich - aRich;
      return a.line - b.line;
    });

  const prioritized = [];
  const secondary = [];

  for (const candidate of candidates) {
    const isMatched = matchedSet.has(candidate.name.toLowerCase());
    if (isMatched || HIGH_SIGNAL_PREVIEW_KINDS.has(candidate.kind)) prioritized.push(candidate);
    else secondary.push(candidate);
  }

  return [...prioritized, ...secondary].slice(0, maxItems).map(compactSymbolPreview);
};

const attachSymbolEvidence = (files, index, symbolCandidates) => {
  if (!index || symbolCandidates.length === 0) return;

  const candidateMap = new Map(symbolCandidates.map((symbol) => [symbol.toLowerCase(), symbol]));

  for (const [rel, info] of files) {
    const fileSymbols = index.files?.[rel]?.symbols ?? [];
    const matchedSymbols = [];

    for (const symbol of fileSymbols) {
      const matched = candidateMap.get(symbol.name.toLowerCase());
      if (matched && !matchedSymbols.includes(matched)) matchedSymbols.push(matched);
    }

    if (matchedSymbols.length === 0) continue;

    const evidence = dedupeEvidence([
      ...(info.evidence ?? []),
      { type: 'symbolMatch', symbols: matchedSymbols.slice(0, 3) },
    ]);

    files.set(rel, {
      ...info,
      evidence,
      matchedSymbols: uniqueList([...(info.matchedSymbols ?? []), ...matchedSymbols]).slice(0, 3),
    });
  }
};

const computeStaticUtility = (candidate, intent) => {
  let score = ROLE_BASE_SCORE[candidate.role] ?? 40;
  if (candidate.role === 'test' && intent === 'tests') score += 20;

  for (const evidence of candidate.evidence ?? []) {
    score += EVIDENCE_BASE_SCORE[evidence.type] ?? 0;
    if (evidence.type === 'searchHit') score += Math.max(0, 24 - ((evidence.rank ?? 1) - 1) * 6);
    if (evidence.type === 'symbolMatch') score += (evidence.symbols?.length ?? 0) * 12;
  }

  score += (candidate.matchedSymbols?.length ?? 0) * 10;
  return score;
};

const inferRelatedRole = (candidate) => {
  const evidenceTypes = new Set((candidate.evidence ?? []).map((item) => item.type));
  if (evidenceTypes.has('testOf')) return 'test';
  if (evidenceTypes.has('dependencyOf')) return 'dependency';
  if (evidenceTypes.has('dependentOf')) return 'dependent';
  return 'dependent';
};

const computePrimarySignal = (candidate, intent) => {
  const relLower = (candidate.rel ?? '').toLowerCase();
  let score = 0;

  for (const evidence of candidate.evidence ?? []) {
    if (evidence.type === 'entryFile') score += 120;
    if (evidence.type === 'diffHit') score += 110;
    if (evidence.type === 'searchHit') score += Math.max(0, 28 - ((evidence.rank ?? 1) - 1) * 6);
    if (evidence.type === 'symbolMatch') score += (evidence.symbols?.length ?? 0) * 10;
    if (evidence.type === 'symbolDetail') score += (evidence.symbols?.length ?? 0) * 12;
  }

  score += (candidate.matchedSymbols?.length ?? 0) * 12;

  if (TEST_FILE_RE.test(relLower)) {
    score += intent === 'tests' ? 10 : -60;
  } else if (relLower.startsWith('src/')) {
    score += 10;
  }

  return score;
};

const computePrimaryPromotionScore = (candidate, task, intent) => {
  let score = scorePrimarySeed(candidate, task, intent);
  score += computePrimarySignal(candidate, intent);
  if (candidate.role === 'primary') score += 6;
  return score;
};

const normalizePrimaryCandidate = (files, task, intent) => {
  const candidates = [...files.entries()].map(([rel, info]) => ({ rel, ...info }));
  if (candidates.length === 0) return;

  const currentPrimary = candidates.find((candidate) => candidate.role === 'primary');
  const best = [...candidates].sort((a, b) =>
    computePrimaryPromotionScore(b, task, intent) - computePrimaryPromotionScore(a, task, intent)
    || a.rel.localeCompare(b.rel)
  )[0];

  if (!best) return;

  const currentScore = currentPrimary
    ? computePrimaryPromotionScore(currentPrimary, task, intent)
    : Number.NEGATIVE_INFINITY;
  const bestScore = computePrimaryPromotionScore(best, task, intent);
  const chosenPrimary = currentPrimary && currentScore > bestScore + 10 ? currentPrimary : best;

  for (const candidate of candidates) {
    if (candidate.rel === chosenPrimary.rel) {
      files.set(candidate.rel, { ...files.get(candidate.rel), role: 'primary' });
      continue;
    }

    if (candidate.role !== 'primary') continue;
    files.set(candidate.rel, { ...files.get(candidate.rel), role: inferRelatedRole(candidate) });
  }
};

const collectViaRefs = (candidate) => uniqueList((candidate.evidence ?? []).map((item) => item.via));

const computeMarginalPenalty = (candidate, selected) => {
  if (selected.length === 0) return 0;

  const dir = path.dirname(candidate.rel);
  const candidateVia = new Set(collectViaRefs(candidate));
  const candidateSymbols = new Set((candidate.matchedSymbols ?? []).map((symbol) => symbol.toLowerCase()));

  let penalty = 0;
  let sameDirCount = 0;
  let sameRoleCount = 0;
  let sameViaCount = 0;
  let overlappingSymbolCount = 0;

  for (const item of selected) {
    if (path.dirname(item.rel) === dir) sameDirCount++;
    if (item.role === candidate.role) sameRoleCount++;

    for (const via of collectViaRefs(item)) {
      if (candidateVia.has(via)) sameViaCount++;
    }

    for (const symbol of item.matchedSymbols ?? []) {
      if (candidateSymbols.has(symbol.toLowerCase())) overlappingSymbolCount++;
    }
  }

  penalty += sameDirCount * (candidate.role === 'primary' ? 3 : 8);
  penalty += sameRoleCount * (candidate.role === 'primary' ? 2 : 5);
  penalty += sameViaCount * 12;
  penalty += overlappingSymbolCount * 18;

  return penalty;
};

export const inferIntent = (task) => {
  const lower = task.toLowerCase();
  let best = 'explore';
  let bestScore = 0;

  for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
    const score = keywords.filter((kw) => lower.includes(kw)).length;
    if (score > bestScore) { bestScore = score; best = intent; }
  }

  return best;
};

const extractCompoundQueries = (task) => {
  const lowerTask = task.toLowerCase();
  const queries = [];

  if (/\b(create[-\s]+user|user[-\s]+creation)\b/.test(lowerTask)) {
    queries.push('createUser');
  }

  if (/\bjwt[-\s]+secret\b/.test(lowerTask)) {
    queries.push('jwtSecret');
  }

  return queries;
};

const filterRedundantPromptQueries = (queries, compoundQueries) => {
  const lowerCompoundQueries = new Set(compoundQueries.map((query) => query.toLowerCase()));
  return queries.filter((query) => {
    const lowerQuery = query.toLowerCase();
    if (lowerCompoundQueries.has('jwtsecret') && lowerQuery === 'jwt') return false;
    return true;
  });
};

export const extractSymbolCandidates = (task) => {
  const compoundQueries = extractCompoundQueries(task);
  return uniqueList([
    ...compoundQueries,
    ...filterRedundantPromptQueries(task.match(IDENTIFIER_RE) || [], compoundQueries),
  ]);
};

const isLikelyCodeSymbol = (token) =>
  token.includes('_')
  || /\d/.test(token)
  || /[a-z][A-Z]/.test(token)
  || /[A-Z]{2,}/.test(token);

const scoreKeywordQuery = (token, lowerTask) => {
  let score = Math.min(token.length, 8);
  const position = lowerTask.indexOf(token);
  if (position >= 0) score += Math.max(0, 16 - position);
  if (token.length >= 12) score += 1;
  return score;
};

const extractKeywordQueries = (task, { allowIntentKeywords = false } = {}) => {
  const intentKws = new Set(Object.values(INTENT_KEYWORDS).flat());
  const lowerTask = task.toLowerCase();
  const compoundQueries = extractCompoundQueries(task);

  return filterRedundantPromptQueries(
    [...new Set((task.match(QUERY_TOKEN_RE) || [])
      .map((token) => token.toLowerCase())
      .filter((token) => {
        if (token.length <= 2) return false;
        if (/^\d+$/.test(token)) return false;
        if (STOP_WORDS.has(token)) return false;
        if (LOW_SIGNAL_QUERY_WORDS.has(token)) return false;
        if (!allowIntentKeywords && intentKws.has(token)) return false;
        return true;
      })
      .sort((a, b) => scoreKeywordQuery(b, lowerTask) - scoreKeywordQuery(a, lowerTask)
        || lowerTask.indexOf(a) - lowerTask.indexOf(b)
        || b.length - a.length
        || a.localeCompare(b)))],
    compoundQueries,
  );
};

const extractExpandedQueries = (task) => {
  const lowerTask = task.toLowerCase();
  const queries = [...extractCompoundQueries(task)];

  if (/\b(container|docker|image|deploy|deployment)\b/.test(lowerTask)) {
    queries.push('FROM');
  }

  return queries;
};

const extractFallbackSearchQuery = (task) => {
  const symbolFallback = extractSymbolCandidates(task).find(isLikelyCodeSymbol);
  if (symbolFallback) return symbolFallback;

  const keywordFallback = extractKeywordQueries(task, { allowIntentKeywords: true })[0];
  if (keywordFallback) return keywordFallback;

  return task.trim();
};

export const extractSearchQueries = (task) => {
  const symbolQueries = extractSymbolCandidates(task)
    .filter(isLikelyCodeSymbol)
    .filter((candidate) => !LOW_SIGNAL_QUERY_WORDS.has(candidate.toLowerCase()) && !STOP_WORDS.has(candidate.toLowerCase()));
  const keywordQueries = extractKeywordQueries(task);
  const queries = [];
  const seen = new Set();

  for (const candidate of [...symbolQueries, ...keywordQueries]) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(candidate);
  }

  return queries.slice(0, 3);
};

const PRIMARY_PATH_HINT_MAP = [
  { test: /\b(api|endpoint|endpoints|route|routes)\b/, hints: ['api', 'routes'] },
  { test: /\b(auth|token|jwt|login|session)\b/, hints: ['auth'] },
  { test: /\b(config|env|secret|yaml|json)\b/, hints: ['config'] },
  { test: /\b(test|tests|spec|coverage)\b/, hints: ['test', 'tests'] },
  { test: /\b(model|models|schema|schemas|entity|entities)\b/, hints: ['model', 'models'] },
  { test: /\b(container|docker|image|deploy|deployment)\b/, hints: ['dockerfile', 'docker'] },
];

const TEST_FILE_RE = /(^|\/)(tests?|__tests__)\//;

const tokenizePath = (rel) =>
  uniqueList((rel.toLowerCase().match(/[a-z0-9]+/g) || []).filter((token) => token.length > 1));

const extractPrimaryPathHints = (task) => {
  const lowerTask = task.toLowerCase();
  const hints = new Set(
    (lowerTask.match(QUERY_TOKEN_RE) || [])
      .map((token) => token.toLowerCase())
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token) && !LOW_SIGNAL_QUERY_WORDS.has(token))
  );

  for (const entry of PRIMARY_PATH_HINT_MAP) {
    if (entry.test.test(lowerTask)) {
      for (const hint of entry.hints) hints.add(hint);
    }
  }

  return [...hints];
};

const scorePrimarySeed = (seed, task, intent) => {
  const rel = seed.rel ?? '';
  const relLower = rel.toLowerCase();
  const basename = path.basename(relLower, path.extname(relLower));
  const pathTokens = new Set(tokenizePath(relLower));
  const pathHints = extractPrimaryPathHints(task);
  let score = 0;

  for (const evidence of seed.evidence ?? []) {
    if (evidence.type !== 'searchHit') continue;
    score += Math.max(0, 40 - ((evidence.rank ?? 1) - 1) * 8);
    if (!evidence.query) continue;

    const query = evidence.query.toLowerCase();
    if (basename === query) score += 28;
    else if (relLower.includes(query)) score += 18;
    else if (pathTokens.has(query)) score += 14;
  }

  let hintHits = 0;
  for (const hint of pathHints) {
    if (basename === hint) {
      score += 28;
      hintHits++;
      continue;
    }
    if (pathTokens.has(hint) || relLower.includes(hint)) {
      score += 18;
      hintHits++;
    }
  }

  const targetsApiSurface = pathHints.includes('api') || pathHints.includes('routes');
  if (targetsApiSurface) {
    if (/(^|\/)(api|routes)(\/|$)/.test(relLower)) score += 28;
    if (/(^|\/)(models?|schemas?)(\/|$)/.test(relLower)) score -= 12;
  }

  if (TEST_FILE_RE.test(relLower)) {
    score += intent === 'tests' ? 24 : -40;
  } else if (intent === 'tests') {
    score -= 10;
  }

  if (intent === 'implementation' && relLower.startsWith('src/')) score += 10;
  if ((intent === 'debug' || intent === 'review') && relLower.startsWith('src/')) score += 8;
  if (hintHits > 0 && relLower.startsWith('src/')) score += 6;

  return score;
};

const rerankPrimarySeeds = (primarySeeds, task, intent) =>
  [...primarySeeds].sort((a, b) =>
    scorePrimarySeed(b, task, intent) - scorePrimarySeed(a, task, intent)
    || a.rel.localeCompare(b.rel)
  );

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
      : best.role === 'primary' && !tightBudget
        ? 'outline'
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

const serializeEvidencePayload = (item) => {
  const evidence = dedupeEvidence(item.evidence ?? []);
  if (evidence.length === 0) return [];

  const limit = item.role === 'primary' ? 2 : 1;
  const preferred = item.role === 'primary'
    ? evidence
    : [
      evidence.find((entry) => ['testOf', 'dependencyOf', 'dependentOf'].includes(entry.type)),
      evidence[0],
    ].filter(Boolean);

  return uniqueList(preferred)
    .slice(0, limit)
    .map((entry) => ({
      type: entry.type,
      ...(entry.via ? { via: entry.via } : {}),
      ...(entry.query && item.role === 'primary' ? { query: entry.query } : {}),
      ...(entry.ref && item.role === 'primary' ? { ref: entry.ref } : {}),
      ...(Array.isArray(entry.symbols) && entry.symbols.length > 0 ? { symbols: entry.symbols.slice(0, 2) } : {}),
    }));
};

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
  const evidence = serializeEvidencePayload(item);

  return {
    file: item.rel,
    role: item.role,
    readMode,
    reasonIncluded: formatReasonIncluded(item.evidence),
    evidence,
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
    if ((item.matchedSymbols?.length ?? 0) > 0) return false;
    return !strongIndexSignal;
  }

  if (item.role === 'test' && intent === 'tests') {
    return !strongIndexSignal;
  }

  if (item.role === 'dependency') {
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
        for (const u of untrackedOut.split('\n').map((l) => l.trim()).filter(Boolean)) {
          if (!allPaths.includes(u)) allPaths.push(u);
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

export const smartContext = async ({
  task,
  intent,
  maxTokens = 8000,
  entryFile,
  diff,
  detail = 'balanced',
  include = DEFAULT_INCLUDE,
}) => {
  const resolvedIntent = (intent && VALID_INTENTS.has(intent)) ? intent : inferIntent(task);
  const root = projectRoot;
  const detailMode = VALID_DETAIL_MODES.has(detail) ? detail : 'balanced';
  const includeSet = new Set(Array.isArray(include) ? include : DEFAULT_INCLUDE);

  let primarySeeds = [];
  let searchIndexFreshness;
  let diffSummary = null;

  if (diff) {
    const changed = await getChangedFiles(diff, root);
    primarySeeds = changed.files.map((rel, idx) => ({
      rel,
      absPath: path.join(root, rel),
      evidence: [{ type: 'diffHit', ref: changed.ref, rank: idx + 1 }],
    }));
    diffSummary = {
      ref: changed.ref,
      totalChanged: changed.files.length + changed.skippedDeleted,
      included: Math.min(changed.files.length, 5),
      skippedDeleted: changed.skippedDeleted,
    };
    if (changed.error) diffSummary.error = changed.error;
    searchIndexFreshness = null;
  } else {
    const queries = extractSearchQueries(task);
    const expandedQueries = extractExpandedQueries(task);
    const fallbackKeywords = extractKeywordQueries(task, { allowIntentKeywords: true });
    const queryCandidates = uniqueList([
      ...expandedQueries,
      ...queries,
      ...fallbackKeywords,
      extractFallbackSearchQuery(task),
    ]).slice(0, 6);
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
    } catch { /* invalid path — skip */ }
  }

  const index = loadIndex(root);

  primarySeeds = rerankPrimarySeeds(primarySeeds, task, resolvedIntent);

  const primarySeedsLimited = primarySeeds.slice(0, 5);
  const primaryFiles = primarySeedsLimited.map((seed) => seed.absPath);

  const indexFreshness = searchIndexFreshness ?? checkIndexFreshness(index, primaryFiles, root);

  const { files: expanded, neighbors } = expandWithGraph(primarySeedsLimited, index, root);
  const symbolCandidates = extractSymbolCandidates(task);
  attachSymbolEvidence(expanded, index, symbolCandidates);
  normalizePrimaryCandidate(expanded, task, resolvedIntent);

  const readPlan = allocateReads(expanded, maxTokens, resolvedIntent, detailMode);

  const context = [];
  let totalRawTokens = 0;
  let totalCompressedTokens = 0;
  const filesWithContent = new Set();
  const pendingReads = [];

  for (const item of readPlan) {
    const basePayload = buildContextItemPayload(item, index, detailMode);
    const baseTokens = countTokens(JSON.stringify(basePayload));
    if (totalCompressedTokens + baseTokens > maxTokens && context.length > 0) break;

    const contextIndex = context.length;
    context.push(basePayload);
    totalCompressedTokens += baseTokens;

    if (shouldReadContentForItem(item, basePayload, detailMode, includeSet, resolvedIntent)) {
      pendingReads.push({ contextIndex, item });
    }
  }

  if (pendingReads.length > 0) {
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

      if (totalCompressedTokens + tokenDelta > maxTokens && pending.contextIndex > 0) continue;

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
          const symbolEvidence = dedupeEvidence([{
            type: 'symbolDetail',
            symbols: symbolCandidates.slice(0, 3),
          }]);
          const symbolPayload = {
            file: topPrimary.rel,
            role: 'symbolDetail',
            readMode: 'symbol',
            reasonIncluded: formatReasonIncluded(symbolEvidence),
            evidence: symbolEvidence,
            content: filtered,
          };
          const symbolTokens = countTokens(JSON.stringify(symbolPayload));
          if (totalCompressedTokens + symbolTokens <= maxTokens) {
            context.push(symbolPayload);
            totalCompressedTokens += symbolTokens;

            if (detailMode === 'minimal') {
              const existingIdx = context.findIndex((c) => c.file === topPrimary.rel && c.role === 'primary');
              if (existingIdx !== -1) {
                const existing = context[existingIdx];
                const signaturesOnly = {
                  ...existing,
                  readMode: 'signatures-only',
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
  const indexOnlyItems = context.filter((item) => item.readMode === 'index-only').length;
  const contentItems = context.filter((item) => typeof item.content === 'string' && item.content.length > 0).length;
  const primaryItem = context.find((item) => item.role === 'primary');

  await persistMetrics({
    tool: 'smart_context',
    target: `${root} :: ${task}`,
    rawTokens: totalRawTokens,
    compressedTokens: totalCompressedTokens,
    savedTokens: Math.max(0, totalRawTokens - totalCompressedTokens),
    savingsPct,
    timestamp: new Date().toISOString(),
  });

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

  const result = {
    task,
    intent: resolvedIntent,
    indexFreshness,
    confidence: { indexFreshness, graphCoverage: graphCov },
    context,
    ...(includeSet.has('graph') ? { graph: graphSummary, graphCoverage: graphCov } : {}),
    metrics: {
      contentTokens,
      totalTokens: 0,
      filesIncluded: new Set(context.map((c) => c.file)).size,
      filesEvaluated: expanded.size,
      savingsPct,
      detailMode,
      include: [...includeSet],
      previewTokens,
      indexOnlyItems,
      contentItems,
      primaryReadMode: primaryItem?.readMode ?? null,
    },
    ...(includeSet.has('hints') ? { hints } : {}),
  };

  if (diffSummary) {
    diffSummary.included = context.filter((c) => c.role === 'primary').length;
    result.diffSummary = diffSummary;
  }

  result.metrics.totalTokens = countTokens(JSON.stringify(result));

  return result;
};
