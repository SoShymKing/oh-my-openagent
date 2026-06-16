import { log } from "../../shared"
import type { PendingParentWake } from "./parent-wake-dedupe"
import type { ParentWakeDispatchedTracker } from "./parent-wake-dispatched-tracker"
import type { ParentWakeSessionInspector } from "./parent-wake-session-inspector"

type ParentWakeWindowRecoveryInput = {
  readonly sessionID: string
  readonly wake: PendingParentWake
  readonly dispatchedTracker: ParentWakeDispatchedTracker
  readonly sessionInspector: ParentWakeSessionInspector
  readonly requeueWake: (wake: PendingParentWake) => void
  readonly scheduleFlush: () => void
}

export async function handleDispatchedParentWakeWindowElapsed(
  input: ParentWakeWindowRecoveryInput,
): Promise<void> {
  const currentWake = input.dispatchedTracker.getWake(input.sessionID)
  if (!currentWake || currentWake.dispatchedAt !== input.wake.dispatchedAt) {
    return
  }

  const hasAssistantOrToolOutput = await input.sessionInspector.hasAssistantOrToolOutputAfterDispatchedWake(
    input.sessionID,
    input.wake,
  )
  const latestWake = input.dispatchedTracker.getWake(input.sessionID)
  if (!latestWake || latestWake.dispatchedAt !== input.wake.dispatchedAt) {
    return
  }

  if (hasAssistantOrToolOutput) {
    input.dispatchedTracker.clearWake(input.sessionID)
    log("[background-agent] Cleared dispatched parent wake after observing assistant output:", {
      sessionID: input.sessionID,
    })
    return
  }

  const missingOutputWindowCount = input.dispatchedTracker.recordMissingOutputRecoveryWindow(
    input.sessionID,
    latestWake.dispatchedAt,
  )
  if (latestWake.shouldReply && missingOutputWindowCount >= 2) {
    input.dispatchedTracker.clearWake(input.sessionID)
    input.requeueWake(latestWake)
    input.scheduleFlush()
    log("[background-agent] Requeued dispatched parent wake after silent dispatch:", {
      sessionID: input.sessionID,
      missingOutputWindowCount,
    })
    return
  }

  input.dispatchedTracker.refreshWakeTimer(input.sessionID)
  log("[background-agent] Kept dispatched parent wake awaiting late failure or assistant output:", {
    sessionID: input.sessionID,
    missingOutputWindowCount,
  })
}

export function logParentWakeWindowRecoveryError(sessionID: string, error: unknown): void {
  const errorText = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  log("[background-agent] Failed to inspect dispatched parent wake after recovery window:", {
    sessionID,
    error: errorText,
  })
}

export function rescheduleParentWakeWindowRecoveryAfterError(
  sessionID: string,
  wake: PendingParentWake,
  dispatchedTracker: ParentWakeDispatchedTracker,
): void {
  const currentWake = dispatchedTracker.getWake(sessionID)
  if (!currentWake || currentWake.dispatchedAt !== wake.dispatchedAt) {
    return
  }
  dispatchedTracker.refreshWakeTimer(sessionID)
}
