import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { executeSyncContinuation } from "./sync-continuation"
import type { ExecutorContext } from "./executor-types"
import { cancelSyncSessionDeletion } from "./sync-session-cleanup"
import { releasePromptAsyncReservation } from "../../shared/prompt-async-gate"
import { SessionNotFoundError } from "./session-not-found-error"
import * as messageContext from "../../features/hook-message-injector"

const sessionID = "ses_deleted_continuation"
const missing = { error: { name: "NotFoundError", data: { message: "Session record missing" } }, response: { status: 404 } }
const context = { sessionID: "ses_parent", messageID: "msg_parent", agent: "sisyphus", abort: new AbortController().signal }
const args = { task_id: sessionID, prompt: "Continue", description: "Resume", load_skills: [], run_in_background: false }

afterEach(() => {
  mock.restore()
  cancelSyncSessionDeletion(sessionID)
  releasePromptAsyncReservation(sessionID, "model-suggestion-retry")
})

test("#given fulfilled SDK Error envelope #when reading history #then local transcript fallback is skipped", async () => {
  const resolveMessageContext = spyOn(messageContext, "resolveMessageContext").mockResolvedValue({ prevMessage: undefined, firstMessage: undefined })
  const promptAsync = mock(async () => ({}))
  const executor = unsafeTestValue<ExecutorContext>({
    client: { session: { messages: async () => ({ error: new Error("history unavailable") }), promptAsync, status: async () => ({ data: {} }) } },
  })
  const pollSyncSession = mock(async () => null)
  const fetchSyncResult = mock(async () => ({ ok: true as const, textContent: "stale" }))

  const result = await executeSyncContinuation(args, context, executor, context, { pollSyncSession, fetchSyncResult })

  expect(resolveMessageContext).not.toHaveBeenCalled()
  expect(promptAsync).not.toHaveBeenCalled()
  expect(pollSyncSession).not.toHaveBeenCalled()
  expect(result).toContain("history unavailable")
})

for (const [rejected, wrapped] of [[false, false], [true, false], [true, true]] as const) {
  test(`#given deleted history (${wrapped ? "SDK wrapper" : rejected ? "rejected" : "fulfilled"}) #when continuing #then no dispatch or result reads`, async () => {
    const localHistory = spyOn(messageContext, "resolveMessageContext").mockResolvedValue({ prevMessage: undefined, firstMessage: undefined })
    const messages = mock(async () => {
      if (wrapped) throw new Error("Session record missing", { cause: { body: missing.error, status: 404 } })
      if (rejected) throw missing
      return missing
    })
    const promptAsync = mock(async () => ({}))
    const detach = mock(() => {})
    const pollSyncSession = mock(async () => null)
    const fetchSyncResult = mock(async () => ({ ok: true as const, textContent: "stale result" }))
    const executor = unsafeTestValue<ExecutorContext>({
      client: { session: { messages, promptAsync, status: async () => ({ data: {} }) } },
      manager: { attachSyncContinuation: () => detach },
    })

    const result = await executeSyncContinuation(args, context, executor, context, { pollSyncSession, fetchSyncResult })

    expect(promptAsync).not.toHaveBeenCalled()
    expect(pollSyncSession).not.toHaveBeenCalled()
    expect(fetchSyncResult).not.toHaveBeenCalled()
    expect(messages).toHaveBeenCalledTimes(1)
    expect(localHistory).not.toHaveBeenCalled()
    expect(detach).toHaveBeenCalledTimes(1)
    expect(result).toContain("NotFoundError")
    expect(result).toContain(sessionID)
    expect(result).toContain("Session record missing")
  })

  test(`#given history success then dispatch 404 (${wrapped ? "SDK wrapper" : rejected ? "rejected" : "fulfilled"}) #when continuing #then no polling`, async () => {
    const promptAsync = mock(async () => {
      if (wrapped) throw new Error("Session record missing", { cause: { body: missing.error, status: 404 } })
      if (rejected) throw missing.error
      return missing
    })
    const pollSyncSession = mock(async () => null)
    const fetchSyncResult = mock(async () => ({ ok: true as const, textContent: "stale result" }))
    const executor = unsafeTestValue<ExecutorContext>({
      client: { session: { messages: async () => ({ data: [] }), promptAsync, status: async () => ({ data: {} }) } },
    })

    const result = await executeSyncContinuation(args, context, executor, context, { pollSyncSession, fetchSyncResult })

    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(pollSyncSession).not.toHaveBeenCalled()
    expect(fetchSyncResult).not.toHaveBeenCalled()
    expect(result).toContain("NotFoundError")
    expect(result).toContain(sessionID)
  })
}

test("#given terminal deletion mentioning abort #when continuation polls #then stale abort recovery is skipped", async () => {
  const terminal = new SessionNotFoundError(sessionID, { name: "NotFoundError", message: "AbortError: session not found" }).message
  const fetchSyncResult = mock(async () => ({ ok: true as const, textContent: "stale result" }))
  const executor = unsafeTestValue<ExecutorContext>({
    client: { session: { messages: async () => ({ data: [] }), promptAsync: async () => ({}), status: async () => ({ data: {} }) } },
  })

  const result = await executeSyncContinuation(args, context, executor, context, { pollSyncSession: async () => terminal, fetchSyncResult })

  expect(result).toBe(terminal)
  expect(fetchSyncResult).not.toHaveBeenCalled()
})
