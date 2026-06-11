import fs from 'node:fs';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { rgPath } from '@vscode/ripgrep';
import { buildMetrics, persistMetrics } from '../metrics.js';
import { loadIndex, queryIndex, queryRelated } from '../index.js';
import { countTokens } from '../tokenCounter.js';
import { projectRoot } from '../utils/paths.js';
import { isBinaryBuffer, isDockerfile, resolveSafePath } from '../utils/fs.js';
import { truncate } from '../utils/text.js';
import { recordToolUsage } from '../usage-feedback.js';
import { recordDecision, DECISION_REASONS, EXPECTED_BENEFITS } from '../decision-explainer.js';
import { recordDevctxOperation } from '../missed-opportunities.js';
import { IGNORED_DIRS, IGNORED_FILE_NAMES, IGNORED_FILE_PATTERNS } from '../config/ignored-paths.js';
import { createProgressReporter } from '../streaming.js';
import { ensureIndexReady } from '../index-manager.js';
import { semanticRankSymbols, semanticRankFiles, buildIndexCorpusIdf, embed, cosineSimilarity } from '../embeddings/index.js';
import { ACTIVE_SESSION_SCOPE, withStateDbSnapshot } from '../storage/sqlite.js';
import { getNoiseHints, isGlobalMemoryEnabled, recordNoiseHint } from '../global-memory/store.js';

const execFile = promisify(execFileCallback);
const supportedGlobs = [
  '*.js', '*.jsx', '*.ts', '*.tsx', '*.json', '*.mjs', '*.cjs',
  '*.py', '*.toml', '*.yaml', '*.yml', '*.md', '*.graphql', '*.gql', '*.sql',
  '*.go', '*.rs', '*.java', '*.sh', '*.bash', '*.zsh', '*.tf', '*.tfvars', '*.hcl',
  'Dockerfile', 'Dockerfile.*',
];
const ignoredDirs = IGNORED_DIRS;
const ignoredFileNames = new Set(IGNORED_FILE_NAMES);
const fallbackExtensions = new Set(['.js', '.jsx', '.ts', '.tsx', '.json', '.mjs', '.cjs', '.py', '.toml', '.yaml', '.yml', '.md', '.graphql', '.gql', '.sql', '.go', '.rs', '.java', '.sh', '.bash', '.zsh', '.tf', '.tfvars', '.hcl']);
const likelySourceExtensions = new Set(['.js', '.jsx', '.ts', '.tsx', '.py', '.graphql', '.gql', '.sql', '.go', '.rs', '.java', '.sh', '.bash', '.zsh']);
const likelyConfigExtensions = new Set(['.json', '.toml', '.yaml', '.yml', '.tf', '.tfvars', '.hcl']);
const lowSignalNames = ['changelog', 'readme', 'migration', 'license', 'licence', 'contributing', 'authors', 'code_of_conduct', 'security', 'history'];
const testPatterns = ['.test.', '.spec.', '__tests__', '__mocks__', 'fixtures'];
const barrelFileNames = new Set(['index', 'mod', 'exports', 'public-api', 'public_api', 'barrel']);
const reexportPattern = /^\s*export\s+(?:\*|\{.*\})\s+from\s+/i;

export const VALID_INTENTS = new Set(['implementation', 'debug', 'tests', 'config', 'docs', 'explore']);
export const VALID_SEARCH_MODES = new Set(['needle', 'balanced', 'semantic']);

export const intentWeights = {
  implementation: { src: 10, source: 14, config: 4, lowSignal: -35, test: -15 },
  debug:          { src: 10, source: 14, config: 4, lowSignal: -35, test: -15 },
  tests:          { src: 5,  source: 10, config: 0, lowSignal: -35, test: 10 },
  config:         { src: 0,  source: 0,  config: 14, lowSignal: -20, test: -15 },
  docs:           { src: 0,  source: 4,  config: 4, lowSignal: -10, test: -15 },
  explore:        { src: 10, source: 14, config: 4, lowSignal: -35, test: -15 },
};

const defaultWeights = intentWeights.explore;
const DEFAULT_SEARCH_MODE = 'balanced';

const resolveSearchMode = ({ mode, semantic }) => {
  if (typeof mode === 'string' && VALID_SEARCH_MODES.has(mode)) {
    return mode;
  }

  if (semantic === true) {
    return 'semantic';
  }

  return DEFAULT_SEARCH_MODE;
};

const parseJsonObject = (value, fallback = {}) => {
  if (typeof value !== 'string' || value.trim().length === 0) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const normalizeRelPath = (value) => String(value ?? '').replace(/\\/g, '/');

const uniqueLowerTerms = (value) => [...new Set(extractTerms(String(value ?? '')).map((term) => term.toLowerCase()))];

const countTermHits = (terms, text) => {
  if (!Array.isArray(terms) || terms.length === 0 || !text) return 0;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const term of terms) {
    if (lower.includes(term)) hits++;
  }
  return hits;
};

const loadActiveSessionSignals = async () => {
  try {
    return await withStateDbSnapshot((db) => {
      const activeSessionId = db.prepare(`
        SELECT session_id
        FROM active_session
        WHERE scope = ?
      `).get(ACTIVE_SESSION_SCOPE)?.session_id;

      if (!activeSessionId) return null;

      const row = db.prepare(`
        SELECT goal, current_focus, snapshot_json
        FROM sessions
        WHERE session_id = ?
      `).get(activeSessionId);

      if (!row) return null;

      const snapshot = parseJsonObject(row.snapshot_json, {});
      const touchedFiles = Array.isArray(snapshot.touchedFiles)
        ? [...new Set(snapshot.touchedFiles.map(normalizeRelPath).filter(Boolean))]
        : [];

      return {
        touchedFiles: new Set(touchedFiles),
        hotFiles: new Set(touchedFiles.slice(-5)),
        focusTerms: uniqueLowerTerms(row.current_focus),
        goalTerms: uniqueLowerTerms(row.goal),
      };
    });
  } catch {
    return null;
  }
};

const shouldIgnoreFile = (filePath) => {
  const base = path.basename(filePath);
  if (ignoredFileNames.has(base)) return true;
  if (IGNORED_FILE_PATTERNS.some((p) => p.test(base))) return true;
  return false;
};

const isSearchableFile = (entryName, fullPath) => fallbackExtensions.has(path.extname(entryName)) || isDockerfile(fullPath);

export const walk = (dir, files = [], stats = { skippedDirs: 0 }) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    stats.skippedDirs++;
    return files;
  }

  for (const entry of entries) {
    if (ignoredDirs.includes(entry.name) || ignoredFileNames.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      walk(fullPath, files, stats);
      continue;
    }

    if (isSearchableFile(entry.name, fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
};

const parseRgLine = (line, root) => {
  const match = /^(.*?):(\d+):(.*)$/.exec(line);

  if (!match) {
    return null;
  }

  const [, relativePath, lineNumber, content] = match;
  return {
    file: path.join(root, relativePath),
    lineNumber: Number(lineNumber),
    content,
  };
};

const MAX_FILE_SIZE = '1M';

const buildRgBaseArgs = () => {
  const args = [
    '--line-number',
    '--no-heading',
    '--color', 'never',
    '--smart-case',
    '--max-filesize', MAX_FILE_SIZE,
  ];
  for (const dir of ignoredDirs) {
    args.push('--glob', `!${dir}/**`);
    args.push('--glob', `!**/${dir}/**`);
  }
  for (const fileName of ignoredFileNames) {
    args.push('--glob', `!${fileName}`);
  }
  for (const extension of supportedGlobs) {
    args.push('--glob', extension);
  }
  return args;
};

const runRg = async (root, pattern, extraArgs = []) => {
  const args = [...buildRgBaseArgs(), ...extraArgs, pattern, '.'];
  try {
    const { stdout } = await execFile(rgPath, args, {
      cwd: root,
      maxBuffer: 1024 * 1024 * 10,
      timeout: 15000,
    });
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => parseRgLine(line, root))
      .filter(Boolean)
      .filter((match) => !shouldIgnoreFile(match.file));
  } catch (error) {
    if (error.code === 1) return [];
    process.stderr.write(`[smart-search] ripgrep failed: ${error.message}\n`);
    return null;
  }
};

const extractTerms = (query) =>
  query
    .split(/[\s,;|/\\]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);

const buildQueryProfile = (query) => {
  const trimmed = String(query ?? '').trim();
  const terms = extractTerms(trimmed);
  const tokenCount = trimmed.length === 0 ? 0 : trimmed.split(/\s+/).filter(Boolean).length;
  const isSingleToken = tokenCount === 1;
  const hasCodeHints = /[A-Z_./:-]/.test(trimmed) || /[a-z][A-Z]/.test(trimmed);
  const looksSymbolLike = isSingleToken && (hasCodeHints || /^[a-z][a-z0-9]*$/.test(trimmed));
  const isConceptualMultiWord = tokenCount >= 2;
  const refinementTerm = terms
    .slice()
    .sort((left, right) => right.length - left.length || left.localeCompare(right))[0] ?? trimmed;

  return {
    raw: trimmed,
    terms,
    tokenCount,
    isSingleToken,
    looksSymbolLike,
    isConceptualMultiWord,
    refinementTerm,
  };
};

const buildSearchSuggestions = ({
  query,
  mode = DEFAULT_SEARCH_MODE,
  totalMatches = 0,
  totalFiles = 0,
  searchMode = 'exact',
  hasKinds = false,
}) => {
  const profile = buildQueryProfile(query);
  const suggestions = [];
  const pushSuggestion = (value) => {
    if (!value || suggestions.includes(value)) return;
    suggestions.push(value);
  };

  if (totalMatches === 0) {
    if (mode === 'needle' && profile.isConceptualMultiWord) {
      pushSuggestion('Try `mode="balanced"` to allow regex and term expansion for this multi-word query.');
      pushSuggestion('Try `mode="semantic"` if the query is conceptual rather than a literal symbol or string.');
    } else if (mode !== 'semantic' && profile.isConceptualMultiWord) {
      pushSuggestion('Try `mode="semantic"` for conceptual multi-word queries such as flows, behaviors, or features.');
    }

    if (mode !== 'needle' && profile.looksSymbolLike) {
      pushSuggestion('Try `mode="needle"` for an exact symbol/string lookup without aggressive expansion.');
    }

    if (!hasKinds && profile.looksSymbolLike) {
      pushSuggestion('Try `kinds=["function"]` or `kinds=["class"]` to narrow the search to symbol declarations.');
    }

    if (profile.isConceptualMultiWord && profile.refinementTerm && profile.refinementTerm !== profile.raw) {
      pushSuggestion(`Try refining the query to \`${profile.refinementTerm}\` or pair it with a symbol filter.`);
    }

    pushSuggestion('Try Grep for raw text if the content may live in a file type not indexed by `smart_search`.');
    return suggestions;
  }

  if (totalFiles > 30) {
    if (mode !== 'needle' && profile.looksSymbolLike) {
      pushSuggestion('Try `mode="needle"` to keep this search exact and avoid broad expansion.');
    }

    if (!hasKinds && profile.looksSymbolLike) {
      pushSuggestion('Try `kinds=["function"]`, `kinds=["class"]`, or another symbol kind to reduce noise.');
    }

    if (profile.isConceptualMultiWord && profile.refinementTerm && searchMode === 'terms') {
      pushSuggestion(`Try refining to the strongest term \`${profile.refinementTerm}\` before widening again.`);
    }

    if (profile.isSingleToken && !profile.looksSymbolLike) {
      pushSuggestion('Try a more discriminative term such as a function name, class name, or config key.');
    }
  }

  return suggestions;
};

const searchWithRipgrep = async (root, query, mode = DEFAULT_SEARCH_MODE) => {
  // Pass 1: exact literal match
  const exact = await runRg(root, query, ['--fixed-strings']);
  if (exact === null) return null;
  if (exact.length > 0) return { matches: exact, searchMode: 'exact' };

  if (mode === 'needle') {
    return { matches: [], searchMode: 'exact', zeroReason: 'no_matches' };
  }

  // Pass 2: regex (handles partial words, snake_case, camelCase fragments)
  const escaped = query.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&');
  const regex = await runRg(root, escaped);
  if (regex === null) return null;
  if (regex.length > 0) return { matches: regex, searchMode: 'regex' };

  // Pass 3: term expansion — search each significant word independently and merge
  const terms = extractTerms(query);
  if (terms.length < 2) return { matches: [], searchMode: 'exact', zeroReason: 'no_matches' };

  const seen = new Set();
  const merged = [];
  for (const term of terms) {
    const hits = await runRg(root, term, ['--fixed-strings']);
    if (!hits) continue;
    for (const hit of hits) {
      const key = `${hit.file}:${hit.lineNumber}`;
      if (!seen.has(key)) { seen.add(key); merged.push({ ...hit, matchedTerm: term }); }
    }
  }

  return { matches: merged, searchMode: 'terms', terms };
};

const MAX_FALLBACK_FILE_BYTES = 1024 * 1024;

export const isSmartCaseSensitive = (query) => query !== query.toLowerCase();

export const searchWithFallback = (root, query) => {
  const walkStats = { skippedDirs: 0 };
  const files = walk(root, [], walkStats);
  const matches = [];
  const caseSensitive = isSmartCaseSensitive(query);
  const comparator = caseSensitive
    ? (line) => line.includes(query)
    : (line) => line.toLowerCase().includes(query.toLowerCase());
  let skippedLarge = 0;
  let skippedBinary = 0;
  let skippedErrors = 0;

  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_FALLBACK_FILE_BYTES) { skippedLarge++; continue; }

      const buffer = fs.readFileSync(file);
      if (isBinaryBuffer(buffer)) { skippedBinary++; continue; }

      const content = buffer.toString('utf8');
      const lines = content.split('\n');

      lines.forEach((line, index) => {
        if (comparator(line)) {
          matches.push({
            file,
            lineNumber: index + 1,
            content: line,
          });
        }
      });
    } catch {
      skippedErrors++;
    }
  }

  return { matches, caseSensitive, skippedLarge, skippedBinary, skippedErrors, skippedDirs: walkStats.skippedDirs };
};

const formatMatch = (match) => `${match.file}:${match.lineNumber}:${match.content}`;

const scoreSessionContext = (group, sessionSignals, root = projectRoot) => {
  if (!sessionSignals) {
    return {
      score: 0,
      breakdown: {
        touchedFileBoost: 0,
        hotFileBoost: 0,
        focusPathBoost: 0,
        focusContentBoost: 0,
        goalPathBoost: 0,
        goalContentBoost: 0,
      },
    };
  }

  const relPath = normalizeRelPath(path.relative(root, group.file));
  const pathText = relPath.toLowerCase();
  const sampleText = group.matches.slice(0, 5).map((match) => match.content.toLowerCase()).join(' ');
  const focusPathHits = countTermHits(sessionSignals.focusTerms, pathText);
  const focusContentHits = countTermHits(sessionSignals.focusTerms, sampleText);
  const goalPathHits = countTermHits(sessionSignals.goalTerms, pathText);
  const goalContentHits = countTermHits(sessionSignals.goalTerms, sampleText);
  const breakdown = {
    touchedFileBoost: sessionSignals.touchedFiles.has(relPath) ? 24 : 0,
    hotFileBoost: sessionSignals.hotFiles.has(relPath) ? 8 : 0,
    focusPathBoost: Math.min(12, focusPathHits * 4),
    focusContentBoost: Math.min(8, focusContentHits * 2),
    goalPathBoost: Math.min(8, goalPathHits * 2),
    goalContentBoost: Math.min(6, goalContentHits * 2),
  };

  const score = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  return { score, breakdown };
};

const isBarrelLikeGroup = (group) => {
  const extension = path.extname(group.file).toLowerCase();
  if (!['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(extension)) {
    return false;
  }

  const baseName = path.basename(group.file, extension).toLowerCase();
  const sampleLines = group.matches.slice(0, 6).map((match) => String(match.content ?? ''));
  const reexportLines = sampleLines.filter((line) => reexportPattern.test(line)).length;
  const barrelNamed = barrelFileNames.has(baseName);
  return (barrelNamed && reexportLines > 0) || (sampleLines.length > 0 && reexportLines / sampleLines.length >= 0.6);
};

const buildGroupSemanticFingerprint = (group, root = projectRoot) => {
  const relPath = path.relative(root, group.file).replace(/\\/g, '/');
  const sample = group.matches.slice(0, 6).map((match) => match.content).join(' ');
  return `${relPath} ${sample}`;
};

const dedupeSemanticGroups = (groups, root = projectRoot) => {
  const kept = [];
  let dropped = 0;
  const droppedNoiseHints = [];

  for (const group of groups) {
    const candidateFingerprint = buildGroupSemanticFingerprint(group, root);
    const candidateVector = embed(candidateFingerprint);
    const candidateBarrel = isBarrelLikeGroup(group);
    let duplicate = false;

    for (const existing of kept.slice(0, 8)) {
      const similarity = cosineSimilarity(candidateVector, existing.vector);
      if (similarity < 0.93) continue;

      const sameBase = path.basename(existing.group.file) === path.basename(group.file);
      const sameFirstLine = (existing.group.matches[0]?.content ?? '').trim() === (group.matches[0]?.content ?? '').trim();
      if (candidateBarrel || sameBase || sameFirstLine) {
        duplicate = true;
        break;
      }
    }

    if (duplicate) {
      dropped += 1;
      if (candidateBarrel) {
        droppedNoiseHints.push(path.relative(root, group.file).replace(/\\/g, '/'));
      }
      continue;
    }

    kept.push({ group, vector: candidateVector });
  }

  return {
    groups: kept.map((entry) => entry.group),
    dropped,
    droppedNoiseHints,
  };
};

const scoreNoiseHints = (group, noiseHints, root = projectRoot) => {
  if (!Array.isArray(noiseHints) || noiseHints.length === 0) {
    return 0;
  }

  const relPath = path.relative(root, group.file).replace(/\\/g, '/');
  const fileName = path.basename(relPath);
  let penalty = 0;

  for (const hint of noiseHints) {
    if (!hint?.hintKey) continue;
    if (relPath === hint.hintKey || fileName === hint.hintKey) {
      penalty = Math.max(penalty, Number(hint.penalty ?? 0));
    }
  }

  return penalty > 0 ? -penalty : 0;
};

const scoreGroup = (group, query, intent) => {
  const w = (intent && intentWeights[intent]) || defaultWeights;
  const normalizedQuery = query.toLowerCase();
  const lowerFilePath = group.file.toLowerCase();
  const fileName = path.basename(group.file).toLowerCase();
  const extension = path.extname(group.file).toLowerCase();
  const pathDepth = group.file.split(path.sep).length;
  const sampleText = group.matches.slice(0, 5).map((match) => match.content.toLowerCase()).join(' ');
  const pathSegments = lowerFilePath.split(/[\\/._-]+/).filter(Boolean);
  const breakdown = {
    matchCountBoost: Math.min(group.count, 12) * 6,
    fileNameBoost: 0,
    pathSegmentBoost: 0,
    srcBoost: 0,
    packageBoost: 0,
    sourceBoost: 0,
    configBoost: 0,
    contentBoost: 0,
    lowSignalPenalty: 0,
    testBoost: 0,
    barrelPenalty: 0,
    depthPenalty: -Math.min(pathDepth, 12),
  };
  let score = breakdown.matchCountBoost;

  if (fileName.includes(normalizedQuery)) {
    breakdown.fileNameBoost = 30;
    score += breakdown.fileNameBoost;
  }

  if (pathSegments.includes(normalizedQuery)) {
    breakdown.pathSegmentBoost = 16;
    score += breakdown.pathSegmentBoost;
  }

  if (lowerFilePath.includes(`${path.sep}src${path.sep}`)) {
    breakdown.srcBoost = w.src;
    score += breakdown.srcBoost;
  }

  if (lowerFilePath.includes(`${path.sep}packages${path.sep}`) || lowerFilePath.includes(`${path.sep}apps${path.sep}`)) {
    breakdown.packageBoost = 8;
    score += breakdown.packageBoost;
  }

  if (likelySourceExtensions.has(extension) || isDockerfile(group.file)) {
    breakdown.sourceBoost = w.source;
    score += breakdown.sourceBoost;
  } else if (likelyConfigExtensions.has(extension)) {
    breakdown.configBoost = w.config;
    score += breakdown.configBoost;
  }

  if (sampleText.includes(normalizedQuery)) {
    breakdown.contentBoost = 8;
    score += breakdown.contentBoost;
  }

  if (lowSignalNames.some((name) => fileName.includes(name))) {
    breakdown.lowSignalPenalty = w.lowSignal;
    score += breakdown.lowSignalPenalty;
  }

  if (testPatterns.some((p) => lowerFilePath.includes(p))) {
    breakdown.testBoost = w.test;
    score += breakdown.testBoost;
  }

  if (isBarrelLikeGroup(group)) {
    breakdown.barrelPenalty = -18;
    score += breakdown.barrelPenalty;
  }

  score += breakdown.depthPenalty;

  return { score, breakdown };
};

const buildWhyRanked = ({ count, boostSource, scoreBreakdown }) => {
  const reasons = [];

  if (scoreBreakdown.touchedFileBoost > 0) reasons.push(`touched-file boost (+${scoreBreakdown.touchedFileBoost})`);
  else if (scoreBreakdown.hotFileBoost > 0) reasons.push(`recent-session file boost (+${scoreBreakdown.hotFileBoost})`);

  if (scoreBreakdown.indexBoost > 0) reasons.push(`index boost (+${scoreBreakdown.indexBoost})`);
  else if (scoreBreakdown.graphBoost > 0) reasons.push(`graph boost (+${scoreBreakdown.graphBoost})`);

  const textReasons = [
    [scoreBreakdown.fileNameBoost, `filename match (+${scoreBreakdown.fileNameBoost})`],
    [scoreBreakdown.pathSegmentBoost, `path segment match (+${scoreBreakdown.pathSegmentBoost})`],
    [scoreBreakdown.matchCountBoost, `${count} text match${count === 1 ? '' : 'es'} (+${scoreBreakdown.matchCountBoost})`],
    [scoreBreakdown.sourceBoost, `source-file boost (+${scoreBreakdown.sourceBoost})`],
    [scoreBreakdown.configBoost, `config-file boost (+${scoreBreakdown.configBoost})`],
    [scoreBreakdown.contentBoost, `content hit (+${scoreBreakdown.contentBoost})`],
    [scoreBreakdown.focusPathBoost, `focus-path boost (+${scoreBreakdown.focusPathBoost})`],
    [scoreBreakdown.focusContentBoost, `focus-content boost (+${scoreBreakdown.focusContentBoost})`],
    [scoreBreakdown.goalPathBoost, `goal-path boost (+${scoreBreakdown.goalPathBoost})`],
    [scoreBreakdown.goalContentBoost, `goal-content boost (+${scoreBreakdown.goalContentBoost})`],
    [scoreBreakdown.testBoost, scoreBreakdown.testBoost > 0 ? `test intent boost (+${scoreBreakdown.testBoost})` : `test-path penalty (${scoreBreakdown.testBoost})`],
    [scoreBreakdown.barrelPenalty, `barrel penalty (${scoreBreakdown.barrelPenalty})`],
    [scoreBreakdown.lowSignalPenalty, `low-signal penalty (${scoreBreakdown.lowSignalPenalty})`],
  ].filter(([value]) => value !== 0)
    .sort((left, right) => Math.abs(right[0]) - Math.abs(left[0]))
    .map(([, label]) => label);

  reasons.push(...textReasons.slice(0, Math.max(0, 3 - reasons.length)));

  if (reasons.length === 0) {
    return boostSource === 'text' ? 'text matches ranked by relevance' : `${boostSource} signal boosted this file`;
  }

  return reasons.join(', ');
};

const groupMatches = (matches, query, intent, indexHits, graphHits, sessionSignals, noiseHints, root = projectRoot) => {
  const groups = new Map();

  for (const match of matches) {
    if (!groups.has(match.file)) {
      groups.set(match.file, []);
    }

    groups.get(match.file).push(match);
  }

  const breakdown = { textMatch: 0, indexBoost: 0, graphBoost: 0, sessionBoost: 0, semanticDedup: 0, noisePenalty: 0 };

  const sorted = [...groups.entries()]
    .map(([file, fileMatches]) => {
      const { score: textScore, breakdown: textBreakdown } = scoreGroup({ file, count: fileMatches.length, matches: fileMatches }, query, intent);
      const { score: sessionScore, breakdown: sessionBreakdown } = scoreSessionContext({ file, count: fileMatches.length, matches: fileMatches }, sessionSignals, root);
      let score = textScore;
      let boostSource = 'text';
      const scoreBreakdown = {
        ...textBreakdown,
        ...sessionBreakdown,
        textScore,
        sessionScore,
        indexBoost: 0,
        graphBoost: 0,
        noisePenalty: 0,
        finalScore: textScore,
      };
      score += sessionScore;
      if (indexHits?.has(file)) {
        score += 50;
        boostSource = 'index';
        scoreBreakdown.indexBoost = 50;
      } else if (graphHits?.has(file)) {
        score += 25;
        boostSource = 'graph';
        scoreBreakdown.graphBoost = 25;
      }
      const noisePenalty = scoreNoiseHints({ file, count: fileMatches.length, matches: fileMatches }, noiseHints, root);
      if (noisePenalty !== 0) {
        score += noisePenalty;
        scoreBreakdown.noisePenalty = noisePenalty;
      }
      scoreBreakdown.finalScore = score;
      return {
        file,
        count: fileMatches.length,
        score,
        matches: fileMatches,
        boostSource,
        matchedBy: boostSource,
        scoreBreakdown,
        whyRanked: buildWhyRanked({ count: fileMatches.length, boostSource, scoreBreakdown }),
      };
    })
    .sort((left, right) => right.score - left.score || right.count - left.count || left.file.localeCompare(right.file));

  const deduped = dedupeSemanticGroups(sorted, root);

  for (const g of deduped.groups.slice(0, 10)) {
    if (g.boostSource === 'index') breakdown.indexBoost++;
    else if (g.boostSource === 'graph') breakdown.graphBoost++;
    else breakdown.textMatch++;
    if ((g.scoreBreakdown.sessionScore ?? 0) > 0) breakdown.sessionBoost++;
    if ((g.scoreBreakdown.noisePenalty ?? 0) < 0) breakdown.noisePenalty++;
  }
  breakdown.semanticDedup = deduped.dropped;

  return { groups: deduped.groups, breakdown, droppedNoiseHints: deduped.droppedNoiseHints };
};

const buildZeroResultsMessage = (query, searchMode, provenance, mode = DEFAULT_SEARCH_MODE, suggestions = []) => {
  const lines = [`No matches found for: "${query}"`];

  if (mode === 'needle') {
    lines.push('• Tried: exact literal match (--fixed-strings)');
    lines.push('• Skipped: regex fallback and term expansion (needle mode)');
  } else if (searchMode === 'exact') {
    lines.push('• Tried: exact literal match (--fixed-strings)');
    lines.push('• Tried: regex match');
  } else if (searchMode === 'terms') {
    const terms = provenance?.expandedTerms ?? [];
    lines.push(`• Tried: exact, regex, and term expansion (${terms.join(', ')})`);
  }

  lines.push('');
  lines.push('Suggestions:');
  for (const suggestion of suggestions) {
    lines.push(`  – ${suggestion}`);
  }

  if (suggestions.length === 0) {
    lines.push('  – Use a shorter, more specific term (e.g. a function name, not a phrase)');
    lines.push('  – Try Grep for raw text: the query may be in a file type not indexed by smart_search');
    lines.push('  – Run build_index to enable symbol-level search if the codebase is new');
  }

  return lines.join('\n');
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

const countResponseTokens = (value) => countTokens(JSON.stringify(value));

const buildCompactTopFile = ({ file, count, score, boostSource, matchedBy }) => ({
  file,
  count,
  score,
  boostSource,
  matchedBy,
});

const applyResponseBudget = (response, maxTokens) => {
  const sectionsCompacted = [];
  const actions = [];
  const noteCompaction = (name) => {
    if (!sectionsCompacted.includes(name)) sectionsCompacted.push(name);
  };
  const noteAction = (name) => {
    if (!actions.includes(name)) actions.push(name);
  };

  const withBudgetMeta = (value) => ({
    ...value,
    budgetApplied: true,
    budgetDetails: {
      scope: 'response',
      maxTokens,
      actions,
      sectionsCompacted,
    },
  });

  const countBudgeted = (value) => countResponseTokens(withBudgetMeta(value));

  const finalize = (budgeted, applied) => {
    if (!applied) return { response: budgeted, applied: false };
    return { response: withBudgetMeta(budgeted), applied: true };
  };

  if (!Number.isFinite(maxTokens) || maxTokens < 1) {
    return { response, applied: false };
  }

  if (countResponseTokens(response) <= maxTokens) {
    return { response, applied: false };
  }

  const budgeted = { ...response };

  delete budgeted.semantic;
  delete budgeted.semanticError;
  noteCompaction('semantic');
  noteAction('metadata_compacted');

  if (countBudgeted(budgeted) <= maxTokens) {
    return finalize(budgeted, true);
  }

  delete budgeted.suggestions;
  delete budgeted.totalFiles;
  delete budgeted.nextSuggestedMaxFiles;
  noteCompaction('suggestions');
  noteCompaction('expansionHints');
  noteAction('metadata_compacted');

  if (countBudgeted(budgeted) <= maxTokens) {
    return finalize(budgeted, true);
  }

  if (Array.isArray(budgeted.topFiles) && budgeted.topFiles.length > 0) {
    budgeted.topFiles = budgeted.topFiles.map(buildCompactTopFile);
    noteCompaction('topFilesDiagnostics');
    noteAction('metadata_compacted');
  }

  if (countBudgeted(budgeted) <= maxTokens) {
    return finalize(budgeted, true);
  }

  while (Array.isArray(budgeted.topFiles) && budgeted.topFiles.length > 1 && countBudgeted(budgeted) > maxTokens) {
    budgeted.topFiles = budgeted.topFiles.slice(0, -1);
    noteCompaction('topFilesCount');
    noteAction('results_reduced');
  }

  if (countBudgeted(budgeted) <= maxTokens) {
    return finalize(budgeted, true);
  }

  if (typeof budgeted.matches === 'string') {
    noteCompaction('matches');
    noteAction('content_truncated');
    const withoutMatches = { ...budgeted, matches: '' };
    const remaining = maxTokens - countBudgeted(withoutMatches);
    budgeted.matches = remaining > 0
      ? truncateByTokens(budgeted.matches, remaining)
      : '';
  }

  if (countBudgeted(budgeted) <= maxTokens) {
    return finalize(budgeted, true);
  }

  delete budgeted.rankingBreakdown;
  noteCompaction('rankingBreakdown');
  noteAction('metadata_compacted');

  if (countBudgeted(budgeted) <= maxTokens) {
    return finalize(budgeted, true);
  }

  while (Array.isArray(budgeted.topFiles) && budgeted.topFiles.length > 0 && countBudgeted(budgeted) > maxTokens) {
    budgeted.topFiles = budgeted.topFiles.slice(0, -1);
    noteCompaction('topFiles');
    noteAction('results_reduced');
  }

  if (countBudgeted(budgeted) <= maxTokens) {
    return finalize(budgeted, true);
  }

  budgeted.matches = '';
  noteCompaction('matchesOmitted');
  noteAction('content_truncated');
  return finalize(budgeted, true);
};

const DEFAULT_RESULT_FILES = 5;
const MAX_COMPACT_RESULT_FILES = 15;

const buildCompactResult = (groups, totalMatches, query, root, searchMode, provenance, totalFiles, mode = DEFAULT_SEARCH_MODE, suggestions = []) => {
  if (totalMatches === 0) {
    return buildZeroResultsMessage(query, searchMode, provenance, mode, suggestions);
  }

  const modeLabel = searchMode === 'exact'
    ? ''
    : searchMode === 'regex'
      ? ' [regex fallback]'
      : ` [term expansion: ${(provenance?.expandedTerms ?? []).join(', ')}]`;
  const topGroups = groups.slice(0, MAX_COMPACT_RESULT_FILES);

  if (totalMatches <= 20) {
    const header = modeLabel ? `# Search mode:${modeLabel}\n` : '';
    return header + topGroups
      .flatMap((group) => group.matches)
      .map(formatMatch)
      .join('\n');
  }

  const lines = [];
  if (modeLabel) {
    lines.push(`# Search mode:${modeLabel}`);
  }

  const topScore = topGroups[0]?.score ?? 0;
  for (const group of topGroups.slice(0, 5)) {
    const linesPerFile = group.score >= topScore * 0.7 ? 5 : 2;
    for (const match of group.matches.slice(0, linesPerFile)) {
      lines.push(formatMatch(match));
    }
  }

  const fileCount = totalFiles ?? groups.length;
  if (fileCount > 30) {
    lines.push(`# Note: ${fileCount} files matched — query may be too broad. Use Grep for exact pattern matching.`);
    if (suggestions.length > 0) {
      lines.push('# Refinements:');
      for (const suggestion of suggestions) {
        lines.push(`- ${suggestion}`);
      }
    }
  }

  return lines.join('\n');
};

const filterGroupsByKinds = (groups, loadedIndex, indexRoot, kinds) => {
  if (!Array.isArray(kinds) || kinds.length === 0) return groups;
  if (!loadedIndex?.files) return groups;
  const kindSet = new Set(kinds.map((k) => String(k).toLowerCase()));
  return groups.filter((group) => {
    const rel = path.relative(indexRoot, group.file).replace(/\\/g, '/');
    const entry = loadedIndex.files[rel];
    if (!entry?.symbols) return false;
    return entry.symbols.some((s) => kindSet.has(String(s.kind ?? '').toLowerCase()));
  });
};

export const smartSearch = async ({ query, cwd = '.', intent, maxFiles, kinds, mode, semantic = false, semanticLimit = 8, maxTokens, _testForceWalk = false, _testIgnoreSessionSignals = false, progress: enableProgress = false }) => {
  const progress = enableProgress ? createProgressReporter('smart_search') : null;
  const startTime = Date.now();
  const resolvedMode = resolveSearchMode({ mode, semantic });
  const validBudget = Number.isFinite(maxTokens) && maxTokens >= 1 ? maxTokens : null;
  
  if (progress) {
    progress.report({ phase: 'searching', query });
  }
  
  const root = resolveSafePath(cwd);
  const rgResult = _testForceWalk ? null : await searchWithRipgrep(root, query, resolvedMode);
  const usedFallback = rgResult === null;
  const engine = usedFallback ? 'walk' : 'rg';

  let rawMatches;
  let provenance;
  let searchMode = 'exact';

  if (usedFallback) {
    const fallback = searchWithFallback(root, query);
    rawMatches = fallback.matches;
    const skippedTotal = fallback.skippedLarge + fallback.skippedBinary + fallback.skippedErrors + fallback.skippedDirs;
    const warnings = ['search used filesystem walk instead of ripgrep'];
    if (skippedTotal > 0) warnings.push(`${skippedTotal} items skipped (${fallback.skippedDirs} dirs, ${fallback.skippedLarge + fallback.skippedBinary + fallback.skippedErrors} files)`);

    provenance = {
      fallbackReason: 'rg unavailable or failed',
      caseMode: fallback.caseSensitive ? 'sensitive' : 'insensitive',
      partial: skippedTotal > 0,
      skippedItemsTotal: skippedTotal,
      skippedLargeFiles: fallback.skippedLarge,
      skippedBinaryFiles: fallback.skippedBinary,
      skippedReadErrors: fallback.skippedErrors,
      skippedDirs: fallback.skippedDirs,
      warnings,
    };
  } else {
    rawMatches = rgResult.matches;
    searchMode = rgResult.searchMode;
    if (rgResult.terms) provenance = { expandedTerms: rgResult.terms };
  }

  rawMatches = rawMatches.filter((match) => !shouldIgnoreFile(match.file));

  const seen = new Set();
  const dedupedMatches = rawMatches.filter((match) => {
    const key = `${match.file}:${match.lineNumber}:${match.content.trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const validIntent = intent && VALID_INTENTS.has(intent) ? intent : undefined;

  const indexRoot = projectRoot;
  let indexHits = null;
  let graphHits = null;
  let indexFreshness = 'unavailable';
  let loadedIndex = null;
  const sessionSignals = _testIgnoreSessionSignals ? null : await loadActiveSessionSignals();
  const noiseHints = isGlobalMemoryEnabled() ? (await getNoiseHints({ projectPath: indexRoot })).hints : [];
  
  if (progress) {
    progress.report({ phase: 'ranking', rawMatches: rawMatches.length });
  }
  
  await ensureIndexReady({ root: indexRoot });
  
  try {
    loadedIndex = loadIndex(indexRoot);
    if (loadedIndex) {
      indexFreshness = 'fresh';
      const hits = queryIndex(loadedIndex, query);
      if (hits.length > 0) {
        indexHits = new Set(hits.map((h) => path.join(indexRoot, h.path)));
        const related = new Set();
        for (const h of hits) {
          const rel = queryRelated(loadedIndex, h.path);
          for (const p of [...rel.importedBy, ...rel.tests, ...rel.imports]) {
            const full = path.join(indexRoot, p);
            if (!indexHits.has(full)) related.add(full);
          }
        }
        if (related.size > 0) graphHits = related;
      }
    }
  } catch {
    // index unavailable — continue without it
  }

  let { groups, breakdown, droppedNoiseHints } = groupMatches(dedupedMatches, query, validIntent, indexHits, graphHits, sessionSignals, noiseHints, indexRoot);
  const normalizedKinds = Array.isArray(kinds) ? kinds.filter((k) => typeof k === 'string' && k.trim()) : null;
  if (normalizedKinds && normalizedKinds.length > 0) {
    groups = filterGroupsByKinds(groups, loadedIndex, indexRoot, normalizedKinds);
  }

  const suggestions = buildSearchSuggestions({
    query,
    mode: resolvedMode,
    totalMatches: dedupedMatches.length,
    totalFiles: groups.length,
    searchMode,
    hasKinds: Boolean(normalizedKinds && normalizedKinds.length > 0),
  });

  if (loadedIndex && indexFreshness === 'fresh') {
    const topRelPaths = groups.slice(0, 10).map((g) => path.relative(indexRoot, g.file).replace(/\\/g, '/'));
    for (const rp of topRelPaths) {
      const entry = loadedIndex.files?.[rp];
      if (!entry) continue;
      try {
        const diskMtime = Math.floor(fs.statSync(path.join(indexRoot, rp)).mtimeMs);
        if (diskMtime !== entry.mtime) { indexFreshness = 'stale'; break; }
      } catch { /* file gone or unreadable */ }
    }
  }

  const effectiveMaxFiles = maxFiles ?? DEFAULT_RESULT_FILES;
  const cappedGroups = groups.slice(0, effectiveMaxFiles);
  const hasMore = groups.length > cappedGroups.length;
  const nextSuggestedMaxFiles = hasMore
    ? Math.min(50, groups.length, Math.max(effectiveMaxFiles + 5, effectiveMaxFiles * 2))
    : undefined;

  const rawText = dedupedMatches.map(formatMatch).join('\n');
  const baseCompactText = truncate(
    buildCompactResult(cappedGroups, dedupedMatches.length, query, root, searchMode, provenance, groups.length, resolvedMode, suggestions),
    5000,
  );
  let compressedText = baseCompactText;
  if (validBudget && countTokens(compressedText) > validBudget) {
    compressedText = truncateByTokens(compressedText, validBudget);
  }
  const metrics = buildMetrics({
    tool: 'smart_search',
    target: `${root} :: ${query}`,
    rawText,
    compressedText,
  });

  await persistMetrics(metrics);
  
  recordToolUsage({
    tool: 'smart_search',
    savedTokens: metrics.savedTokens,
    target: query,
  });
  recordDevctxOperation();

  let retrievalConfidence = 'high';
  if (dedupedMatches.length === 0) retrievalConfidence = 'none';
  else if (searchMode === 'terms') retrievalConfidence = 'low';
  else if (searchMode === 'regex') retrievalConfidence = 'medium';
  else if (usedFallback) retrievalConfidence = provenance?.skippedItemsTotal > 0 ? 'low' : 'medium';
  else if (provenance?.skippedItemsTotal > 0) retrievalConfidence = 'low';

  if (progress) {
    progress.complete({
      query,
      matches: dedupedMatches.length,
      files: groups.length,
      savedTokens: metrics.savedTokens,
      savingsPct: metrics.savingsPct,
    });
  }

  let result = {
    query,
    mode: resolvedMode,
    indexFreshness,
    ...(validIntent ? { intent: validIntent } : {}),
    ...(normalizedKinds && normalizedKinds.length > 0 ? { kinds: normalizedKinds } : {}),
    ...(indexHits ? { indexBoosted: indexHits.size } : {}),
    totalMatches: dedupedMatches.length,
    matchedFiles: cappedGroups.length,
    hasMore,
    rankingBreakdown: breakdown,
    ...(groups.length > cappedGroups.length ? { totalFiles: groups.length } : {}),
    ...(nextSuggestedMaxFiles ? { nextSuggestedMaxFiles } : {}),
    ...(suggestions.length > 0 ? { suggestions } : {}),
    topFiles: cappedGroups.slice(0, 5).map((group) => ({
      file: group.file,
      count: group.count,
      score: group.score,
      boostSource: group.boostSource,
      matchedBy: group.matchedBy,
      scoreBreakdown: group.scoreBreakdown,
      whyRanked: group.whyRanked,
    })),
    matches: compressedText,
  };

  if (provenance?.fallbackReason) result.searchMode = provenance.fallbackReason;
  if (retrievalConfidence !== 'high') result.retrievalConfidence = retrievalConfidence;

  const shouldIncludeSemanticBlock = resolvedMode === 'semantic'
    && (dedupedMatches.length === 0 || searchMode !== 'exact');

  if (shouldIncludeSemanticBlock) {
    try {
      const index = loadIndex(root);
      if (index) {
        const idf = buildIndexCorpusIdf(index);
        const symbolRanks = semanticRankSymbols({ query, index, limit: semanticLimit, idf });
        const fileRanks = semanticRankFiles({ query, index, limit: semanticLimit, idf });
        result.semantic = {
          embedder: 'hashing-v1',
          symbols: symbolRanks.map((r) => ({
            score: Number(r.score.toFixed(4)),
            path: r.path,
            symbol: r.symbol.name,
            kind: r.symbol.kind,
            line: r.symbol.line,
            matchedBy: 'semantic',
            whyRanked: `semantic similarity (${Number(r.score.toFixed(4))})`,
          })),
          files: fileRanks.map((r) => ({
            score: Number(r.score.toFixed(4)),
            path: r.path,
            symbols: r.symbolCount,
            matchedBy: 'semantic',
            whyRanked: `semantic similarity (${Number(r.score.toFixed(4))})`,
          })),
        };
      }
    } catch (err) {
      result.semanticError = err?.message ?? String(err);
    }
  }

  const budgetedResult = applyResponseBudget(result, validBudget);
  result = budgetedResult.response;

  if (isGlobalMemoryEnabled() && Array.isArray(droppedNoiseHints) && droppedNoiseHints.length > 0) {
    for (const hintKey of droppedNoiseHints) {
      await recordNoiseHint({ projectPath: indexRoot, hintKey, reason: 'semantic_dedupe' });
    }
  }

  let reason = DECISION_REASONS.MULTIPLE_FILES;
  if (budgetedResult.applied) {
    reason = DECISION_REASONS.TOKEN_BUDGET;
  } else if (indexHits && indexHits.size > 0) {
    reason = DECISION_REASONS.INDEX_BOOST;
  } else if (validIntent) {
    reason = DECISION_REASONS.INTENT_AWARE;
  }

  recordDecision({
    tool: 'smart_search',
    action: `search "${query}"${validIntent ? ` (intent: ${validIntent})` : ''}`,
    reason,
    alternative: 'Grep (unranked results)',
    expectedBenefit: `${EXPECTED_BENEFITS.TOKEN_SAVINGS(metrics.savedTokens)}, ${EXPECTED_BENEFITS.BETTER_RANKING}`,
    context: `${dedupedMatches.length} matches in ${groups.length} files, ranked by relevance`,
  });

  return result;
};
