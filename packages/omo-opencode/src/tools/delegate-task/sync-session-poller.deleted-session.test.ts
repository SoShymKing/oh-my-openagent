import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { MIN_SESSION_GONE_POLLS } from "../../features/background-agent/session-existence"
import { isSessionNotFoundPollError } from "./session-not-found-error"
import { pollSyncSession } from "./sync-session-poller"
import { __resetTimingConfig, __setTimingConfig } from "./timing"
import type { OpencodeClient, ToolContextWithMetadata } from "./types"

beforeEach(() => __setTimingConfig({ POLL_INTERVAL_MS: 1 }))
afterEach(() => __resetTimingConfig())
const LONG_POLL_TIMEOUT_MS = 60_000
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

      const result = await pollSyncSession(context, client, { ...input, toastManager: { removeTask } }, LONG_POLL_TIMEOUT_MS)

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

  const result = await pollSyncSession(context, client, input, LONG_POLL_TIMEOUT_MS)

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

  const result = await pollSyncSession(context, client, input, LONG_POLL_TIMEOUT_MS)

  expect(result).toBeNull()
  expect(messages).toHaveBeenCalledTimes(2)
})

const toolContext: ToolContextWithMetadata = {
  sessionID: "ses_parent",
  messageID: "msg_parent",
  agent: "sisyphus",
  abort: new AbortController().signal,
}

const notFound = (sessionID: string) => ({
  data: undefined,
  error: { name: "NotFoundError", data: { message: `Session not found: ${sessionID}` } },
})

describe("pollSyncSession for a session that no longer exists", () => {
  test("#given the session is absent from status and deleted #when polling #then it stops with a terminal error instead of waiting for the timeout", async () => {
    // given
    const abort = mock(async () => ({}))
    const get = mock(async (input: { path: { id: string } }) => notFound(input.path.id))
    const client = unsafeTestValue<OpencodeClient>({
      session: {
        status: async () => ({ data: {} }),
        get,
        messages: async () => ({ data: [] }),
        abort,
      },
    })

    // when
    const result = await pollSyncSession(toolContext, client, {
      sessionID: "ses_deleted",
      agentToUse: "oracle",
      toastManager: null,
      taskId: undefined,
      anchorMessageCount: 0,
    }, LONG_POLL_TIMEOUT_MS)

    // then
    expect(isSessionNotFoundPollError(result ?? "")).toBe(true)
    expect(result).toContain("ses_deleted")
    expect(get).toHaveBeenCalledTimes(MIN_SESSION_GONE_POLLS)
    expect(abort).not.toHaveBeenCalled()
  }, 5_000)

  test("#given an idle session that still exists outside the status map #when polling #then completion is still detected", async () => {
    // given
    const client = unsafeTestValue<OpencodeClient>({
      session: {
        status: async () => ({ data: {} }),
        get: async (input: { path: { id: string } }) => ({ data: { id: input.path.id } }),
        messages: async () => ({
          data: [
            { info: { id: "msg_001", role: "user" }, parts: [{ type: "text", text: "go" }] },
            { info: { id: "msg_002", role: "assistant", finish: "stop" }, parts: [{ type: "text", text: "done" }] },
          ],
        }),
        abort: async () => ({}),
      },
    })

    // when
    const result = await pollSyncSession(toolContext, client, {
      sessionID: "ses_idle",
      agentToUse: "oracle",
      toastManager: null,
      taskId: undefined,
    }, LONG_POLL_TIMEOUT_MS)

    // then
    expect(result).toBeNull()
  }, 5_000)
})
