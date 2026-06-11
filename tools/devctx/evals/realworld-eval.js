#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { smartRead, clearReadCache } from '../src/tools/smart-read.js';
import { smartSearch } from '../src/tools/smart-search.js';
import { smartContext } from '../src/tools/smart-context.js';
import { smartReadBatch } from '../src/tools/smart-read-batch.js';
import { setProjectRoot } from '../src/utils/paths.js';
import { buildIndex, persistIndex, loadIndex } from '../src/index.js';
import { countTokens } from '../src/tokenCounter.js';
import { average, bucketTaskSize, ratio, summarizeTaskSizes } from './kpi-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const RESULTS_DIR = path.resolve(__dirname, 'results');

const SCENARIOS = [
  {
    id: 'debug-shell-quotes',
    type: 'debug',
    task: 'TypeError in smartShell when command has nested quotes — find the tokenizer and validation logic',
    expectedFiles: ['src/tools/smart-shell.js'],
    expectedSymbols: ['validateCommand', 'tokenize', 'smartShell'],
    verify: (ctx) => {
      const files = ctx.context.map((c) => c.file);
      const hasShell = files.some((f) => f.includes('smart-shell'));
      const hasContent = ctx.context.some((c) => c.file?.includes('smart-shell') && c.content?.length > 50);
      return { hasShell, hasContent, selfSufficient: hasShell && hasContent };
    },
  },
  {
    id: 'debug-index-silent-fail',
    type: 'debug',
    task: 'ensureIndexReady fails silently in repos without package.json — find the index manager and its fallback logic',
    expectedFiles: ['src/index-manager.js'],
    expectedSymbols: ['ensureIndexReady'],
    verify: (ctx) => {
      const files = ctx.context.map((c) => c.file);
      const hasManager = files.some((f) => f.includes('index-manager'));
      const hasContent = ctx.context.some((c) => c.file?.includes('index-manager') && c.content?.length > 50);
      return { hasManager, hasContent, selfSufficient: hasManager && hasContent };
    },
  },
  {
    id: 'review-allocate-reads',
    type: 'code-review',
    task: 'Review smart_context allocateReads function — how does it distribute token budget across files?',
    expectedFiles: ['src/tools/smart-context.js'],
    expectedSymbols: ['allocateReads', 'shouldReadContentForItem'],
    verify: (ctx) => {
      const files = ctx.context.map((c) => c.file);
      const hasContext = files.some((f) => f.includes('smart-context'));
      const hasContent = ctx.context.some((c) => c.file?.includes('smart-context') && c.content?.length > 50);
      return { hasContext, hasContent, selfSufficient: hasContext && hasContent };
    },
  },
  {
    id: 'refactor-extract-validation',
    type: 'refactoring',
    task: 'Refactor: extract validateCommand and tokenize from smart-shell.js into a separate validation module',
    expectedFiles: ['src/tools/smart-shell.js'],
    expectedSymbols: ['validateCommand', 'tokenize', 'hasUnquotedShellOperators'],
    entryFile: 'tools/devctx/src/tools/smart-shell.js',
    verify: (ctx) => {
      const files = ctx.context.map((c) => c.file);
      const hasShell = files.some((f) => f.includes('smart-shell'));
      const hasTests = files.some((f) => f.includes('test') || f.includes('spec'));
      const hasGraph = ctx.graph && (ctx.graph.tests?.length > 0 || ctx.graph.dependents?.length > 0);
      return { hasShell, hasTests, hasGraph, selfSufficient: hasShell && hasTests };
    },
  },
  {
    id: 'testing-score-group',
    type: 'testing',
    task: 'Write tests for scoreGroup ranking function in smart-search.js — need to understand its inputs and scoring logic',
    expectedFiles: ['src/tools/smart-search.js'],
    expectedSymbols: ['scoreGroup', 'intentWeights', 'defaultWeights'],
    verify: (ctx) => {
      const files = ctx.context.map((c) => c.file);
      const hasSearch = files.some((f) => f.includes('smart-search'));
      const symbolDetail = ctx.context.find((c) => c.role === 'symbolDetail');
      const hasContent = ctx.context.some((c) => c.file?.includes('smart-search') && c.content?.length > 50);
      return { hasSearch, hasSymbolDetail: !!symbolDetail, hasContent, selfSufficient: hasSearch && hasContent };
    },
  },
  {
    id: 'architecture-call-chain',
    type: 'architecture',
    task: 'Understand the full call chain from server.js tool registration through to SQLite persistence',
    expectedFiles: ['src/server.js', 'src/storage/sqlite.js'],
    expectedSymbols: ['createDevctxServer', 'persistMetrics'],
    verify: (ctx) => {
      const files = ctx.context.map((c) => c.file);
      const hasServer = files.some((f) => f.includes('server.js') && !f.includes('devctx-server'));
      const hasSqlite = files.some((f) => f.includes('sqlite'));
      return { hasServer, hasSqlite, selfSufficient: hasServer && hasSqlite };
    },
  },
  {
    id: 'search-exact-symbol',
    type: 'search-comparison',
    task: 'Find all call sites of persistMetrics across the codebase',
    query: 'persistMetrics',
    verify: (searchResult) => {
      const total = searchResult.totalMatches;
      const files = searchResult.matchedFiles;
      return { totalMatches: total, matchedFiles: files, lowNoise: files <= 15 };
    },
  },
  {
    id: 'search-broad-query',
    type: 'search-comparison',
    task: 'Search for a common term to test noise cap and broad-query hint',
    query: 'error',
    verify: (searchResult) => {
      const files = searchResult.matchedFiles;
      const totalFiles = searchResult.totalFiles ?? files;
      const hasHint = searchResult.matches?.includes('Note:') && searchResult.matches?.includes('Grep');
      return { matchedFiles: files, totalFiles, capped: files <= 15, hintShown: hasHint };
    },
  },
  {
    id: 'entryfile-guarantee',
    type: 'entryfile',
    task: 'Review smart-turn.js — understand the startTurn orchestration and session management',
    entryFile: 'tools/devctx/src/tools/smart-turn.js',
    expectedFiles: ['src/tools/smart-turn.js'],
    expectedSymbols: ['startTurn', 'endTurn', 'smartTurn'],
    verify: (ctx) => {
      const primary = ctx.context.find((c) => c.role === 'primary');
      const isPrimaryEntryFile = primary?.file?.includes('smart-turn');
      const hasContent = primary?.content?.length > 50;
      return { isPrimaryEntryFile, primaryHasContent: hasContent, selfSufficient: isPrimaryEntryFile && hasContent };
    },
  },
  {
    id: 'tight-budget',
    type: 'budget-test',
    task: 'Debug the AuthMiddleware validation flow',
    maxTokens: 2000,
    verify: (ctx) => {
      const totalItems = ctx.context?.length ?? 0;
      const withContent = ctx.context?.filter((c) => c.content?.length > 10).length ?? 0;
      return { totalItems, withContent, usable: totalItems > 0 };
    },
  },
];

const runContextScenario = async (scenario, countTokens) => {
  clearReadCache();
  const start = Date.now();

  const opts = {
    task: scenario.task,
    intent: scenario.type === 'debug' ? 'debug'
      : scenario.type === 'testing' ? 'tests'
      : scenario.type === 'architecture' ? 'explore'
      : 'implementation',
    detail: 'balanced',
    include: ['content', 'graph', 'hints', 'symbolDetail'],
  };
  if (scenario.entryFile) opts.entryFile = scenario.entryFile;
  if (scenario.maxTokens) opts.maxTokens = scenario.maxTokens;

  const result = await smartContext(opts);
  const latencyMs = Date.now() - start;

  const contextTokens = countTokens(JSON.stringify(result.context ?? []));
  const filesReturned = result.context?.length ?? 0;
  const filesWithContent = result.context?.filter((c) => c.content?.length > 10).length ?? 0;
  const expectedHits = (scenario.expectedFiles ?? []).filter((ef) =>
    result.context?.some((c) => c.file?.includes(ef))
  );

  const symbolsInContent = (scenario.expectedSymbols ?? []).filter((sym) => {
    const allContent = (result.context ?? []).map((c) => c.content ?? '').join('\n');
    return allContent.toLowerCase().includes(sym.toLowerCase());
  });

  const verification = scenario.verify(result);

  let followUpNeeded = 0;
  let followUpTokens = 0;

  if (!verification.selfSufficient && scenario.expectedSymbols?.length > 0) {
    const primaryFile = result.context?.find((c) => c.role === 'primary')?.file;
    if (primaryFile) {
      for (const sym of scenario.expectedSymbols.slice(0, 3)) {
        try {
          const readResult = await smartRead({ filePath: primaryFile, mode: 'symbol', symbol: sym });
          if (readResult.content?.length > 10) {
            followUpNeeded++;
            followUpTokens += countTokens(readResult.content);
          }
        } catch {}
      }
    }
  }

  return {
    id: scenario.id,
    type: scenario.type,
    taskSize: bucketTaskSize(scenario.type),
    latencyMs,
    contextTokens,
    filesReturned,
    filesWithContent,
    expectedFileHits: `${expectedHits.length}/${(scenario.expectedFiles ?? []).length}`,
    symbolsFound: `${symbolsInContent.length}/${(scenario.expectedSymbols ?? []).length}`,
    followUpReadsNeeded: followUpNeeded,
    followUpTokens,
    totalTokens: contextTokens + followUpTokens,
    selfSufficient: verification.selfSufficient ?? false,
    verification,
  };
};

const runSearchScenario = async (scenario, countTokens) => {
  clearReadCache();
  const start = Date.now();
  const result = await smartSearch({ query: scenario.query, cwd: '.' });
  const latencyMs = Date.now() - start;
  const matchTokens = countTokens(result.matches ?? '');
  const verification = scenario.verify(result);

  return {
    id: scenario.id,
    type: scenario.type,
    taskSize: bucketTaskSize(scenario.type),
    latencyMs,
    query: scenario.query,
    totalMatches: result.totalMatches,
    matchedFiles: result.matchedFiles,
    matchTokens,
    verification,
  };
};

const run = async () => {
  const jsonMode = process.argv.includes('--json');
  const print = (msg) => { if (!jsonMode) process.stdout.write(`${msg}\n`); };

  setProjectRoot(PROJECT_ROOT);

  print('Building index...');
  const index = buildIndex(PROJECT_ROOT);
  await persistIndex(index, PROJECT_ROOT);
  print('Index ready.\n');

  const tokenCounter = countTokens;
  const results = [];

  print('=== Real-World Scenario Evaluation ===\n');

  for (const scenario of SCENARIOS) {
    print(`Running: [${scenario.id}] ${scenario.task.slice(0, 70)}...`);
    try {
      const result = scenario.type === 'search-comparison'
        ? await runSearchScenario(scenario, tokenCounter)
        : await runContextScenario(scenario, tokenCounter);
      results.push(result);

      if (!jsonMode) {
        if (result.selfSufficient !== undefined) {
          print(`  Self-sufficient: ${result.selfSufficient ? 'YES' : 'NO'}`);
          print(`  Files: ${result.filesReturned} (${result.filesWithContent} with content)`);
          print(`  Expected files: ${result.expectedFileHits} | Symbols: ${result.symbolsFound}`);
          print(`  Context tokens: ${result.contextTokens} | Follow-up: ${result.followUpReadsNeeded} calls (+${result.followUpTokens} tokens)`);
          print(`  Total: ${result.totalTokens} tokens | ${result.latencyMs}ms`);
        } else {
          print(`  Matches: ${result.totalMatches} in ${result.matchedFiles} files`);
          print(`  Tokens: ${result.matchTokens} | ${result.latencyMs}ms`);
          print(`  ${JSON.stringify(result.verification)}`);
        }
        print('');
      }
    } catch (err) {
      print(`  ERROR: ${err.message}`);
      results.push({ id: scenario.id, type: scenario.type, error: err.message });
    }
  }

  const contextResults = results.filter((r) => r.selfSufficient !== undefined);
  const selfSufficientCount = contextResults.filter((r) => r.selfSufficient).length;
  const totalContextTokens = contextResults.reduce((sum, r) => sum + (r.contextTokens ?? 0), 0);
  const totalFollowUpTokens = contextResults.reduce((sum, r) => sum + (r.followUpTokens ?? 0), 0);
  const totalFollowUpCalls = contextResults.reduce((sum, r) => sum + (r.followUpReadsNeeded ?? 0), 0);
  const rereadTasks = contextResults.filter((r) => (r.followUpReadsNeeded ?? 0) > 0).length;
  const avgLatency = Math.round(contextResults.reduce((sum, r) => sum + (r.latencyMs ?? 0), 0) / (contextResults.length || 1));

  const summary = {
    timestamp: new Date().toISOString(),
    scenarios: results.length,
    contextScenarios: contextResults.length,
    selfSufficient: selfSufficientCount,
    selfSufficiencyRate: `${Math.round((selfSufficientCount / (contextResults.length || 1)) * 100)}%`,
    totalContextTokens,
    totalFollowUpTokens,
    totalFollowUpCalls,
    tokenEfficiency: totalFollowUpTokens > 0
      ? `${Math.round((totalFollowUpTokens / (totalContextTokens + totalFollowUpTokens)) * 100)}% wasted on follow-ups`
      : '0% wasted — fully self-sufficient',
    avgLatencyMs: avgLatency,
    rereadTaskRate: ratio(rereadTasks, contextResults.length),
    rereadCallRate: ratio(totalFollowUpCalls, contextResults.length),
    byTaskSize: summarizeTaskSizes(results, (subset) => ({
      avgLatencyMs: Math.round(average(subset, (r) => r.latencyMs ?? 0)),
      avgTokens: Math.round(average(subset, (r) => r.totalTokens ?? r.matchTokens ?? 0)),
      selfSufficientRate: ratio(
        subset.filter((r) => r.selfSufficient === true).length,
        subset.filter((r) => r.selfSufficient !== undefined).length,
      ),
    })),
  };

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = path.join(RESULTS_DIR, `realworld-eval-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ summary, results }, null, 2));

  if (jsonMode) {
    process.stdout.write(JSON.stringify({ outPath, summary, results }, null, 2) + '\n');
  } else {
    print('=== Summary ===');
    print(`Scenarios: ${summary.scenarios} (${summary.contextScenarios} context + ${results.length - summary.contextScenarios} search)`);
    print(`Self-sufficient: ${summary.selfSufficient}/${summary.contextScenarios} (${summary.selfSufficiencyRate})`);
    print(`Context tokens: ${summary.totalContextTokens}`);
    print(`Follow-up tokens: ${summary.totalFollowUpTokens} (${summary.totalFollowUpCalls} extra calls)`);
    print(`Token efficiency: ${summary.tokenEfficiency}`);
    print(`Avg latency: ${summary.avgLatencyMs}ms`);
    print(`Reread task rate: ${summary.rereadTaskRate}`);
    print(`Reread call rate: ${summary.rereadCallRate}`);
    print(`Results: ${outPath}`);
  }
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
