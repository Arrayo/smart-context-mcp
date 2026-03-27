import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../utils/runtime-config.js';
import { countTokens } from '../tokenCounter.js';
import { persistMetrics } from '../metrics.js';

const MAX_SESSION_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TOKENS = 500;
const VALID_STATUSES = new Set(['planning', 'in_progress', 'blocked', 'completed']);
const DEFAULT_STATUS = 'in_progress';
const SESSION_SCHEMA_VERSION = 2;

const getSessionsDir = () => path.join(projectRoot, '.devctx', 'sessions');
const getActiveSessionFile = () => path.join(getSessionsDir(), 'active.json');

const ensureSessionsDir = () => {
  const sessionsDir = getSessionsDir();
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
  }
};

const generateSessionId = (goal) => {
  const date = new Date().toISOString().split('T')[0];
  const slug = goal
    ? goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)
    : 'session';
  return `${date}-${slug}`;
};

const getSessionPath = (sessionId) => path.join(getSessionsDir(), `${sessionId}.json`);

const loadSession = (sessionId) => {
  const sessionPath = getSessionPath(sessionId);
  if (!fs.existsSync(sessionPath)) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    return data;
  } catch {
    return null;
  }
};

const saveSession = (sessionId, data) => {
  ensureSessionsDir();
  const sessionPath = getSessionPath(sessionId);
  const sessionData = {
    ...data,
    schemaVersion: SESSION_SCHEMA_VERSION,
    sessionId,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2), 'utf8');
  
  const activeSessionFile = getActiveSessionFile();
  fs.writeFileSync(activeSessionFile, JSON.stringify({ sessionId, updatedAt: sessionData.updatedAt }, null, 2), 'utf8');
  
  return sessionData;
};

const getActiveSession = () => {
  const activeSessionFile = getActiveSessionFile();
  if (!fs.existsSync(activeSessionFile)) {
    return null;
  }
  try {
    const { sessionId } = JSON.parse(fs.readFileSync(activeSessionFile, 'utf8'));
    const activeSession = loadSession(sessionId);
    if (!activeSession) {
      fs.unlinkSync(activeSessionFile);
      return null;
    }
    return activeSession;
  } catch {
    try {
      fs.unlinkSync(activeSessionFile);
    } catch {}
    return null;
  }
};

const cleanupStaleSessions = () => {
  ensureSessionsDir();
  const sessionsDir = getSessionsDir();
  const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json') && f !== 'active.json');
  const now = Date.now();
  let cleaned = 0;
  
  const activeSession = getActiveSession();
  const activeSessionId = activeSession?.sessionId;
  
  for (const file of files) {
    const sessionPath = path.join(sessionsDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      
      if (data.sessionId === activeSessionId) {
        continue;
      }
      
      const age = now - new Date(data.updatedAt).getTime();
      if (age > MAX_SESSION_AGE_MS) {
        fs.unlinkSync(sessionPath);
        cleaned += 1;
      }
    } catch {
      fs.unlinkSync(sessionPath);
      cleaned += 1;
    }
  }
  
  return cleaned;
};

const listSessions = () => {
  ensureSessionsDir();
  cleanupStaleSessions();
  
  const sessionsDir = getSessionsDir();
  const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json') && f !== 'active.json');
  const now = Date.now();
  
  return files
    .map(file => {
      const sessionPath = path.join(sessionsDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
        const age = now - new Date(data.updatedAt).getTime();
        return {
          sessionId: data.sessionId,
          goal: data.goal,
          status: data.status,
          updatedAt: data.updatedAt,
          ageMs: age,
          isStale: age > MAX_SESSION_AGE_MS,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
};

const truncateString = (str, maxLength) => {
  if (!str || str.length <= maxLength) return str;
  if (maxLength <= 3) return '';
  return str.slice(0, maxLength - 3) + '...';
};

const normalizeStatus = (status, fallback = DEFAULT_STATUS) =>
  VALID_STATUSES.has(status) ? status : fallback;

const isMeaningfulString = (value) => typeof value === 'string' && value.trim().length > 0;

const compactFilePath = (filePath) => {
  if (!isMeaningfulString(filePath)) {
    return filePath;
  }

  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 3 && normalized.length <= 60) {
    return normalized;
  }

  const tail = parts.slice(-3).join('/');
  return normalized.length <= tail.length ? normalized : `.../${tail}`;
};

const validateUpdateInput = (update) => {
  if (!update || typeof update !== 'object') {
    throw new Error('update parameter is required for update/append actions');
  }

  if (update.status !== undefined && !VALID_STATUSES.has(update.status)) {
    throw new Error(`Invalid status: ${update.status}. Valid statuses: planning, in_progress, blocked, completed`);
  }
};

const mergeUniqueStrings = (...lists) => {
  const seen = new Set();
  const result = [];

  for (const list of lists) {
    for (const item of list || []) {
      if (!isMeaningfulString(item) || seen.has(item)) {
        continue;
      }
      seen.add(item);
      result.push(item);
    }
  }

  return result;
};

const uniqueTail = (items, limit) => mergeUniqueStrings(items || []).slice(-limit);
const uniqueHead = (items, limit) => mergeUniqueStrings(items || []).slice(0, limit);

const buildSummaryMetrics = (rawTokens, finalTokens) => ({
  rawTokens,
  finalTokens,
  compressedTokens: finalTokens,
  savedTokens: Math.max(0, rawTokens - finalTokens),
});

const pruneEmptyFields = (value) =>
  Object.fromEntries(
    Object.entries(value).filter(([, item]) => {
      if (item === undefined || item === null || item === '') {
        return false;
      }
      if (Array.isArray(item) && item.length === 0) {
        return false;
      }
      return true;
    }),
  );

const buildResumeSummary = (data) => {
  const status = normalizeStatus(data.status);
  const whyBlocked = status === 'blocked'
    ? (isMeaningfulString(data.whyBlocked) ? data.whyBlocked : (data.blockers || []).find(isMeaningfulString))
    : undefined;
  const completed = mergeUniqueStrings(data.completed);
  const decisions = mergeUniqueStrings(data.decisions);
  const touchedFiles = mergeUniqueStrings(data.touchedFiles);

  return pruneEmptyFields({
    status,
    nextStep: isMeaningfulString(data.nextStep) ? data.nextStep : undefined,
    pinnedContext: uniqueHead(data.pinnedContext, 3),
    unresolvedQuestions: uniqueHead(data.unresolvedQuestions, 3),
    currentFocus: isMeaningfulString(data.currentFocus) ? data.currentFocus : undefined,
    whyBlocked,
    goal: isMeaningfulString(data.goal) ? data.goal : undefined,
    recentCompleted: uniqueTail(completed, 3),
    keyDecisions: uniqueTail(decisions, 2),
    hotFiles: uniqueTail(touchedFiles.map(compactFilePath), 5),
    completedCount: data.completedCount ?? completed.length,
    decisionsCount: data.decisionsCount ?? decisions.length,
    touchedFilesCount: data.touchedFilesCount ?? touchedFiles.length,
  });
};

const compressSummary = (data, maxTokens) => {
  const baseSummary = buildResumeSummary(data);
  let compressed = baseSummary;
  let summary = JSON.stringify(compressed, null, 2);
  let tokens = countTokens(summary);

  if (tokens <= maxTokens) {
    return { compressed, tokens, truncated: false, omitted: [], compressionLevel: 'none' };
  }

  const recomputeTokens = () => {
    compressed = pruneEmptyFields(compressed);
    summary = JSON.stringify(compressed, null, 2);
    tokens = countTokens(summary);
  };

  const shrinkScalarField = (field, { removable = true } = {}) => {
    const value = compressed[field];
    if (!isMeaningfulString(value)) {
      return false;
    }

    if (value.length <= 12) {
      if (!removable) {
        return false;
      }
      delete compressed[field];
      return true;
    }

    const next = truncateString(value, Math.max(4, Math.floor(value.length * 0.6)));
    if (!next || next === value) {
      if (!removable) {
        return false;
      }
      delete compressed[field];
      return true;
    }

    compressed[field] = next;
    return true;
  };

  const shrinkArrayField = (field) => {
    const value = compressed[field];
    if (!Array.isArray(value) || value.length === 0) {
      return false;
    }

    if (value.length > 1) {
      compressed[field] = value.slice(-1);
      return true;
    }

    const [item] = value;
    if (!isMeaningfulString(item)) {
      delete compressed[field];
      return true;
    }

    if (item.length <= 12) {
      delete compressed[field];
      return true;
    }

    compressed[field] = [truncateString(item, Math.max(4, Math.floor(item.length * 0.6)))];
    return true;
  };

  const reductionSteps = [
    () => shrinkArrayField('recentCompleted'),
    () => shrinkArrayField('keyDecisions'),
    () => shrinkArrayField('hotFiles'),
    () => shrinkArrayField('unresolvedQuestions'),
    () => shrinkScalarField('goal'),
    () => shrinkScalarField('currentFocus'),
    () => shrinkScalarField('whyBlocked'),
    () => shrinkArrayField('pinnedContext'),
    () => shrinkScalarField('nextStep', { removable: false }),
  ];

  let madeProgress = true;

  while (tokens > maxTokens && madeProgress) {
    madeProgress = false;

    for (const reduce of reductionSteps) {
      if (!reduce()) {
        continue;
      }

      recomputeTokens();
      madeProgress = true;

      if (tokens <= maxTokens) {
        break;
      }
    }
  }

  if (tokens > maxTokens && isMeaningfulString(compressed.nextStep)) {
    while (tokens > maxTokens && shrinkScalarField('nextStep')) {
      recomputeTokens();
    }
  }

  if (tokens > maxTokens) {
    compressed = pruneEmptyFields({
      status: normalizeStatus(data.status),
      nextStep: isMeaningfulString(data.nextStep) ? data.nextStep : undefined,
      pinnedContext: uniqueHead(data.pinnedContext, 1),
      completedCount: data.completedCount ?? mergeUniqueStrings(data.completed).length,
      decisionsCount: data.decisionsCount ?? mergeUniqueStrings(data.decisions).length,
      touchedFilesCount: data.touchedFilesCount ?? mergeUniqueStrings(data.touchedFiles).length,
    });
    recomputeTokens();

    while (tokens > maxTokens && isMeaningfulString(compressed.nextStep) && shrinkScalarField('nextStep')) {
      recomputeTokens();
    }
  }

  if (tokens > maxTokens) {
    compressed = { status: normalizeStatus(data.status) };
    recomputeTokens();
  }

  const omitted = Object.keys(baseSummary).filter((key) => !(key in compressed));
  const compressionLevel = Object.keys(compressed).length === 1 && compressed.status
    ? 'status_only'
    : omitted.length > 0
      ? 'reduced'
      : 'trimmed';

  return { compressed, tokens, truncated: true, omitted, compressionLevel };
};

export const smartSummary = async ({ action, sessionId, update, maxTokens = DEFAULT_MAX_TOKENS }) => {
  const startTime = Date.now();
  
  ensureSessionsDir();
  
  if (action === 'list_sessions') {
    const sessions = listSessions();
    const activeSession = getActiveSession();
    
    return {
      action: 'list_sessions',
      sessions,
      activeSessionId: activeSession?.sessionId || null,
      totalSessions: sessions.length,
      staleSessions: sessions.filter(s => s.isStale).length,
    };
  }
  
  if (action === 'get') {
    const targetSessionId = sessionId || getActiveSession()?.sessionId;
    
    if (!targetSessionId) {
      return {
        action: 'get',
        sessionId: null,
        found: false,
        message: 'No active session found. Use action=update to create one.',
      };
    }
    
    const session = loadSession(targetSessionId);
    
    if (!session) {
      return {
        action: 'get',
        sessionId: targetSessionId,
        found: false,
        message: 'Session not found.',
      };
    }
    
    const { compressed, tokens, truncated, omitted, compressionLevel } = compressSummary(session, maxTokens);
    
    const rawTokens = countTokens(JSON.stringify(session));
    const summaryMetrics = buildSummaryMetrics(rawTokens, tokens);

    persistMetrics({
      tool: 'smart_summary',
      action: 'get',
      sessionId: targetSessionId,
      ...summaryMetrics,
      latencyMs: Date.now() - startTime,
    });
    
    return {
      action: 'get',
      sessionId: targetSessionId,
      found: true,
      summary: compressed,
      tokens,
      truncated,
      omitted,
      compressionLevel,
      schemaVersion: session.schemaVersion ?? 1,
      updatedAt: session.updatedAt,
    };
  }
  
  if (action === 'reset') {
    const targetSessionId = sessionId || getActiveSession()?.sessionId;
    
    if (!targetSessionId) {
      return {
        action: 'reset',
        sessionId: null,
        message: 'No session to reset.',
      };
    }
    
    const activeSession = getActiveSession();
    const isActiveSession = activeSession?.sessionId === targetSessionId;
    
    const sessionPath = getSessionPath(targetSessionId);
    if (fs.existsSync(sessionPath)) {
      fs.unlinkSync(sessionPath);
    }
    
    if (isActiveSession) {
      const activeSessionFile = getActiveSessionFile();
      if (fs.existsSync(activeSessionFile)) {
        fs.unlinkSync(activeSessionFile);
      }
    }
    
    return {
      action: 'reset',
      sessionId: targetSessionId,
      message: 'Session cleared.',
    };
  }
  
  if (action === 'update' || action === 'append') {
    validateUpdateInput(update);
    
    let targetSessionId = sessionId;
    let existingData = {};
    
    if (!targetSessionId || targetSessionId === 'new') {
      if (action === 'append') {
        const activeSession = getActiveSession();
        if (activeSession) {
          targetSessionId = activeSession.sessionId;
          existingData = activeSession;
        } else {
          targetSessionId = generateSessionId(update.goal);
        }
      } else {
        targetSessionId = generateSessionId(update.goal);
      }
    } else {
      const existing = loadSession(targetSessionId);
      if (existing) {
        existingData = existing;
      }
    }
    
    const resolvedStatus = normalizeStatus(update.status, normalizeStatus(existingData.status));
    const completed = action === 'append'
      ? mergeUniqueStrings(existingData.completed, update.completed)
      : mergeUniqueStrings(update.completed);
    const decisions = action === 'append'
      ? mergeUniqueStrings(existingData.decisions, update.decisions)
      : mergeUniqueStrings(update.decisions);
    const touchedFiles = action === 'append'
      ? mergeUniqueStrings(existingData.touchedFiles, update.touchedFiles)
      : mergeUniqueStrings(update.touchedFiles);
    const mergedData = action === 'append'
      ? {
          goal: update.goal || existingData.goal || 'Untitled session',
          status: resolvedStatus,
          pinnedContext: mergeUniqueStrings(existingData.pinnedContext, update.pinnedContext),
          unresolvedQuestions: mergeUniqueStrings(existingData.unresolvedQuestions, update.unresolvedQuestions),
          currentFocus: update.currentFocus || existingData.currentFocus || '',
          whyBlocked: update.whyBlocked || existingData.whyBlocked || '',
          completed,
          decisions,
          blockers: update.blockers !== undefined ? mergeUniqueStrings(update.blockers) : (existingData.blockers || []),
          nextStep: update.nextStep || existingData.nextStep || '',
          touchedFiles,
          completedCount: completed.length,
          decisionsCount: decisions.length,
          touchedFilesCount: touchedFiles.length,
        }
      : {
          goal: update.goal || 'Untitled session',
          status: normalizeStatus(update.status),
          pinnedContext: mergeUniqueStrings(update.pinnedContext),
          unresolvedQuestions: mergeUniqueStrings(update.unresolvedQuestions),
          currentFocus: update.currentFocus ?? '',
          whyBlocked: update.whyBlocked ?? '',
          completed,
          decisions,
          blockers: mergeUniqueStrings(update.blockers),
          nextStep: update.nextStep ?? '',
          touchedFiles,
          completedCount: completed.length,
          decisionsCount: decisions.length,
          touchedFilesCount: touchedFiles.length,
        };
    
    const savedData = saveSession(targetSessionId, mergedData);
    const { compressed, tokens, truncated, omitted, compressionLevel } = compressSummary(savedData, maxTokens);
    
    const rawTokens = countTokens(JSON.stringify(savedData));
    const summaryMetrics = buildSummaryMetrics(rawTokens, tokens);

    persistMetrics({
      tool: 'smart_summary',
      action,
      sessionId: targetSessionId,
      ...summaryMetrics,
      latencyMs: Date.now() - startTime,
    });
    
    return {
      action,
      sessionId: targetSessionId,
      summary: compressed,
      tokens,
      truncated,
      omitted,
      compressionLevel,
      schemaVersion: savedData.schemaVersion,
      updatedAt: savedData.updatedAt,
      message: action === 'append' ? 'Session updated incrementally.' : 'Session saved.',
    };
  }
  
  throw new Error(`Invalid action: ${action}. Valid actions: get, update, append, reset, list_sessions`);
};
