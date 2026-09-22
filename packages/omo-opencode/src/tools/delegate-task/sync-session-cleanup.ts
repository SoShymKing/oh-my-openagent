import {
  deleteSessionIfEligible,
  getSessionRetentionDeadline,
  sessionOperationLeases,
  type SessionRetentionCheckpoint,
  writeSessionRetentionCheckpoint,
} from "../../features/background-agent/session-retention"
import type { OpencodeClient as RetentionClient } from "../../features/background-agent/opencode-client"
import { handedBackSyncSessions } from "../../features/claude-code-session-state"
import { log } from "../../shared/logger"
import type { OpencodeClient } from "./types"

const pendingDeletionTimers = new Map<string, ReturnType<typeof setTimeout>>()
const checkpoints = new Map<string, SessionRetentionCheckpoint>()

function asRetentionClient(client: OpencodeClient): RetentionClient {
  return client as unknown as RetentionClient
}

export function cancelSyncSessionDeletion(sessionID: string): void {
  const timer = pendingDeletionTimers.get(sessionID)
  if (!timer) return
  clearTimeout(timer)
  pendingDeletionTimers.delete(sessionID)
}

export function acquireSyncSessionLease(sessionID: string): () => void {
  cancelSyncSessionDeletion(sessionID)
  return sessionOperationLeases.acquire(sessionID)
}

export async function recordSyncSessionRetentionCheckpoint(
  client: OpencodeClient,
  checkpoint: SessionRetentionCheckpoint,
  directory?: string,
): Promise<boolean> {
  if (checkpoint.mode !== "sync") return false
  try {
    const accepted = await writeSessionRetentionCheckpoint(asRetentionClient(client), checkpoint, directory)
    if (accepted) checkpoints.set(checkpoint.sessionID, checkpoint)
    else checkpoints.delete(checkpoint.sessionID)
    return accepted
  } catch (error) {
    checkpoints.delete(checkpoint.sessionID)
    log("[task] Failed to record sync session retention checkpoint:", {
      sessionID: checkpoint.sessionID,
      error: String(error),
    })
    return false
  }
}

export function scheduleSyncSessionDeletion(
  client: OpencodeClient,
  sessionID: string,
  directory?: string,
): void {
  cancelSyncSessionDeletion(sessionID)
  const checkpoint = checkpoints.get(sessionID)
  if (!checkpoint?.autoDelete) return
  const deadline = getSessionRetentionDeadline(checkpoint)
  if (deadline === undefined) return

  const timer = setTimeout(async () => {
    pendingDeletionTimers.delete(sessionID)
    try {
      const latest = checkpoints.get(sessionID)
      if (!latest) return
      const result = await deleteSessionIfEligible({
        client: asRetentionClient(client),
        checkpoint: latest,
        leases: sessionOperationLeases,
        directory,
      })

      if (result.status === "deleted" || result.status === "missing") {
        checkpoints.delete(sessionID)
        handedBackSyncSessions.delete(sessionID)
      } else if (result.retryAt !== undefined) {
        scheduleSyncSessionDeletion(client, sessionID, directory)
      }
    } catch (error) {
      log("[task] Failed to reconcile completed sync session:", { sessionID, error: String(error) })
    }
  }, Math.max(0, deadline - Date.now()))
  pendingDeletionTimers.set(sessionID, timer)
  timer.unref()
}
