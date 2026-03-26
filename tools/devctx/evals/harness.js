#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setProjectRoot } from '../src/utils/paths.js';
import { buildIndex, persistIndex } from '../src/index.js';
import { smartSearch } from '../src/tools/smart-search.js';
import { smartRead } from '../src/tools/smart-read.js';
import { smartContext } from '../src/tools/smart-context.js';
import { countTokens } from '../src/tokenCounter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, 'fixtures', 'sample-project');
const CORPUS_PATH = path.resolve(__dirname, 'corpus', 'tasks.json');
const RESULTS_DIR = path.resolve(__dirname, 'results');

const isBaseline = process.argv.includes('--baseline');

const getArgValue = (prefix) => {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.split('=')[1] : null;
};

const toolMode = getArgValue('--tool=') ?? 'search';

const normalizeFilePath = (filePath, root) => {
  const rel = path.relative(root, filePath);
  return rel.replace(/\\/g, '/');
};

const percentile = (arr, p) => {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
};

const matchesExpectedFile = (candidate, expectedFiles) =>
  Boolean(candidate) && expectedFiles.some((expected) => candidate.endsWith(expected) || candidate === expected);

const collectPreviewSymbols = (items) => new Set(
  items.flatMap((item) =>
    (item.symbolPreviews ?? [])
      .map((preview) => preview?.name)
      .filter(Boolean)
      .map((name) => String(name).toLowerCase())
  )
);

const countPreviewTokens = (items) =>
  items.reduce((sum, item) => sum + countTokens(JSON.stringify(item.symbolPreviews ?? [])), 0);

const evaluateSearch = (result, task, root) => {
  const topFiles = (result.topFiles ?? []).map((f) => normalizeFilePath(f.file, root));
  const top5 = topFiles.slice(0, 5);
  const top10 = topFiles.slice(0, 10);

  const expectedNorm = task.expectedFiles.map((f) => f.replace(/\\/g, '/'));
  const hitsTop5 = expectedNorm.filter((f) => top5.some((t) => t.endsWith(f) || t === f));
  const hitsTop10 = expectedNorm.filter((f) => top10.some((t) => t.endsWith(f) || t === f));

  const wrongFileTop1 = expectedNorm.length > 0 && top5.length > 0
    ? !expectedNorm.some((f) => top5[0].endsWith(f) || top5[0] === f)
    : false;

  return {
    precision5: expectedNorm.length > 0 ? hitsTop5.length / expectedNorm.length : 1,
    precision10: expectedNorm.length > 0 ? hitsTop10.length / expectedNorm.length : 1,
    recall: expectedNorm.length > 0 ? hitsTop10.length / expectedNorm.length : 1,
    wrongFileTop1,
    totalMatches: result.totalMatches,
    matchedFiles: result.matchedFiles,
    engine: result.engine,
    retrievalConfidence: result.retrievalConfidence,
    indexFreshness: result.indexFreshness,
    sourceBreakdown: result.sourceBreakdown,
    confidenceLevel: result.confidence?.level ?? null,
    searchTokens: result.metrics?.compressedTokens ?? 0,
  };
};

const evaluateSymbol = async (topFile, symbols, root) => {
  if (symbols.length === 0) return { symbolHits: 0, symbolTotal: 0, symbolTokens: 0 };

  const filePath = path.isAbsolute(topFile) ? topFile : path.join(root, topFile);
  if (!fs.existsSync(filePath)) return { symbolHits: 0, symbolTotal: symbols.length, symbolTokens: 0 };

  try {
    const result = await smartRead({ filePath, mode: 'symbol', symbol: symbols });
    const content = result.content ?? '';
    const hits = symbols.filter((s) => content.includes(s) && !content.includes(`Symbol not found: ${s}`));
    return {
      symbolHits: hits.length,
      symbolTotal: symbols.length,
      symbolTokens: result.metrics?.compressedTokens ?? 0,
    };
  } catch {
    return { symbolHits: 0, symbolTotal: symbols.length, symbolTokens: 0 };
  }
};

const evaluateContext = async (task, root) => {
  const start = Date.now();
  try {
    const result = await smartContext({ task: task.description });
    const latencyMs = Date.now() - start;

    const contextItems = result.context ?? [];
    const contextFiles = contextItems.map((item) => item.file);
    const expectedNorm = task.expectedFiles.map((file) => file.replace(/\\/g, '/'));
    const expectedSymbols = (task.expectedSymbols ?? []).map((symbol) => symbol.toLowerCase());
    const hits = expectedNorm.filter((file) => contextFiles.some((candidate) => candidate.endsWith(file) || candidate === file));
    const explainedItems = contextItems.filter((item) =>
      typeof item.reasonIncluded === 'string' &&
      item.reasonIncluded.trim() &&
      Array.isArray(item.evidence) &&
      item.evidence.length > 0
    );
    const previewItems = contextItems.filter((item) => Array.isArray(item.symbolPreviews) && item.symbolPreviews.length > 0);
    const previewSymbols = collectPreviewSymbols(previewItems);
    const previewHits = expectedSymbols.filter((symbol) => previewSymbols.has(symbol));
    const primaryItem = contextItems.find((item) => item.role === 'primary') ?? contextItems[0] ?? null;
    const primaryPreviewSymbols = new Set(
      (primaryItem?.symbolPreviews ?? [])
        .map((preview) => preview?.name)
        .filter(Boolean)
        .map((name) => String(name).toLowerCase())
    );
    const primaryPreviewHits = expectedSymbols.filter((symbol) => primaryPreviewSymbols.has(symbol));
    const primaryHasPreviews = (primaryItem?.symbolPreviews?.length ?? 0) > 0;
    const primaryHit = matchesExpectedFile(primaryItem?.file ?? '', expectedNorm);

    return {
      contextPrecision: expectedNorm.length > 0 ? hits.length / expectedNorm.length : 1,
      contextFiles: contextFiles.length,
      contextItems: contextItems.length,
      contextTokens: result.metrics?.totalTokens ?? 0,
      previewTokens: result.metrics?.previewTokens ?? countPreviewTokens(contextItems),
      indexOnlyItems: result.metrics?.indexOnlyItems ?? contextItems.filter((item) => item.readMode === 'index-only').length,
      contentItems: result.metrics?.contentItems ?? contextItems.filter((item) => typeof item.content === 'string' && item.content.length > 0).length,
      indexFreshness: result.indexFreshness,
      graphCoverage: result.graphCoverage,
      confidenceIndexFreshness: result.confidence?.indexFreshness ?? null,
      explainedCoverage: contextItems.length > 0 ? +(explainedItems.length / contextItems.length).toFixed(3) : 0,
      previewCoverage: contextItems.length > 0 ? +(previewItems.length / contextItems.length).toFixed(3) : 0,
      previewSymbolRecall: expectedSymbols.length > 0 ? +(previewHits.length / expectedSymbols.length).toFixed(3) : null,
      primaryFile: primaryItem?.file ?? null,
      primaryReadMode: primaryItem?.readMode ?? null,
      primaryHit,
      primaryPreviewCoverage: primaryHasPreviews ? 1 : 0,
      primaryPreviewRecall: expectedSymbols.length > 0 ? +(primaryPreviewHits.length / expectedSymbols.length).toFixed(3) : null,
      primaryUsefulPreview: primaryPreviewHits.length > 0,
      latencyMs,
      pass: expectedNorm.length === 0 || hits.length > 0,
    };
  } catch {
    return {
      contextPrecision: 0,
      contextFiles: 0,
      contextItems: 0,
      contextTokens: 0,
      previewTokens: 0,
      indexOnlyItems: 0,
      contentItems: 0,
      indexFreshness: 'unavailable',
      graphCoverage: null,
      confidenceIndexFreshness: null,
      explainedCoverage: 0,
      previewCoverage: 0,
      previewSymbolRecall: null,
      primaryFile: null,
      primaryReadMode: null,
      primaryHit: false,
      primaryPreviewCoverage: 0,
      primaryPreviewRecall: null,
      primaryUsefulPreview: false,
      latencyMs: Date.now() - start,
      pass: false,
    };
  }
};

const taskTypeToIntent = {
  'find-definition': 'implementation',
  debug: 'debug',
  review: 'implementation',
  tests: 'tests',
  refactor: 'implementation',
  config: 'config',
  onboard: 'explore',
  explore: 'explore',
};

const runTask = async (task, root) => {
  const start = Date.now();
  const intent = isBaseline ? undefined : taskTypeToIntent[task.taskType];

  const searchResult = await smartSearch({ query: task.query, cwd: root, intent });
  const searchMetrics = evaluateSearch(searchResult, task, root);

  let symbolMetrics = { symbolHits: 0, symbolTotal: 0, symbolTokens: 0 };
  let followUpReads = 0;
  let tokensToSuccess = searchMetrics.searchTokens;
  let symbolSuccessReached = false;

  if (task.expectedSymbols?.length > 0 && searchResult.topFiles?.length > 0) {
    for (const topFile of searchResult.topFiles.slice(0, 5)) {
      followUpReads++;
      const candidate = await evaluateSymbol(topFile.file, task.expectedSymbols, root);

      if (!symbolSuccessReached) {
        tokensToSuccess += candidate.symbolTokens;
      }

      if (candidate.symbolHits > symbolMetrics.symbolHits) {
        symbolMetrics = candidate;
      }
      if (symbolMetrics.symbolHits === symbolMetrics.symbolTotal) {
        symbolSuccessReached = true;
        break;
      }
    }
  }

  let contextMetrics = null;
  if (toolMode === 'context' || toolMode === 'both') {
    contextMetrics = await evaluateContext(task, root);
  }

  const latencyMs = Date.now() - start;
  const searchTokens = searchMetrics.searchTokens + symbolMetrics.symbolTokens;
  const searchPass = searchMetrics.precision5 >= 0.5 && (symbolMetrics.symbolTotal === 0 || symbolMetrics.symbolHits > 0);

  const pass = toolMode === 'context'
    ? (contextMetrics?.pass ?? false)
    : toolMode === 'both'
      ? searchPass && (contextMetrics?.pass ?? true)
      : searchPass;

  const totalTokens = toolMode === 'context'
    ? (contextMetrics?.contextTokens ?? 0)
    : toolMode === 'both'
      ? searchTokens + (contextMetrics?.contextTokens ?? 0)
      : searchTokens;

  const retrievalHonest = (() => {
    const conf = searchMetrics.retrievalConfidence;
    const engine = searchMetrics.engine;
    const freshness = searchMetrics.indexFreshness;
    if (engine === 'walk' && conf === 'high') return false;
    if (freshness === 'stale' && conf === 'high') return false;
    return true;
  })();

  return {
    id: task.id,
    taskType: task.taskType,
    query: task.query,
    latencyMs,
    totalTokens,
    tokensToSuccess,
    followUpReads,
    retrievalHonest,
    ...searchMetrics,
    ...symbolMetrics,
    pass,
    ...(contextMetrics ? { context: contextMetrics } : {}),
  };
};

const computeConfidenceCalibration = (results) => {
  let correct = 0;
  let overConfident = 0;
  let underConfident = 0;
  let total = 0;

  for (const r of results) {
    const level = r.confidenceLevel;
    if (!level) continue;
    total++;
    const isHighConf = level === 'high';
    if (isHighConf && r.pass) correct++;
    else if (isHighConf && !r.pass) overConfident++;
    else if (!isHighConf && r.pass) underConfident++;
    else correct++;
  }

  return {
    total,
    accuracy: total > 0 ? +(correct / total).toFixed(3) : 0,
    overConfidentRate: total > 0 ? +(overConfident / total).toFixed(3) : 0,
    underConfidentRate: total > 0 ? +(underConfident / total).toFixed(3) : 0,
  };
};

const run = async () => {
  const corpusPath = getArgValue('--corpus=') ? path.resolve(getArgValue('--corpus=')) : CORPUS_PATH;
  const evalRoot = getArgValue('--root=') ? path.resolve(getArgValue('--root=')) : FIXTURE_ROOT;

  setProjectRoot(evalRoot);

  if (!isBaseline) {
    const index = buildIndex(evalRoot);
    await persistIndex(index, evalRoot);
    const symbolCount = Object.values(index.files).reduce((sum, f) => sum + f.symbols.length, 0);
    const sigCount = Object.values(index.files).reduce((sum, f) => sum + f.symbols.filter((s) => s.signature).length, 0);
    process.stdout.write(`Index: ${Object.keys(index.files).length} files, ${symbolCount} symbols, ${sigCount} signatures\n`);
    process.stdout.write(`Tool mode: ${toolMode}\n\n`);
  } else {
    process.stdout.write('Baseline mode: index and intent disabled\n\n');
  }

  const tasks = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
  const results = [];

  for (const task of tasks) {
    const result = await runTask(task, evalRoot);
    results.push(result);
    const status = result.pass ? 'PASS' : 'FAIL';
    const ctxInfo = result.context ? ` ctx=${result.context.contextPrecision.toFixed(2)} primary=${result.context.primaryHit ? 1 : 0}` : '';
    process.stdout.write(`  ${status}  ${result.id} (${result.latencyMs}ms, p5=${result.precision5.toFixed(2)}${ctxInfo})\n`);
  }

  const latencies = results.map((r) => r.latencyMs);
  const tokenCounts = results.map((r) => r.totalTokens);
  const calibration = toolMode === 'context'
    ? null
    : computeConfidenceCalibration(results);

  const summary = {
    timestamp: new Date().toISOString(),
    mode: isBaseline ? 'baseline' : 'full',
    toolMode,
    fixtureRoot: evalRoot,
    totalTasks: results.length,
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).length,
    avgPrecision5: +(results.reduce((a, r) => a + r.precision5, 0) / results.length).toFixed(3),
    avgPrecision10: +(results.reduce((a, r) => a + r.precision10, 0) / results.length).toFixed(3),
    avgRecall: +(results.reduce((a, r) => a + r.recall, 0) / results.length).toFixed(3),
    wrongFileRate: +(results.filter((r) => r.wrongFileTop1).length / results.length).toFixed(3),
    avgFollowUpReads: +(results.reduce((a, r) => a + r.followUpReads, 0) / results.length).toFixed(2),
    avgTokensToSuccess: Math.round(results.reduce((a, r) => a + r.tokensToSuccess, 0) / results.length),
    retrievalHonesty: +(results.filter((r) => r.retrievalHonest).length / results.length).toFixed(3),
    confidenceCalibration: calibration,
    avgLatencyMs: Math.round(results.reduce((a, r) => a + r.latencyMs, 0) / results.length),
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    avgTokens: Math.round(results.reduce((a, r) => a + r.totalTokens, 0) / results.length),
    p50Tokens: percentile(tokenCounts, 50),
    p95Tokens: percentile(tokenCounts, 95),
    byTaskType: {},
    results,
  };

  if (toolMode === 'context' || toolMode === 'both') {
    const ctxResults = results.filter((r) => r.context);
    if (ctxResults.length > 0) {
      const previewEligible = ctxResults.filter((r) => r.context.previewSymbolRecall != null);
      const primaryPreviewEligible = ctxResults.filter((r) => r.context.primaryPreviewRecall != null);
      summary.contextMetrics = {
        avgContextPrecision: +(ctxResults.reduce((a, r) => a + r.context.contextPrecision, 0) / ctxResults.length).toFixed(3),
        avgContextItems: +(ctxResults.reduce((a, r) => a + r.context.contextItems, 0) / ctxResults.length).toFixed(2),
        avgContextTokens: Math.round(ctxResults.reduce((a, r) => a + r.context.contextTokens, 0) / ctxResults.length),
        avgPreviewTokens: Math.round(ctxResults.reduce((a, r) => a + r.context.previewTokens, 0) / ctxResults.length),
        avgIndexOnlyItems: +(ctxResults.reduce((a, r) => a + r.context.indexOnlyItems, 0) / ctxResults.length).toFixed(2),
        avgContentItems: +(ctxResults.reduce((a, r) => a + r.context.contentItems, 0) / ctxResults.length).toFixed(2),
        avgExplainedCoverage: +(ctxResults.reduce((a, r) => a + r.context.explainedCoverage, 0) / ctxResults.length).toFixed(3),
        avgPreviewCoverage: +(ctxResults.reduce((a, r) => a + r.context.previewCoverage, 0) / ctxResults.length).toFixed(3),
        avgPreviewSymbolRecall: previewEligible.length > 0
          ? +(previewEligible.reduce((a, r) => a + r.context.previewSymbolRecall, 0) / previewEligible.length).toFixed(3)
          : null,
        previewEligibleTasks: previewEligible.length,
        primaryHits: ctxResults.filter((r) => r.context.primaryHit).length,
        primaryHitRate: +(ctxResults.filter((r) => r.context.primaryHit).length / ctxResults.length).toFixed(3),
        primaryIndexFirstRate: +(ctxResults.filter((r) => ['index-only', 'signatures-only'].includes(r.context.primaryReadMode)).length / ctxResults.length).toFixed(3),
        avgPrimaryPreviewCoverage: +(ctxResults.reduce((a, r) => a + r.context.primaryPreviewCoverage, 0) / ctxResults.length).toFixed(3),
        avgPrimaryPreviewRecall: primaryPreviewEligible.length > 0
          ? +(primaryPreviewEligible.reduce((a, r) => a + r.context.primaryPreviewRecall, 0) / primaryPreviewEligible.length).toFixed(3)
          : null,
        primaryPreviewEligibleTasks: primaryPreviewEligible.length,
        primaryUsefulPreviewRate: primaryPreviewEligible.length > 0
          ? +(primaryPreviewEligible.filter((r) => r.context.primaryUsefulPreview).length / primaryPreviewEligible.length).toFixed(3)
          : null,
        contextPassed: ctxResults.filter((r) => r.context.pass).length,
        contextTotal: ctxResults.length,
      };
    }
  }

  const taskTypes = [...new Set(results.map((r) => r.taskType))];
  for (const type of taskTypes) {
    const subset = results.filter((r) => r.taskType === type);
    summary.byTaskType[type] = {
      count: subset.length,
      passed: subset.filter((r) => r.pass).length,
      avgPrecision5: +(subset.reduce((a, r) => a + r.precision5, 0) / subset.length).toFixed(3),
      avgRecall: +(subset.reduce((a, r) => a + r.recall, 0) / subset.length).toFixed(3),
      wrongFileRate: +(subset.filter((r) => r.wrongFileTop1).length / subset.length).toFixed(3),
      avgFollowUpReads: +(subset.reduce((a, r) => a + r.followUpReads, 0) / subset.length).toFixed(2),
    };
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const prefix = isBaseline ? 'eval-baseline' : 'eval';
  const outPath = path.join(RESULTS_DIR, `${prefix}-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  process.stdout.write(`\nResults: ${outPath}\n`);
  process.stdout.write(`Pass: ${summary.passed}/${summary.totalTasks} | P@5: ${summary.avgPrecision5} | Recall: ${summary.avgRecall} | WrongFile: ${summary.wrongFileRate} | Honesty: ${summary.retrievalHonesty}\n`);
  if (calibration) {
    process.stdout.write(`Confidence calibration: accuracy=${calibration.accuracy} overConfident=${calibration.overConfidentRate} underConfident=${calibration.underConfidentRate}\n`);
  }
  process.stdout.write(`Latency p50/p95: ${summary.p50LatencyMs}/${summary.p95LatencyMs}ms | Tokens p50/p95: ${summary.p50Tokens}/${summary.p95Tokens}\n`);

  if (summary.contextMetrics) {
    const previewInfo = summary.contextMetrics.avgPreviewSymbolRecall != null
      ? ` | Preview symbol recall: ${summary.contextMetrics.avgPreviewSymbolRecall}`
      : '';
    const primaryInfo = ` | Primary hit: ${summary.contextMetrics.primaryHitRate} | Primary preview coverage: ${summary.contextMetrics.avgPrimaryPreviewCoverage}`;
    const primaryRecallInfo = summary.contextMetrics.avgPrimaryPreviewRecall != null
      ? ` | Primary preview recall: ${summary.contextMetrics.avgPrimaryPreviewRecall}`
      : '';
    process.stdout.write(`Context: ${summary.contextMetrics.contextPassed}/${summary.contextMetrics.contextTotal} passed | Avg precision: ${summary.contextMetrics.avgContextPrecision} | Explained: ${summary.contextMetrics.avgExplainedCoverage} | Preview coverage: ${summary.contextMetrics.avgPreviewCoverage}${previewInfo}${primaryInfo}${primaryRecallInfo} | Preview tokens: ${summary.contextMetrics.avgPreviewTokens} | Avg tokens: ${summary.contextMetrics.avgContextTokens}\n`);
  }

  return summary;
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
