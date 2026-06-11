import { buildIndexIncremental, persistIndex } from '../index.js';
import { triggerBackgroundIndexBuild } from '../index-manager.js';
import { projectRoot } from '../utils/runtime-config.js';
import {
  autoTrackWorkflow,
  endWorkflow,
  getActiveWorkflowForSession,
  isWorkflowTrackingEnabled,
} from '../workflow-tracker.js';
import { persistMetrics } from '../metrics.js';
import { runStorageMaintenance } from '../storage/sqlite.js';
import { PRODUCT_QUALITY_ANALYTICS_KIND } from '../analytics/product-quality.js';
import { attachSafetyMetadata, buildMutationSafety } from '../utils/mutation-safety.js';
import { normalizeTokenBudget, peekRemainingBudget } from '../utils/task-budget.js';
import { smartContext } from './smart-context.js';
import { smartMetrics } from './smart-metrics.js';
import { smartSummary } from './smart-summary.js';
import { deriveStartActions, deriveEndActions } from '../turn/next-actions.js';
import { isSimpleTask } from '../orchestration/policy/event-policy.js';

const isStorageUnhealthy = (health) =>
  health && health.status !== 'ok' && health.status !== null && health.status !== undefined;

const VALID_VERBOSITIES = new Set(['minimal', 'standard', 'full']);
const DEFAULT_VERBOSITY = 'minimal';

const normalizeVerbosity = (value) =>
  typeof value === 'string' && VALID_VERBOSITIES.has(value) ? value : DEFAULT_VERBOSITY;

const DEFAULT_START_MAX_TOKENS = 400;
const DEFAULT_END_MAX_TOKENS = 500;
const DEFAULT_END_EVENT = 'milestone';
const DEFAULT_REFRESH_CONTEXT_MAX_TOKENS = 1400;
const MAX_PROMPT_PREVIEW = 160;
const SIMPLE_TASK_SKIP_MAX_LENGTH = 40;
const REFRESHED_CONTEXT_FILE_LIMIT = 3;
const SAFE_CONTINUITY_STATES = new Set(['aligned', 'resume']);
const WORKFLOW_END_EVENTS = new Set(['milestone', 'task_complete', 'session_end', 'blocker']);
const INDEX_REFRESH_STATES = new Set(['stale', 'unavailable']);
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'where',
  'what', 'have', 'will', 'your', 'about', 'there', 'their', 'then', 'than',
  'want', 'need', 'make', 'does', 'just', 'each', 'also', 'todo', 'done',
  'pero', 'para', 'como', 'esta', 'esto', 'cuando', 'donde', 'quiero', 'hacer',
  'sobre', 'porque', 'tengo', 'vamos', 'luego', 'ahora', 'puede', 'puedo',
]);

const normalizeWhitespace = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

const truncate = (value, maxLength = MAX_PROMPT_PREVIEW) => {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  if (maxLength <= 3) {
    return '';
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
};

const extractTerms = (value) => {
  const normalized = normalizeWhitespace(value).toLowerCase();
  if (!normalized) {
    return [];
  }

  return [...new Set(
    normalized
      .split(/[^a-z0-9_.-]+/i)
      .map((term) => term.trim())
      .filter((term) => term.length >= 3 && !STOP_WORDS.has(term))
  )];
};

const collectSummaryStrings = (value, sink = []) => {
  if (typeof value === 'string') {
    if (value.trim()) {
      sink.push(value);
    }
    return sink;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectSummaryStrings(item, sink));
    return sink;
  }

  if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectSummaryStrings(item, sink));
  }

  return sink;
};

const summarizeMetrics = (metrics) => {
  if (!metrics?.summary) {
    return null;
  }

  return {
    count: metrics.summary.count,
    savedTokens: metrics.summary.savedTokens,
    savingsPct: metrics.summary.savingsPct,
    netSavedTokens: metrics.summary.netSavedTokens,
    netSavingsPct: metrics.summary.netSavingsPct,
    overheadTokens: metrics.summary.overheadTokens,
    topTools: metrics.summary.tools.slice(0, 3).map((tool) => ({
      tool: tool.tool,
      savedTokens: tool.savedTokens,
      netSavedTokens: tool.netSavedTokens,
      count: tool.count,
    })),
  };
};

const buildRecommendedStep = (tool, instruction, priority = 'recommended') => ({
  tool,
  instruction,
  priority,
});

const classifyContinuity = ({ prompt, summaryResult }) => {
  if (!summaryResult?.found) {
    if (summaryResult?.ambiguous) {
      return {
        state: 'ambiguous_resume',
        shouldReuseContext: false,
        reason: 'Multiple recent sessions matched and need an explicit choice.',
      };
    }

    return {
      state: 'cold_start',
      shouldReuseContext: false,
      reason: 'No persisted session was available for reuse.',
    };
  }

  const promptTerms = extractTerms(prompt);
  if (promptTerms.length === 0) {
    return {
      state: 'resume',
      shouldReuseContext: true,
      reason: 'A persisted session was found and no prompt terms were available for comparison.',
    };
  }

  const summaryTerms = extractTerms(collectSummaryStrings(summaryResult.summary).join(' '));
  const sharedTerms = promptTerms.filter((term) => summaryTerms.includes(term));
  const matchScore = promptTerms.length === 0
    ? 0
    : Number((sharedTerms.length / promptTerms.length).toFixed(2));

  if (sharedTerms.length >= 3 || matchScore >= 0.35) {
    return {
      state: 'aligned',
      shouldReuseContext: true,
      reason: 'Prompt terms align with persisted task context.',
    };
  }

  if (sharedTerms.length >= 1 || matchScore >= 0.15) {
    return {
      state: 'possible_shift',
      shouldReuseContext: true,
      reason: 'Prompt partially overlaps the persisted context; review before continuing.',
    };
  }

  return {
    state: 'context_mismatch',
    shouldReuseContext: false,
    reason: 'Prompt terms do not align with the persisted session summary.',
  };
};

const hasMeaningfulPrompt = (prompt) => {
  const normalized = normalizeWhitespace(prompt);
  return normalized.length >= 20 && extractTerms(normalized).length >= 4;
};

const buildSimpleTaskStartResult = ({ prompt, tokenBudget, verbosity = DEFAULT_VERBOSITY }) => {
  const normalizedTokenBudget = normalizeTokenBudget(tokenBudget);
  const recommendedPath = verbosity === 'minimal'
    ? {
        phase: 'start',
        mode: 'simple_task_skip',
        nextTools: ['smart_read', 'smart_search'],
        next: 'smart_read: Skip smart_turn for this simple task and use lightweight read/search directly.',
      }
    : {
        phase: 'start',
        mode: 'simple_task_skip',
        contextSource: 'direct_prompt',
        continuityState: 'simple_task_skip',
        ensureSessionRecommended: false,
        autoCreated: false,
        isolatedSession: false,
        nextTools: ['smart_read', 'smart_search'],
        nextActions: deriveStartActions({ prompt, mode: 'simple_task_skip', refreshedContext: null, summaryResult: null }),
        next: 'smart_read: Skip smart_turn for this simple task and use lightweight read/search directly.',
        instructions: 'smart_read: Skip smart_turn for this simple task and use lightweight read/search directly. | smart_search: Use only if the task grows beyond a single targeted read.',
      };

  return {
    phase: 'start',
    skipSmartTurn: true,
    continuity: {
      state: 'simple_task_skip',
      shouldReuseContext: false,
      reason: 'Simple task heuristic skipped persisted continuity setup to avoid overhead.',
    },
    ...(normalizedTokenBudget ? {
      taskBudget: normalizedTokenBudget,
      remainingBudget: peekRemainingBudget({ tokenBudget: normalizedTokenBudget }),
    } : {}),
    recommendedPath,
    message: 'Simple task heuristic skipped smart_turn(start); use lightweight read/search flow unless the task grows.',
  };
};

const buildAutoCreateUpdate = (prompt) => ({
  goal: truncate(prompt, 120),
  status: 'planning',
  currentFocus: truncate(prompt, 160),
  pinnedContext: [truncate(prompt, 160)],
  nextStep: 'Inspect relevant code, confirm the task boundaries, and checkpoint the first milestone.',
});

const summarizeRefreshedContext = (result, { indexRefreshed = false } = {}) => {
  if (!result?.success) {
    return null;
  }

  return {
    indexFreshness: result.indexFreshness ?? 'unavailable',
    indexRefreshed,
    graphCoverage: result.graphCoverage ?? result.confidence?.graphCoverage ?? null,
    hints: Array.isArray(result.hints) ? result.hints.slice(0, 2) : [],
    topFiles: Array.isArray(result.context)
      ? result.context.slice(0, REFRESHED_CONTEXT_FILE_LIMIT).map((item) => ({
          file: item.file,
          role: item.role,
          readMode: item.readMode ?? null,
          reasonIncluded: item.reasonIncluded ?? null,
          symbols: Array.isArray(item.symbols) ? item.symbols.slice(0, 3) : [],
        }))
      : [],
  };
};

const refreshPromptContext = async (prompt) => {
  if (!hasMeaningfulPrompt(prompt)) {
    return null;
  }

  const buildContext = async () => smartContext({
    task: prompt,
    detail: 'minimal',
    include: ['hints'],
    maxTokens: DEFAULT_REFRESH_CONTEXT_MAX_TOKENS,
  });

  let result = await buildContext();
  let indexRefreshed = false;

  if (INDEX_REFRESH_STATES.has(result?.indexFreshness ?? '')) {
    try {
      const { index } = buildIndexIncremental(projectRoot);
      await persistIndex(index, projectRoot);
      indexRefreshed = true;
      result = await buildContext();
    } catch {
      // best-effort refresh only
    }
  }

  return summarizeRefreshedContext(result, { indexRefreshed });
};

const shouldIsolateSession = ({ sessionId, ensureSession, prompt, continuity }) =>
  !sessionId
  && ensureSession
  && hasMeaningfulPrompt(prompt)
  && continuity
  && !SAFE_CONTINUITY_STATES.has(continuity.state ?? '');

const shouldRefreshContext = ({ prompt, ensureSession, summaryResult, continuity, isolatedSession, autoCreated }) =>
  hasMeaningfulPrompt(prompt)
  && (
    isolatedSession
    || autoCreated
    || (ensureSession && (summaryResult?.ambiguous || !summaryResult?.found))
    || ['possible_shift', 'context_mismatch'].includes(continuity?.state)
  );

const shouldIncludeSummaryInMinimal = ({ continuity, summaryResult, mutationSafety, autoCreated }) =>
  Boolean(mutationSafety?.blocked)
  || Boolean(summaryResult?.ambiguous)
  || Boolean(autoCreated)
  || ['possible_shift', 'context_mismatch'].includes(continuity?.state);

const shouldIncludeRefreshedContextInMinimal = ({ continuity, summaryResult, mutationSafety, refreshedContext }) =>
  Boolean(mutationSafety?.blocked)
  || Boolean(summaryResult?.ambiguous)
  || ['possible_shift', 'context_mismatch'].includes(continuity?.state)
  || Number(refreshedContext?.topFiles?.length ?? 0) > 0;

const compactSummaryForMinimal = (summary) => {
  if (!summary) return null;
  return {
    ...(summary.status ? { status: summary.status } : {}),
    ...(summary.goal ? { goal: summary.goal } : {}),
    ...(summary.currentFocus ? { currentFocus: summary.currentFocus } : {}),
    ...(summary.nextStep ? { nextStep: summary.nextStep } : {}),
  };
};

const buildStartRecommendedPath = ({
  prompt,
  ensureSession,
  summaryResult,
  continuity,
  refreshedContext,
  mutationSafety,
  autoCreated,
  isolatedSession,
  verbosity = DEFAULT_VERBOSITY,
}) => {
  const nextTools = [];
  const steps = [];

  if (mutationSafety?.blocked) {
    nextTools.push('repo_safety', 'smart_search', 'smart_read');
    steps.push(buildRecommendedStep(
      'repo_safety',
      'Pause persisted-write workflows, surface blockedBy, and follow recommendedActions before retrying checkpoints or workflow tracking.',
      'required',
    ));
    steps.push(buildRecommendedStep(
      'smart_search',
      'Continue with read-only exploration until repo safety is fixed.',
      'recommended',
    ));
  } else if (refreshedContext?.topFiles?.length) {
    nextTools.push('smart_read', 'smart_turn');
    steps.push(buildRecommendedStep(
      'smart_read',
      'Start from refreshedContext.topFiles with smart_read(outline|signatures|symbol) before any full reads.',
    ));
  } else if (hasMeaningfulPrompt(prompt)) {
    nextTools.push('smart_context', 'smart_read', 'smart_turn');
    steps.push(buildRecommendedStep(
      'smart_context',
      'Build focused multi-file context with smart_context(...) or smart_search(intent=...) before opening more files.',
    ));
    steps.push(buildRecommendedStep(
      'smart_read',
      'Use smart_read(outline|signatures|symbol) as the default follow-up read path.',
    ));
  } else {
    nextTools.push('smart_search', 'smart_read');
    steps.push(buildRecommendedStep(
      'smart_search',
      'Stay lightweight: only use devctx search/read if the task grows beyond a trivial lookup.',
    ));
  }

  if (summaryResult?.ambiguous && summaryResult?.recommendedSessionId) {
    nextTools.unshift('smart_turn');
    steps.unshift(buildRecommendedStep(
      'smart_turn',
      `Reuse or pass sessionId=${summaryResult.recommendedSessionId} if you want to resume the recommended persisted session explicitly.`,
      'required',
    ));
  }

  if (!mutationSafety?.blocked) {
    nextTools.push('smart_turn');
    steps.push(buildRecommendedStep(
      'smart_turn',
      'Checkpoint with smart_turn(end, event=milestone) after the first meaningful progress point.',
    ));
  }

  const mode = mutationSafety?.blocked
    ? 'blocked_guided'
    : refreshedContext
      ? 'guided_refresh'
      : hasMeaningfulPrompt(prompt)
        ? 'guided_context'
        : 'lightweight';
  const dedupedTools = [...new Set(nextTools)];
  const next = steps[0] ? `${steps[0].tool}: ${steps[0].instruction}` : (dedupedTools[0] ?? '');
  const nextActions = deriveStartActions({ prompt, mode, refreshedContext, summaryResult });

  if (verbosity === 'minimal') {
    return { phase: 'start', mode, nextTools: dedupedTools, nextActions, next };
  }

  return {
    phase: 'start',
    mode,
    contextSource: refreshedContext
      ? 'refreshed_context'
      : continuity?.shouldReuseContext
        ? 'persisted_summary'
        : 'direct_prompt',
    continuityState: continuity?.state ?? null,
    ensureSessionRecommended: Boolean(hasMeaningfulPrompt(prompt) && (ensureSession || !summaryResult?.found)),
    autoCreated,
    isolatedSession,
    nextTools: dedupedTools,
    nextActions,
    next,
    instructions: steps.map((s) => `${s.tool}: ${s.instruction}`).join(' | '),
  };
};

const buildEndRecommendedPath = ({ event, checkpoint, mutationSafety, workflow, verbosity = DEFAULT_VERBOSITY }) => {
  const nextTools = [];
  const steps = [];

  if (mutationSafety?.blocked) {
    nextTools.push('repo_safety', 'smart_search', 'smart_read');
    steps.push(buildRecommendedStep(
      'repo_safety',
      'Fix repo safety before expecting checkpoints, workflow tracking, or hook state writes to persist.',
      'required',
    ));
  } else if (checkpoint?.skipped) {
    nextTools.push('smart_turn');
    steps.push(buildRecommendedStep(
      'smart_turn',
      'No durable checkpoint was written; keep working and call smart_turn(end, event=milestone) once you have a concrete milestone or next step.',
      'required',
    ));
  } else {
    nextTools.push('smart_turn');
    steps.push(buildRecommendedStep(
      'smart_turn',
      'On the next substantial prompt, restart with smart_turn(start, prompt, ensureSession=true) to reuse this checkpoint cleanly.',
    ));
  }

  if (workflow?.ended) {
    nextTools.push('smart_turn');
    steps.push(buildRecommendedStep(
      'smart_turn',
      'This workflow is closed; start a fresh turn for the next substantial task boundary.',
    ));
  }

  const mode = mutationSafety?.blocked
    ? 'blocked_guided'
    : checkpoint?.skipped
      ? 'continue_until_milestone'
      : 'checkpointed';
  const dedupedTools = [...new Set(nextTools)];
  const next = steps[0] ? `${steps[0].tool}: ${steps[0].instruction}` : (dedupedTools[0] ?? '');
  const nextActions = deriveEndActions({ event, checkpoint, mutationSafety, workflow });

  if (verbosity === 'minimal') {
    return { phase: 'end', mode, nextTools: dedupedTools, nextActions, next };
  }

  return {
    phase: 'end',
    mode,
    checkpointEvent: event,
    nextTools: dedupedTools,
    nextActions,
    next,
    instructions: steps.map((s) => `${s.tool}: ${s.instruction}`).join(' | '),
  };
};

const persistSmartTurnQualityMetrics = async ({
  phase,
  sessionId,
  target,
  action,
  latencyMs,
  metadata,
}) => {
  await persistMetrics({
    tool: 'smart_turn',
    action,
    sessionId,
    target,
    rawTokens: 0,
    compressedTokens: 0,
    savedTokens: 0,
    savingsPct: 0,
    latencyMs,
    metadata: {
      analyticsKind: PRODUCT_QUALITY_ANALYTICS_KIND,
      phase,
      ...metadata,
    },
    timestamp: new Date().toISOString(),
  });
};

const startTurn = async ({
  sessionId,
  taskId,
  prompt,
  maxTokens = DEFAULT_START_MAX_TOKENS,
  tokenBudget,
  ensureSession = false,
  includeMetrics = false,
  metricsWindow = '7d',
  latestMetrics = 5,
  verbosity = DEFAULT_VERBOSITY,
} = {}) => {
  const startTime = Date.now();
  const normalizedTokenBudget = normalizeTokenBudget(tokenBudget);

  if (!sessionId && !taskId && isSimpleTask(prompt) && normalizeWhitespace(prompt).length <= SIMPLE_TASK_SKIP_MAX_LENGTH) {
    return buildSimpleTaskStartResult({ prompt, tokenBudget: normalizedTokenBudget, verbosity });
  }

  if (process.env.DEVCTX_DISABLE_BACKGROUND_TASKS !== 'true') {
    triggerBackgroundIndexBuild({ root: projectRoot }).catch(() => {});
    runStorageMaintenance().catch(() => {});
  }

  let summaryResult = await smartSummary({
    action: 'get',
    sessionId,
    taskId,
    maxTokens,
  });

  let autoCreated = false;
  let isolatedSession = false;
  let previousSessionId = null;
  if (!summaryResult.found && !summaryResult.ambiguous && ensureSession && hasMeaningfulPrompt(prompt)) {
    const created = await smartSummary({
      action: 'update',
      update: buildAutoCreateUpdate(prompt),
      maxTokens,
    });
    autoCreated = !created.blocked;
    if (autoCreated) {
      summaryResult = await smartSummary({
        action: 'get',
        sessionId: created.sessionId,
        taskId: created.task?.taskId ?? null,
        maxTokens,
      });
    }
  }

  let continuity = classifyContinuity({ prompt, summaryResult });

  if (summaryResult.found && shouldIsolateSession({ sessionId, ensureSession, prompt, continuity })) {
    const created = await smartSummary({
      action: 'update',
      update: buildAutoCreateUpdate(prompt),
      maxTokens,
    });

    if (!created.blocked) {
      isolatedSession = true;
      previousSessionId = summaryResult.sessionId ?? null;
      summaryResult = await smartSummary({
        action: 'get',
        sessionId: created.sessionId,
        taskId: created.task?.taskId ?? null,
        maxTokens,
      });
      continuity = classifyContinuity({ prompt, summaryResult });
    }
  }

  const effectiveSessionId = summaryResult.sessionId ?? sessionId ?? summaryResult.recommendedSessionId ?? null;
  const mutationSafety = buildMutationSafety(summaryResult.repoSafety);
  const workflowBlocked = Boolean(isWorkflowTrackingEnabled() && mutationSafety?.blocked);
  const refreshedContext = shouldRefreshContext({
    prompt,
    ensureSession,
    summaryResult,
    continuity,
    isolatedSession,
    autoCreated,
  })
    ? await refreshPromptContext(prompt)
    : null;

  let workflow = null;
  if (workflowBlocked) {
    workflow = { enabled: true, blocked: true, workflowId: null, workflowType: null, autoTracked: false };
  } else if (effectiveSessionId && isWorkflowTrackingEnabled()) {
    const workflowId = await autoTrackWorkflow(
      effectiveSessionId,
      summaryResult.summary?.goal ?? prompt ?? '',
    );
    if (workflowId) {
      const activeWorkflow = await getActiveWorkflowForSession(effectiveSessionId);
      workflow = activeWorkflow
        ? {
            enabled: true,
            workflowId: activeWorkflow.workflow_id,
            workflowType: activeWorkflow.workflow_type,
            autoTracked: true,
          }
        : {
            enabled: true,
            workflowId,
            workflowType: null,
            autoTracked: true,
          };
    } else {
      workflow = { enabled: true, workflowId: null, workflowType: null, autoTracked: false };
    }
  }

  const metrics = includeMetrics
    ? await smartMetrics({
        window: metricsWindow,
        latest: latestMetrics,
        sessionId: effectiveSessionId || 'active',
      })
    : null;

  const recommendedPath = buildStartRecommendedPath({
    prompt,
    ensureSession,
    summaryResult,
    continuity,
    refreshedContext,
    mutationSafety,
    autoCreated,
    isolatedSession,
    verbosity,
  });

  await persistSmartTurnQualityMetrics({
    phase: 'start',
    sessionId: effectiveSessionId ?? null,
    target: truncate(prompt, 120) || 'smart_turn:start',
    action: 'start',
    latencyMs: Date.now() - startTime,
    metadata: {
      continuityState: continuity?.state ?? null,
      shouldReuseContext: Boolean(continuity?.shouldReuseContext),
      sessionFound: Boolean(summaryResult.found),
      ambiguousResume: Boolean(summaryResult.ambiguous),
      autoCreated,
      isolatedSession,
      previousSessionId,
      mutationBlocked: Boolean(mutationSafety?.blocked),
      blockedBy: mutationSafety?.blockedBy ?? [],
      recommendedActionsCount: mutationSafety?.recommendedActions?.length ?? 0,
      refreshedContext: Boolean(refreshedContext),
      refreshedTopFiles: refreshedContext?.topFiles?.length ?? 0,
      indexRefreshed: Boolean(refreshedContext?.indexRefreshed),
      recommendedPathMode: recommendedPath.mode,
      nextToolsCount: recommendedPath.nextTools.length,
      workflowEnabled: Boolean(workflow?.enabled),
      workflowAutoTracked: Boolean(workflow?.autoTracked),
    },
  });

  const minimal = verbosity === 'minimal';
  const compactContinuity = minimal
    ? { state: continuity.state, shouldReuseContext: continuity.shouldReuseContext }
    : continuity;
  const compactTask = summaryResult.task && minimal
    ? { taskId: summaryResult.task.taskId, status: summaryResult.task.status }
    : summaryResult.task ?? null;
  const includeSummary = !minimal || shouldIncludeSummaryInMinimal({ continuity, summaryResult, mutationSafety, autoCreated });
  const includeRefreshedContext = !minimal || shouldIncludeRefreshedContextInMinimal({ continuity, summaryResult, mutationSafety, refreshedContext });
  const includeMessage = !minimal || mutationSafety?.blocked;

  return attachSafetyMetadata({
    phase: 'start',
    sessionId: effectiveSessionId,
    found: summaryResult.found ?? false,
    autoCreated,
    isolatedSession,
    ...(minimal ? {} : { promptPreview: truncate(prompt, MAX_PROMPT_PREVIEW) }),
    ...(previousSessionId ? { previousSessionId } : {}),
    continuity: compactContinuity,
    ...(includeSummary && summaryResult.summary ? { summary: minimal ? compactSummaryForMinimal(summaryResult.summary) : summaryResult.summary } : {}),
    ...(includeRefreshedContext && refreshedContext ? { refreshedContext } : {}),
    ...(workflow ? { workflow } : {}),
    ...(!minimal && summaryResult.candidates ? { candidates: summaryResult.candidates } : {}),
    ...(summaryResult.ambiguous && summaryResult.recommendedSessionId ? { recommendedSessionId: summaryResult.recommendedSessionId } : {}),
    ...(compactTask ? { task: compactTask } : {}),
    ...(summaryResult.handoff ? { handoff: summaryResult.handoff } : {}),
    ...(metrics ? { metrics: summarizeMetrics(metrics) } : {}),
    ...(isStorageUnhealthy(summaryResult.storageHealth ?? metrics?.storageHealth) ? { storageHealth: summaryResult.storageHealth ?? metrics?.storageHealth } : {}),
    recommendedPath,
    ...(includeMessage ? {
      message: mutationSafety?.blocked
        ? mutationSafety.message
        : summaryResult.found
          ? continuity.reason
          : autoCreated
            ? 'Created a new persisted session for this task prompt.'
            : continuity.reason,
    } : {}),
    ...(normalizedTokenBudget ? {
      taskBudget: normalizedTokenBudget,
      remainingBudget: peekRemainingBudget({ tokenBudget: normalizedTokenBudget }),
    } : {}),
  }, {
    repoSafety: summaryResult.repoSafety ?? metrics?.repoSafety ?? null,
    sideEffectsSuppressed: Boolean(summaryResult.sideEffectsSuppressed ?? metrics?.sideEffectsSuppressed),
    subject: 'Project-local context writes',
    degradedReason: 'repo_safety_blocked',
    degradedMode: 'read_only_snapshot',
    degradedImpact: 'Checkpoint and workflow side effects are paused while git hygiene is blocked.',
  });
};

const endTurn = async ({
  sessionId,
  taskId,
  event = DEFAULT_END_EVENT,
  update = {},
  force = false,
  maxTokens = DEFAULT_END_MAX_TOKENS,
  tokenBudget,
  includeMetrics = false,
  metricsWindow = '7d',
  latestMetrics = 5,
  verbosity = DEFAULT_VERBOSITY,
} = {}) => {
  const startTime = Date.now();
  const normalizedTokenBudget = normalizeTokenBudget(tokenBudget);
  const checkpoint = await smartSummary({
    action: 'checkpoint',
    sessionId,
    taskId,
    event,
    update,
    force,
    maxTokens,
  });

  const effectiveSessionId = checkpoint.sessionId ?? sessionId ?? 'active';
  const mutationSafety = buildMutationSafety(checkpoint.repoSafety);
  const workflowBlocked = Boolean(isWorkflowTrackingEnabled() && mutationSafety?.blocked);
  let workflow = null;
  if (workflowBlocked) {
    workflow = { enabled: true, blocked: true, workflowId: null, workflowType: null, ended: false };
  } else if (
    checkpoint.sessionId
    && !checkpoint.skipped
    && WORKFLOW_END_EVENTS.has(event)
    && isWorkflowTrackingEnabled()
  ) {
    const activeWorkflow = await getActiveWorkflowForSession(checkpoint.sessionId);
    if (activeWorkflow?.workflow_id) {
      const endedWorkflow = await endWorkflow(activeWorkflow.workflow_id);
      workflow = endedWorkflow
        ? {
            enabled: true,
            workflowId: endedWorkflow.workflowId,
            workflowType: endedWorkflow.workflowType,
            ended: true,
            summary: endedWorkflow,
          }
        : {
            enabled: true,
            workflowId: activeWorkflow.workflow_id,
            workflowType: activeWorkflow.workflow_type,
            ended: false,
          };
    } else {
      workflow = { enabled: true, workflowId: null, workflowType: null, ended: false };
    }
  }

  const metrics = includeMetrics
    ? await smartMetrics({
        window: metricsWindow,
        latest: latestMetrics,
        sessionId: effectiveSessionId,
      })
    : null;

  const recommendedPath = buildEndRecommendedPath({
    event,
    checkpoint,
    mutationSafety,
    workflow,
    verbosity,
  });

  await persistSmartTurnQualityMetrics({
    phase: 'end',
    sessionId: checkpoint.sessionId ?? sessionId ?? null,
    target: event,
    action: 'end',
    latencyMs: Date.now() - startTime,
    metadata: {
      event,
      checkpointSkipped: Boolean(checkpoint.skipped),
      checkpointPersisted: !checkpoint.skipped && !checkpoint.blocked,
      mutationBlocked: Boolean(mutationSafety?.blocked),
      blockedBy: mutationSafety?.blockedBy ?? [],
      recommendedActionsCount: mutationSafety?.recommendedActions?.length ?? 0,
      recommendedPathMode: recommendedPath.mode,
      workflowEnabled: Boolean(workflow?.enabled),
      workflowEnded: Boolean(workflow?.ended),
      checkpointScore: checkpoint.checkpoint?.score ?? null,
      checkpointThreshold: checkpoint.checkpoint?.threshold ?? null,
    },
  });

  const minimal = verbosity === 'minimal';
  const compactCheckpoint = minimal
    ? {
        skipped: Boolean(checkpoint.skipped),
        ...(checkpoint.blocked !== undefined ? { blocked: checkpoint.blocked } : {}),
        ...(checkpoint.checkpoint ? {
          checkpoint: {
            event: checkpoint.checkpoint.event,
            shouldPersist: checkpoint.checkpoint.shouldPersist,
            score: checkpoint.checkpoint.score,
            threshold: checkpoint.checkpoint.threshold,
          },
        } : {}),
      }
    : checkpoint;
  const includeMessage = !minimal || mutationSafety?.blocked;

  return attachSafetyMetadata({
    phase: 'end',
    sessionId: checkpoint.sessionId ?? sessionId ?? null,
    checkpoint: compactCheckpoint,
    ...(workflow ? { workflow } : {}),
    ...(metrics ? { metrics: summarizeMetrics(metrics) } : {}),
    ...(isStorageUnhealthy(checkpoint.storageHealth ?? metrics?.storageHealth) ? { storageHealth: checkpoint.storageHealth ?? metrics?.storageHealth } : {}),
    ...(normalizedTokenBudget ? {
      taskBudget: normalizedTokenBudget,
      remainingBudget: peekRemainingBudget({ tokenBudget: normalizedTokenBudget }),
    } : {}),
    recommendedPath,
    ...(includeMessage ? { message: mutationSafety?.blocked ? mutationSafety.message : checkpoint.message } : {}),
  }, {
    repoSafety: checkpoint.repoSafety ?? metrics?.repoSafety ?? null,
    sideEffectsSuppressed: Boolean(checkpoint.sideEffectsSuppressed ?? metrics?.sideEffectsSuppressed),
    subject: 'Project-local context writes',
    degradedReason: 'repo_safety_blocked',
    degradedMode: 'read_only_snapshot',
    degradedImpact: 'Checkpoint and workflow side effects are paused while git hygiene is blocked.',
  });
};

export const smartTurn = async ({
  phase,
  sessionId,
  taskId,
  prompt,
  update,
  event,
  force,
  maxTokens,
  tokenBudget,
  ensureSession = false,
  includeMetrics = false,
  metricsWindow = '7d',
  latestMetrics = 5,
  verbosity,
} = {}) => {
  const resolvedVerbosity = normalizeVerbosity(verbosity);

  if (phase === 'start') {
    return startTurn({
      sessionId,
      taskId,
      prompt,
      maxTokens,
      tokenBudget,
      ensureSession,
      includeMetrics,
      metricsWindow,
      latestMetrics,
      verbosity: resolvedVerbosity,
    });
  }

  if (phase === 'end') {
    return endTurn({
      sessionId,
      taskId,
      event,
      update,
      force,
      maxTokens,
      tokenBudget,
      includeMetrics,
      metricsWindow,
      latestMetrics,
      verbosity: resolvedVerbosity,
    });
  }

  throw new Error('Invalid phase. Valid phases: start, end');
};
