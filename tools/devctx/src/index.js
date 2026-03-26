import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { isBinaryBuffer } from './utils/fs.js';

const INDEX_VERSION = 4;

const MAX_SIGNATURE_LEN = 200;
const MAX_SNIPPET_LEN = 280;
const MAX_SNIPPET_LINES = 3;

const trimSignature = (raw) => {
  if (!raw) return undefined;
  const condensed = raw.replace(/\s+/g, ' ').trim();
  return condensed.length > MAX_SIGNATURE_LEN
    ? condensed.substring(0, MAX_SIGNATURE_LEN) + '...'
    : condensed;
};

const trimSnippet = (raw) => {
  if (!raw) return undefined;
  const condensed = raw.replace(/\s+/g, ' ').trim();
  return condensed.length > MAX_SNIPPET_LEN
    ? condensed.substring(0, MAX_SNIPPET_LEN) + '...'
    : condensed;
};

const buildSymbolSnippet = (content, line) => {
  if (!line || line < 1) return undefined;

  const lines = content.split('\n');
  const start = Math.max(0, line - 1);
  const snippetLines = [];

  for (let i = start; i < Math.min(lines.length, start + MAX_SNIPPET_LINES); i++) {
    const value = lines[i].trimEnd();
    if (!value.trim() && snippetLines.length > 0) break;
    snippetLines.push(value);
  }

  return trimSnippet(snippetLines.join('\n'));
};

const enrichSymbolsWithSnippets = (content, symbols = []) =>
  symbols.map((sym) => {
    const snippet = sym.snippet ?? buildSymbolSnippet(content, sym.line);
    return snippet ? { ...sym, snippet } : sym;
  });

const resolveIndexPath = (root) => {
  if (process.env.DEVCTX_INDEX_DIR) {
    return path.join(process.env.DEVCTX_INDEX_DIR, 'index.json');
  }
  return path.join(root, '.devctx', 'index.json');
};

const indexableExtensions = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java',
  '.cs', '.kt', '.php', '.swift',
]);

const ignoredDirs = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'coverage',
  '.venv', 'venv', '__pycache__', '.terraform', '.devctx',
]);

const scriptKindByExtension = {
  '.js': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
  '.ts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
};

// ---------------------------------------------------------------------------
// JS/TS extraction
// ---------------------------------------------------------------------------

const parseJsSource = (fullPath, content) => {
  const ext = path.extname(fullPath).toLowerCase();
  const kind = scriptKindByExtension[ext] ?? ts.ScriptKind.TS;
  return ts.createSourceFile(fullPath, content, ts.ScriptTarget.Latest, true, kind);
};

const getNodeSignature = (node, sourceFile) => {
  const start = node.getStart(sourceFile);
  const text = sourceFile.text.substring(start);
  const braceIdx = text.indexOf('{');
  const raw = braceIdx > 0 ? text.substring(0, braceIdx) : text.split('\n')[0];
  return trimSignature(raw);
};

const extractJsSymbolsFromAst = (sourceFile) => {
  const symbols = [];

  const addSymbol = (name, symbolKind, line, parent, signature) => {
    if (!name) return;
    const entry = { name, kind: symbolKind, line };
    if (parent) entry.parent = parent;
    if (signature) entry.signature = signature;
    symbols.push(entry);
  };

  const visitMembers = (node, parentName) => {
    ts.forEachChild(node, (child) => {
      if (ts.isMethodDeclaration(child) || ts.isMethodSignature(child)) {
        const name = child.name && ts.isIdentifier(child.name) ? child.name.text : null;
        const line = sourceFile.getLineAndCharacterOfPosition(child.getStart(sourceFile)).line + 1;
        addSymbol(name, 'method', line, parentName, getNodeSignature(child, sourceFile));
      } else if (ts.isPropertyDeclaration(child) || ts.isPropertySignature(child)) {
        const name = child.name && ts.isIdentifier(child.name) ? child.name.text : null;
        const line = sourceFile.getLineAndCharacterOfPosition(child.getStart(sourceFile)).line + 1;
        addSymbol(name, 'property', line, parentName);
      }
    });
  };

  for (const stmt of sourceFile.statements) {
    const line = sourceFile.getLineAndCharacterOfPosition(stmt.getStart(sourceFile)).line + 1;
    const sig = getNodeSignature(stmt, sourceFile);

    if (ts.isFunctionDeclaration(stmt)) {
      addSymbol(stmt.name?.text, 'function', line, undefined, sig);
    } else if (ts.isClassDeclaration(stmt)) {
      const className = stmt.name?.text;
      addSymbol(className, 'class', line, undefined, sig);
      if (className) visitMembers(stmt, className);
    } else if (ts.isInterfaceDeclaration(stmt)) {
      const ifName = stmt.name?.text;
      addSymbol(ifName, 'interface', line, undefined, sig);
      if (ifName) visitMembers(stmt, ifName);
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      addSymbol(stmt.name?.text, 'type', line, undefined, sig);
    } else if (ts.isEnumDeclaration(stmt)) {
      addSymbol(stmt.name?.text, 'enum', line, undefined, sig);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          addSymbol(decl.name.text, 'const', line, undefined, sig);
        }
      }
    }
  }

  return symbols;
};

const hasExportModifier = (node) => {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
};

const extractJsImportsExports = (sourceFile) => {
  const imports = [];
  const exports = [];

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      imports.push(stmt.moduleSpecifier.text);
    }

    if (ts.isExportDeclaration(stmt)) {
      if (stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        imports.push(stmt.moduleSpecifier.text);
      }
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const spec of stmt.exportClause.elements) {
          exports.push(spec.name.text);
        }
      }
    }

    if (ts.isExportAssignment(stmt)) {
      exports.push('default');
    }

    if (hasExportModifier(stmt)) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name) exports.push(stmt.name.text);
      else if (ts.isClassDeclaration(stmt) && stmt.name) exports.push(stmt.name.text);
      else if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) exports.push(decl.name.text);
        }
      } else if (ts.isInterfaceDeclaration(stmt)) exports.push(stmt.name.text);
      else if (ts.isTypeAliasDeclaration(stmt)) exports.push(stmt.name.text);
      else if (ts.isEnumDeclaration(stmt)) exports.push(stmt.name.text);
    }
  }

  return { imports, exports };
};

// ---------------------------------------------------------------------------
// Python extraction
// ---------------------------------------------------------------------------

const PYTHON_SYMBOL_RE = /^(class|def|async\s+def)\s+(\w+)/;

const extractPySymbols = (content) => {
  const symbols = [];
  const lines = content.split('\n');
  let currentClass = null;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const indent = lines[i].length - trimmed.length;
    const match = PYTHON_SYMBOL_RE.exec(trimmed);
    if (!match) continue;

    const keyword = match[1].replace(/\s+/g, ' ');
    const name = match[2];
    const line = i + 1;
    const signature = trimSignature(trimmed.replace(/:$/, ''));

    if (keyword === 'class') {
      currentClass = name;
      symbols.push({ name, kind: 'class', line, signature });
    } else if (indent > 0 && currentClass) {
      symbols.push({ name, kind: 'method', line, parent: currentClass, signature });
    } else {
      currentClass = null;
      symbols.push({ name, kind: 'function', line, signature });
    }
  }

  return symbols;
};

const PY_IMPORT_RE = /^(?:from\s+(\S+)\s+import|import\s+(\S+))/;

const extractPyImports = (content) => {
  const imports = [];
  for (const line of content.split('\n')) {
    const m = PY_IMPORT_RE.exec(line.trimStart());
    if (m) imports.push(m[1] ?? m[2]);
  }
  return { imports, exports: [] };
};

// ---------------------------------------------------------------------------
// Go extraction
// ---------------------------------------------------------------------------

const GO_FUNC_RE = /^func\s+(?:\([\w\s*]+\)\s+)?(\w+)\s*\(/;
const GO_TYPE_RE = /^type\s+(\w+)\s+/;

const extractGoSymbols = (content) => {
  const symbols = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const funcMatch = GO_FUNC_RE.exec(trimmed);
    if (funcMatch) {
      symbols.push({ name: funcMatch[1], kind: 'function', line: i + 1, signature: trimSignature(trimmed) });
      continue;
    }
    const typeMatch = GO_TYPE_RE.exec(trimmed);
    if (typeMatch) {
      symbols.push({ name: typeMatch[1], kind: 'type', line: i + 1, signature: trimSignature(trimmed) });
    }
  }

  return symbols;
};

const extractGoImports = (content) => {
  const imports = [];
  const lines = content.split('\n');
  let inBlock = false;

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('import (')) { inBlock = true; continue; }
    if (inBlock && trimmed === ')') { inBlock = false; continue; }

    if (inBlock || trimmed.startsWith('import "')) {
      const m = /"([^"]+)"/.exec(trimmed);
      if (m) imports.push(m[1]);
    }
  }

  return { imports, exports: [] };
};

// ---------------------------------------------------------------------------
// Rust extraction
// ---------------------------------------------------------------------------

const RUST_ITEM_RE = /^(?:pub\s+)?(?:async\s+)?(fn|struct|enum|trait|type|impl|const|static)\s+(\w+)/;

const extractRustSymbols = (content) => {
  const symbols = [];
  const lines = content.split('\n');
  let currentImpl = null;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const match = RUST_ITEM_RE.exec(trimmed);
    if (!match) continue;

    const [, keyword, name] = match;
    const line = i + 1;
    const signature = trimSignature(trimmed);

    if (keyword === 'impl') {
      currentImpl = name;
      symbols.push({ name, kind: 'impl', line, signature });
    } else if (keyword === 'fn' && currentImpl && lines[i].startsWith('    ')) {
      symbols.push({ name, kind: 'method', line, parent: currentImpl, signature });
    } else {
      if (keyword === 'fn') currentImpl = null;
      symbols.push({ name, kind: keyword, line, signature });
    }
  }

  return symbols;
};

// ---------------------------------------------------------------------------
// Java extraction
// ---------------------------------------------------------------------------

const JAVA_DECL_RE = /^(?:public|private|protected|static|final|abstract|\s)*(?:class|interface|enum|record)\s+(\w+)/;
const JAVA_METHOD_RE = /^(?:public|private|protected|static|final|abstract|synchronized|\s)*(?:<[\w\s,?]+>\s+)?[\w<>\[\],\s]+\s+(\w+)\s*\(/;

const extractJavaSymbols = (content) => {
  const symbols = [];
  const lines = content.split('\n');
  let currentType = null;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const declMatch = JAVA_DECL_RE.exec(trimmed);
    if (declMatch) {
      currentType = declMatch[1];
      symbols.push({ name: declMatch[1], kind: 'class', line: i + 1, signature: trimSignature(trimmed) });
      continue;
    }
    if (currentType) {
      const methodMatch = JAVA_METHOD_RE.exec(trimmed);
      if (methodMatch && !trimmed.includes(' new ') && !trimmed.includes('return ')) {
        symbols.push({ name: methodMatch[1], kind: 'method', line: i + 1, parent: currentType, signature: trimSignature(trimmed) });
      }
    }
  }

  return symbols;
};

// ---------------------------------------------------------------------------
// C# extraction
// ---------------------------------------------------------------------------

const CSHARP_DECL_RE = /^(?:public|private|protected|internal|static|abstract|sealed|partial|\s)*(class|struct|interface|enum|record)\s+(\w+)/;
const CSHARP_METHOD_RE = /^(?:public|private|protected|internal|static|virtual|override|abstract|async|\s)*[\w<>\[\],.\s]+\s+(\w+)\s*\(/;
const CSHARP_USING_RE = /^using\s+([\w.]+);$/;

const extractCsharpSymbols = (content) => {
  const symbols = [];
  const lines = content.split('\n');
  let currentType = null;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const declMatch = CSHARP_DECL_RE.exec(trimmed);
    if (declMatch) {
      currentType = declMatch[2];
      symbols.push({ name: declMatch[2], kind: declMatch[1], line: i + 1, signature: trimSignature(trimmed) });
    } else if (currentType) {
      const methodMatch = CSHARP_METHOD_RE.exec(trimmed);
      if (methodMatch && !trimmed.includes(' new ') && !trimmed.includes('return ') && !trimmed.startsWith('//')) {
        symbols.push({ name: methodMatch[1], kind: 'method', line: i + 1, parent: currentType, signature: trimSignature(trimmed) });
      }
    }
    braceDepth += (trimmed.match(/\{/g) ?? []).length;
    braceDepth -= (trimmed.match(/\}/g) ?? []).length;
    if (braceDepth <= 0) { currentType = null; braceDepth = 0; }
  }

  return symbols;
};

const extractCsharpImports = (content) => {
  const imports = [];
  for (const line of content.split('\n')) {
    const m = CSHARP_USING_RE.exec(line.trim());
    if (m) imports.push(m[1]);
  }
  return { imports, exports: [] };
};

// ---------------------------------------------------------------------------
// Kotlin extraction
// ---------------------------------------------------------------------------

const KOTLIN_DECL_RE = /^(?:open|abstract|data|sealed|internal|private|protected|\s)*(class|object|interface|enum)\s+(\w+)/;
const KOTLIN_FUN_RE = /^(?:(?:public|private|protected|internal|open|override|suspend|inline)\s+)*fun\s+(?:<[^>]+>\s+)?(\w+)\s*\(/;
const KOTLIN_IMPORT_RE = /^import\s+([\w.*]+)$/;

const extractKotlinSymbols = (content) => {
  const symbols = [];
  const lines = content.split('\n');
  let currentType = null;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const declMatch = KOTLIN_DECL_RE.exec(trimmed);
    if (declMatch) {
      currentType = declMatch[2];
      symbols.push({ name: declMatch[2], kind: declMatch[1], line: i + 1, signature: trimSignature(trimmed) });
      continue;
    }
    const funMatch = KOTLIN_FUN_RE.exec(trimmed);
    if (funMatch) {
      if (currentType && lines[i].startsWith('    ')) {
        symbols.push({ name: funMatch[1], kind: 'method', line: i + 1, parent: currentType, signature: trimSignature(trimmed) });
      } else {
        symbols.push({ name: funMatch[1], kind: 'function', line: i + 1, signature: trimSignature(trimmed) });
      }
      continue;
    }
    braceDepth += (trimmed.match(/\{/g) ?? []).length;
    braceDepth -= (trimmed.match(/\}/g) ?? []).length;
    if (braceDepth <= 0) { currentType = null; braceDepth = 0; }
  }

  return symbols;
};

const extractKotlinImports = (content) => {
  const imports = [];
  for (const line of content.split('\n')) {
    const m = KOTLIN_IMPORT_RE.exec(line.trim());
    if (m) imports.push(m[1]);
  }
  return { imports, exports: [] };
};

// ---------------------------------------------------------------------------
// PHP extraction
// ---------------------------------------------------------------------------

const PHP_DECL_RE = /^(?:abstract|final|\s)*(class|interface|trait|enum)\s+(\w+)/;
const PHP_FUNC_RE = /^(?:public|protected|private|static|\s)*function\s+(\w+)\s*\(/;
const PHP_USE_RE = /^use\s+([\w\\]+)(?:\s+as\s+\w+)?;$/;

const extractPhpSymbols = (content) => {
  const symbols = [];
  const lines = content.split('\n');
  let currentType = null;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const declMatch = PHP_DECL_RE.exec(trimmed);
    if (declMatch) {
      currentType = declMatch[2];
      symbols.push({ name: declMatch[2], kind: declMatch[1], line: i + 1, signature: trimSignature(trimmed) });
      continue;
    }
    const funcMatch = PHP_FUNC_RE.exec(trimmed);
    if (funcMatch) {
      if (currentType && braceDepth > 0) {
        symbols.push({ name: funcMatch[1], kind: 'method', line: i + 1, parent: currentType, signature: trimSignature(trimmed) });
      } else {
        symbols.push({ name: funcMatch[1], kind: 'function', line: i + 1, signature: trimSignature(trimmed) });
      }
      continue;
    }
    braceDepth += (trimmed.match(/\{/g) ?? []).length;
    braceDepth -= (trimmed.match(/\}/g) ?? []).length;
    if (braceDepth <= 0) { currentType = null; braceDepth = 0; }
  }

  return symbols;
};

const extractPhpImports = (content) => {
  const imports = [];
  for (const line of content.split('\n')) {
    const m = PHP_USE_RE.exec(line.trim());
    if (m) imports.push(m[1]);
  }
  return { imports, exports: [] };
};

// ---------------------------------------------------------------------------
// Swift extraction
// ---------------------------------------------------------------------------

const SWIFT_DECL_RE = /^(?:public|private|internal|open|final|\s)*(class|struct|enum|protocol|actor)\s+(\w+)/;
const SWIFT_FUNC_RE = /^(?:(?:public|private|internal|open|override|static|class|@\w+)\s+)*func\s+(\w+)/;
const SWIFT_IMPORT_RE = /^import\s+(\w+)$/;

const extractSwiftSymbols = (content) => {
  const symbols = [];
  const lines = content.split('\n');
  let currentType = null;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const declMatch = SWIFT_DECL_RE.exec(trimmed);
    if (declMatch) {
      currentType = declMatch[2];
      symbols.push({ name: declMatch[2], kind: declMatch[1], line: i + 1, signature: trimSignature(trimmed) });
      continue;
    }
    const funcMatch = SWIFT_FUNC_RE.exec(trimmed);
    if (funcMatch) {
      if (currentType && braceDepth > 0) {
        symbols.push({ name: funcMatch[1], kind: 'method', line: i + 1, parent: currentType, signature: trimSignature(trimmed) });
      } else {
        symbols.push({ name: funcMatch[1], kind: 'function', line: i + 1, signature: trimSignature(trimmed) });
      }
      continue;
    }
    braceDepth += (trimmed.match(/\{/g) ?? []).length;
    braceDepth -= (trimmed.match(/\}/g) ?? []).length;
    if (braceDepth <= 0) { currentType = null; braceDepth = 0; }
  }

  return symbols;
};

const extractSwiftImports = (content) => {
  const imports = [];
  for (const line of content.split('\n')) {
    const m = SWIFT_IMPORT_RE.exec(line.trim());
    if (m) imports.push(m[1]);
  }
  return { imports, exports: [] };
};

// ---------------------------------------------------------------------------
// Unified file info extraction
// ---------------------------------------------------------------------------

const extractFileInfo = (fullPath, content) => {
  const ext = path.extname(fullPath).toLowerCase();

  let info;

  if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) {
    try {
      const sourceFile = parseJsSource(fullPath, content);
      info = {
        symbols: extractJsSymbolsFromAst(sourceFile),
        ...extractJsImportsExports(sourceFile),
      };
    } catch {
      info = { symbols: [], imports: [], exports: [] };
    }
  } else if (ext === '.py') info = { symbols: extractPySymbols(content), ...extractPyImports(content) };
  else if (ext === '.go') info = { symbols: extractGoSymbols(content), ...extractGoImports(content) };
  else if (ext === '.rs') info = { symbols: extractRustSymbols(content), imports: [], exports: [] };
  else if (ext === '.java') info = { symbols: extractJavaSymbols(content), imports: [], exports: [] };
  else if (ext === '.cs') info = { symbols: extractCsharpSymbols(content), ...extractCsharpImports(content) };
  else if (ext === '.kt') info = { symbols: extractKotlinSymbols(content), ...extractKotlinImports(content) };
  else if (ext === '.php') info = { symbols: extractPhpSymbols(content), ...extractPhpImports(content) };
  else if (ext === '.swift') info = { symbols: extractSwiftSymbols(content), ...extractSwiftImports(content) };
  else info = { symbols: [], imports: [], exports: [] };

  return {
    ...info,
    symbols: enrichSymbolsWithSnippets(content, info.symbols ?? []),
  };
};

// ---------------------------------------------------------------------------
// Test file detection
// ---------------------------------------------------------------------------

const TEST_FILE_RE = /(?:\.(?:test|spec)\.[jt]sx?$|__tests__|_test\.go$|test_\w+\.py$|Tests?\.(?:cs|kt|swift)$|_test\.(?:cs|kt)$|Test\.php$)/;
export const isTestFile = (relPath) => TEST_FILE_RE.test(relPath);

// ---------------------------------------------------------------------------
// Import resolution
// ---------------------------------------------------------------------------

const resolveLocalImport = (specifier, fileDir, root, knownRelPaths) => {
  if (!specifier.startsWith('.')) return null;

  const abs = path.resolve(fileDir, specifier);
  const rel = path.relative(root, abs).replace(/\\/g, '/');

  if (knownRelPaths.has(rel)) return rel;

  for (const ext of ['.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs']) {
    const c = rel + ext;
    if (knownRelPaths.has(c)) return c;
  }

  for (const ext of ['.js', '.ts', '.tsx', '.jsx']) {
    const c = rel + '/index' + ext;
    if (knownRelPaths.has(c)) return c;
  }

  return null;
};

const SOURCE_EXTENSIONS = ['.js', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.cs', '.kt', '.php', '.swift'];

const TEST_STRIP_RE = /\.(?:test|spec)\.[^.]+$|Tests?\.(cs|kt|swift)$|_test\.(cs|kt)$|Test\.php$/;

const inferTestTarget = (testRelPath, knownRelPaths) => {
  const baseName = path.basename(testRelPath);
  const base = baseName.replace(TEST_STRIP_RE, '');
  const dir = path.dirname(testRelPath);
  const parentDir = path.dirname(dir);
  const prefix = dir === '.' ? '' : `${dir}/`;
  const parentPrefix = parentDir === '.' ? '' : `${parentDir}/`;

  for (const ext of SOURCE_EXTENSIONS) {
    const c = `${prefix}${base}${ext}`;
    if (knownRelPaths.has(c)) return c;
  }

  for (const srcDir of ['src', 'lib', 'pkg']) {
    for (const ext of SOURCE_EXTENSIONS) {
      const c = `${parentPrefix}${srcDir}/${base}${ext}`;
      if (knownRelPaths.has(c)) return c;
    }
  }

  return null;
};

// ---------------------------------------------------------------------------
// Directory walker
// ---------------------------------------------------------------------------

const walkForIndex = (dir, files = []) => {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return files; }

  for (const entry of entries) {
    if (ignoredDirs.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      walkForIndex(fullPath, files);
    } else if (indexableExtensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }

  return files;
};

// ---------------------------------------------------------------------------
// Build index
// ---------------------------------------------------------------------------

export const buildIndex = (root) => {
  const files = walkForIndex(root);
  const fileEntries = {};
  const invertedIndex = {};
  const rawImports = {};

  for (const fullPath of files) {
    try {
      const stat = fs.statSync(fullPath);
      if (stat.size > 512 * 1024) continue;

      const buffer = fs.readFileSync(fullPath);
      if (isBinaryBuffer(buffer)) continue;

      const content = buffer.toString('utf8');
      const info = extractFileInfo(fullPath, content);
      if (info.symbols.length === 0 && info.imports.length === 0) continue;

      const relPath = path.relative(root, fullPath).replace(/\\/g, '/');
      fileEntries[relPath] = {
        mtime: Math.floor(stat.mtimeMs),
        symbols: info.symbols,
        exports: info.exports,
      };
      rawImports[relPath] = info.imports;

      for (const sym of info.symbols) {
        const key = sym.name.toLowerCase();
        if (!invertedIndex[key]) invertedIndex[key] = [];
        const entry = { path: relPath, line: sym.line, kind: sym.kind };
        if (sym.parent) entry.parent = sym.parent;
        if (sym.signature) entry.signature = sym.signature;
        if (sym.snippet) entry.snippet = sym.snippet;
        invertedIndex[key].push(entry);
      }
    } catch {
      // skip unreadable files
    }
  }

  const knownRelPaths = new Set(Object.keys(fileEntries));
  const edges = [];

  for (const [relPath, specifiers] of Object.entries(rawImports)) {
    const fileDir = path.resolve(root, path.dirname(relPath));
    const testFile = isTestFile(relPath);

    for (const spec of specifiers) {
      const resolved = resolveLocalImport(spec, fileDir, root, knownRelPaths);
      if (!resolved) continue;

      edges.push({ from: relPath, to: resolved, kind: 'import' });
      if (testFile) edges.push({ from: relPath, to: resolved, kind: 'testOf' });
    }

    if (testFile && !edges.some((e) => e.from === relPath && e.kind === 'testOf')) {
      const target = inferTestTarget(relPath, knownRelPaths);
      if (target) edges.push({ from: relPath, to: target, kind: 'testOf' });
    }
  }

  return {
    version: INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    files: fileEntries,
    invertedIndex,
    graph: { edges },
  };
};

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export const queryIndex = (index, symbolName) => {
  if (!index?.invertedIndex) return [];
  const key = symbolName.toLowerCase();
  return index.invertedIndex[key] ?? [];
};

export const queryRelated = (index, relPath) => {
  const result = { imports: [], importedBy: [], tests: [], neighbors: [] };
  if (!index?.graph?.edges) return result;

  for (const edge of index.graph.edges) {
    if (edge.from === relPath && edge.kind === 'import') result.imports.push(edge.to);
    if (edge.to === relPath && edge.kind === 'import') result.importedBy.push(edge.from);
    if (edge.to === relPath && edge.kind === 'testOf') result.tests.push(edge.from);
  }

  const dir = path.dirname(relPath);
  if (index.files) {
    result.neighbors = Object.keys(index.files).filter((p) => p !== relPath && path.dirname(p) === dir);
  }

  return result;
};

// ---------------------------------------------------------------------------
// Graph coverage per language
// ---------------------------------------------------------------------------

const FULL_GRAPH_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.go']);
const PARTIAL_IMPORT_EXTS = new Set(['.cs', '.kt', '.php', '.swift']);
const INDEXED_EXTS = new Set([...FULL_GRAPH_EXTS, ...PARTIAL_IMPORT_EXTS, '.rs', '.java']);

export const getGraphCoverage = (ext) => {
  const e = ext.toLowerCase();
  if (FULL_GRAPH_EXTS.has(e)) return { imports: 'full', tests: 'full' };
  if (PARTIAL_IMPORT_EXTS.has(e)) return { imports: 'partial', tests: 'partial' };
  if (INDEXED_EXTS.has(e)) return { imports: 'none', tests: 'partial' };
  return { imports: 'none', tests: 'none' };
};

// ---------------------------------------------------------------------------
// Staleness & incremental reindex
// ---------------------------------------------------------------------------

export const isFileStale = (index, relPath, currentMtimeMs) => {
  const entry = index?.files?.[relPath];
  if (!entry) return true;
  return Math.floor(currentMtimeMs) !== entry.mtime;
};

export const reindexFile = (index, root, relPath) => {
  const fullPath = path.join(root, relPath);

  if (index.graph?.edges) {
    index.graph.edges = index.graph.edges.filter((e) => e.from !== relPath);
  }

  try {
    const stat = fs.statSync(fullPath);
    const buffer = fs.readFileSync(fullPath);
    if (isBinaryBuffer(buffer)) return;

    const content = buffer.toString('utf8');
    const info = extractFileInfo(fullPath, content);

    const oldSymbols = index.files[relPath]?.symbols ?? [];
    for (const sym of oldSymbols) {
      const key = sym.name.toLowerCase();
      if (index.invertedIndex[key]) {
        index.invertedIndex[key] = index.invertedIndex[key].filter((e) => e.path !== relPath);
        if (index.invertedIndex[key].length === 0) delete index.invertedIndex[key];
      }
    }

    if (info.symbols.length === 0 && info.imports.length === 0) {
      delete index.files[relPath];
      return;
    }

    index.files[relPath] = {
      mtime: Math.floor(stat.mtimeMs),
      symbols: info.symbols,
      exports: info.exports,
    };

    for (const sym of info.symbols) {
      const key = sym.name.toLowerCase();
      if (!index.invertedIndex[key]) index.invertedIndex[key] = [];
      const invEntry = { path: relPath, line: sym.line, kind: sym.kind };
      if (sym.parent) invEntry.parent = sym.parent;
      if (sym.signature) invEntry.signature = sym.signature;
      if (sym.snippet) invEntry.snippet = sym.snippet;
      index.invertedIndex[key].push(invEntry);
    }

    if (!index.graph) index.graph = { edges: [] };
    const knownRelPaths = new Set(Object.keys(index.files));
    const fileDir = path.resolve(root, path.dirname(relPath));
    const testFile = isTestFile(relPath);

    for (const spec of info.imports) {
      const resolved = resolveLocalImport(spec, fileDir, root, knownRelPaths);
      if (!resolved) continue;
      index.graph.edges.push({ from: relPath, to: resolved, kind: 'import' });
      if (testFile) index.graph.edges.push({ from: relPath, to: resolved, kind: 'testOf' });
    }

    if (testFile && !index.graph.edges.some((e) => e.from === relPath && e.kind === 'testOf')) {
      const target = inferTestTarget(relPath, knownRelPaths);
      if (target) index.graph.edges.push({ from: relPath, to: target, kind: 'testOf' });
    }
  } catch {
    if (index.files[relPath]) {
      const oldSymbols = index.files[relPath].symbols ?? [];
      for (const sym of oldSymbols) {
        const key = sym.name.toLowerCase();
        if (index.invertedIndex[key]) {
          index.invertedIndex[key] = index.invertedIndex[key].filter((e) => e.path !== relPath);
          if (index.invertedIndex[key].length === 0) delete index.invertedIndex[key];
        }
      }
      delete index.files[relPath];
    }
  }
};

export const removeFileFromIndex = (index, relPath) => {
  const oldSymbols = index.files?.[relPath]?.symbols ?? [];
  for (const sym of oldSymbols) {
    const key = sym.name.toLowerCase();
    if (index.invertedIndex?.[key]) {
      index.invertedIndex[key] = index.invertedIndex[key].filter((e) => e.path !== relPath);
      if (index.invertedIndex[key].length === 0) delete index.invertedIndex[key];
    }
  }
  if (index.graph?.edges) {
    index.graph.edges = index.graph.edges.filter((e) => e.from !== relPath && e.to !== relPath);
  }
  delete index.files[relPath];
};

export const buildIndexIncremental = (root) => {
  const existing = loadIndex(root);
  if (!existing) {
    const index = buildIndex(root);
    const total = Object.keys(index.files).length;
    return { index, stats: { total, reindexed: total, removed: 0, unchanged: 0, fullRebuild: true } };
  }

  const diskFiles = walkForIndex(root);
  const diskRelPaths = new Set();
  const reindexedPaths = [];
  let unchanged = 0;

  for (const fullPath of diskFiles) {
    try {
      const stat = fs.statSync(fullPath);
      if (stat.size > 512 * 1024) continue;
      const relPath = path.relative(root, fullPath).replace(/\\/g, '/');
      diskRelPaths.add(relPath);

      if (isFileStale(existing, relPath, stat.mtimeMs)) {
        reindexFile(existing, root, relPath);
        reindexedPaths.push(relPath);
      } else {
        unchanged++;
      }
    } catch { /* skip unreadable */ }
  }

  const indexedPaths = Object.keys(existing.files);
  let removed = 0;
  for (const relPath of indexedPaths) {
    if (!diskRelPaths.has(relPath)) {
      removeFileFromIndex(existing, relPath);
      removed++;
    }
  }

  if (reindexedPaths.length > 0) {
    const knownRelPaths = new Set(Object.keys(existing.files));
    if (!existing.graph) existing.graph = { edges: [] };

    for (const relPath of reindexedPaths) {
      existing.graph.edges = existing.graph.edges.filter((e) => e.from !== relPath);

      const entry = existing.files[relPath];
      if (!entry) continue;

      const fullPath = path.join(root, relPath);
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const info = extractFileInfo(fullPath, content);
        const fileDir = path.resolve(root, path.dirname(relPath));
        const testFile = isTestFile(relPath);

        for (const spec of info.imports) {
          const resolved = resolveLocalImport(spec, fileDir, root, knownRelPaths);
          if (!resolved) continue;
          existing.graph.edges.push({ from: relPath, to: resolved, kind: 'import' });
          if (testFile) existing.graph.edges.push({ from: relPath, to: resolved, kind: 'testOf' });
        }

        if (testFile && !existing.graph.edges.some((e) => e.from === relPath && e.kind === 'testOf')) {
          const target = inferTestTarget(relPath, knownRelPaths);
          if (target) existing.graph.edges.push({ from: relPath, to: target, kind: 'testOf' });
        }
      } catch { /* skip */ }
    }
  }

  existing.generatedAt = new Date().toISOString();

  const total = Object.keys(existing.files).length;
  return { index: existing, stats: { total, reindexed: reindexedPaths.length, removed, unchanged, fullRebuild: false } };
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export const persistIndex = async (index, root) => {
  try {
    const indexPath = resolveIndexPath(root);
    await fsp.mkdir(path.dirname(indexPath), { recursive: true });
    await fsp.writeFile(indexPath, JSON.stringify(index), 'utf8');
  } catch {
    // best-effort
  }
};

export const loadIndex = (root) => {
  try {
    const indexPath = resolveIndexPath(root);
    const raw = fs.readFileSync(indexPath, 'utf8');
    const index = JSON.parse(raw);
    if (index.version !== INDEX_VERSION) return null;
    return index;
  } catch {
    return null;
  }
};
