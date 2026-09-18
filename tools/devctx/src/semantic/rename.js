import fs from 'node:fs';
import { resolveSafePath } from '../utils/fs.js';

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED_WORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
  'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
]);

export const validateNewName = (newName) => {
  if (typeof newName !== 'string' || newName.trim().length === 0) {
    return { valid: false, reason: 'newName is required' };
  }
  const candidate = newName.trim();
  if (!IDENTIFIER_RE.test(candidate)) {
    return { valid: false, reason: `newName is not a valid identifier: ${candidate}` };
  }
  if (RESERVED_WORDS.has(candidate)) {
    return { valid: false, reason: `newName is a reserved word: ${candidate}` };
  }
  return { valid: true, newName: candidate };
};

const groupByFile = (locations) => {
  const byFile = new Map();
  for (const location of locations) {
    if (!location?.filePath) continue;
    if (!byFile.has(location.filePath)) byFile.set(location.filePath, []);
    byFile.get(location.filePath).push(location);
  }
  for (const edits of byFile.values()) {
    edits.sort((left, right) => right.offset - left.offset);
  }
  return byFile;
};

const applyEditsToContent = (content, edits, newName) => {
  let next = content;
  for (const edit of edits) {
    next = next.slice(0, edit.offset) + newName + next.slice(edit.offset + edit.length);
  }
  return next;
};

const buildHunks = (originalContent, updatedContent, edits) => {
  const originalLines = originalContent.split('\n');
  const updatedLines = updatedContent.split('\n');
  const touchedLines = [...new Set(edits.map((edit) => edit.start.line))].sort((a, b) => a - b);

  return touchedLines.map((line) => ({
    line,
    before: (originalLines[line - 1] ?? '').trim().slice(0, 200),
    after: (updatedLines[line - 1] ?? '').trim().slice(0, 200),
  }));
};

const detectNameCollisions = (provider, newName, filePaths) => {
  if (typeof provider.resolveSymbol !== 'function') return [];

  const collisions = [];
  for (const filePath of filePaths) {
    const existing = provider.resolveSymbol({ symbol: newName, filePath });
    if (existing?.filePath === filePath) {
      collisions.push({
        type: 'name-collision',
        severity: 'warning',
        basis: 'heuristic',
        file: filePath,
        message: `"${newName}" already resolves to a declaration in ${filePath}; scope overlap not verified`,
      });
    }
  }
  return collisions;
};

export const planRename = async ({
  provider,
  location,
  symbol,
  newName,
  root,
  maxFiles = 50,
}) => {
  const validation = validateNewName(newName);
  if (!validation.valid) {
    return {
      ok: false,
      conflicts: [{ type: 'invalid-name', severity: 'error', message: validation.reason }],
      plan: null,
    };
  }

  if (symbol && validation.newName === symbol) {
    return {
      ok: false,
      conflicts: [{
        type: 'same-name',
        severity: 'error',
        message: `newName equals the current symbol name: ${symbol}`,
      }],
      plan: null,
    };
  }

  if (typeof provider.renameLocations !== 'function') {
    return {
      ok: false,
      conflicts: [{
        type: 'unsupported-provider',
        severity: 'error',
        message: `provider "${provider.provider}" cannot compute rename locations`,
      }],
      plan: null,
    };
  }

  const locations = await provider.renameLocations(location);
  if (locations.length === 0) {
    return {
      ok: false,
      conflicts: [{
        type: 'no-locations',
        severity: 'error',
        message: 'No rename locations resolved for the target symbol',
      }],
      plan: null,
    };
  }

  const byFile = groupByFile(locations);
  if (byFile.size > maxFiles) {
    return {
      ok: false,
      conflicts: [{
        type: 'too-many-files',
        severity: 'error',
        message: `rename spans ${byFile.size} files, above the maxFiles limit of ${maxFiles}`,
      }],
      plan: null,
    };
  }

  const conflicts = [];
  const files = [];

  for (const [filePath, edits] of byFile) {
    let absolute;
    try {
      absolute = resolveSafePath(filePath, root);
    } catch (error) {
      conflicts.push({ type: 'path-escape', severity: 'error', file: filePath, message: error.message });
      continue;
    }

    if (!fs.existsSync(absolute)) {
      conflicts.push({
        type: 'missing-file',
        severity: 'error',
        file: filePath,
        message: `rename target file does not exist: ${filePath}`,
      });
      continue;
    }

    const originalContent = fs.readFileSync(absolute, 'utf8');
    const updatedContent = applyEditsToContent(originalContent, edits, validation.newName);

    files.push({
      file: filePath,
      absPath: absolute,
      edits: edits.length,
      hunks: buildHunks(originalContent, updatedContent, edits),
      originalContent,
      updatedContent,
    });
  }

  conflicts.push(...detectNameCollisions(provider, validation.newName, files.map((item) => item.file)));

  return {
    ok: conflicts.every((conflict) => conflict.severity !== 'error') && files.length > 0,
    newName: validation.newName,
    conflicts,
    plan: {
      filesAffected: files.length,
      totalEdits: files.reduce((sum, item) => sum + item.edits, 0),
      files: files.map(({ originalContent: _original, updatedContent: _updated, absPath: _abs, ...rest }) => rest),
    },
    _files: files,
  };
};

export const applyRename = async ({ provider, files, root }) => {
  const written = [];

  for (const file of files) {
    const absolute = resolveSafePath(file.file, root);
    fs.writeFileSync(absolute, file.updatedContent, 'utf8');
    written.push(file.file);
  }

  if (typeof provider.touchFiles === 'function') {
    provider.touchFiles(written);
  }

  const diagnostics = [];
  if (typeof provider.diagnostics === 'function') {
    for (const filePath of written) {
      const fileDiagnostics = await provider.diagnostics({ filePath, line: 0, character: 0 });
      diagnostics.push(...fileDiagnostics.filter((item) => item.severity === 'error'));
    }
  }

  return { written, diagnostics };
};
