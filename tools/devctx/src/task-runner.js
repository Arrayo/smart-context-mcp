import { setTimeout as delay } from 'node:timers/promises';
import { persistMetrics } from './metrics.js';
import { countTokens } from './tokenCounter.js';
import { projectRoot } from './utils/paths.js';
import { TASK_RUNNER_QUALITY_ANALYTICS_KIND } from './analytics/product-quality.js';
import { DEFAULT_END_MAX_TOKENS, DEFAULT_START_MAX_TOKENS, resolveManagedStart } from './orchestration/base-orchestrator.js';
import { runHeadlessWrapper } from './orchestration/headless-wrapper.js';
import { smartDoctor } from './tools/smart-doctor.js';
import {
  buildPreflightSummary,
  buildTaskRunnerAutomaticity,
  buildWorkflowPolicyPayload,
  buildWorkflowPromptWithPolicy,
  runWorkflowPreflight,
} from './orchestration/policy/event-policy.js';
import { smartStatus } from './tools/smart-status.js';
import { smartSummary } from './tools/smart-summary.js';
import { smartTurn } from './tools/smart-turn.js';
import {
  RUNNER_COMMANDS,
  SPECIALIZED_WORKFLOW_COMMANDS,
  WORKFLOW_COMMANDS,
  WORKFLOW_DEFINITIONS,
  buildCleanupPlan,
  buildWorkflowPolicyProfile,
  buildRunnerBlockedResult,
  buildWorkflowPrompt,
  evaluateRunnerGate,
} from './task-runner/policy.js';
import { detectClient } from './utils/client-detection.js';

const RUNNER_LOCK_RETRY_ATTEMPTS = 3;
const RUNNER_LOCK_RETRY_DELAY_MS = 100;

const isRetriableLockError = (error) => {
  const issue = error?.storageHealth?.issue ?? error?.cause?.storageHealth?.issue ?? null;
  const retriable = error?.storageHealth?.retriable ?? error?.cause?.storageHealth?.retriable ?? false;
  const message = String(error?.message ?? error?.cause?.message ?? error ?? '');
  return retriable || issue === 'locked' || /database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(message);
};

const withRunnerLockRetry = async (operation) => {
  for (let attempt = 1; attempt <= RUNNER_LOCK_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetriableLockError(error) || attempt === RUNNER_LOCK_RETRY_ATTEMPTS) {
        throw error;
      }

      await delay(RUNNER_LOCK_RETRY_DELAY_MS * attempt);
    }
  }

  throw new Error('Task runner lock retry exhausted unexpectedly.');
};

const recordRunnerMetrics = async ({
  commandName,
  client,
  result,
  usedWrapper = false,
  blocked = false,
  doctorIssued = false,
  fastPath = false,
}) => {
  const startResult = result?.start ?? result?.startResult ?? null;
  const endResult = result?.end ?? (result?.phase === 'end' ? result : null);
  const workflowPolicy = result?.workflowPolicy ?? null;
  const preflight = workflowPolicy?.preflight ?? null;
  const mutationBlocked = Boolean(result?.mutationSafety?.blocked ?? startResult?.mutationSafety?.blocked ?? endResult?.mutationSafety?.blocked);
  const storageIssue = result?.storageHealth?.issue ?? startResult?.storageHealth?.issue ?? endResult?.storageHealth?.issue ?? 'ok';
  const recommendedPathMode = result?.recommendedPath?.mode
    ?? startResult?.recommendedPath?.mode
    ?? endResult?.recommendedPath?.mode
    ?? null;
  const checkpointPersisted = Boolean(endResult && !endResult.checkpoint?.skipped && !endResult.checkpoint?.blocked);
  const checkpointSkipped = Boolean(endResult?.checkpoint?.skipped);
  const automaticity = buildTaskRunnerAutomaticity({
    isWorkflowCommand: WORKFLOW_COMMANDS.has(commandName),
    startResult,
    endResult,
    workflowPolicy,
    usedWrapper,
    overheadTokens: Number(result?.overheadTokens ?? 0),
    managedByBaseOrchestrator: WORKFLOW_COMMANDS.has(commandName),
    fastPath,
  });

  await persistMetrics({
    tool: 'task_runner',
    action: commandName,
    sessionId: result?.sessionId ?? result?.start?.sessionId ?? null,
    rawTokens: 0,
    compressedTokens: countTokens(JSON.stringify(result ?? {})),
    savedTokens: 0,
    savingsPct: 0,
    metadata: {
      analyticsKind: TASK_RUNNER_QUALITY_ANALYTICS_KIND,
      client,
      usedWrapper,
      blocked,
      doctorIssued,
      dryRun: Boolean(result?.dryRun),
      allowDegraded: Boolean(result?.allowDegraded),
      isWorkflowCommand: WORKFLOW_COMMANDS.has(commandName),
      specializedWorkflow: SPECIALIZED_WORKFLOW_COMMANDS.has(commandName),
      workflowIntent: workflowPolicy?.intent ?? null,
      workflowPolicyMode: workflowPolicy?.policyMode ?? null,
      workflowNextToolsCount: workflowPolicy?.nextTools?.length ?? 0,
      workflowHasCheckpointRule: Boolean(workflowPolicy?.checkpointStrategy),
      workflowPreflightTool: preflight?.tool ?? null,
      workflowPreflightTopFiles: preflight?.topFiles?.length ?? 0,
      workflowPreflightHints: preflight?.hints?.length ?? 0,
      continuityState: startResult?.continuity?.state ?? null,
      mutationBlocked,
      storageIssue,
      recommendedPathMode,
      checkpointPersisted,
      checkpointSkipped,
      ...automaticity,
    },
    timestamp: new Date().toISOString(),
  });
};

const runWorkflowCommand = async ({
  commandName,
  client,
  prompt,
  sessionId,
  tokenBudget,
  event,
  stdinPrompt = false,
  dryRun = false,
  streamOutput = false,
  command = '',
  args = [],
  runCommand,
  allowDegraded = false,
}) => {
  const requestedPrompt = buildWorkflowPrompt({
    commandName,
    prompt,
  });
  const workflowProfile = buildWorkflowPolicyProfile({ commandName });

  const startResolution = await withRunnerLockRetry(() => resolveManagedStart({
    prompt: requestedPrompt,
    sessionId,
    tokenBudget,
    ensureSession: true,
    allowIsolation: false,
    startMaxTokens: DEFAULT_START_MAX_TOKENS,
    enableFastPath: true,
  }));
  const start = startResolution.startResult;
  const fastPath = startResolution.fastPath ?? false;

  const gate = evaluateRunnerGate({ startResult: start });
  let preflightSummary = null;

  if (!gate.requiresDoctor || allowDegraded) {
    const preflightResult = await runWorkflowPreflight({
      workflowProfile,
      prompt: requestedPrompt,
      startResult: start,
      skipPreflight: fastPath,
    });
    preflightSummary = buildPreflightSummary(preflightResult);
  }

  const workflowPolicy = buildWorkflowPolicyPayload({
    commandName,
    workflowProfile,
    preflightSummary,
  });
  const effectivePrompt = buildWorkflowPromptWithPolicy({
    prompt: requestedPrompt,
    workflowProfile,
    preflightSummary,
    startResult: start,
  });

  if (gate.requiresDoctor && !allowDegraded) {
    const doctor = await withRunnerLockRetry(() => smartDoctor());
    const blockedResult = buildRunnerBlockedResult({
      commandName,
      client,
      prompt: effectivePrompt,
      startResult: start,
      gate,
      doctorResult: doctor,
      allowDegraded,
      workflowPolicy,
    });
    await recordRunnerMetrics({
      commandName,
      client,
      result: blockedResult,
      usedWrapper: false,
      blocked: true,
      doctorIssued: true,
      fastPath,
    });
    return blockedResult;
  }

  const wrapperResult = await runHeadlessWrapper({
    client,
    prompt: effectivePrompt,
    command,
    args,
    sessionId: start.sessionId ?? sessionId,
    event: event ?? WORKFLOW_DEFINITIONS[commandName]?.defaultEvent,
    stdinPrompt,
    dryRun,
    streamOutput,
    runCommand,
    preparedStartResult: start,
  });

  const result = {
    success: true,
    usedWrapper: true,
    ...wrapperResult,
    command: commandName,
    client,
    prompt: effectivePrompt,
    requestedPrompt,
    gate,
    workflowPolicy,
  };

  await recordRunnerMetrics({
    commandName,
    client,
    result,
    usedWrapper: true,
    blocked: false,
    doctorIssued: false,
    fastPath,
  });
  return result;
};

const runDoctorCommand = async ({ verifyIntegrity = true, client }) => {
  const result = await withRunnerLockRetry(() => smartDoctor({ verifyIntegrity }));
  await recordRunnerMetrics({
    commandName: 'doctor',
    client,
    result,
    usedWrapper: false,
    blocked: result.overall === 'error',
    doctorIssued: true,
  });
  return result;
};

const runStatusCommand = async ({ format = 'compact', maxItems = 10, client }) => {
  const result = await withRunnerLockRetry(() => smartStatus({ format, maxItems }));
  await recordRunnerMetrics({
    commandName: 'status',
    client,
    result,
  });
  return result;
};

const runCheckpointCommand = async ({
  client,
  sessionId,
  event = 'milestone',
  update = {},
}) => {
  const result = await withRunnerLockRetry(() => smartTurn({
    phase: 'end',
    sessionId,
    event,
    update,
    maxTokens: DEFAULT_END_MAX_TOKENS,
  }));
  await recordRunnerMetrics({
    commandName: 'checkpoint',
    client,
    result,
  });
  return result;
};

const runCleanupCommand = async ({
  client,
  cleanupMode = 'compact',
  apply = false,
  retentionDays = 30,
  keepLatestEventsPerSession = 20,
  keepLatestMetrics = 1000,
  vacuum = false,
}) => {
  const plan = buildCleanupPlan({
    mode: cleanupMode,
    apply,
    retentionDays,
    keepLatestEventsPerSession,
    keepLatestMetrics,
    vacuum,
  });

  if (cleanupMode === 'legacy') {
    const dryRun = await smartSummary({
      action: 'cleanup_legacy',
      apply: false,
    });

    if (!apply) {
      const eligibleFiles = [];

      if (dryRun.sessions?.candidates) {
        for (const session of dryRun.sessions.candidates) {
          if (session.deletable) {
            eligibleFiles.push({
              relativePath: session.relativePath || session.path,
              sizeBytes: session.sizeBytes || 0,
            });
          }
        }
      }

      if (dryRun.metrics?.eligible && dryRun.metrics?.path) {
        eligibleFiles.push({
          relativePath: dryRun.metrics.path.replace(projectRoot + '/', ''),
          sizeBytes: dryRun.metrics.sizeBytes || 0,
        });
      }

      if (dryRun.activeSession?.eligible && dryRun.activeSession?.path) {
        eligibleFiles.push({
          relativePath: dryRun.activeSession.path.replace(projectRoot + '/', ''),
          sizeBytes: dryRun.activeSession.sizeBytes || 0,
        });
      }

      if (eligibleFiles.length > 0) {
        console.log('\n📋 Legacy files eligible for cleanup:\n');
        console.log('File                                      Size');
        console.log('─'.repeat(60));
        for (const file of eligibleFiles) {
          const sizeKB = file.sizeBytes ? `${(file.sizeBytes / 1024).toFixed(1)}KB` : 'N/A';
          console.log(`${file.relativePath.padEnd(42)} ${sizeKB}`);
        }
        const totalKB = eligibleFiles.reduce((sum, f) => sum + (f.sizeBytes || 0), 0) / 1024;
        console.log('─'.repeat(60));
        console.log(`Total: ${eligibleFiles.length} files, ${totalKB.toFixed(1)}KB\n`);
        console.log('💡 To apply cleanup, run: smart-context-task cleanup --cleanup-mode legacy --apply\n');
      } else {
        console.log('\n✅ No legacy files eligible for cleanup.\n');
      }
    }

    const result = apply ? await smartSummary({ action: 'cleanup_legacy', apply: true }) : dryRun;
    const payload = {
      command: 'cleanup',
      cleanupMode,
      plan,
      result,
    };
    await recordRunnerMetrics({
      commandName: 'cleanup',
      client,
      result: payload,
    });
    return payload;
  }

  if (cleanupMode === 'all') {
    const compact = await smartSummary({
      action: 'compact',
      retentionDays,
      keepLatestEventsPerSession,
      keepLatestMetrics,
      vacuum,
    });
    const legacy = await smartSummary({
      action: 'cleanup_legacy',
      apply,
    });
    const payload = {
      command: 'cleanup',
      cleanupMode,
      plan,
      result: {
        compact,
        legacy,
      },
    };
    await recordRunnerMetrics({
      commandName: 'cleanup',
      client,
      result: payload,
    });
    return payload;
  }

  const result = await smartSummary({
    action: 'compact',
    retentionDays,
    keepLatestEventsPerSession,
    keepLatestMetrics,
    vacuum,
  });
  const payload = {
    command: 'cleanup',
    cleanupMode,
    plan,
    result,
  };
  await recordRunnerMetrics({
    commandName: 'cleanup',
    client,
    result: payload,
  });
  return payload;
};

export const runTaskRunner = async ({
  commandName = 'task',
  client = null,
  prompt = '',
  sessionId,
  tokenBudget,
  event,
  stdinPrompt = false,
  dryRun = false,
  streamOutput = false,
  command = '',
  args = [],
  runCommand,
  allowDegraded = false,
  verifyIntegrity = true,
  format = 'compact',
  maxItems = 10,
  cleanupMode = 'compact',
  apply = false,
  retentionDays = 30,
  keepLatestEventsPerSession = 20,
  keepLatestMetrics = 1000,
  vacuum = false,
  update = {},
} = {}) => {
  const resolvedClient = client ?? detectClient();

  if (!RUNNER_COMMANDS.includes(commandName)) {
    throw new Error(`Unsupported task-runner command: ${commandName}`);
  }

  if (WORKFLOW_COMMANDS.has(commandName)) {
    return runWorkflowCommand({
      commandName,
      client: resolvedClient,
      prompt,
      sessionId,
      tokenBudget,
      event,
      stdinPrompt,
      dryRun,
      streamOutput,
      command,
      args,
      runCommand,
      allowDegraded,
    });
  }

  if (commandName === 'doctor') {
    return runDoctorCommand({ verifyIntegrity, client: resolvedClient });
  }

  if (commandName === 'status') {
    return runStatusCommand({ format, maxItems, client: resolvedClient });
  }

  if (commandName === 'checkpoint') {
    return runCheckpointCommand({
      client: resolvedClient,
      sessionId,
      event,
      update,
    });
  }

  if (commandName === 'cleanup') {
    return runCleanupCommand({
      client: resolvedClient,
      cleanupMode,
      apply,
      retentionDays,
      keepLatestEventsPerSession,
      keepLatestMetrics,
      vacuum,
    });
  }

  throw new Error(`Command not implemented: ${commandName}`);
};
