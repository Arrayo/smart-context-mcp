import { loadIndex, queryRelated, isTestFile } from '../index.js';
import { ensureIndexReady } from '../index-manager.js';

const TEST_PATH_RE = /(?:^|[/\\])(?:__tests__|tests?|specs?)[/\\]|(?:\.|\b)(?:test|spec)\.[^.]+$/i;

const uniqueList = (items = []) => [...new Set(items.filter(Boolean))];

const isTestPath = (filePath) =>
  TEST_PATH_RE.test(String(filePath ?? '')) || isTestFile(String(filePath ?? ''));

const toFileEntry = (location, relation) => {
  if (!location?.filePath) return null;
  return {
    file: location.filePath,
    relation,
    ...(location.start ? { start: location.start } : {}),
    ...(location.end ? { end: location.end } : {}),
  };
};

const expandTransitive = (index, seedFiles, { maxHops = 2, maxFiles = 30 } = {}) => {
  if (!index?.files) {
    return { files: [], hops: 0, indexAvailable: false };
  }

  const expanded = new Map();
  const queue = seedFiles.map((file) => ({ file, depth: 0 }));

  while (queue.length > 0 && expanded.size < maxFiles) {
    const { file, depth } = queue.shift();
    if (!file || expanded.has(file)) continue;
    expanded.set(file, depth);
    if (depth >= maxHops || !index.files[file]) continue;

    const related = queryRelated(index, file);
    for (const next of [...related.imports, ...related.importedBy, ...related.tests]) {
      if (!expanded.has(next)) queue.push({ file: next, depth: depth + 1 });
    }
  }

  const files = [...expanded.entries()]
    .filter(([file, depth]) => depth > 0)
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([file, depth]) => ({ file, depth }));

  return {
    files,
    hops: files.reduce((max, item) => Math.max(max, item.depth), 0),
    indexAvailable: true,
  };
};

const estimateRisk = ({
  directFiles,
  transitiveFiles,
  tests,
  hasDefinition,
  provider,
}) => {
  const reasons = [];
  let score = 0;

  if (provider === 'fallback') {
    reasons.push('semantic provider unavailable; impact relies on weaker signals');
    score += 2;
  }
  if (!hasDefinition) {
    reasons.push('no definition resolved for the target symbol');
    score += 2;
  }
  if (directFiles >= 8) {
    reasons.push(`${directFiles} direct semantic hits`);
    score += 2;
  } else if (directFiles >= 3) {
    reasons.push(`${directFiles} direct semantic hits`);
    score += 1;
  }
  if (transitiveFiles >= 10) {
    reasons.push(`${transitiveFiles} transitive import-graph files`);
    score += 2;
  } else if (transitiveFiles >= 4) {
    reasons.push(`${transitiveFiles} transitive import-graph files`);
    score += 1;
  }
  if (tests === 0) {
    reasons.push('no related tests found');
    score += 2;
  }

  const level = score >= 5 ? 'high' : score >= 3 ? 'medium' : 'low';
  if (reasons.length === 0) reasons.push('narrow direct impact with related tests present');

  return {
    level,
    basis: 'heuristic',
    score,
    reasons,
    note: 'Risk is an estimate from counts and coverage signals, not a semantic certainty.',
  };
};

export const analyzeSemanticImpact = async ({
  provider,
  location,
  symbol = null,
  root,
  includeTests = true,
  maxResults = 20,
  maxHops = 2,
} = {}) => {
  const definitions = await provider.definition(location);
  const references = await provider.references(location);
  const implementations = await provider.implementations(location);
  const definition = definitions[0] ?? null;

  const seen = new Set();
  const directEntries = [];
  for (const item of [
    ...definitions.map((entry) => toFileEntry(entry, 'definition')),
    ...implementations.map((entry) => toFileEntry(entry, 'implementation')),
    ...references.map((entry) => toFileEntry(entry, 'reference')),
  ]) {
    if (!item) continue;
    const key = `${item.file}|${item.relation}|${item.start?.line ?? ''}|${item.start?.character ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    directEntries.push(item);
  }

  const directFiles = uniqueList(directEntries.map((item) => item.file));
  const semanticTests = uniqueList(
    directEntries.filter((item) => isTestPath(item.file)).map((item) => item.file),
  );

  await ensureIndexReady({ root }).catch(() => null);
  const index = loadIndex(root);
  const transitive = expandTransitive(index, directFiles, {
    maxHops,
    maxFiles: Math.max(maxResults * 2, 30),
  });

  const graphTests = uniqueList(
    transitive.files.filter((item) => isTestPath(item.file)).map((item) => item.file),
  );

  const tests = uniqueList([
    ...(includeTests ? semanticTests : []),
    ...(includeTests ? graphTests : []),
  ]);

  const transitiveOnly = transitive.files
    .filter((item) => !directFiles.includes(item.file))
    .slice(0, maxResults);

  const directLimited = directEntries.slice(0, maxResults);
  const testsLimited = tests.slice(0, maxResults);

  const coverage = {
    hasDefinition: Boolean(definition),
    hasReferences: references.length > 0,
    hasImplementations: implementations.length > 0,
    hasTests: tests.length > 0,
    indexAvailable: transitive.indexAvailable,
  };

  const confidence = provider.provider === 'fallback'
    ? 'none'
    : (!coverage.hasDefinition && directFiles.length === 0)
      ? 'low'
      : (coverage.indexAvailable ? 'high' : 'mixed');

  return {
    definition,
    impact: {
      direct: {
        source: 'semantic',
        files: uniqueList(directLimited.map((item) => item.file)),
        locations: directLimited,
        counts: {
          definitions: definitions.length,
          references: references.length,
          implementations: implementations.length,
          files: directFiles.length,
        },
        truncated: directEntries.length > maxResults,
      },
      transitive: {
        source: 'import-graph',
        basis: 'heuristic-expansion',
        hops: transitive.hops,
        files: transitiveOnly,
        truncated: transitive.files.length > transitiveOnly.length + directFiles.length,
        note: 'Transitive files come from the import graph, not LanguageService certainty.',
      },
      tests: {
        source: 'semantic+import-graph',
        files: testsLimited,
        total: tests.length,
        truncated: tests.length > maxResults,
      },
      coverage,
      risk: estimateRisk({
        directFiles: directFiles.length,
        transitiveFiles: transitiveOnly.length,
        tests: tests.length,
        hasDefinition: coverage.hasDefinition,
        provider: provider.provider,
      }),
    },
    confidence,
    totals: {
      directFiles: directFiles.length,
      transitiveFiles: transitiveOnly.length,
      tests: tests.length,
    },
  };
};
