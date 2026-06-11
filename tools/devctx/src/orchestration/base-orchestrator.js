import { persistMetrics } from '../metrics.js';
import { countTokens } from '../tokenCounter.js';
import { buildOperationalContextLines } from '../client-contract.js';
import { smartSummary } from '../tools/smart-summary.js';
import { smartTurn } from '../tools/smart-turn.js';
import {
  SAFE_CONTINUITY_STATES,
  extractNextStep,
  normalizeWhitespace,
  truncate,
  isSimpleTask,
  MAX_FOCUS_LENGTH,
  MAX_GOAL_LENGTH,
} from './policy/event-policy.js';

export const DEFAULT_ORCHESTRATION_EVENT = 'session_end';
export const DEFAULT_START_MAX_TOKENS = 350;
export const DEFAULT_END_MAX_TOKENS = 350;
const SIMPLE_TASK_SKIP_MAX_LENGTH = 40;

const buildContextLines = (startResult) => {
  const context = buildOperationalContextLines(startResult, {
    sessionStart: false,
    maxLineLength: 120,
    maxLines: 8,
    maxChars: 560,
  });
  return context ? context.split('\n') : [];
};

export const buildWrappedPrompt = ({ prompt, startResult }) => {
  const lines = buildContextLines(startResult);
  if (lines.length === 0) {
    return prompt;
  }

  return [
    'Use the persisted devctx project context below only if it is relevant to the user request.',
    ...lines.map((line) => `- ${line}`),
    '',
    'User request:',
    prompt,
  ].join('\n');
};

const buildFreshSessionUpdate = (prompt) => {
  const preview = truncate(prompt, MAX_FOCUS_LENGTH);
  return {
    goal: truncate(prompt, MAX_GOAL_LENGTH),
    status: 'planning',
    currentFocus: preview,
    pinnedContext: [preview],
    nextStep: 'Inspect the relevant code, validate task boundaries, and checkpoint the first concrete milestone.',
  };
};

const buildSimpleTaskStartResult = (prompt) => ({
  phase: 'start',
  skipSmartTurn: true,
  continuity: {
    state: 'simple_task_skip',
    shouldReuseContext: false,
    reason: 'Simple task heuristic skipped persisted continuity setup to avoid overhead.',
  },
  recommendedPath: {
    phase: 'start',
    mode: 'simple_task_skip',
    nextTools: ['smart_read', 'smart_search'],
    nextActions: [],
    next: 'smart_read: Skip smart_turn for this simple task and use lightweight read/search directly.',
  },
  message: 'Simple task heuristic skipped smart_turn(start); use lightweight read/search flow unless the task grows.',
  ...(prompt ? { promptPreview: truncate(prompt, MAX_FOCUS_LENGTH) } : {}),
});

const ensureIsolatedSession = async ({
  prompt,
  sessionId,
  startResult,
  startMaxTokens = DEFAULT_START_MAX_TOKENS,
  tokenBudget,
  summaryTool = smartSummary,
  startTurn = smartTurn,
}) => {
  if (sessionId || !startResult?.sessionId) {
    return {
      startResult,
      isolated: Boolean(startResult?.isolatedSession),
      previousSessionId: startResult?.previousSessionId ?? null,
    };
  }

  if (startResult?.isolatedSession) {
    return {
      startResult,
      isolated: true,
      previousSessionId: startResult.previousSessionId ?? null,
    };
  }

  if (SAFE_CONTINUITY_STATES.has(startResult.continuity?.state ?? '')) {
    return {
      startResult,
      isolated: false,
      previousSessionId: null,
    };
  }

  const created = await summaryTool({
    action: 'update',
    update: buildFreshSessionUpdate(prompt),
    maxTokens: startMaxTokens,
  });
  const isolatedStart = await startTurn({
    phase: 'start',
    sessionId: created.sessionId,
    prompt,
    ensureSession: false,
    maxTokens: startMaxTokens,
    tokenBudget,
  });

  return {
    startResult: isolatedStart,
    isolated: true,
    previousSessionId: startResult.sessionId,
  };
};

export const resolveManagedStart = async ({
  prompt,
  sessionId,
  preparedStartResult = null,
  ensureSession = true,
  allowIsolation = false,
  startMaxTokens = DEFAULT_START_MAX_TOKENS,
  tokenBudget,
  startTurn = smartTurn,
  summaryTool = smartSummary,
  enableFastPath = true,
}) => {
  const simpleTask = enableFastPath && isSimpleTask(prompt) && normalizeWhitespace(prompt).length <= SIMPLE_TASK_SKIP_MAX_LENGTH;

  if (simpleTask && !preparedStartResult && !sessionId) {
    const startResult = buildSimpleTaskStartResult(prompt);
    return {
      startResult,
      isolated: false,
      previousSessionId: null,
      autoStarted: false,
      fastPath: true,
    };
  }

  const startResult = preparedStartResult ?? await startTurn({
    phase: 'start',
    sessionId,
    prompt,
    ensureSession: simpleTask ? false : ensureSession,
    maxTokens: startMaxTokens,
    tokenBudget,
  });

  if (!allowIsolation || simpleTask) {
    return {
      startResult,
      isolated: Boolean(startResult?.isolatedSession),
      previousSessionId: startResult?.previousSessionId ?? null,
      autoStarted: !preparedStartResult,
      fastPath: simpleTask,
    };
  }

  const isolatedSession = await ensureIsolatedSession({
    prompt,
    sessionId,
    startResult,
    startMaxTokens,
    tokenBudget,
    summaryTool,
    startTurn,
  });

  return {
    ...isolatedSession,
    autoStarted: !preparedStartResult,
    fastPath: false,
  };
};

export const computeContextOverhead = ({ prompt, wrappedPrompt }) =>
  Math.max(0, countTokens(wrappedPrompt) - countTokens(prompt));

export const buildChildEndUpdate = ({ prompt, childResult }) => {
  const combinedOutput = [childResult.stdout, childResult.stderr].filter(Boolean).join('\n');
  const nextStep = extractNextStep(combinedOutput);
  const update = {
    currentFocus: truncate(prompt, MAX_FOCUS_LENGTH),
  };

  if (nextStep) {
    update.nextStep = nextStep;
  } else if (childResult.exitCode === 0) {
    update.nextStep = 'Review the latest headless agent output and checkpoint any concrete file changes before continuing.';
  } else {
    update.status = 'blocked';
    update.whyBlocked = `Headless agent command exited with code ${childResult.exitCode}.`;
    update.nextStep = 'Review the headless agent stderr/output and rerun the command once the issue is fixed.';
  }

  return update;
};

export const inferChildEndEvent = ({
  requestedEvent,
  childResult,
  successEvent = DEFAULT_ORCHESTRATION_EVENT,
}) => {
  if (requestedEvent) {
    return requestedEvent;
  }

  return childResult.exitCode === 0 ? successEvent : 'blocker';
};

export const finalizeManagedRun = async ({
  prompt,
  childResult,
  sessionId,
  requestedEvent,
  endMaxTokens = DEFAULT_END_MAX_TOKENS,
  endTurn = smartTurn,
}) => {
  const resolvedEvent = inferChildEndEvent({ requestedEvent, childResult });
  const endResult = await endTurn({
    phase: 'end',
    sessionId,
    event: resolvedEvent,
    update: buildChildEndUpdate({ prompt, childResult }),
    maxTokens: endMaxTokens,
  });

  return {
    resolvedEvent,
    endResult,
  };
};

export const recordAgentWrapperMetric = async ({
  phase,
  client,
  sessionId,
  dryRun = false,
  overheadTokens = 0,
  isolatedSession = false,
  previousSessionId = null,
  exitCode = null,
  event = null,
  autoStarted = false,
}) => {
  const safeOverheadTokens = Number.isFinite(overheadTokens) ? Math.max(0, overheadTokens) : 0;
  await persistMetrics({
    tool: 'agent_wrapper',
    action: `${client}:${phase}`,
    sessionId: sessionId ?? null,
    rawTokens: 0,
    compressedTokens: 0,
    savedTokens: 0,
    savingsPct: 0,
    metadata: {
      client,
      dryRun,
      autoStarted,
      isolatedSession,
      previousSessionId,
      exitCode,
      event,
      managedByBaseOrchestrator: true,
      isContextOverhead: phase === 'start' && safeOverheadTokens > 0,
      overheadTokens: phase === 'start' ? safeOverheadTokens : 0,
    },
    timestamp: new Date().toISOString(),
  });
};
