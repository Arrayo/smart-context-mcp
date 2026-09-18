import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { createSemanticDiagnostic, createSemanticLocation, severityFromTsCategory } from './types.js';

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const IGNORED_DIRS = new Set(['.git', '.devctx', 'node_modules', 'dist', 'build', 'coverage']);

const walkSourceFiles = (root) => {
  const files = [];
  const visit = (directory) => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) visit(path.join(directory, entry.name));
        continue;
      }
      if (SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(path.join(directory, entry.name));
      }
    }
  };
  visit(root);
  return files;
};

const parseProject = (root) => {
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) {
    return {
      fileNames: walkSourceFiles(root),
      options: {
        allowJs: true,
        checkJs: false,
        noEmit: true,
        target: ts.ScriptTarget.Latest,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
      },
    };
  }

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath), undefined, configPath);
  return { fileNames: parsed.fileNames, options: parsed.options, configPath };
};

const toPosition = (sourceFile, offset) => {
  const position = ts.getLineAndCharacterOfPosition(sourceFile, offset);
  return { line: position.line + 1, character: position.character + 1 };
};

const toLocation = (root, sourceFile, span) => {
  if (!sourceFile || !span) return null;
  return createSemanticLocation({
    root,
    filePath: sourceFile.fileName,
    start: toPosition(sourceFile, span.start),
    end: toPosition(sourceFile, span.start + span.length),
  });
};

const createHost = ({ files, options, versions }) => ({
  getScriptFileNames: () => files,
  getScriptVersion: (fileName) => versions.get(fileName) ?? '0',
  getScriptSnapshot: (fileName) => {
    try {
      return ts.ScriptSnapshot.fromString(fs.readFileSync(fileName, 'utf8'));
    } catch {
      return undefined;
    }
  },
  getCurrentDirectory: () => options.configFilePath ? path.dirname(options.configFilePath) : process.cwd(),
  getCompilationSettings: () => options,
  getDefaultLibFileName: (currentOptions) => ts.getDefaultLibFilePath(currentOptions),
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists,
  getDirectories: ts.sys.getDirectories,
  getNewLine: () => '\n',
  useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
});

const resolveLocation = ({ root, languageService, location }) => {
  const fileName = path.resolve(root, location.filePath);
  if (!fs.existsSync(fileName)) return null;
  const program = languageService.getProgram();
  const sourceFile = program?.getSourceFile(fileName);
  if (!sourceFile) return null;
  const offset = ts.getPositionOfLineAndCharacter(sourceFile, location.line, location.character);
  return { fileName, sourceFile, offset };
};

const hasExportModifier = (node) =>
  Boolean(node.modifiers?.some((modifier) =>
    modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword));

const scoreNamedDeclaration = (identifier) => {
  const parent = identifier.parent;
  if (!parent) return 1;

  let score = 2;
  if (
    (ts.isFunctionDeclaration(parent) && parent.name === identifier)
    || (ts.isClassDeclaration(parent) && parent.name === identifier)
    || (ts.isInterfaceDeclaration(parent) && parent.name === identifier)
    || (ts.isTypeAliasDeclaration(parent) && parent.name === identifier)
    || (ts.isEnumDeclaration(parent) && parent.name === identifier)
    || (ts.isMethodDeclaration(parent) && parent.name === identifier)
    || (ts.isPropertyDeclaration(parent) && parent.name === identifier)
    || (ts.isVariableDeclaration(parent) && parent.name === identifier)
  ) {
    score = 10;
    if (hasExportModifier(parent) || hasExportModifier(parent.parent ?? parent)) score += 5;
  } else if (ts.isParameter(parent) && parent.name === identifier) {
    score = 3;
  }

  return score;
};

const findSymbolMatchesInSourceFile = (sourceFile, symbolName) => {
  const matches = [];
  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === symbolName) {
      matches.push({
        node,
        score: scoreNamedDeclaration(node),
        offset: node.getStart(sourceFile),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  matches.sort((left, right) => right.score - left.score || left.offset - right.offset);
  return matches;
};

const toInputLocation = (root, sourceFile, offset) => {
  const position = ts.getLineAndCharacterOfPosition(sourceFile, offset);
  return {
    filePath: path.relative(root, sourceFile.fileName).replace(/\\/g, '/'),
    line: position.line,
    character: position.character,
  };
};

const normalizeDiagnostic = (root, languageService, diagnostic, category) => {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  const file = diagnostic.file;
  if (!file || diagnostic.start == null) {
    return createSemanticDiagnostic({
      root,
      filePath: file?.fileName ?? '',
      severity: severityFromTsCategory(diagnostic.category),
      code: diagnostic.code,
      message,
      category,
    });
  }

  const start = toPosition(file, diagnostic.start);
  const end = toPosition(file, diagnostic.start + (diagnostic.length ?? 0));
  return createSemanticDiagnostic({
    root,
    filePath: file.fileName,
    start,
    end,
    severity: severityFromTsCategory(diagnostic.category),
    code: diagnostic.code,
    message,
    category,
  });
};

export const createTypeScriptProvider = ({ root = process.cwd() } = {}) => {
  const projectRoot = path.resolve(root);
  const project = parseProject(projectRoot);
  const versions = new Map(project.fileNames.map((fileName) => [path.resolve(fileName), '0']));
  const options = { ...project.options, configFilePath: project.configPath };
  const host = createHost({ files: project.fileNames, options, versions });
  const languageService = ts.createLanguageService(host, ts.createDocumentRegistry());

  const locationsFor = (location, resolver) => {
    const resolved = resolveLocation({ root: projectRoot, languageService, location });
    if (!resolved) return [];
    const items = resolver(resolved.fileName, resolved.offset) ?? [];
    return items.map((item) => {
      const sourceFile = languageService.getProgram()?.getSourceFile(item.fileName);
      return toLocation(projectRoot, sourceFile, item.textSpan ?? item);
    }).filter(Boolean);
  };

  const resolveSymbol = ({ symbol, filePath } = {}) => {
    if (typeof symbol !== 'string' || !symbol.trim()) return null;
    const symbolName = symbol.trim();
    const program = languageService.getProgram();
    if (!program) return null;

    const preferred = filePath
      ? [path.resolve(projectRoot, filePath)]
      : [];
    const candidates = [
      ...preferred,
      ...project.fileNames.map((fileName) => path.resolve(fileName)),
    ].filter((fileName, index, all) => all.indexOf(fileName) === index);

    let best = null;
    for (const absolutePath of candidates) {
      const sourceFile = program.getSourceFile(absolutePath);
      if (!sourceFile) continue;
      const matches = findSymbolMatchesInSourceFile(sourceFile, symbolName);
      if (matches.length === 0) continue;
      const top = matches[0];
      const candidate = {
        ...toInputLocation(projectRoot, sourceFile, top.offset),
        score: top.score + (preferred.includes(absolutePath) ? 100 : 0),
        symbol: symbolName,
      };
      if (!best || candidate.score > best.score) best = candidate;
      if (preferred.includes(absolutePath) && top.score >= 10) break;
    }

    if (!best) return null;
    const { score: _score, ...location } = best;
    return location;
  };

  const toEditLocation = (item) => {
    const sourceFile = languageService.getProgram()?.getSourceFile(item.fileName);
    const span = item.textSpan;
    if (!sourceFile || !span) return null;
    return {
      filePath: path.relative(projectRoot, sourceFile.fileName).replace(/\\/g, '/'),
      offset: span.start,
      length: span.length,
      start: toPosition(sourceFile, span.start),
      end: toPosition(sourceFile, span.start + span.length),
    };
  };

  return {
    provider: 'typescript',
    root: projectRoot,
    files: project.fileNames,
    resolveSymbol,
    touchFiles(filePaths = []) {
      for (const filePath of filePaths) {
        const absolute = path.resolve(projectRoot, filePath);
        const current = Number(versions.get(absolute) ?? 0);
        versions.set(absolute, String(current + 1));
      }
    },
    async renameLocations(location, { findInStrings = false, findInComments = false } = {}) {
      const resolved = resolveLocation({ root: projectRoot, languageService, location });
      if (!resolved) return [];
      const items = languageService.findRenameLocations(
        resolved.fileName,
        resolved.offset,
        findInStrings,
        findInComments,
      ) ?? [];
      return items.map(toEditLocation).filter(Boolean);
    },
    async definition(location) {
      return locationsFor(location, (fileName, offset) =>
        languageService.getDefinitionAtPosition(fileName, offset) ?? []);
    },
    async references(location) {
      return locationsFor(location, (fileName, offset) =>
        languageService.findReferences(fileName, offset)?.flatMap((group) => group.references) ?? []);
    },
    async implementations(location) {
      return locationsFor(location, (fileName, offset) =>
        languageService.getImplementationAtPosition(fileName, offset) ?? []);
    },
    async diagnostics(location) {
      const filePath = location?.filePath;
      if (!filePath) return [];
      const fileName = path.resolve(projectRoot, filePath);
      if (!fs.existsSync(fileName)) return [];
      const syntactic = languageService.getSyntacticDiagnostics(fileName)
        .map((diagnostic) => normalizeDiagnostic(projectRoot, languageService, diagnostic, 'syntactic'));
      const semantic = languageService.getSemanticDiagnostics(fileName)
        .map((diagnostic) => normalizeDiagnostic(projectRoot, languageService, diagnostic, 'semantic'));
      return [...syntactic, ...semantic].filter(Boolean);
    },
    async hover(location) {
      const resolved = resolveLocation({ root: projectRoot, languageService, location });
      if (!resolved) return null;
      const info = languageService.getQuickInfoAtPosition(resolved.fileName, resolved.offset);
      if (!info) return null;
      return {
        displayParts: ts.displayPartsToString(info.displayParts ?? []),
        documentation: ts.displayPartsToString(info.documentation ?? []),
        location: toLocation(projectRoot, resolved.sourceFile, info.textSpan),
      };
    },
    dispose() {
      languageService.dispose();
    },
  };
};
