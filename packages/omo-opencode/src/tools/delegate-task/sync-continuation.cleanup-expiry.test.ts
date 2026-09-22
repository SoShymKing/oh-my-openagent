import { afterEach, expect, mock, test } from "bun:test"
import { mock as nodeMock } from "node:test"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { TASK_CLEANUP_DELAY_MS } from "../../features/background-agent/constants"
import type { SessionRetentionCheckpoint } from "../../features/background-agent/session-retention"
import { handedBackSyncSessions } from "../../features/claude-code-session-state"
import { releaseAllPromptAsyncReservationsForTesting } from "../../shared/prompt-async-gate"
import type { ExecutorContext } from "./executor-types"
import { executeSyncContinuation } from "./sync-continuation"
import {
  cancelSyncSessionDeletion,
  recordSyncSessionRetentionCheckpoint,
  scheduleSyncSessionDeletion,
} from "./sync-session-cleanup"

const sessionID = "ses_cleanup_expiry_boundary"

afterEach(() => {
  cancelSyncSessionDeletion(sessionID)
  cancelSyncSessionDeletion(`${sessionID}_false`)
  cancelSyncSessionDeletion(`${sessionID}_true`)
  releaseAllPromptAsyncReservationsForTesting()
  handedBackSyncSessions.delete(sessionID)
  nodeMock.timers.reset()
})

test.each([false, true])("#given cleanup expired=%s #when resuming #then cancellation or terminal 404 follows timer boundary", async (expired) => {
  const now = Date.now()
  nodeMock.timers.enable({ apis: ["setTimeout", "Date"], now })
  const currentSessionID = `${sessionID}_${expired}`
  let deleted = false
  const deleteSession = mock(async () => {
    deleted = true
    return { data: true }
  })
  const messages = mock(async () => deleted
    ? { error: { name: "NotFoundError" }, response: { status: 404 } }
    : { data: [] })
  const promptAsync = mock(async () => ({}))
  const get = mock(async () => ({ data: { id: currentSessionID } }))
  const children = mock(async () => ({ data: [] }))
  const executor = unsafeTestValue<ExecutorContext>({
    client: {
      session: {
        get,
        children,
        delete: deleteSession,
        messages,
        promptAsync,
        status: async () => ({ data: {} }),
      },
    },
  })
  const context = { sessionID: "ses_parent", messageID: "msg_parent", agent: "sisyphus", abort: new AbortController().signal }
  const args = { task_id: sessionID, prompt: "Continue", description: "Resume", load_skills: [], run_in_background: false }
  const pollSyncSession = mock(async () => {
    nodeMock.timers.tick(1)
    expect(deleteSession).not.toHaveBeenCalled()
    return null
  })
  const fetchSyncResult = mock(async () => ({ ok: true as const, textContent: "resumed output" }))
  const handoffAt = now - TASK_CLEANUP_DELAY_MS + 1_000
  const checkpoint: SessionRetentionCheckpoint = {
    version: 1,
    mode: "sync",
    sessionID: currentSessionID,
    taskID: currentSessionID,
    autoDelete: true,
    terminalStatus: "completed",
    terminalAt: handoffAt,
    handoffConfirmedAt: handoffAt,
  }
  await recordSyncSessionRetentionCheckpoint(executor.client, checkpoint)
  scheduleSyncSessionDeletion(executor.client, currentSessionID)
  nodeMock.timers.tick(expired ? 1_000 : 999)
  await new Promise<void>((resolve) => setImmediate(resolve))

  const result = await executeSyncContinuation(
    { ...args, task_id: currentSessionID },
    context,
    executor,
    context,
    { pollSyncSession, fetchSyncResult },
  )

  if (expired) {
    expect(deleteSession).toHaveBeenCalledTimes(1)
    expect(deleteSession).toHaveBeenCalledWith({ path: { id: currentSessionID } })
    expect(get).toHaveBeenCalledTimes(1)
    expect(children).toHaveBeenCalledTimes(1)
    expect(result).toContain("NotFoundError")
    expect(result).toContain(currentSessionID)
    expect(pollSyncSession).not.toHaveBeenCalled()
    expect(fetchSyncResult).not.toHaveBeenCalled()
  } else {
    expect(result).toContain("resumed output")
    expect(result).toContain(currentSessionID)
    const continuationPrompts = promptAsync.mock.calls.filter(([input]) => input.body?.noReply !== true)
    expect(continuationPrompts).toHaveLength(1)
    expect(pollSyncSession).toHaveBeenCalledTimes(1)
    expect(fetchSyncResult).toHaveBeenCalledTimes(1)
    expect(deleteSession).not.toHaveBeenCalled()
  }
})
