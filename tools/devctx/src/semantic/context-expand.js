import path from 'node:path';
import { createSemanticProvider } from './semantic-provider.js';

const TEST_PATH_RE = /(?:^|[/\\])(?:__tests__|tests?|specs?)[/\\]|(?:\.|\b)(?:test|spec)\.[^.]+$/i;
const SOURCE_EXT_RE = /\.(?:[cm]?[jt]sx?)$/i;

const uniqueList = (items = []) => [...new Set(items.filter(Boolean))];

const isTestPath = (filePath) => TEST_PATH_RE.test(String(filePath ?? ''));

const isSourcePath = (filePath) => SOURCE_EXT_RE.test(String(filePath ?? ''));

export const collectSemanticSymbols = ({
  symbolCandidates = [],
  primarySeeds = [],
  index = null,
  maxSymbols = 3,
} = {}) => {
  const fromTask = uniqueList(symbolCandidates).slice(0, maxSymbols);
  if (fromTask.length > 0) return fromTask;

  const fromSeeds = [];
  for (const seed of primarySeeds) {
    for (const name of seed.matchedSymbols ?? []) {
      if (!fromSeeds.includes(name)) fromSeeds.push(name);
    }
    const fileSymbols = index?.files?.[seed.rel]?.symbols ?? [];
    for (const entry of fileSymbols.slice(0, 3)) {
      if (entry?.name && !fromSeeds.includes(entry.name)) fromSeeds.push(entry.name);
    }
    if (fromSeeds.length >= maxSymbols) break;
  }

  return fromSeeds.slice(0, maxSymbols);
};

const upsertSemanticFile = (files, rel, next) => {
  if (!rel || !isSourcePath(rel)) return false;
  const absPath = next.absPath ?? path.join(next.root, rel);
  const existing = files.get(rel);

  if (!existing) {
    files.set(rel, {
      absPath,
      role: next.role,
      evidence: next.evidence ?? [],
      ...(next.matchedSymbols?.length ? { matchedSymbols: uniqueList(next.matchedSymbols).slice(0, 3) } : {}),
    });
    return true;
  }

  const ROLE_RANK = { primary: 0, test: 1, dependency: 2, dependent: 3 };
  const role = (ROLE_RANK[next.role] ?? 99) < (ROLE_RANK[existing.role] ?? 99) ? next.role : existing.role;
  const evidence = [...(existing.evidence ?? []), ...(next.evidence ?? [])];
  const matchedSymbols = uniqueList([
    ...(existing.matchedSymbols ?? []),
    ...(next.matchedSymbols ?? []),
  ]).slice(0, 3);

  files.set(rel, {
    ...existing,
    absPath: existing.absPath ?? absPath,
    role,
    evidence,
    ...(matchedSymbols.length ? { matchedSymbols } : {}),
  });
  return false;
};

const roleForSemanticHit = (rel, relation) => {
  if (isTestPath(rel)) return 'test';
  if (relation === 'definition') return 'primary';
  if (relation === 'implementation') return 'dependent';
  return 'dependent';
};

export const expandWithSemantic = async ({
  root,
  expanded,
  symbolCandidates = [],
  primarySeeds = [],
  index = null,
  maxSymbols = 3,
  maxFiles = 6,
  maxResultsPerSymbol = 12,
  _provider = null,
} = {}) => {
  const symbols = collectSemanticSymbols({
    symbolCandidates,
    primarySeeds,
    index,
    maxSymbols,
  });

  if (!expanded || symbols.length === 0) {
    return {
      enabled: true,
      provider: 'none',
      confidence: 'none',
      symbolsResolved: [],
      filesAdded: 0,
      locationsSeen: 0,
      reason: symbols.length === 0 ? 'no-symbol-candidates' : 'no-expanded-map',
    };
  }

  const provider = _provider ?? createSemanticProvider({ root });
  const shouldDispose = !_provider && typeof provider.dispose === 'function';
  const symbolsResolved = [];
  let filesAdded = 0;
  let locationsSeen = 0;

  try {
    for (const symbol of symbols) {
      if (filesAdded >= maxFiles) break;

      const resolved = typeof provider.resolveSymbol === 'function'
        ? provider.resolveSymbol({ symbol })
        : null;

      if (!resolved?.filePath) {
        symbolsResolved.push({ symbol, found: false });
        continue;
      }

      symbolsResolved.push({
        symbol,
        found: true,
        filePath: resolved.filePath,
        line: resolved.line,
        character: resolved.character,
      });

      const definitionHits = await provider.definition(resolved);
      const referenceHits = await provider.references(resolved);
      const implementationHits = await provider.implementations(resolved);

      const buckets = [
        { relation: 'definition', hits: definitionHits.slice(0, 3) },
        { relation: 'implementation', hits: implementationHits.slice(0, maxResultsPerSymbol) },
        { relation: 'reference', hits: referenceHits.slice(0, maxResultsPerSymbol) },
      ];

      for (const bucket of buckets) {
        for (const hit of bucket.hits) {
          if (filesAdded >= maxFiles) break;
          const rel = hit?.filePath;
          if (!rel) continue;
          locationsSeen += 1;

          const added = upsertSemanticFile(expanded, rel, {
            root,
            role: roleForSemanticHit(rel, bucket.relation),
            matchedSymbols: [symbol],
            evidence: [{
              type: bucket.relation === 'definition'
                ? 'semanticDefinition'
                : bucket.relation === 'implementation'
                  ? 'semanticImplementation'
                  : 'semanticReference',
              symbol,
              relation: bucket.relation,
              via: resolved.filePath,
            }],
          });
          if (added) filesAdded += 1;
        }
      }
    }

    return {
      enabled: true,
      provider: provider.provider,
      ...(provider.reason ? { providerReason: provider.reason } : {}),
      confidence: provider.provider === 'fallback'
        ? 'none'
        : (filesAdded > 0 || symbolsResolved.some((item) => item.found) ? 'high' : 'low'),
      symbolsResolved,
      filesAdded,
      locationsSeen,
    };
  } finally {
    if (shouldDispose) provider.dispose();
  }
};
