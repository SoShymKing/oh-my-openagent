import { afterEach, expect, mock, test } from "bun:test"
import { mock as nodeMock } from "node:test"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { handedBackSyncSessions } from "../../features/claude-code-session-state"
import { releasePromptAsyncReservation } from "../../shared/prompt-async-gate"
import type { ExecutorContext } from "./executor-types"
import { executeSyncContinuation } from "./sync-continuation"
import { cancelSyncSessionDeletion, scheduleSyncSessionDeletion } from "./sync-session-cleanup"

const sessionID = "ses_cleanup_expiry_boundary"

afterEach(() => {
  cancelSyncSessionDeletion(sessionID)
  releasePromptAsyncReservation(sessionID, "model-suggestion-retry")
  handedBackSyncSessions.delete(sessionID)
  nodeMock.timers.reset()
})

test.each([false, true])("#given cleanup expired=%s #when resuming #then cancellation or terminal 404 follows timer boundary", async (expired) => {
  nodeMock.timers.enable({ apis: ["setTimeout"] })
  let deleted = false
  const deleteSession = mock(async () => {
    deleted = true
    return { data: true }
  })
  const messages = mock(async () => deleted
    ? { error: { name: "NotFoundError" }, response: { status: 404 } }
    : { data: [] })
  const promptAsync = mock(async () => ({}))
  const executor = unsafeTestValue<ExecutorContext>({
    client: { session: { delete: deleteSession, messages, promptAsync, status: async () => ({ data: {} }) } },
  })
  const context = { sessionID: "ses_parent", messageID: "msg_parent", agent: "sisyphus", abort: new AbortController().signal }
  const args = { task_id: sessionID, prompt: "Continue", description: "Resume", load_skills: [], run_in_background: false }
  const pollSyncSession = mock(async () => {
    nodeMock.timers.tick(1)
    expect(deleteSession).not.toHaveBeenCalled()
    return null
  })
  const fetchSyncResult = mock(async () => ({ ok: true as const, textContent: "resumed output" }))
  scheduleSyncSessionDeletion(executor.client, sessionID, 10)
  nodeMock.timers.tick(expired ? 10 : 9)

  const result = await executeSyncContinuation(args, context, executor, context, { pollSyncSession, fetchSyncResult })

  if (expired) {
    expect(deleteSession).toHaveBeenCalledTimes(1)
    expect(deleteSession).toHaveBeenCalledWith({ path: { id: sessionID } })
    expect(messages).toHaveBeenCalledTimes(1)
    expect(result).toContain("NotFoundError")
    expect(result).toContain(sessionID)
    expect(promptAsync).not.toHaveBeenCalled()
    expect(pollSyncSession).not.toHaveBeenCalled()
    expect(fetchSyncResult).not.toHaveBeenCalled()
  } else {
    expect(result).toContain("resumed output")
    expect(result).toContain(sessionID)
    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(pollSyncSession).toHaveBeenCalledTimes(1)
    expect(fetchSyncResult).toHaveBeenCalledTimes(1)
    expect(deleteSession).not.toHaveBeenCalled()
  }
})
