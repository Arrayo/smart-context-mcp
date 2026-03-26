#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.resolve(__dirname, 'results');

const listResultFiles = () => fs.readdirSync(RESULTS_DIR).filter((name) => name.endsWith('.json'));

const readJson = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
};

const findLatest = (predicate) => {
  const files = listResultFiles().filter(predicate).sort().reverse();
  if (files.length === 0) return null;
  return path.join(RESULTS_DIR, files[0]);
};

const findLatestComparable = (currentPath, currentData) => {
  const currentName = path.basename(currentPath);
  const files = listResultFiles()
    .filter((name) => name.startsWith('eval-') && name.endsWith('.json'))
    .filter((name) => name !== currentName)
    .filter((name) => !name.startsWith('eval-baseline-'))
    .sort()
    .reverse();

  for (const name of files) {
    const candidatePath = path.join(RESULTS_DIR, name);
    const candidate = readJson(candidatePath);
    if (!candidate) continue;
    if (candidate.toolMode === currentData.toolMode) {
      return { path: candidatePath, data: candidate, label: 'previous' };
    }
  }

  const baselinePath = findLatest((name) => name.startsWith('eval-baseline-') && name.endsWith('.json'));
  if (!baselinePath) return null;
  const baseline = readJson(baselinePath);
  if (!baseline) return null;
  return { path: baselinePath, data: baseline, label: 'baseline' };
};

const inputPath = process.argv[2] ?? findLatest((name) => name.startsWith('eval-') && name.endsWith('.json') && !name.startsWith('eval-baseline-')) ?? (() => { throw new Error('No eval results found. Run npm run eval first.'); })();
const data = readJson(inputPath);
if (!data) throw new Error(`Unable to read eval results: ${inputPath}`);
const comparison = findLatestComparable(inputPath, data);

const bar = (value, width = 20) => {
  const filled = Math.round(value * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
};

const delta = (current, base) => {
  if (base == null) return '';
  const diff = current - base;
  return `  (${diff >= 0 ? '+' : ''}${typeof current === 'number' && current % 1 !== 0 ? diff.toFixed(3) : Math.round(diff)})`;
};

console.log('');
console.log('╔══════════════════════════════════════════════════════╗');
console.log('║              devctx eval report                     ║');
console.log('╚══════════════════════════════════════════════════════╝');
console.log('');
console.log(`  Date:       ${data.timestamp}`);
console.log(`  Mode:       ${data.mode ?? 'full'}`);
console.log(`  Tool mode:  ${data.toolMode ?? 'search'}`);
console.log(`  Tasks:      ${data.totalTasks}`);
console.log(`  Passed:     ${data.passed}/${data.totalTasks} (${((data.passed / data.totalTasks) * 100).toFixed(0)}%)${delta(data.passed, comparison?.data?.passed)}`);
if (comparison) console.log(`  Compared:   ${comparison.data.timestamp} (${comparison.label}: ${path.basename(comparison.path)})`);
console.log('');

console.log('  ── Scorecard ───────────────────────────────────────');
console.log(`  P@5:              ${bar(data.avgPrecision5)}  ${data.avgPrecision5}${delta(data.avgPrecision5, comparison?.data?.avgPrecision5)}`);
console.log(`  P@10:             ${bar(data.avgPrecision10)}  ${data.avgPrecision10}${delta(data.avgPrecision10, comparison?.data?.avgPrecision10)}`);
console.log(`  Recall:           ${bar(data.avgRecall)}  ${data.avgRecall}${delta(data.avgRecall, comparison?.data?.avgRecall)}`);

if (data.wrongFileRate != null) {
  console.log(`  Wrong-file rate:  ${bar(1 - data.wrongFileRate)}  ${data.wrongFileRate}${delta(data.wrongFileRate, comparison?.data?.wrongFileRate)}`);
}
if (data.retrievalHonesty != null) {
  console.log(`  Retrieval honesty:${bar(data.retrievalHonesty)}  ${data.retrievalHonesty}${delta(data.retrievalHonesty, comparison?.data?.retrievalHonesty)}`);
}
if (data.avgFollowUpReads != null) {
  console.log(`  Avg follow-ups:   ${data.avgFollowUpReads}${delta(data.avgFollowUpReads, comparison?.data?.avgFollowUpReads)}`);
}
if (data.avgTokensToSuccess != null) {
  console.log(`  Tokens to success:${data.avgTokensToSuccess}${delta(data.avgTokensToSuccess, comparison?.data?.avgTokensToSuccess)}`);
}

console.log('');
console.log('  ── Latency & tokens ────────────────────────────────');
console.log(`  Avg latency:      ${data.avgLatencyMs}ms${delta(data.avgLatencyMs, comparison?.data?.avgLatencyMs)}`);
if (data.p50LatencyMs != null) {
  console.log(`  P50 latency:      ${data.p50LatencyMs}ms`);
  console.log(`  P95 latency:      ${data.p95LatencyMs}ms`);
}
console.log(`  Avg tokens:       ${data.avgTokens}${delta(data.avgTokens, comparison?.data?.avgTokens)}`);
if (data.p50Tokens != null) {
  console.log(`  P50 tokens:       ${data.p50Tokens}`);
  console.log(`  P95 tokens:       ${data.p95Tokens}`);
}

console.log('');
console.log('  ── By task type ────────────────────────────────────');

for (const [type, stats] of Object.entries(data.byTaskType)) {
  const passRate = stats.count > 0 ? (stats.passed / stats.count) : 0;
  const wfr = stats.wrongFileRate != null ? `  WF=${stats.wrongFileRate}` : '';
  const fur = stats.avgFollowUpReads != null ? `  FU=${stats.avgFollowUpReads}` : '';
  console.log(`  ${type.padEnd(18)} ${stats.passed}/${stats.count} pass  P@5=${stats.avgPrecision5.toFixed(2)}  R=${stats.avgRecall.toFixed(2)}${wfr}${fur}  ${bar(passRate, 10)}`);
}

if (data.confidenceCalibration) {
  const cal = data.confidenceCalibration;
  console.log('');
  console.log('  ── Confidence calibration ──────────────────────────');
  console.log(`  Accuracy:         ${bar(cal.accuracy)}  ${cal.accuracy}`);
  console.log(`  Over-confident:   ${cal.overConfidentRate}`);
  console.log(`  Under-confident:  ${cal.underConfidentRate}`);
  console.log(`  Samples:          ${cal.total}`);
}

if (data.contextMetrics) {
  const ctx = data.contextMetrics;
  const prevCtx = comparison?.data?.contextMetrics;
  console.log('');
  console.log('  ── smart_context metrics ───────────────────────────');
  console.log(`  Context pass:     ${ctx.contextPassed}/${ctx.contextTotal}${delta(ctx.contextPassed, prevCtx?.contextPassed)}`);
  console.log(`  Avg precision:    ${bar(ctx.avgContextPrecision)}  ${ctx.avgContextPrecision}${delta(ctx.avgContextPrecision, prevCtx?.avgContextPrecision)}`);
  if (ctx.avgContextItems != null) {
    console.log(`  Avg items:        ${ctx.avgContextItems}${delta(ctx.avgContextItems, prevCtx?.avgContextItems)}`);
  }
  if (ctx.avgIndexOnlyItems != null) {
    console.log(`  Avg index-only:   ${ctx.avgIndexOnlyItems}${delta(ctx.avgIndexOnlyItems, prevCtx?.avgIndexOnlyItems)}`);
  }
  if (ctx.avgContentItems != null) {
    console.log(`  Avg content items:${ctx.avgContentItems}${delta(ctx.avgContentItems, prevCtx?.avgContentItems)}`);
  }
  if (ctx.avgExplainedCoverage != null) {
    console.log(`  Explained items:  ${bar(ctx.avgExplainedCoverage)}  ${ctx.avgExplainedCoverage}${delta(ctx.avgExplainedCoverage, prevCtx?.avgExplainedCoverage)}`);
  }
  if (ctx.avgPreviewCoverage != null) {
    console.log(`  Preview coverage: ${bar(ctx.avgPreviewCoverage)}  ${ctx.avgPreviewCoverage}${delta(ctx.avgPreviewCoverage, prevCtx?.avgPreviewCoverage)}`);
  }
  if (ctx.avgPreviewSymbolRecall != null) {
    console.log(`  Preview recall:   ${bar(ctx.avgPreviewSymbolRecall)}  ${ctx.avgPreviewSymbolRecall}${delta(ctx.avgPreviewSymbolRecall, prevCtx?.avgPreviewSymbolRecall)} (n=${ctx.previewEligibleTasks})`);
  }
  if (ctx.avgPreviewTokens != null) {
    console.log(`  Preview tokens:   ${ctx.avgPreviewTokens}${delta(ctx.avgPreviewTokens, prevCtx?.avgPreviewTokens)}`);
  }
  if (ctx.primaryHitRate != null) {
    console.log(`  Primary hit:      ${bar(ctx.primaryHitRate)}  ${ctx.primaryHitRate}${delta(ctx.primaryHitRate, prevCtx?.primaryHitRate)}`);
  }
  if (ctx.primaryIndexFirstRate != null) {
    console.log(`  Primary index-1st:${bar(ctx.primaryIndexFirstRate)}  ${ctx.primaryIndexFirstRate}${delta(ctx.primaryIndexFirstRate, prevCtx?.primaryIndexFirstRate)}`);
  }
  if (ctx.avgPrimaryPreviewCoverage != null) {
    console.log(`  Primary previews: ${bar(ctx.avgPrimaryPreviewCoverage)}  ${ctx.avgPrimaryPreviewCoverage}${delta(ctx.avgPrimaryPreviewCoverage, prevCtx?.avgPrimaryPreviewCoverage)}`);
  }
  if (ctx.avgPrimaryPreviewRecall != null) {
    console.log(`  Primary recall:   ${bar(ctx.avgPrimaryPreviewRecall)}  ${ctx.avgPrimaryPreviewRecall}${delta(ctx.avgPrimaryPreviewRecall, prevCtx?.avgPrimaryPreviewRecall)} (n=${ctx.primaryPreviewEligibleTasks})`);
  }
  if (ctx.primaryUsefulPreviewRate != null) {
    console.log(`  Useful previews:  ${bar(ctx.primaryUsefulPreviewRate)}  ${ctx.primaryUsefulPreviewRate}${delta(ctx.primaryUsefulPreviewRate, prevCtx?.primaryUsefulPreviewRate)}`);
  }
  console.log(`  Avg tokens:       ${ctx.avgContextTokens}${delta(ctx.avgContextTokens, prevCtx?.avgContextTokens)}`);
}

const failures = data.results.filter((r) => !r.pass);
if (failures.length > 0) {
  console.log('');
  console.log('  ── Failures ────────────────────────────────────────');
  for (const f of failures) {
    const ctxInfo = f.context ? `, ctx=${f.context.contextPrecision.toFixed(2)}, primary=${f.context.primaryFile ?? 'n/a'}:${f.context.primaryReadMode ?? 'n/a'}` : '';
    console.log(`  x ${f.id} (${f.taskType}): P@5=${f.precision5.toFixed(2)}, symbols=${f.symbolHits}/${f.symbolTotal}, conf=${f.retrievalConfidence}${ctxInfo}`);
  }
}

console.log('');
