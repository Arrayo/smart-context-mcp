import fs from 'node:fs';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { rgPath } from '@vscode/ripgrep';
import { buildMetrics, persistMetrics } from '../metrics.js';
import { loadIndex, queryIndex, queryRelated, getGraphCoverage } from '../index.js';
import { isDockerfile, readTextFile } from '../utils/fs.js';
import { projectRoot } from '../utils/paths.js';
import { truncate } from '../utils/text.js';
import { countTokens } from '../tokenCounter.js';
import { consumeTokenBudget, normalizeTokenBudget, resolveTokenBudgetWindow } from '../utils/task-budget.js';
import { recordToolUsage } from '../usage-feedback.js';
import { recordDecision, DECISION_REASONS, EXPECTED_BENEFITS } from '../decision-explainer.js';
import { recordDevctxOperation } from '../missed-opportunities.js';
import { createProgressReporter } from '../streaming.js';
import { createHash } from 'node:crypto';
import { getReadCache, setReadCache } from '../storage/sqlite.js';

const safeGetReadCache = async (args) => {
  try {
    return await getReadCache(args);
  } catch {
    return null;
  }
};

const safeSetReadCache = async (args) => {
  try {
    await setReadCache(args);
  } catch {
    // best-effort — never fail a read for cache persistence
  }
};

const execFile = promisify(execFileCb);
import { summarizeGo, summarizeRust, summarizeJava, summarizeShell, summarizeTerraform, summarizeDockerfile, summarizeSql, extractGoSymbol, extractRustSymbol, extractJavaSymbol, summarizeCsharp, extractCsharpSymbol, summarizeKotlin, extractKotlinSymbol, summarizePhp, extractPhpSymbol, summarizeSwift, extractSwiftSymbol } from './smart-read/additional-languages.js';
import { summarizeCode, extractCodeSymbol } from './smart-read/code.js';
import { summarizeFallback } from './smart-read/fallback.js';
import { summarizePython, extractPythonSymbol } from './smart-read/python.js';
import { summarizeJson } from './smart-read/shared.js';
import { summarizeToml, summarizeYaml } from './smart-read/structured.js';
import { explainSymbols, formatExplanationsAsText } from '../explain/explainer.js';

const codeExtensions = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const pythonExtensions = new Set(['.py']);
const tomlExtensions = new Set(['.toml']);
const yamlExtensions = new Set(['.yaml', '.yml']);
const goExtensions = new Set(['.go']);
const rustExtensions = new Set(['.rs']);
const javaExtensions = new Set(['.java']);
const shellExtensions = new Set(['.sh', '.bash', '.zsh']);
const terraformExtensions = new Set(['.tf', '.tfvars', '.hcl']);
const sqlExtensions = new Set(['.sql']);
const csharpExtensions = new Set(['.cs']);
const kotlinExtensions = new Set(['.kt']);
const phpExtensions = new Set(['.php']);
const swiftExtensions = new Set(['.swift']);

const readCache = new Map();
const MAX_CACHE_ENTRIES = 200;

const buildCacheKey = (fullPath, mode, extra) =>
  extra ? `${fullPath}::${mode}::${extra}` : `${fullPath}::${mode}`;

const buildContentHash = (content) => createHash('sha256').update(content).digest('hex');

const getFileMtime = (fullPath) => Math.floor(fs.statSync(fullPath).mtimeMs);

const getCached = (key, mtime) => {
  const entry = readCache.get(key);
  if (!entry || entry.mtime !== mtime) return null;
  readCache.delete(key);
  readCache.set(key, entry);
  return entry.content;
};

const setCache = (key, mtime, content) => {
  if (readCache.size >= MAX_CACHE_ENTRIES) {
    readCache.delete(readCache.keys().next().value);
  }
  readCache.set(key, { mtime, content });
};

export const clearReadCache = () => readCache.clear();

const extractRange = (content, startLine, endLine) => {
  const lines = content.split('\n');
  const start = Math.max(0, (startLine ?? 1) - 1);
  const end = endLine ?? lines.length;
  const slice = lines.slice(start, end);
  const numbered = slice.map((line, i) => `${start + i + 1}|${line}`);
  return truncate(numbered.join('\n'), 12000);
};

const lookupIndexLine = (fullPath, symbolName, root = projectRoot) => {
  try {
    const index = loadIndex(root);
    if (!index) return { line: undefined, used: false };
    const relPath = path.relative(root, fullPath).replace(/\\/g, '/');
    const hits = queryIndex(index, symbolName);
    const match = hits.find((h) => h.path === relPath);
    return { line: match?.line, used: !!match };
  } catch {
    return { line: undefined, used: false };
  }
};

const extractSymbolFromContent = (fullPath, content, symbol) => {
  const extension = path.extname(fullPath).toLowerCase();

  if (codeExtensions.has(extension)) {
    return extractCodeSymbol(fullPath, content, symbol);
  }

  if (pythonExtensions.has(extension)) {
    return extractPythonSymbol(content, symbol);
  }

  if (goExtensions.has(extension)) {
    return extractGoSymbol(content, symbol);
  }

  if (rustExtensions.has(extension)) {
    return extractRustSymbol(content, symbol);
  }

  if (javaExtensions.has(extension)) {
    return extractJavaSymbol(content, symbol);
  }

  if (csharpExtensions.has(extension)) {
    return extractCsharpSymbol(content, symbol);
  }

  if (kotlinExtensions.has(extension)) {
    return extractKotlinSymbol(content, symbol);
  }

  if (phpExtensions.has(extension)) {
    return extractPhpSymbol(content, symbol);
  }

  if (swiftExtensions.has(extension)) {
    return extractSwiftSymbol(content, symbol);
  }

  const { line: indexLine } = lookupIndexLine(fullPath, symbol);
  return extractSymbolFallback(content, symbol, indexLine);
};

const extractSymbolFallback = (content, symbol, indexLine) => {
  const lines = content.split('\n');
  let idx = indexLine ? indexLine - 1 : -1;
  if (idx < 0 || idx >= lines.length) {
    idx = lines.findIndex((line) => line.includes(symbol));
  }
  if (idx === -1) return `Symbol not found: ${symbol}`;
  const start = Math.max(0, idx - 2);
  const end = Math.min(lines.length, idx + 30);
  const slice = lines.slice(start, end);
  return slice.map((line, i) => `${start + i + 1}|${line}`).join('\n');
};

const resolveParserType = (extension, fullPath) => {
  if (codeExtensions.has(extension)) return 'ast';
  if (pythonExtensions.has(extension) || goExtensions.has(extension) ||
      rustExtensions.has(extension) || javaExtensions.has(extension) ||
      csharpExtensions.has(extension) || kotlinExtensions.has(extension) ||
      phpExtensions.has(extension) || swiftExtensions.has(extension) ||
      shellExtensions.has(extension) || terraformExtensions.has(extension) ||
      sqlExtensions.has(extension) || tomlExtensions.has(extension) ||
      yamlExtensions.has(extension) || extension === '.json' ||
      isDockerfile(fullPath)) return 'heuristic';
  return 'fallback';
};

const MODE_BUDGET_CASCADE = {
  full: ['signatures', 'outline'],
  signatures: ['signatures', 'outline'],
  outline: ['outline'],
};

const getBudgetCascade = (mode) => MODE_BUDGET_CASCADE[mode] ?? [mode];

const buildFullModeMetadata = ({ requestedMode, effectiveMode, validBudget }) => {
  if (requestedMode !== 'full') {
    return null;
  }

  if (effectiveMode === 'full') {
    return {
      requested: true,
      used: true,
      reason: 'explicit_request',
    };
  }

  return {
    requested: true,
    used: false,
    reason: validBudget ? 'degraded_for_budget' : 'not_used',
    fallbackMode: effectiveMode,
  };
};

const buildBudgetDetails = ({ requestedMode, effectiveMode, validBudget, truncated }) => {
  if (!validBudget) {
    return null;
  }

  const actions = [];
  if (effectiveMode !== requestedMode) actions.push('mode_degraded');
  if (truncated) actions.push('content_truncated');

  if (actions.length === 0) {
    return null;
  }

  return {
    scope: 'content',
    maxTokens: validBudget,
    finalMode: effectiveMode,
    actions,
  };
};

const generateContent = (fullPath, extension, content, mode) => {
  if (mode === 'full') return truncate(content, 12000);

  if (isDockerfile(fullPath)) return summarizeDockerfile(content, mode);
  if (extension === '.json') return summarizeJson(content, mode);
  if (codeExtensions.has(extension)) return summarizeCode(fullPath, content, mode);
  if (pythonExtensions.has(extension)) return summarizePython(content, mode);
  if (goExtensions.has(extension)) return summarizeGo(content, mode);
  if (rustExtensions.has(extension)) return summarizeRust(content, mode);
  if (javaExtensions.has(extension)) return summarizeJava(content, mode);
  if (csharpExtensions.has(extension)) return summarizeCsharp(content, mode);
  if (kotlinExtensions.has(extension)) return summarizeKotlin(content, mode);
  if (phpExtensions.has(extension)) return summarizePhp(content, mode);
  if (swiftExtensions.has(extension)) return summarizeSwift(content, mode);
  if (shellExtensions.has(extension)) return summarizeShell(content, mode);
  if (terraformExtensions.has(extension)) return summarizeTerraform(content, mode);
  if (sqlExtensions.has(extension)) return summarizeSql(content, mode);
  if (tomlExtensions.has(extension)) return summarizeToml(content, mode);
  if (yamlExtensions.has(extension)) return summarizeYaml(content, mode);
  return summarizeFallback(content, mode);
};

const generateSymbolContent = (fullPath, content, symbol) => {
  if (!symbol) return { text: 'Error: symbol parameter is required for symbol mode', indexHint: false };
  const symbols = Array.isArray(symbol) ? symbol : [symbol];
  let anyIndexHint = false;
  const results = symbols.map((s) => {
    const { used } = lookupIndexLine(fullPath, s);
    if (used) anyIndexHint = true;
    const extracted = extractSymbolFromContent(fullPath, content, s);
    return symbols.length > 1 ? `--- ${s} ---\n${extracted}` : extracted;
  });
  return { text: truncate(results.join('\n\n'), 12000), indexHint: anyIndexHint };
};

const truncateByTokens = (text, maxTokens) => {
  const marker = `\n[truncated to fit ${maxTokens} token budget]`;
  const markerTokens = countTokens(marker);
  const budget = Math.max(1, maxTokens - markerTokens);

  const lines = text.split('\n');
  const kept = [];
  let tokens = 0;

  for (const line of lines) {
    const lineTokens = countTokens(line);
    if (tokens + lineTokens > budget) break;
    kept.push(line);
    tokens += lineTokens;
  }

  let result = `${kept.join('\n')}${marker}`;
  while (kept.length > 0 && countTokens(result) > maxTokens) {
    kept.pop();
    result = `${kept.join('\n')}${marker}`;
  }

  return result;
};

const cachedGenerate = async (fullPath, extension, content, mode, mtime, root = projectRoot, selector = '') => {
  const key = buildCacheKey(fullPath, mode);
  const hit = getCached(key, mtime);
  if (hit !== null) return { text: hit, cached: true };

  const relPath = path.relative(root, fullPath).replace(/\\/g, '/');
  const contentHash = buildContentHash(content);
  const persistent = await safeGetReadCache({ relPath, mode, selector, contentHash });
  if (persistent?.payload?.text) {
    setCache(key, mtime, persistent.payload.text);
    return { text: persistent.payload.text, cached: true };
  }

  const text = generateContent(fullPath, extension, content, mode);
  setCache(key, mtime, text);
  await safeSetReadCache({ relPath, mode, selector, contentHash, payload: { text }, tokens: countTokens(text) });
  return { text, cached: false };
};

const cachedSymbol = async (fullPath, content, symbol, mtime, root = projectRoot) => {
  const symbols = Array.isArray(symbol) ? symbol : [symbol];
  const extra = symbols.join(',');
  const key = buildCacheKey(fullPath, 'symbol', extra);
  const hit = getCached(key, mtime);
  if (hit !== null) return { text: hit.text, indexHint: hit.indexHint, cached: true };

  const relPath = path.relative(root, fullPath).replace(/\\/g, '/');
  const contentHash = buildContentHash(content);
  const persistent = await safeGetReadCache({ relPath, mode: 'symbol', selector: extra, contentHash });
  if (persistent?.payload?.text) {
    setCache(key, mtime, { text: persistent.payload.text, indexHint: persistent.payload.indexHint });
    return { text: persistent.payload.text, indexHint: persistent.payload.indexHint, cached: true };
  }

  const result = generateSymbolContent(fullPath, content, symbol);
  setCache(key, mtime, { text: result.text, indexHint: result.indexHint });
  await safeSetReadCache({ relPath, mode: 'symbol', selector: extra, contentHash, payload: result, tokens: countTokens(result.text) });
  return { ...result, cached: false };
};

const cachedRange = (content, startLine, endLine, fullPath, mtime) => {
  const extra = `${startLine ?? ''}-${endLine ?? ''}`;
  const key = buildCacheKey(fullPath, 'range', extra);
  const hit = getCached(key, mtime);
  if (hit !== null) return { text: hit, cached: true };
  const text = extractRange(content, startLine, endLine);
  setCache(key, mtime, text);
  return { text, cached: false };
};

export const grepSymbolInFile = async (absPath, symbol) => {
  try {
    const { stdout } = await execFile(rgPath, [
      '--line-number', '--no-heading', '--fixed-strings', '--max-count', '5',
      symbol, absPath,
    ], { timeout: 3000 });
    return stdout.split('\n').filter(Boolean).map((line) => {
      const sep = line.indexOf(':');
      if (sep === -1) return line;
      return `${line.substring(0, sep)}|${line.substring(sep + 1)}`;
    });
  } catch {
    return [];
  }
};

export const grepMultipleSymbolsInFile = async (absPath, symbols) => {
  if (symbols.length === 0) return {};
  if (symbols.length === 1) {
    const matches = await grepSymbolInFile(absPath, symbols[0]);
    return { [symbols[0]]: matches };
  }

  try {
    const args = ['--line-number', '--no-heading', '--fixed-strings', '--max-count', '5'];
    for (const sym of symbols) {
      args.push('-e', sym);
    }
    args.push(absPath);

    const { stdout } = await execFile(rgPath, args, { timeout: 3000 });
    const result = {};
    for (const sym of symbols) result[sym] = [];

    for (const line of stdout.split('\n').filter(Boolean)) {
      const sep = line.indexOf(':');
      if (sep === -1) continue;
      const formatted = `${line.substring(0, sep)}|${line.substring(sep + 1)}`;
      const content = line.substring(sep + 1);
      
      for (const sym of symbols) {
        if (content.includes(sym)) {
          result[sym].push(formatted);
        }
      }
    }

    return result;
  } catch {
    const result = {};
    for (const sym of symbols) result[sym] = [];
    return result;
  }
};

const TYPE_REF_RE = /:\s*([A-Z][A-Za-z0-9_]+)|<([A-Z][A-Za-z0-9_]+)>|(?:extends|implements)\s+([A-Z][A-Za-z0-9_]+)/g;

export const extractTypeReferences = (definitionText, index, relPath) => {
  if (!index?.invertedIndex) return [];
  const seen = new Set();
  const results = [];
  for (const match of definitionText.matchAll(TYPE_REF_RE)) {
    const name = match[1] || match[2] || match[3];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const hits = queryIndex(index, name);
    const localHit = hits.find((h) => h.path === relPath);
    if (localHit) {
      results.push({ name, file: relPath, line: localHit.line });
    } else if (hits.length > 0) {
      results.push({ name, file: hits[0].path, line: hits[0].line });
    }
  }
  return results;
};

export const buildSymbolContext = async (fullPath, symbolNames, root) => {
  const index = loadIndex(root);
  const relPath = path.relative(root, fullPath).replace(/\\/g, '/');
  const sections = { callers: [], tests: [], types: [] };
  const hints = [];

  if (!index) {
    hints.push('No symbol index — run build_index for cross-file context');
    return { sections, hints };
  }

  const related = queryRelated(index, relPath);

  for (const caller of related.importedBy.slice(0, 5)) {
    const callerAbs = path.join(root, caller);
    if (!fs.existsSync(callerAbs)) continue;
    
    const matchesBySymbol = await grepMultipleSymbolsInFile(callerAbs, symbolNames);
    for (const sym of symbolNames) {
      const matches = matchesBySymbol[sym] || [];
      if (matches.length > 0) {
        sections.callers.push({ file: caller, symbol: sym, lines: matches.slice(0, 3) });
      }
    }
  }

  for (const testFile of related.tests.slice(0, 3)) {
    const testAbs = path.join(root, testFile);
    if (!fs.existsSync(testAbs)) continue;
    
    const matchesBySymbol = await grepMultipleSymbolsInFile(testAbs, symbolNames);
    for (const sym of symbolNames) {
      const matches = matchesBySymbol[sym] || [];
      if (matches.length > 0) {
        sections.tests.push({ file: testFile, symbol: sym, lines: matches.slice(0, 3) });
      }
    }
  }

  const symbolDef = symbolNames.map((s) => {
    const hits = queryIndex(index, s);
    const hit = hits.find((h) => h.path === relPath);
    return hit ? { name: s, line: hit.line } : null;
  }).filter(Boolean);

  if (symbolDef.length > 0) {
    try {
      const fileContent = fs.readFileSync(fullPath, 'utf8');
      const defLines = fileContent.split('\n');
      for (const def of symbolDef) {
        const startIdx = Math.max(0, (def.line ?? 1) - 1);
        const endIdx = Math.min(defLines.length, startIdx + 30);
        const snippet = defLines.slice(startIdx, endIdx).join('\n');
        const typeRefs = extractTypeReferences(snippet, index, relPath);
        for (const t of typeRefs) {
          if (!sections.types.some((e) => e.name === t.name)) sections.types.push(t);
        }
      }
    } catch { /* unreadable — skip types */ }
  }

  return { sections, hints };
};

const formatContextSections = (sections) => {
  const parts = [];

  if (sections.callers.length > 0) {
    parts.push('\n--- callers ---');
    for (const c of sections.callers) {
      parts.push(`// ${c.file}`);
      parts.push(...c.lines);
    }
  }

  if (sections.tests.length > 0) {
    parts.push('\n--- tests ---');
    for (const t of sections.tests) {
      parts.push(`// ${t.file}`);
      parts.push(...t.lines);
    }
  }

  if (sections.types.length > 0) {
    parts.push('\n--- types ---');
    for (const t of sections.types) {
      parts.push(`// ${t.file} → ${t.name} (line ${t.line})`);
    }
  }

  return parts.length > 0 ? '\n' + parts.join('\n') : '';
};

export const smartRead = async ({ filePath, mode = 'outline', startLine, endLine, symbol, maxTokens, tokenBudget, context: includeContext, cwd, progress: enableProgress = false }) => {
  const progress = enableProgress ? createProgressReporter('smart_read') : null;
  const startTime = Date.now();
  const normalizedTokenBudget = normalizeTokenBudget(tokenBudget);
  const budgetWindow = resolveTokenBudgetWindow({ tokenBudget: normalizedTokenBudget, maxTokens });
  
  let fullPath, content;
  const effectiveRoot = cwd || projectRoot;
  
  if (progress) {
    progress.report({ phase: 'reading', file: filePath });
  }
  
  try {
    const result = readTextFile(filePath, effectiveRoot);
    fullPath = result.fullPath;
    content = result.content;
    
    if (progress) {
      const rawTokens = countTokens(content);
      progress.report({ phase: 'loaded', file: path.relative(effectiveRoot, fullPath), rawTokens });
    }
  } catch (error) {
    const errorMessage = error.message || String(error);
    return {
      error: errorMessage,
      filePath,
      mode,
      metrics: buildMetrics({
        tool: 'smart_read',
        target: filePath,
        rawText: '',
        compressedText: errorMessage,
      }),
    };
  }

  const extension = path.extname(fullPath).toLowerCase();
  const mtime = getFileMtime(fullPath);

  const effectiveMaxTokens = budgetWindow.effectiveMaxTokens;
  const validBudget = Number.isFinite(effectiveMaxTokens) && effectiveMaxTokens >= 1 ? effectiveMaxTokens : null;
  let effectiveMode = mode;
  let indexHintUsed = false;
  let compressedText;
  let cacheHit = false;
  let fullModeMetadata = null;

  if (mode === 'range') {
    const r = cachedRange(content, startLine, endLine, fullPath, mtime);
    compressedText = r.text;
    cacheHit = r.cached;
  } else if (mode === 'outline' && (startLine || endLine)) {
    const lines = content.split('\n');
    const start = Math.max(0, (startLine ?? 1) - 1);
    const end = endLine ?? lines.length;
    const rangeContent = lines.slice(start, end).join('\n');
    const g = await cachedGenerate(fullPath, extension, rangeContent, 'outline', mtime, effectiveRoot, `${startLine ?? 1}-${endLine ?? ''}`);
    compressedText = g.text;
    cacheHit = g.cached;
    effectiveMode = 'outline';
  } else if (mode === 'symbol') {
    const sym = await cachedSymbol(fullPath, content, symbol, mtime, effectiveRoot);
    compressedText = sym.text;
    indexHintUsed = sym.indexHint;
    cacheHit = sym.cached;
    if (validBudget && normalizedTokenBudget?.shared && countTokens(compressedText) > validBudget) {
      for (const candidate of ['signatures', 'outline']) {
        const g = await cachedGenerate(fullPath, extension, content, candidate, mtime, effectiveRoot);
        compressedText = g.text;
        if (g.cached) cacheHit = true;
        effectiveMode = candidate;
        if (countTokens(compressedText) <= validBudget) break;
      }
    }
  } else if (mode === 'explain') {
    if (!symbol) {
      compressedText = 'Error: symbol parameter is required for explain mode';
    } else {
      const explanations = await explainSymbols({
        fullPath,
        content,
        symbols: symbol,
        root: effectiveRoot,
      });
      compressedText = formatExplanationsAsText(explanations);
      const anyCached = explanations.some((e) => e.cached);
      const anyIndex = explanations.some((e) => e.found);
      if (anyCached) cacheHit = true;
      indexHintUsed = anyIndex;
    }
    if (validBudget && normalizedTokenBudget?.shared && countTokens(compressedText) > validBudget) {
      for (const candidate of ['signatures', 'outline']) {
        const g = await cachedGenerate(fullPath, extension, content, candidate, mtime, effectiveRoot);
        compressedText = g.text;
        if (g.cached) cacheHit = true;
        effectiveMode = candidate;
        if (countTokens(compressedText) <= validBudget) break;
      }
    }
  } else if (validBudget) {
    const cascade = getBudgetCascade(effectiveMode);

    for (const candidate of cascade) {
      const g = await cachedGenerate(fullPath, extension, content, candidate, mtime, effectiveRoot);
      compressedText = g.text;
      if (g.cached) cacheHit = true;
      effectiveMode = candidate;
      if (countTokens(compressedText) <= validBudget) break;
    }

    if (countTokens(compressedText) > validBudget) {
      compressedText = truncateByTokens(compressedText, validBudget);
    }
  } else {
    const g = await cachedGenerate(fullPath, extension, content, mode, mtime, effectiveRoot);
    compressedText = g.text;
    cacheHit = g.cached;
  }

  fullModeMetadata = buildFullModeMetadata({ requestedMode: mode, effectiveMode, validBudget });

  if (progress) {
    const compressedTokens = countTokens(compressedText);
    const rawTokens = countTokens(content);
    progress.report({ 
      phase: 'compressed', 
      mode: effectiveMode,
      rawTokens, 
      compressedTokens,
      ratio: rawTokens > 0 ? (rawTokens / compressedTokens).toFixed(1) : null,
    });
  }

  let contextResult = null;

  if (mode === 'symbol' && includeContext && symbol) {
    const symbolNames = Array.isArray(symbol) ? symbol : [symbol];
    const { sections, hints } = await buildSymbolContext(fullPath, symbolNames, effectiveRoot);
    const contextText = formatContextSections(sections);
    if (contextText) compressedText += contextText;
    contextResult = {
      context: { callers: sections.callers.length, tests: sections.tests.length, types: sections.types.length },
      graphCoverage: getGraphCoverage(extension),
      ...(hints.length > 0 ? { contextHints: hints } : {}),
    };
  }

  if (validBudget && (mode === 'range' || mode === 'symbol' || mode === 'explain') && countTokens(compressedText) > validBudget) {
    compressedText = truncateByTokens(compressedText, validBudget);
  }

  const rawMode = effectiveMode === 'full' || effectiveMode === 'range';
  const parser = mode === 'explain' ? 'structural' : (rawMode ? 'raw' : resolveParserType(extension, fullPath));
  const truncated = compressedText.includes('[truncated ');
  const budgetDetails = buildBudgetDetails({ requestedMode: mode, effectiveMode, validBudget, truncated });

  const metrics = buildMetrics({
    tool: 'smart_read',
    target: fullPath,
    rawText: content,
    compressedText,
  });

  await persistMetrics(metrics);
  
  recordToolUsage({
    tool: 'smart_read',
    savedTokens: metrics.savedTokens,
    target: path.relative(effectiveRoot, fullPath),
  });
  recordDevctxOperation();
  const lineCount = content.split('\n').length;
  let reason = DECISION_REASONS.LARGE_FILE;
  let expectedBenefit = EXPECTED_BENEFITS.TOKEN_SAVINGS(metrics.savedTokens);
  
  if (mode === 'symbol') {
    reason = DECISION_REASONS.SYMBOL_EXTRACTION;
  } else if (mode === 'explain') {
    reason = DECISION_REASONS.SYMBOL_EXTRACTION;
  } else if (validBudget && effectiveMode !== mode) {
    reason = DECISION_REASONS.TOKEN_BUDGET;
  } else if (lineCount < 100) {
    reason = `File is small (${lineCount} lines), but using ${effectiveMode} mode for consistency`;
  }
  
  recordDecision({
    tool: 'smart_read',
    action: `read ${path.relative(effectiveRoot, fullPath)} (${effectiveMode} mode)`,
    reason,
    alternative: 'Read (full file)',
    expectedBenefit,
    context: `${lineCount} lines, ${metrics.rawTokens} tokens → ${metrics.compressedTokens} tokens`,
  });

  if (progress) {
    progress.complete({
      file: path.relative(effectiveRoot, fullPath),
      mode: effectiveMode,
      savedTokens: metrics.savedTokens,
      savingsPct: metrics.savingsPct,
    });
  }

  const result = {
    filePath: fullPath,
    mode,
    parser,
    truncated,
    content: compressedText,
  };
  if (mode === 'symbol' || mode === 'explain') result.indexHint = indexHintUsed;
  result.cached = cacheHit;
  if (normalizedTokenBudget) result.taskBudget = normalizedTokenBudget;
  if (normalizedTokenBudget) {
    result.remainingBudget = consumeTokenBudget({
      tokenBudget: normalizedTokenBudget,
      usedTokens: countTokens(compressedText),
    });
  }
  if (effectiveMode !== mode) {
    result.chosenMode = effectiveMode;
  }
  if (budgetDetails) {
    result.budgetApplied = true;
    result.budgetDetails = budgetDetails;
  }
  if (contextResult) Object.assign(result, contextResult);
  if (fullModeMetadata) result.fullMode = fullModeMetadata;

  return result;
};
