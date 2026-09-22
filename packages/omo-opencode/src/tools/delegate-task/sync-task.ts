import { handedBackSyncSessions, subagentSessions } from "../../features/claude-code-session-state"
import type { SessionRetentionCheckpoint } from "../../features/background-agent/session-retention"
import { getTaskToastManager } from "../../features/task-toast-manager"
import type { ModelFallbackInfo } from "../../features/task-toast-manager/types"
import type { FallbackEntry } from "../../shared/model-requirements"
import { log } from "../../shared/logger"
import {
  acquireSyncSessionLease,
  recordSyncSessionRetentionCheckpoint,
  scheduleSyncSessionDeletion,
} from "./sync-session-cleanup"
import { formatDetailedError } from "./error-formatting"
import type { ExecutorContext, ParentContext } from "./executor-types"
import { reserveSyncSubagentSpawn } from "./sync-spawn-reservation"
import { type SyncTaskDeps, syncTaskDeps } from "./sync-task-deps"
import { publishSyncTaskMetadata } from "./sync-task-metadata"
import { runSyncTaskLoop } from "./sync-task-runner"
import { cleanupSyncSessionSideEffects, registerSyncSessionSideEffects } from "./sync-session-lifecycle"
import type { DelegatedModelConfig, DelegateTaskArgs, ToolContextWithMetadata } from "./types"

export async function executeSyncTask(
  args: DelegateTaskArgs,
  ctx: ToolContextWithMetadata,
  executorCtx: ExecutorContext,
  parentContext: ParentContext,
  agentToUse: string,
  categoryModel: DelegatedModelConfig | undefined,
  systemContent: string | undefined,
  modelInfo?: ModelFallbackInfo,
  fallbackChain?: FallbackEntry[],
  deps: SyncTaskDeps = syncTaskDeps
): Promise<string> {
  const { client, directory, syncPollTimeoutMs } = executorCtx
  const toastManager = getTaskToastManager()
  let taskId: string | undefined
  let syncSessionID: string | undefined
  let retentionDirectory = directory
  let returnedResult = false
  let terminalStatus: SessionRetentionCheckpoint["terminalStatus"] = "error"
  const retentionCheckpoints = new Map<string, SessionRetentionCheckpoint>()
  const releaseSessionLeases = new Map<string, () => void>()
  let spawnReservation:
    | Awaited<ReturnType<ExecutorContext["manager"]["reserveSubagentSpawn"]>>
    | undefined
  let concurrencyAcquired = false
  const concurrencyModel = categoryModel && typeof categoryModel.providerID === "string" && typeof categoryModel.modelID === "string"
    ? `${categoryModel.providerID}/${categoryModel.modelID}`
    : typeof agentToUse === "string" ? agentToUse : "default"
  const manager = executorCtx?.manager

  try {
    if (!subagentSessions.has(parentContext.sessionID) && typeof manager?.acquireSyncSubagentConcurrency === "function") {
      await manager.acquireSyncSubagentConcurrency(concurrencyModel)
      concurrencyAcquired = true
    }
    const spawn = await reserveSyncSubagentSpawn(executorCtx, parentContext)
    spawnReservation = spawn.reservation
    const { spawnContext } = spawn

    const createSessionResult = await deps.createSyncSession(client, {
      parentSessionID: parentContext.sessionID,
      agentToUse,
      description: args.description,
      defaultDirectory: directory,
      categoryModel,
    })

    if (!createSessionResult.ok) {
      spawnReservation?.rollback()
      return createSessionResult.error
    }

    const sessionID = createSessionResult.sessionID
    spawnReservation?.commit()
    syncSessionID = sessionID
    retentionDirectory = createSessionResult.parentDirectory
    taskId = `sync_${sessionID.slice(0, 8)}`

    const registerSyncSession = async (
      newSessionID: string,
      currentModel: DelegatedModelConfig | undefined,
    ): Promise<void> => {
      syncSessionID = newSessionID
      releaseSessionLeases.set(newSessionID, acquireSyncSessionLease(newSessionID))
      const checkpoint: SessionRetentionCheckpoint = {
        version: 1,
        mode: "sync",
        sessionID: newSessionID,
        taskID: taskId,
        parentSessionID: parentContext.sessionID,
        parentMessageID: parentContext.messageID,
        agent: agentToUse,
        ...(currentModel === undefined ? {} : { model: currentModel }),
        ...(args.category === undefined ? {} : { category: args.category }),
        autoDelete: executorCtx.autoDeleteSubagentSessions ?? true,
      }
      retentionCheckpoints.set(newSessionID, checkpoint)
      await registerSyncSessionSideEffects({
        args,
        executorCtx,
        sessionID: newSessionID,
        parentContext,
        agentToUse,
        categoryModel: currentModel,
        fallbackChain,
        systemContent,
      })
    }

    const persistSyncSessionRetentionCheckpoint = async (currentSessionID: string): Promise<void> => {
      const checkpoint = retentionCheckpoints.get(currentSessionID)
      if (checkpoint) {
        await recordSyncSessionRetentionCheckpoint(client, checkpoint, retentionDirectory)
      }
    }

    const publishSyncMetadata = async (
      currentSessionID: string,
      currentModel: DelegatedModelConfig | undefined,
      spawnDepth: number,
    ): Promise<void> => {
      await publishSyncTaskMetadata({
        args,
        ctx,
        currentSessionID,
        currentModel,
        parentContext,
        agentToUse,
        spawnDepth,
      })
    }

    await registerSyncSession(sessionID, categoryModel)

    const startTime = new Date()

    if (toastManager) {
      toastManager.addTask({
        id: taskId,
        sessionID,
        description: args.description,
        agent: agentToUse,
        isBackground: false,
        category: args.category,
        skills: args.load_skills,
        modelInfo,
      })
    }
    await publishSyncMetadata(sessionID, categoryModel, spawnContext.childDepth)

    const setSyncSessionID = (currentSessionID: string): void => {
      syncSessionID = currentSessionID
    }

    const cleanupRetrySession = async (currentSessionID: string): Promise<void> => {
      cleanupSyncSessionSideEffects(currentSessionID, executorCtx)
      const checkpoint = retentionCheckpoints.get(currentSessionID)
      if (checkpoint) {
        const terminalCheckpoint: SessionRetentionCheckpoint = {
          ...checkpoint,
          terminalStatus: "error",
          terminalAt: Date.now(),
        }
        retentionCheckpoints.set(currentSessionID, terminalCheckpoint)
        await recordSyncSessionRetentionCheckpoint(client, terminalCheckpoint, retentionDirectory)
      }
      releaseSessionLeases.get(currentSessionID)?.()
      releaseSessionLeases.delete(currentSessionID)
    }

    try {
      const result = await runSyncTaskLoop({
        args,
        ctx,
        executorCtx: {
          ...executorCtx,
          directory: createSessionResult.parentDirectory,
        },
        parentContext,
        agentToUse,
        categoryModel,
        fallbackChain,
        deps,
        sessionID,
        spawnDepth: spawnContext.childDepth,
        taskId,
        startTime,
        syncPollTimeoutMs,
        systemContent,
        toastManager: toastManager ?? undefined,
        modelInfo,
        registerSyncSession,
        publishSyncMetadata,
        cleanupRetrySession,
        persistSyncSessionRetentionCheckpoint,
        setSyncSessionID,
      })
      terminalStatus = "completed"
      returnedResult = true
      return result
    } finally {
      if (toastManager && taskId !== undefined) {
        toastManager.removeTask(taskId)
      }
    }
  } catch (error) {
    spawnReservation?.rollback()
    const errorToFormat = error instanceof Error ? error : String(error)
    terminalStatus = "error"
    returnedResult = true
    return formatDetailedError(errorToFormat, {
      operation: "Execute task",
      args,
      sessionID: syncSessionID,
      agent: agentToUse,
      category: args.category,
    })
  } finally {
    const terminalAt = Date.now()
    for (const [sessionID, checkpoint] of retentionCheckpoints) {
      const terminalCheckpoint: SessionRetentionCheckpoint = {
        ...checkpoint,
        terminalStatus: checkpoint.terminalStatus ?? (sessionID === syncSessionID ? terminalStatus : "error"),
        terminalAt: checkpoint.terminalAt ?? terminalAt,
        ...(returnedResult
          ? { handoffConfirmedAt: checkpoint.handoffConfirmedAt ?? terminalAt }
          : {}),
      }
      retentionCheckpoints.set(sessionID, terminalCheckpoint)
      await recordSyncSessionRetentionCheckpoint(client, terminalCheckpoint, retentionDirectory)
      releaseSessionLeases.get(sessionID)?.()
      releaseSessionLeases.delete(sessionID)
      scheduleSyncSessionDeletion(client, sessionID, retentionDirectory)
    }
    if (syncSessionID) {
      cleanupSyncSessionSideEffects(syncSessionID, executorCtx)
      handedBackSyncSessions.add(syncSessionID)

      // Prevent todo-continuation-enforcer from re-awakening a completed sync subagent.
      // When a sync subagent finishes, its session may still exist and have incomplete
      // todos; without an explicit abort, the continuation hook sees session.idle and
      // injects a continuation prompt, causing the subagent to resume after the parent
      // has already moved on. This creates a race where two agents work concurrently.
      // Aborting an already-idle session emits no error event (opencode re-publishes
      // session.idle), so handedBackSyncSessions is the signal the enforcer keys on;
      // the abort still cancels the child's opencode-side background jobs.
      if (typeof client?.session?.abort === "function") {
        void client.session.abort({ path: { id: syncSessionID } }).catch((error: unknown) => {
          log(`[task] Failed to abort completed sync session:`, error)
        })
      }
    }
    if (concurrencyAcquired && typeof manager?.releaseSyncSubagentConcurrency === "function") {
      manager.releaseSyncSubagentConcurrency(concurrencyModel)
    }
  }
}
