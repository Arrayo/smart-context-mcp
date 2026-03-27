#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { getLegacyMetricsFilePath, getMetricsFilePath } from '../src/metrics.js';

const requireValue = (argv, index, flag) => {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
};

const parseArgs = (argv) => {
  const options = {
    file: null,
    json: false,
    tool: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--file') {
      options.file = path.resolve(requireValue(argv, index, '--file'));
      index += 1;
      continue;
    }

    if (token === '--tool') {
      options.tool = requireValue(argv, index, '--tool');
      index += 1;
      continue;
    }

    if (token === '--json') {
      options.json = true;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return options;
};

const unique = (items) => [...new Set(items.filter(Boolean))];

const resolveMetricsInput = (options) => {
  if (options.file) {
    return { filePath: options.file, source: 'explicit' };
  }

  const defaultPath = getMetricsFilePath();
  const legacyPath = getLegacyMetricsFilePath();
  const candidates = unique([defaultPath, legacyPath]);
  const existing = candidates.find((filePath) => fs.existsSync(filePath));

  if (existing) {
    return {
      filePath: existing,
      source: existing === legacyPath ? 'legacy' : 'default',
    };
  }

  return { filePath: defaultPath, source: 'default' };
};

const readEntries = (filePath) => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`No metrics file found at ${filePath}`);
  }

  const lines = fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const entries = [];
  const invalidLines = [];

  lines.forEach((line, index) => {
    try {
      entries.push(JSON.parse(line));
    } catch {
      invalidLines.push(index + 1);
    }
  });

  return { entries, invalidLines };
};

const getCompressedTokens = (entry) => Number(entry.compressedTokens ?? entry.finalTokens ?? 0);

const getSavedTokens = (entry, compressedTokens) => {
  if (entry.savedTokens !== undefined) {
    return Number(entry.savedTokens ?? 0);
  }

  return Math.max(0, Number(entry.rawTokens ?? 0) - compressedTokens);
};

const aggregate = (entries) => {
  const byTool = new Map();
  let rawTokens = 0;
  let compressedTokens = 0;
  let savedTokens = 0;

  for (const entry of entries) {
    const tool = entry.tool ?? 'unknown';
    const compressedTokensForEntry = getCompressedTokens(entry);
    const savedTokensForEntry = getSavedTokens(entry, compressedTokensForEntry);
    const current = byTool.get(tool) ?? {
      tool,
      count: 0,
      rawTokens: 0,
      compressedTokens: 0,
      savedTokens: 0,
    };

    current.count += 1;
    current.rawTokens += Number(entry.rawTokens ?? 0);
    current.compressedTokens += compressedTokensForEntry;
    current.savedTokens += savedTokensForEntry;
    byTool.set(tool, current);

    rawTokens += Number(entry.rawTokens ?? 0);
    compressedTokens += compressedTokensForEntry;
    savedTokens += savedTokensForEntry;
  }

  const tools = [...byTool.values()]
    .map((item) => ({
      ...item,
      savingsPct: item.rawTokens > 0 ? +((item.savedTokens / item.rawTokens) * 100).toFixed(2) : 0,
    }))
    .sort((a, b) => b.savedTokens - a.savedTokens || b.count - a.count || a.tool.localeCompare(b.tool));

  return {
    count: entries.length,
    rawTokens,
    compressedTokens,
    savedTokens,
    savingsPct: rawTokens > 0 ? +((savedTokens / rawTokens) * 100).toFixed(2) : 0,
    tools,
  };
};

const formatNumber = (value) => new Intl.NumberFormat('en-US').format(value);

const printHuman = (report) => {
  console.log('');
  console.log('devctx metrics report');
  console.log('');
  console.log(`File:         ${report.filePath}`);
  console.log(`Source:       ${report.source}`);
  console.log(`Entries:      ${formatNumber(report.summary.count)}`);
  console.log(`Raw tokens:   ${formatNumber(report.summary.rawTokens)}`);
  console.log(`Final tokens: ${formatNumber(report.summary.compressedTokens)}`);
  console.log(`Saved tokens: ${formatNumber(report.summary.savedTokens)} (${report.summary.savingsPct}%)`);
  if (report.invalidLines.length > 0) {
    console.log(`Invalid JSONL: ${report.invalidLines.join(', ')}`);
  }
  console.log('');
  console.log('By tool:');

  if (report.summary.tools.length === 0) {
    console.log('  no entries');
    return;
  }

  for (const tool of report.summary.tools) {
    console.log(
      `  ${tool.tool.padEnd(14)} count=${formatNumber(tool.count)} raw=${formatNumber(tool.rawTokens)} final=${formatNumber(tool.compressedTokens)} saved=${formatNumber(tool.savedTokens)} (${tool.savingsPct}%)`
    );
  }
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  const resolved = resolveMetricsInput(options);
  const { entries, invalidLines } = readEntries(resolved.filePath);
  const filteredEntries = options.tool ? entries.filter((entry) => entry.tool === options.tool) : entries;
  const summary = aggregate(filteredEntries);

  const report = {
    filePath: resolved.filePath,
    source: resolved.source,
    toolFilter: options.tool,
    invalidLines,
    summary,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  printHuman(report);
};

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
