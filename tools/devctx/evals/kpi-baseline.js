#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.resolve(__dirname, 'results');

const runJsonScript = (scriptPath, args = []) => {
  const raw = execFileSync(process.execPath, [scriptPath, ...args], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
  });
  return JSON.parse(raw);
};

const average = (items) => items.length > 0
  ? +(items.reduce((sum, value) => sum + value, 0) / items.length).toFixed(3)
  : 0;

const mergeTaskSizeMetrics = (left = {}, right = {}) => {
  const sizes = new Set([...Object.keys(left), ...Object.keys(right)]);
  const merged = {};

  for (const size of sizes) {
    const entries = [];
    if (left[size]) entries.push(left[size]);
    if (right[size]) entries.push(right[size]);
    if (entries.length === 0) continue;

    merged[size] = {
      count: entries.reduce((sum, entry) => sum + (entry.count ?? 0), 0),
      avgTokens: average(entries.map((entry) => entry.avgTokens ?? 0)),
      avgLatencyMs: average(entries.map((entry) => entry.avgLatencyMs ?? 0)),
    };
  }

  return merged;
};

const run = () => {
  const selfEval = runJsonScript('./evals/harness.js', ['--root=../..', '--corpus=./evals/corpus/self-tasks.json', '--tool=both', '--json']);
  const realworldEval = runJsonScript('./evals/realworld-eval.js', ['--json']);

  const baseline = {
    generatedAt: new Date().toISOString(),
    sources: {
      selfEval: {
        outPath: selfEval.outPath,
        avgPrecision5: selfEval.summary.avgPrecision5,
        avgRecall: selfEval.summary.avgRecall,
        avgTokens: selfEval.summary.avgTokens,
        byTaskSize: selfEval.summary.byTaskSize,
      },
      realworldEval: {
        outPath: realworldEval.outPath,
        rereadTaskRate: realworldEval.summary.rereadTaskRate,
        rereadCallRate: realworldEval.summary.rereadCallRate,
        byTaskSize: realworldEval.summary.byTaskSize,
      },
    },
    kpis: {
      top5Precision: selfEval.summary.avgPrecision5,
      recall: selfEval.summary.avgRecall,
      rereadTaskRate: realworldEval.summary.rereadTaskRate,
      rereadCallRate: realworldEval.summary.rereadCallRate,
      byTaskSize: mergeTaskSizeMetrics(selfEval.summary.byTaskSize, realworldEval.summary.byTaskSize),
    },
  };

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const stampedPath = path.join(RESULTS_DIR, `kpi-baseline-${Date.now()}.json`);
  const latestPath = path.join(RESULTS_DIR, 'kpi-baseline-latest.json');
  fs.writeFileSync(stampedPath, JSON.stringify(baseline, null, 2));
  fs.writeFileSync(latestPath, JSON.stringify(baseline, null, 2));

  process.stdout.write(`KPI baseline saved:\n- ${stampedPath}\n- ${latestPath}\n`);
  process.stdout.write(`Top-5 precision: ${baseline.kpis.top5Precision}\n`);
  process.stdout.write(`Reread task rate: ${baseline.kpis.rereadTaskRate}\n`);
  for (const [size, stats] of Object.entries(baseline.kpis.byTaskSize)) {
    process.stdout.write(`${size}: tokens=${stats.avgTokens}, latency=${stats.avgLatencyMs}, count=${stats.count}\n`);
  }
};

run();
