import path from 'node:path';
import { extractSymbolCandidates } from './query-extraction.js';

const ROLE_PRIORITY = ['primary', 'test', 'dependency', 'dependent'];
const ROLE_RANK = Object.fromEntries(ROLE_PRIORITY.map((role, idx) => [role, idx]));
const EVIDENCE_PRIORITY = {
  entryFile: 0,
  diffHit: 1,
  semanticDefinition: 2,
  searchHit: 3,
  symbolMatch: 4,
  symbolDetail: 5,
  semanticImplementation: 6,
  semanticReference: 7,
  testOf: 8,
  dependencyOf: 9,
  dependentOf: 10,
};
const ROLE_BASE_SCORE = { primary: 130, test: 85, dependency: 60, dependent: 50 };
const EVIDENCE_BASE_SCORE = {
  entryFile: 120,
  diffHit: 100,
  semanticDefinition: 115,
  searchHit: 70,
  symbolMatch: 90,
  symbolDetail: 95,
  semanticImplementation: 88,
  semanticReference: 80,
  testOf: 40,
  dependencyOf: 25,
  dependentOf: 22,
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
const QUERY_TOKEN_RE = /[a-zA-Z0-9_]+/g;

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

const uniqueList = (items = []) => [...new Set(items.filter(Boolean))];

const evidenceKey = (evidence) => JSON.stringify([
  evidence.type,
  evidence.via ?? null,
  evidence.ref ?? null,
  evidence.rank ?? null,
  evidence.query ?? null,
  evidence.symbol ?? null,
  evidence.relation ?? null,
  Array.isArray(evidence.symbols) ? evidence.symbols.join('|') : null,
]);

export const dedupeEvidence = (items = []) => {
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

export const formatReasonIncluded = (evidence = []) => {
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
    case 'semanticDefinition':
      return primary.symbol ? `semantic-def: ${primary.symbol}` : 'semantic-def';
    case 'semanticImplementation':
      return primary.symbol ? `semantic-impl: ${primary.symbol}` : 'semantic-impl';
    case 'semanticReference':
      return primary.symbol ? `semantic-ref: ${primary.symbol}` : 'semantic-ref';
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

export const buildSymbolPreviews = (entries = [], matchedSymbols = [], { includeFallback = false, maxItems = 3 } = {}) => {
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

export const attachSymbolEvidence = (files, index, symbolCandidates) => {
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

export const computeStaticUtility = (candidate, intent) => {
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

export const inferRelatedRole = (candidate) => {
  const evidenceTypes = new Set((candidate.evidence ?? []).map((item) => item.type));
  const isTest = TEST_FILE_RE.test((candidate.rel ?? '').toLowerCase());
  if (evidenceTypes.has('testOf') || (evidenceTypes.has('semanticReference') && isTest)) {
    return 'test';
  }
  if (evidenceTypes.has('dependencyOf')) return 'dependency';
  if (
    evidenceTypes.has('dependentOf')
    || evidenceTypes.has('semanticReference')
    || evidenceTypes.has('semanticImplementation')
  ) {
    return 'dependent';
  }
  return 'dependent';
};

export const computePrimarySignal = (candidate, intent) => {
  const relLower = (candidate.rel ?? '').toLowerCase();
  let score = 0;

  for (const evidence of candidate.evidence ?? []) {
    if (evidence.type === 'entryFile') score += 120;
    if (evidence.type === 'diffHit') score += 110;
    if (evidence.type === 'semanticDefinition') score += 118;
    if (evidence.type === 'semanticImplementation') score += 95;
    if (evidence.type === 'semanticReference') score += 70;
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

export const scorePrimarySeed = (seed, task, intent) => {
  const rel = seed.rel ?? '';
  const relLower = rel.toLowerCase();
  const basename = path.basename(relLower, path.extname(relLower));
  const pathTokens = new Set(tokenizePath(relLower));
  const pathHints = extractPrimaryPathHints(task);
  let score = 0;

  for (const evidence of seed.evidence ?? []) {
    if (evidence.type === 'entryFile') { score += 100; continue; }
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

export const rerankPrimarySeeds = (primarySeeds, task, intent) =>
  [...primarySeeds].sort((a, b) =>
    scorePrimarySeed(b, task, intent) - scorePrimarySeed(a, task, intent)
    || a.rel.localeCompare(b.rel)
  );

export const computePrimaryPromotionScore = (candidate, task, intent) => {
  let score = scorePrimarySeed(candidate, task, intent);
  score += computePrimarySignal(candidate, intent);
  if (candidate.role === 'primary') score += 6;
  return score;
};

export const normalizePrimaryCandidate = (files, task, intent) => {
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

export const computeMarginalPenalty = (candidate, selected) => {
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

export { ROLE_RANK, ROLE_BASE_SCORE, EVIDENCE_BASE_SCORE };
