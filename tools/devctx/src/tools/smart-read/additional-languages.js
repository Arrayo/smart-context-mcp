import { joinSections, toUniqueLines, truncateSection } from './shared.js';

const extractBraceBlock = (content, symbolName, declarationPattern) => {
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!declarationPattern(trimmed, symbolName)) continue;

    let depth = 0;
    let opened = false;
    let endIdx = i;
    for (let j = i; j < lines.length; j++) {
      if (!opened && j > i && !lines[j].trim()) break;
      const opens = (lines[j].match(/\{/g) ?? []).length;
      const closes = (lines[j].match(/\}/g) ?? []).length;
      depth += opens;
      depth -= closes;
      if (opens > 0) opened = true;
      endIdx = j;
      if (opened && depth <= 0) break;
    }

    if (!opened) endIdx = i;

    const slice = lines.slice(i, endIdx + 1);
    return slice.map((l, idx) => `${i + idx + 1}|${l}`).join('\n');
  }

  return `Symbol not found: ${symbolName}`;
};

export const extractGoSymbol = (content, symbolName) =>
  extractBraceBlock(content, symbolName, (line, name) =>
    new RegExp(`^func\\s+(?:\\([^)]+\\)\\s+)?${name}\\s*\\(`).test(line) ||
    new RegExp(`^type\\s+${name}\\s+`).test(line));

export const extractRustSymbol = (content, symbolName) =>
  extractBraceBlock(content, symbolName, (line, name) =>
    new RegExp(`^(?:pub\\s+)?(?:async\\s+)?fn\\s+${name}\\s*[(<]`).test(line) ||
    new RegExp(`^(?:pub\\s+)?(?:struct|enum|trait|impl)\\s+${name}`).test(line));

export const extractJavaSymbol = (content, symbolName) =>
  extractBraceBlock(content, symbolName, (line, name) =>
    new RegExp(`(?:class|interface|enum|record)\\s+${name}`).test(line) ||
    new RegExp(`^\\s*(?:(?:public|protected|private|static|final|abstract|synchronized|native|default)\\s+)*(?:<[^>]+>\\s+)?[A-Za-z0-9_$.<>\\[\\]]+\\s+${name}\\s*\\(`).test(line));

export const summarizeGo = (content, mode) => {
  const lines = content.split('\n');
  const packages = [];
  const imports = [];
  const declarations = [];
  const methods = [];
  const constants = [];
  let inImportBlock = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (!trimmed || trimmed.startsWith('//')) {
      continue;
    }

    if (trimmed === 'import (') {
      inImportBlock = true;
      continue;
    }

    if (inImportBlock) {
      if (trimmed === ')') {
        inImportBlock = false;
        continue;
      }

      imports.push(trimmed.replace(/^([A-Za-z_][A-Za-z0-9_]*\s+)?"([^"]+)"$/, '$2'));
      continue;
    }

    const packageMatch = trimmed.match(/^package\s+([A-Za-z_][A-Za-z0-9_]*)$/);
    if (packageMatch) {
      packages.push(`package ${packageMatch[1]}`);
      continue;
    }

    const importMatch = trimmed.match(/^import\s+(?:[A-Za-z_][A-Za-z0-9_]*\s+)?"([^"]+)"$/);
    if (importMatch) {
      imports.push(importMatch[1]);
      continue;
    }

    const methodMatch = trimmed.match(/^func\s*\(([^)]+)\)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (methodMatch) {
      methods.push(`method ${methodMatch[2]}(${methodMatch[1].trim()})`);
      continue;
    }

    const functionMatch = trimmed.match(/^func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (functionMatch) {
      declarations.push(`func ${functionMatch[1]}()`);
      continue;
    }

    const typeMatch = trimmed.match(/^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(struct|interface|map|\[\])/);
    if (typeMatch) {
      declarations.push(`type ${typeMatch[1]} ${typeMatch[2]}`);
      continue;
    }

    const constMatch = trimmed.match(/^(const|var)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (constMatch) {
      constants.push(`${constMatch[1]} ${constMatch[2]}`);
    }
  }

  if (mode === 'signatures') {
    return joinSections([
      truncateSection('# Declarations', toUniqueLines([...declarations, ...methods]), 2600),
      truncateSection('# Imports', toUniqueLines(imports, 10), 1000),
    ], 4000);
  }

  return joinSections([
    truncateSection('# Package', toUniqueLines(packages, 4), 300),
    truncateSection('# Declarations', toUniqueLines(declarations, 20), 1800),
    truncateSection('# Methods', toUniqueLines(methods, 20), 1500),
    truncateSection('# Imports', toUniqueLines(imports, 12), 900),
    truncateSection('# Constants', toUniqueLines(constants, 12), 700),
  ], 5000);
};

export const summarizeRust = (content, mode) => {
  const lines = content.split('\n');
  const uses = [];
  const declarations = [];
  const implBlocks = [];
  const methods = [];
  let currentImpl = null;
  let currentImplDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (!trimmed || trimmed.startsWith('//')) {
      continue;
    }

    if (/^use\s+.+;$/.test(trimmed)) {
      uses.push(trimmed);
      continue;
    }

    const implMatch = trimmed.match(/^impl(?:<[^>]+>)?\s+([^\s{]+)/);
    if (implMatch && !trimmed.endsWith(';')) {
      currentImpl = implMatch[1];
      const braces = (trimmed.match(/\{/g) ?? []).length - (trimmed.match(/\}/g) ?? []).length;
      if (braces > 0) {
        currentImplDepth = braces;
      } else {
        currentImplDepth = 0;
        for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
          const ahead = lines[j].trim();
          if (!ahead) break;
          const opens = (ahead.match(/\{/g) ?? []).length;
          if (opens > 0) {
            currentImplDepth = opens - (ahead.match(/\}/g) ?? []).length;
            i = j;
            break;
          }
        }
        if (currentImplDepth <= 0) { currentImpl = null; continue; }
      }
      implBlocks.push(`impl ${currentImpl}`);
      continue;
    }

    if (currentImpl) {
      currentImplDepth += (trimmed.match(/\{/g) ?? []).length;
      currentImplDepth -= (trimmed.match(/\}/g) ?? []).length;

      const methodMatch = trimmed.match(/^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
      if (methodMatch) {
        methods.push(`${currentImpl}::${methodMatch[1]}()`);
      }

      if (currentImplDepth <= 0) {
        currentImpl = null;
        currentImplDepth = 0;
      }
      continue;
    }

    const declMatch = trimmed.match(/^(?:pub\s+)?(struct|enum|trait|type|const|static)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (declMatch) {
      declarations.push(`${declMatch[1]} ${declMatch[2]}`);
      continue;
    }

    const functionMatch = trimmed.match(/^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (functionMatch) {
      declarations.push(`fn ${functionMatch[1]}()`);
    }
  }

  if (mode === 'signatures') {
    return joinSections([
      truncateSection('# Declarations', toUniqueLines([...declarations, ...implBlocks, ...methods]), 2800),
      truncateSection('# Uses', toUniqueLines(uses, 10), 900),
    ], 4000);
  }

  return joinSections([
    truncateSection('# Declarations', toUniqueLines(declarations, 20), 1800),
    truncateSection('# Impl blocks', toUniqueLines(implBlocks, 12), 900),
    truncateSection('# Methods', toUniqueLines(methods, 20), 1500),
    truncateSection('# Uses', toUniqueLines(uses, 12), 800),
  ], 5000);
};

export const summarizeJava = (content, mode) => {
  const lines = content.split('\n');
  const packages = [];
  const imports = [];
  const declarations = [];
  const methods = [];
  let currentType = null;
  let braceDepth = 0;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) {
      continue;
    }

    const packageMatch = trimmed.match(/^package\s+([A-Za-z0-9_.]+);$/);
    if (packageMatch) {
      packages.push(`package ${packageMatch[1]}`);
      continue;
    }

    const importMatch = trimmed.match(/^import\s+([A-Za-z0-9_.*]+);$/);
    if (importMatch) {
      imports.push(importMatch[1]);
      continue;
    }

    const typeMatch = trimmed.match(/^(?:public\s+)?(?:abstract\s+|final\s+)?(class|interface|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (typeMatch) {
      currentType = typeMatch[2];
      declarations.push(`${typeMatch[1]} ${typeMatch[2]}`);
    }

    const methodMatch = trimmed.match(/^(?:public|protected|private)\s+(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?(?:<[^>]+>\s+)?(?:[A-Za-z0-9_$.<>\[\]]+\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?:throws\s+[A-Za-z0-9_.,\s]+)?\{$/);
    if (methodMatch) {
      const owner = currentType ? `${currentType}::` : '';
      methods.push(`${owner}${methodMatch[1]}(${methodMatch[2].trim()})`);
    }

    braceDepth += (trimmed.match(/\{/g) ?? []).length;
    braceDepth -= (trimmed.match(/\}/g) ?? []).length;

    if (braceDepth <= 0) {
      currentType = null;
      braceDepth = 0;
    }
  }

  if (mode === 'signatures') {
    return joinSections([
      truncateSection('# Declarations', toUniqueLines([...declarations, ...methods]), 2600),
      truncateSection('# Imports', toUniqueLines(imports, 10), 900),
    ], 4000);
  }

  return joinSections([
    truncateSection('# Package', toUniqueLines(packages, 2), 300),
    truncateSection('# Declarations', toUniqueLines(declarations, 20), 1400),
    truncateSection('# Methods', toUniqueLines(methods, 20), 1800),
    truncateSection('# Imports', toUniqueLines(imports, 12), 1000),
  ], 5000);
};

export const summarizeShell = (content, mode) => {
  const lines = content.split('\n');
  const shebangs = [];
  const options = [];
  const functions = [];
  const exports = [];
  const commands = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      if (trimmed.startsWith('#!')) {
        shebangs.push(trimmed);
      }
      continue;
    }

    const functionMatch = trimmed.match(/^(?:function\s+)?([A-Za-z_][A-Za-z0-9_-]*)\s*\(\)\s*\{$/);
    if (functionMatch) {
      functions.push(`function ${functionMatch[1]}()`);
      continue;
    }

    if (/^(set -[A-Za-z]+|set -o\s+\w+)/.test(trimmed) || /^trap\s+/.test(trimmed)) {
      options.push(trimmed);
      continue;
    }

    const exportMatch = trimmed.match(/^export\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (exportMatch) {
      exports.push(`export ${exportMatch[1]}`);
      continue;
    }

    const commandMatch = trimmed.match(/^([A-Za-z0-9_./-]+)(?:\s+.+)?$/);
    if (commandMatch) {
      commands.push(commandMatch[1]);
    }
  }

  if (mode === 'signatures') {
    return joinSections([
      truncateSection('# Shell entrypoints', toUniqueLines([...shebangs, ...functions]), 1800),
      truncateSection('# Commands', toUniqueLines(commands, 15), 1200),
      truncateSection('# Exports', toUniqueLines(exports, 10), 700),
    ], 4000);
  }

  return joinSections([
    truncateSection('# Shebang and options', toUniqueLines([...shebangs, ...options], 12), 900),
    truncateSection('# Functions', toUniqueLines(functions, 20), 1400),
    truncateSection('# Exports', toUniqueLines(exports, 12), 700),
    truncateSection('# Commands', toUniqueLines(commands, 20), 1200),
  ], 5000);
};

export const summarizeTerraform = (content, mode) => {
  const lines = content.split('\n');
  const blocks = [];
  const assignments = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
      continue;
    }

    const blockMatch = trimmed.match(/^(terraform|locals|provider|module|resource|data|variable|output)\s*(?:"([^"]+)")?\s*(?:"([^"]+)")?\s*\{$/);
    if (blockMatch) {
      const [, kind, first, second] = blockMatch;
      const suffix = [first, second].filter(Boolean).map((value) => `"${value}"`).join(' ');
      blocks.push(`${kind}${suffix ? ` ${suffix}` : ''}`);
      continue;
    }

    const assignmentMatch = trimmed.match(/^([A-Za-z0-9_./-]+)\s*=\s*/);
    if (assignmentMatch) {
      assignments.push(assignmentMatch[1]);
    }
  }

  if (mode === 'signatures') {
    return joinSections([
      truncateSection('# Terraform blocks', toUniqueLines(blocks, 20), 2600),
      truncateSection('# Assignments', toUniqueLines(assignments, 20), 1000),
    ], 4000);
  }

  return joinSections([
    truncateSection('# Terraform blocks', toUniqueLines(blocks, 24), 2500),
    truncateSection('# Assignments', toUniqueLines(assignments, 24), 1200),
  ], 5000);
};

export const summarizeDockerfile = (content, mode) => {
  const lines = content.split('\n');
  const instructions = [];
  const stages = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const fromMatch = trimmed.match(/^FROM\s+([^\s]+)(?:\s+AS\s+([^\s]+))?/i);
    if (fromMatch) {
      stages.push(`FROM ${fromMatch[1]}${fromMatch[2] ? ` as ${fromMatch[2]}` : ''}`);
      continue;
    }

    if (/^[A-Z]+\s+/.test(trimmed)) {
      instructions.push(trimmed.replace(/\s+/g, ' '));
    }
  }

  if (mode === 'signatures') {
    return joinSections([
      truncateSection('# Docker stages', toUniqueLines(stages, 12), 1500),
      truncateSection('# Docker instructions', toUniqueLines(instructions, 18), 2200),
    ], 4000);
  }

  return joinSections([
    truncateSection('# Docker stages', toUniqueLines(stages, 12), 1200),
    truncateSection('# Docker instructions', toUniqueLines(instructions, 20), 2600),
  ], 5000);
};

export const summarizeSql = (content, mode) => {
  const lines = content.split('\n');
  const statements = [];
  const ctes = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (!trimmed || trimmed.startsWith('--')) {
      continue;
    }

    const statementMatch = trimmed.match(/^(create\s+(?:or\s+replace\s+)?(?:table|view|index|function|procedure|trigger)|alter\s+table|drop\s+(?:table|view|index)|insert\s+into|update\s+[A-Za-z_][A-Za-z0-9_.]*|delete\s+from|select\b|with\b)/i);
    if (statementMatch) {
      statements.push(trimmed.replace(/\s+/g, ' '));
      continue;
    }

    const cteMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+as\s*\(/i);
    if (cteMatch) {
      ctes.push(`cte ${cteMatch[1]}`);
    }
  }

  if (mode === 'signatures') {
    return joinSections([
      truncateSection('# SQL statements', toUniqueLines(statements, 18), 2800),
      truncateSection('# CTEs', toUniqueLines(ctes, 12), 700),
    ], 4000);
  }

  return joinSections([
    truncateSection('# SQL statements', toUniqueLines(statements, 20), 3200),
    truncateSection('# CTEs', toUniqueLines(ctes, 16), 900),
  ], 5000);
};

// ---------------------------------------------------------------------------
// C#
// ---------------------------------------------------------------------------

export const extractCsharpSymbol = (content, symbolName) =>
  extractBraceBlock(content, symbolName, (line, name) =>
    new RegExp(`(?:class|struct|interface|enum|record)\\s+${name}`).test(line) ||
    new RegExp(`[\\w<>\\[\\]]+\\s+${name}\\s*\\(`).test(line));

export const summarizeCsharp = (content, mode) => {
  const lines = content.split('\n');
  const usings = [];
  const namespaces = [];
  const declarations = [];
  const methods = [];
  let currentType = null;
  let braceDepth = 0;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;

    const usingMatch = trimmed.match(/^using\s+([\w.]+);$/);
    if (usingMatch) { usings.push(usingMatch[1]); continue; }

    const nsMatch = trimmed.match(/^namespace\s+([\w.]+)/);
    if (nsMatch) { namespaces.push(`namespace ${nsMatch[1]}`); }

    const typeMatch = trimmed.match(/^(?:public\s+)?(?:static\s+|abstract\s+|sealed\s+|partial\s+)*(class|struct|interface|enum|record)\s+([A-Za-z_]\w*)/);
    if (typeMatch) {
      currentType = typeMatch[2];
      declarations.push(`${typeMatch[1]} ${typeMatch[2]}`);
    }

    const methodMatch = trimmed.match(/^(?:public|protected|private|internal)\s+(?:static\s+)?(?:virtual\s+|override\s+|abstract\s+|async\s+)?(?:[A-Za-z0-9_<>\[\],.\s]+\s+)([A-Za-z_]\w*)\s*\(/);
    if (methodMatch && currentType) {
      methods.push(`${currentType}::${methodMatch[1]}`);
    }

    braceDepth += (trimmed.match(/\{/g) ?? []).length;
    braceDepth -= (trimmed.match(/\}/g) ?? []).length;
    if (braceDepth <= 0) { currentType = null; braceDepth = 0; }
  }

  if (mode === 'signatures') {
    return joinSections([
      truncateSection('# Declarations', toUniqueLines([...declarations, ...methods]), 2600),
      truncateSection('# Usings', toUniqueLines(usings, 10), 900),
    ], 4000);
  }

  return joinSections([
    truncateSection('# Namespaces', toUniqueLines(namespaces, 5), 300),
    truncateSection('# Declarations', toUniqueLines(declarations, 20), 1400),
    truncateSection('# Methods', toUniqueLines(methods, 20), 1800),
    truncateSection('# Usings', toUniqueLines(usings, 12), 1000),
  ], 5000);
};

// ---------------------------------------------------------------------------
// Kotlin
// ---------------------------------------------------------------------------

export const extractKotlinSymbol = (content, symbolName) =>
  extractBraceBlock(content, symbolName, (line, name) =>
    new RegExp(`(?:class|object|interface|enum)\\s+${name}`).test(line) ||
    new RegExp(`fun\\s+(?:<[^>]+>\\s+)?${name}\\s*\\(`).test(line));

export const summarizeKotlin = (content, mode) => {
  const lines = content.split('\n');
  const imports = [];
  const packages = [];
  const declarations = [];
  const functions = [];
  let currentType = null;
  let braceDepth = 0;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;

    const pkgMatch = trimmed.match(/^package\s+([\w.]+)$/);
    if (pkgMatch) { packages.push(`package ${pkgMatch[1]}`); continue; }

    const impMatch = trimmed.match(/^import\s+([\w.*]+)$/);
    if (impMatch) { imports.push(impMatch[1]); continue; }

    const typeMatch = trimmed.match(/^(?:open|abstract|data|sealed|internal|private|protected|\s)*(class|object|interface|enum)\s+([A-Za-z_]\w*)/);
    if (typeMatch) {
      currentType = typeMatch[2];
      declarations.push(`${typeMatch[1]} ${typeMatch[2]}`);
    }

    const funMatch = trimmed.match(/^(?:(?:public|private|protected|internal|open|override|suspend|inline)\s+)*fun\s+(?:<[^>]+>\s+)?([A-Za-z_]\w*)\s*\(/);
    if (funMatch) {
      const owner = currentType && braceDepth > 0 ? `${currentType}::` : '';
      functions.push(`${owner}${funMatch[1]}`);
    }

    braceDepth += (trimmed.match(/\{/g) ?? []).length;
    braceDepth -= (trimmed.match(/\}/g) ?? []).length;
    if (braceDepth <= 0) { currentType = null; braceDepth = 0; }
  }

  if (mode === 'signatures') {
    return joinSections([
      truncateSection('# Declarations', toUniqueLines([...declarations, ...functions]), 2600),
      truncateSection('# Imports', toUniqueLines(imports, 10), 900),
    ], 4000);
  }

  return joinSections([
    truncateSection('# Package', toUniqueLines(packages, 2), 300),
    truncateSection('# Declarations', toUniqueLines(declarations, 20), 1400),
    truncateSection('# Functions', toUniqueLines(functions, 20), 1800),
    truncateSection('# Imports', toUniqueLines(imports, 12), 1000),
  ], 5000);
};

// ---------------------------------------------------------------------------
// PHP
// ---------------------------------------------------------------------------

export const extractPhpSymbol = (content, symbolName) =>
  extractBraceBlock(content, symbolName, (line, name) =>
    new RegExp(`(?:class|interface|trait|enum)\\s+${name}`).test(line) ||
    new RegExp(`function\\s+${name}\\s*\\(`).test(line));

export const summarizePhp = (content, mode) => {
  const lines = content.split('\n');
  const uses = [];
  const namespaces = [];
  const declarations = [];
  const functions = [];
  let currentType = null;
  let braceDepth = 0;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue;

    const nsMatch = trimmed.match(/^namespace\s+([\w\\]+);?$/);
    if (nsMatch) { namespaces.push(`namespace ${nsMatch[1]}`); continue; }

    const useMatch = trimmed.match(/^use\s+([\w\\]+)(?:\s+as\s+\w+)?;$/);
    if (useMatch) { uses.push(useMatch[1]); continue; }

    const typeMatch = trimmed.match(/^(?:abstract|final|\s)*(class|interface|trait|enum)\s+([A-Za-z_]\w*)/);
    if (typeMatch) {
      currentType = typeMatch[2];
      declarations.push(`${typeMatch[1]} ${typeMatch[2]}`);
    }

    const funcMatch = trimmed.match(/^(?:public|protected|private|static|\s)*function\s+([A-Za-z_]\w*)\s*\(/);
    if (funcMatch) {
      const owner = currentType && braceDepth > 0 ? `${currentType}::` : '';
      functions.push(`${owner}${funcMatch[1]}`);
    }

    braceDepth += (trimmed.match(/\{/g) ?? []).length;
    braceDepth -= (trimmed.match(/\}/g) ?? []).length;
    if (braceDepth <= 0) { currentType = null; braceDepth = 0; }
  }

  if (mode === 'signatures') {
    return joinSections([
      truncateSection('# Declarations', toUniqueLines([...declarations, ...functions]), 2600),
      truncateSection('# Uses', toUniqueLines(uses, 10), 900),
    ], 4000);
  }

  return joinSections([
    truncateSection('# Namespace', toUniqueLines(namespaces, 2), 300),
    truncateSection('# Declarations', toUniqueLines(declarations, 20), 1400),
    truncateSection('# Functions', toUniqueLines(functions, 20), 1800),
    truncateSection('# Uses', toUniqueLines(uses, 12), 1000),
  ], 5000);
};

// ---------------------------------------------------------------------------
// Swift
// ---------------------------------------------------------------------------

export const extractSwiftSymbol = (content, symbolName) =>
  extractBraceBlock(content, symbolName, (line, name) =>
    new RegExp(`(?:class|struct|enum|protocol|actor)\\s+${name}`).test(line) ||
    new RegExp(`func\\s+${name}`).test(line));

export const summarizeSwift = (content, mode) => {
  const lines = content.split('\n');
  const imports = [];
  const declarations = [];
  const functions = [];
  let currentType = null;
  let braceDepth = 0;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;

    const impMatch = trimmed.match(/^import\s+(\w+)$/);
    if (impMatch) { imports.push(impMatch[1]); continue; }

    const typeMatch = trimmed.match(/^(?:public|private|internal|open|final|\s)*(class|struct|enum|protocol|actor)\s+([A-Za-z_]\w*)/);
    if (typeMatch) {
      currentType = typeMatch[2];
      declarations.push(`${typeMatch[1]} ${typeMatch[2]}`);
    }

    const funcMatch = trimmed.match(/^(?:(?:public|private|internal|open|override|static|class|@\w+)\s+)*func\s+([A-Za-z_]\w*)/);
    if (funcMatch) {
      const owner = currentType && braceDepth > 0 ? `${currentType}::` : '';
      functions.push(`${owner}${funcMatch[1]}`);
    }

    braceDepth += (trimmed.match(/\{/g) ?? []).length;
    braceDepth -= (trimmed.match(/\}/g) ?? []).length;
    if (braceDepth <= 0) { currentType = null; braceDepth = 0; }
  }

  if (mode === 'signatures') {
    return joinSections([
      truncateSection('# Declarations', toUniqueLines([...declarations, ...functions]), 2600),
      truncateSection('# Imports', toUniqueLines(imports, 10), 900),
    ], 4000);
  }

  return joinSections([
    truncateSection('# Declarations', toUniqueLines(declarations, 20), 1400),
    truncateSection('# Functions', toUniqueLines(functions, 20), 1800),
    truncateSection('# Imports', toUniqueLines(imports, 12), 1000),
  ], 5000);
};
