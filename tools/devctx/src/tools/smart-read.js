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

const execFile = promisify(execFileCb);
import { summarizeGo, summarizeRust, summarizeJava, summarizeShell, summarizeTerraform, summarizeDockerfile, summarizeSql, extractGoSymbol, extractRustSymbol, extractJavaSymbol, summarizeCsharp, extractCsharpSymbol, summarizeKotlin, extractKotlinSymbol, summarizePhp, extractPhpSymbol, summarizeSwift, extractSwiftSymbol } from './smart-read/additional-languages.js';
import { summarizeCode, extractCodeSymbol } from './smart-read/code.js';
import { summarizeFallback } from './smart-read/fallback.js';
import { summarizePython, extractPythonSymbol } from './smart-read/python.js';
import { summarizeJson } from './smart-read/shared.js';
import { summarizeToml, summarizeYaml } from './smart-read/structured.js';

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

const lookupIndexLine = (fullPath, symbolName) => {
  try {
    const index = loadIndex(projectRoot);
    if (!index) return { line: undefined, used: false };
    const relPath = path.relative(projectRoot, fullPath).replace(/\\/g, '/');
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

const MODE_CASCADE = ['full', 'outline', 'signatures'];

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

  kept.push(marker);
  return kept.join('\n');
};

const cachedGenerate = (fullPath, extension, content, mode, mtime) => {
  const key = buildCacheKey(fullPath, mode);
  const hit = getCached(key, mtime);
  if (hit !== null) return { text: hit, cached: true };
  const text = generateContent(fullPath, extension, content, mode);
  setCache(key, mtime, text);
  return { text, cached: false };
};

const cachedSymbol = (fullPath, content, symbol, mtime) => {
  const symbols = Array.isArray(symbol) ? symbol : [symbol];
  const extra = symbols.join(',');
  const key = buildCacheKey(fullPath, 'symbol', extra);
  const hit = getCached(key, mtime);
  if (hit !== null) return { text: hit.text, indexHint: hit.indexHint, cached: true };
  const result = generateSymbolContent(fullPath, content, symbol);
  setCache(key, mtime, { text: result.text, indexHint: result.indexHint });
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
    for (const sym of symbolNames) {
      const matches = await grepSymbolInFile(callerAbs, sym);
      if (matches.length > 0) {
        sections.callers.push({ file: caller, symbol: sym, lines: matches.slice(0, 3) });
      }
    }
  }

  for (const testFile of related.tests.slice(0, 3)) {
    const testAbs = path.join(root, testFile);
    if (!fs.existsSync(testAbs)) continue;
    for (const sym of symbolNames) {
      const matches = await grepSymbolInFile(testAbs, sym);
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

export const smartRead = async ({ filePath, mode = 'outline', startLine, endLine, symbol, maxTokens, context: includeContext }) => {
  const { fullPath, content } = readTextFile(filePath);
  const extension = path.extname(fullPath).toLowerCase();
  const mtime = getFileMtime(fullPath);

  const validBudget = Number.isFinite(maxTokens) && maxTokens >= 1 ? maxTokens : null;
  let effectiveMode = mode;
  let indexHintUsed = false;
  let compressedText;
  let cacheHit = false;

  if (mode === 'range') {
    const r = cachedRange(content, startLine, endLine, fullPath, mtime);
    compressedText = r.text;
    cacheHit = r.cached;
  } else if (mode === 'symbol') {
    const sym = cachedSymbol(fullPath, content, symbol, mtime);
    compressedText = sym.text;
    indexHintUsed = sym.indexHint;
    cacheHit = sym.cached;
  } else if (validBudget) {
    const cascadeFrom = MODE_CASCADE.indexOf(effectiveMode);
    const cascade = cascadeFrom >= 0 ? MODE_CASCADE.slice(cascadeFrom) : [effectiveMode];

    for (const candidate of cascade) {
      const g = cachedGenerate(fullPath, extension, content, candidate, mtime);
      compressedText = g.text;
      if (g.cached) cacheHit = true;
      effectiveMode = candidate;
      if (countTokens(compressedText) <= validBudget) break;
    }

    if (countTokens(compressedText) > validBudget) {
      compressedText = truncateByTokens(compressedText, validBudget);
    }
  } else {
    const g = cachedGenerate(fullPath, extension, content, mode, mtime);
    compressedText = g.text;
    cacheHit = g.cached;
  }

  let contextResult = null;

  if (mode === 'symbol' && includeContext && symbol) {
    const symbolNames = Array.isArray(symbol) ? symbol : [symbol];
    const { sections, hints } = await buildSymbolContext(fullPath, symbolNames, projectRoot);
    const contextText = formatContextSections(sections);
    if (contextText) compressedText += contextText;
    contextResult = {
      context: { callers: sections.callers.length, tests: sections.tests.length, types: sections.types.length },
      graphCoverage: getGraphCoverage(extension),
      ...(hints.length > 0 ? { contextHints: hints } : {}),
    };
  }

  if (validBudget && (mode === 'range' || mode === 'symbol') && countTokens(compressedText) > validBudget) {
    compressedText = truncateByTokens(compressedText, validBudget);
  }

  const rawMode = effectiveMode === 'full' || effectiveMode === 'range';
  const parser = rawMode ? 'raw' : resolveParserType(extension, fullPath);
  const truncated = compressedText.includes('[truncated ');

  const metrics = buildMetrics({
    tool: 'smart_read',
    target: fullPath,
    rawText: content,
    compressedText,
  });

  await persistMetrics(metrics);

  const confidence = { parser, truncated, cached: cacheHit && !contextResult };
  if (contextResult) confidence.graphCoverage = contextResult.graphCoverage;

  const result = {
    filePath: fullPath,
    mode,
    parser,
    truncated,
    content: compressedText,
    confidence,
    metrics,
  };

  if (cacheHit && !contextResult) result.cached = true;
  if (mode === 'symbol') result.indexHint = indexHintUsed;
  if (validBudget && effectiveMode !== mode) {
    result.chosenMode = effectiveMode;
    result.budgetApplied = true;
  }
  if (contextResult) Object.assign(result, contextResult);

  return result;
};
