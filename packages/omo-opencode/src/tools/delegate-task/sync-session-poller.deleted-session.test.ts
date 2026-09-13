import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { pollSyncSession } from "./sync-session-poller"
import { __resetTimingConfig, __setTimingConfig } from "./timing"
import type { OpencodeClient } from "./types"

beforeEach(() => __setTimingConfig({ POLL_INTERVAL_MS: 1 }))
afterEach(() => __resetTimingConfig())
const sessionID = "ses_deleted_poll"
const input = { sessionID, agentToUse: "explore", taskId: "task_deleted", toastManager: null }
const complete = { data: [{ info: { id: "msg_001", role: "user" } }, { info: { id: "msg_002", role: "assistant", finish: "stop" }, parts: [{ type: "text", text: "done" }] }] }

for (const [rejected, wrapped] of [[false, false], [true, false], [true, true]] as const) {
  for (const aborted of [false, true]) {
    test(`#given deletion (${wrapped ? "SDK wrapper" : rejected ? "rejected" : "fulfilled"}, abort=${aborted}) #when reading messages #then terminal without retry or abort`, async () => {
      const controller = new AbortController()
      if (aborted) controller.abort()
      const context = { sessionID: "ses_parent", messageID: "msg_parent", agent: "sisyphus", abort: controller.signal }
      let reads = 0
      const messages = mock(async () => {
        reads++
        if (!aborted && reads === 1) return { data: [] }
        const error = { error: { name: "NotFoundError" }, response: { status: 404 } }
        if (wrapped) throw new Error("Session record missing", { cause: { body: { name: "NotFoundError", data: { message: "Session record missing" } }, status: 404 } })
        if (rejected) throw error
        return error
      })
      const abort = mock(async () => ({}))
      const removeTask = mock(() => {})
      const client = unsafeTestValue<OpencodeClient>({ session: { messages, abort, status: async () => ({ data: {} }) } })

      const result = await pollSyncSession(context, client, { ...input, toastManager: { removeTask } }, 100)

      expect(result).toContain("NotFoundError")
      expect(result).toContain(sessionID)
      expect(messages).toHaveBeenCalledTimes(aborted ? 1 : 2)
      expect(abort).not.toHaveBeenCalled()
      expect(removeTask).toHaveBeenCalledWith(input.taskId)
    })
  }
}

test("#given missing status and transient read failure #when messages recover #then completed normally", async () => {
  let reads = 0
  const messages = mock(async () => {
    if (++reads === 1) throw new Error("connection reset")
    return complete
  })
  const client = unsafeTestValue<OpencodeClient>({ session: { messages, status: async () => ({ data: {} }) } })
  const context = { sessionID: "ses_parent", messageID: "msg_parent", agent: "sisyphus", abort: new AbortController().signal }

  const result = await pollSyncSession(context, client, input, 100)

  expect(result).toBeNull()
  expect(messages).toHaveBeenCalledTimes(2)
})

test("#given fulfilled transient error with stale completed data #when polling #then retries before accepting completion", async () => {
  let reads = 0
  const messages = mock(async () => ++reads === 1
    ? { ...complete, error: { name: "APIError", data: { message: "temporarily unavailable" } }, response: { status: 503 } }
    : complete)
  const client = unsafeTestValue<OpencodeClient>({ session: { messages, status: async () => ({ data: {} }) } })
  const context = { sessionID: "ses_parent", messageID: "msg_parent", agent: "sisyphus", abort: new AbortController().signal }

  const result = await pollSyncSession(context, client, input, 100)

  expect(result).toBeNull()
  expect(messages).toHaveBeenCalledTimes(2)
})
