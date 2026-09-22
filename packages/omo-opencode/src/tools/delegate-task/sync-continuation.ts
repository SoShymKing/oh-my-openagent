import { isRecord } from "@oh-my-opencode/utils"
import type { DelegateTaskArgs, ToolContextWithMetadata } from "./types"
import type { ExecutorContext, ParentContext, SessionMessage } from "./executor-types"
import { getDeliverableTag, isPlanFamily } from "./constants"
import { handedBackSyncSessions } from "../../features/claude-code-session-state"
import {
  parseSessionRetentionCheckpoint,
  SESSION_RETENTION_METADATA_KEY,
  type SessionRetentionCheckpoint,
} from "../../features/background-agent/session-retention"
import { publishToolMetadata } from "../../features/tool-metadata-store"
import { getTaskToastManager } from "../../features/task-toast-manager"
import { getAgentToolRestrictions } from "../../shared/agent-tool-restrictions"
import { getMessageDir, normalizeSDKResponse } from "../../shared"
import { promptWithModelSuggestionRetry } from "../../shared/model-suggestion-retry"
import { releasePromptAsyncReservation } from "../../shared/prompt-async-gate"
import { resolveMessageContext } from "../../features/hook-message-injector"
import { formatDuration } from "./time-formatter"
import { syncContinuationDeps, type SyncContinuationDeps } from "./sync-continuation-deps"
import { setSessionTools } from "../../shared/session-tools-store"
import { buildTaskPrompt } from "./prompt-builder"
import { buildTaskMetadataBlock } from "../../features/tool-metadata-store/task-metadata-contract"
import { getTaskID } from "./task-id"
import { resolveMetadataModel } from "./resolve-metadata-model"
import { log } from "../../shared/logger"
import {
  acquireSyncSessionLease,
  recordSyncSessionRetentionCheckpoint,
  scheduleSyncSessionDeletion,
} from "./sync-session-cleanup"
import { getSessionNotFoundError, isSessionNotFoundPollError } from "./session-not-found-error"

type ResumeModel = { providerID: string; modelID: string }

type ResumeContext = {
  resumeAgent?: string
  resumeModel?: ResumeModel
  resumeVariant?: string
  anchorMessageCount?: number
  anchorMessageID?: string
  retentionCheckpoint?: SessionRetentionCheckpoint
}

function shouldAttemptPollErrorRecovery(pollError: string): boolean {
  const trimmed = pollError.trim()

  if (trimmed.length === 0) {
    return false
  }

  if (/\bMessageAbortedError\b/u.test(trimmed)) {
    return true
  }

  if (/\bDOMException\b/u.test(trimmed) && /\bAbortError\b/u.test(trimmed)) {
    return true
  }

  if (/\bAbortError\b/u.test(trimmed) && !/\bTask aborted\b/u.test(trimmed)) {
    return true
  }

  if (/^the operation was aborted\.?$/iu.test(trimmed)) {
    return true
  }

  return false
}

async function resolveResumeContext(
  client: ExecutorContext["client"],
  continuationID: string
): Promise<ResumeContext> {
  let messagesResp: unknown
  try {
    messagesResp = await client.session.messages({ path: { id: continuationID } })
  } catch (error) {
    const missingSession = getSessionNotFoundError(error, continuationID)
    if (missingSession) throw missingSession
    if (!(error instanceof Error)) throw error
    const resumeMessageDir = getMessageDir(continuationID)
    const { prevMessage } = await resolveMessageContext(continuationID, client, resumeMessageDir)
    const resumeMessageModel = prevMessage?.model

    return {
      resumeAgent: prevMessage?.agent,
      resumeModel: resumeMessageModel?.providerID && resumeMessageModel.modelID
        ? { providerID: resumeMessageModel.providerID, modelID: resumeMessageModel.modelID }
        : undefined,
      resumeVariant: resumeMessageModel?.variant,
    }
  }
  const missingSession = getSessionNotFoundError(messagesResp, continuationID)
  if (missingSession) throw missingSession
  if (isRecord(messagesResp) && messagesResp.error != null) throw messagesResp.error
  const messages = normalizeSDKResponse(messagesResp, [] as SessionMessage[])
  let retentionCheckpoint: SessionRetentionCheckpoint | undefined
  for (let index = messages.length - 1; index >= 0 && retentionCheckpoint === undefined; index--) {
    const parts = messages[index].parts ?? []
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
      const metadata = parts[partIndex].metadata
      if (!metadata || !Object.hasOwn(metadata, SESSION_RETENTION_METADATA_KEY)) continue
      retentionCheckpoint = parseSessionRetentionCheckpoint(metadata[SESSION_RETENTION_METADATA_KEY])
      break
    }
  }

  for (let index = messages.length - 1; index >= 0; index--) {
    const info = messages[index].info
    if (info?.agent || info?.model || (info?.modelID && info?.providerID)) {
      return {
        resumeAgent: info.agent,
        resumeModel: info.model ?? (info.providerID && info.modelID
          ? { providerID: info.providerID, modelID: info.modelID }
          : undefined),
        resumeVariant: info.variant,
        anchorMessageCount: messages.length,
        anchorMessageID: messages.at(-1)?.info?.id,
        retentionCheckpoint,
      }
    }
  }

  return {
    anchorMessageCount: messages.length,
    anchorMessageID: messages.at(-1)?.info?.id,
    retentionCheckpoint,
  }
}

export async function executeSyncContinuation(
  args: DelegateTaskArgs,
  ctx: ToolContextWithMetadata,
  executorCtx: ExecutorContext,
  parentContext: ParentContext,
  deps: SyncContinuationDeps = syncContinuationDeps,
  systemContent?: string
): Promise<string> {
  const { client, syncPollTimeoutMs, sisyphusAgentConfig } = executorCtx
  const toastManager = getTaskToastManager()
  const continuationID = getTaskID(args)
  if (!continuationID) {
    throw new Error("task_id is required to continue a sync task")
  }
  const releaseRetentionLease = acquireSyncSessionLease(continuationID)
  const detachFromManager = executorCtx.manager?.attachSyncContinuation?.(continuationID)
  const taskId = `resume_sync_${continuationID.slice(0, 8)}`
  const startTime = new Date()

  if (toastManager) {
    toastManager.addTask({
      id: taskId,
      description: args.description,
      agent: "continue",
      isBackground: false,
    })
  }

  let resumeAgent: string | undefined
  let resumeModel: ResumeModel | undefined
  let resumeVariant: string | undefined
  let anchorMessageCount: number | undefined
  let anchorMessageID: string | undefined
  let handedBackToParent = false
  let retentionHandoffConfirmed = false
  let retentionTerminalStatus: SessionRetentionCheckpoint["terminalStatus"] = "error"
  let retentionCheckpoint: SessionRetentionCheckpoint | undefined
  let retentionFinalized = false

  const finalizeRetention = async (): Promise<void> => {
    if (retentionFinalized) return
    retentionFinalized = true
    if (retentionCheckpoint) {
      const terminalAt = Date.now()
      retentionCheckpoint = {
        ...retentionCheckpoint,
        terminalStatus: retentionTerminalStatus,
        terminalAt,
        ...(retentionHandoffConfirmed ? { handoffConfirmedAt: terminalAt } : {}),
      }
      await recordSyncSessionRetentionCheckpoint(
        client,
        retentionCheckpoint,
        executorCtx.directory,
      )
    }
    releaseRetentionLease()
    scheduleSyncSessionDeletion(client, continuationID, executorCtx.directory)
  }

  try {
    const resumeContext = await resolveResumeContext(client, continuationID)
    resumeAgent = resumeContext.resumeAgent
    resumeModel = resumeContext.resumeModel
    resumeVariant = resumeContext.resumeVariant
    anchorMessageCount = resumeContext.anchorMessageCount
    anchorMessageID = resumeContext.anchorMessageID

    const resumeModelForMetadata = resumeModel && resumeVariant !== undefined
      ? { ...resumeModel, variant: resumeVariant }
      : resumeModel
    const previousCheckpoint = resumeContext.retentionCheckpoint?.mode === "sync"
      ? resumeContext.retentionCheckpoint
      : undefined
    const retentionModel = resumeModelForMetadata ?? previousCheckpoint?.model
    const retentionAgent = resumeAgent ?? previousCheckpoint?.agent
    const retentionCategory = args.category ?? previousCheckpoint?.category
    retentionCheckpoint = {
      version: 1,
      mode: "sync",
      sessionID: continuationID,
      taskID: previousCheckpoint?.taskID ?? continuationID,
      parentSessionID: parentContext.sessionID,
      parentMessageID: parentContext.messageID,
      ...(retentionAgent === undefined ? {} : { agent: retentionAgent }),
      ...(retentionModel === undefined ? {} : { model: retentionModel }),
      ...(retentionCategory === undefined ? {} : { category: retentionCategory }),
      autoDelete: previousCheckpoint?.autoDelete === false
        || executorCtx.autoDeleteSubagentSessions === false
        ? false
        : true,
    }
    const syncContMeta = {
      title: args.description,
      metadata: {
        prompt: args.prompt,
        ...(resumeAgent !== undefined ? { agent: resumeAgent } : {}),
        ...(args.category !== undefined ? { category: args.category } : {}),
        ...(args.requested_subagent_type !== undefined ? { requested_subagent_type: args.requested_subagent_type } : {}),
        load_skills: args.load_skills,
        description: args.description,
        run_in_background: args.run_in_background,
        taskId: continuationID,
        sessionId: continuationID,
        sync: true,
        command: args.command,
        model: resolveMetadataModel(resumeModelForMetadata, parentContext.model),
      },
    }
    await publishToolMetadata(ctx, syncContMeta)

    const allowTask = isPlanFamily(resumeAgent)
    const tddEnabled = sisyphusAgentConfig?.tdd
    const effectivePrompt = buildTaskPrompt(args.prompt, resumeAgent, tddEnabled)
    const tools = {
      task: allowTask,
      call_omo_agent: true,
      question: false,
      ...(resumeAgent ? getAgentToolRestrictions(resumeAgent) : {}),
    }
    setSessionTools(continuationID, tools)

    releasePromptAsyncReservation(continuationID, "sync-continuation", {
      reservedBy: "session-retention-checkpoint",
    })
    await promptWithModelSuggestionRetry(client, {
      path: { id: continuationID },
      body: {
        ...(resumeAgent !== undefined ? { agent: resumeAgent } : {}),
        ...(resumeModel !== undefined ? { model: resumeModel } : {}),
        ...(resumeVariant !== undefined ? { variant: resumeVariant } : {}),
        system: systemContent,
        tools,
        parts: [{ type: "text", text: effectivePrompt }],
      },
    }, {
      queueBehavior: "defer",
      checkToolState: false,
    })
    await recordSyncSessionRetentionCheckpoint(client, retentionCheckpoint, executorCtx.directory)
   } catch (promptError) {
     if (toastManager) {
       toastManager.removeTask(taskId)
     }
     const errorMessage = getSessionNotFoundError(promptError, continuationID)?.message
       ?? (promptError instanceof Error ? promptError.message : String(promptError))
     detachFromManager?.()
     retentionHandoffConfirmed = true
     await finalizeRetention()
     return `Failed to send continuation prompt: ${errorMessage}\n\nTask ID: ${continuationID}`
   }

    try {
      const pollError = await deps.pollSyncSession(ctx, client, {
        sessionID: continuationID,
        agentToUse: resumeAgent ?? "continue",
        toastManager,
        taskId,
        anchorMessageCount,
        anchorMessageID,
      }, syncPollTimeoutMs)
      if (pollError && isSessionNotFoundPollError(pollError)) {
        retentionHandoffConfirmed = true
        return pollError
      }
      if (pollError && shouldAttemptPollErrorRecovery(pollError)) {
        if (anchorMessageCount === undefined) {
          retentionHandoffConfirmed = true
          return pollError
        }
        const recoveredResult = await deps.fetchSyncResult(client, continuationID, anchorMessageCount, {
          strictAbortRecovery: true,
          deliverableTag: getDeliverableTag(resumeAgent),
        })
        if (!recoveredResult.ok) {
          retentionHandoffConfirmed = true
          return pollError
        }

        const duration = formatDuration(startTime)
        handedBackToParent = true
        retentionHandoffConfirmed = true
        retentionTerminalStatus = "completed"

        return `Task continued and completed in ${duration}.

---

${recoveredResult.textContent || "(No text output)"}

${buildTaskMetadataBlock({
          sessionId: continuationID,
          taskId: continuationID,
          agent: resumeAgent,
          category: args.category,
        })}`
      } else if (pollError) {
        retentionHandoffConfirmed = true
        return pollError
      }

      const result = await deps.fetchSyncResult(client, continuationID, anchorMessageCount, {
        deliverableTag: getDeliverableTag(resumeAgent),
      })
      if (!result.ok) {
        retentionHandoffConfirmed = true
        return result.error
      }

     const duration = formatDuration(startTime)
     handedBackToParent = true
     retentionHandoffConfirmed = true
     retentionTerminalStatus = "completed"

     return `Task continued and completed in ${duration}.

---

${result.textContent || "(No text output)"}

${buildTaskMetadataBlock({
        sessionId: continuationID,
        taskId: continuationID,
        agent: resumeAgent,
        category: args.category,
      })}`
   } finally {
     if (toastManager) {
       toastManager.removeTask(taskId)
     }
     if (handedBackToParent) {
       handedBackSyncSessions.add(continuationID)
       if (typeof client.session.abort === "function") {
         void client.session.abort({ path: { id: continuationID } }).catch((error: unknown) => {
           log(`[task] Failed to abort completed sync continuation session:`, error)
         })
       }
     }
      // Every terminal continuation path must restore the cleanup grace timer,
      // including prompt/poll failures after revival cancelled the old timer.
      detachFromManager?.()
      await finalizeRetention()
    }
}
