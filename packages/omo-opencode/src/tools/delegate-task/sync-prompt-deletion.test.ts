import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { releasePromptAsyncReservation } from "../../shared/prompt-async-gate"
import { deleteSessionTools } from "../../shared/session-tools-store"
import { sendSyncPrompt } from "./sync-prompt-sender"
import { runSyncTaskLoop } from "./sync-task-runner"
import * as fallback from "./sync-task-fallback"
import type { ExecutorContext } from "./executor-types"
import { SessionNotFoundError } from "./session-not-found-error"

const sessionID = "ses_prompt_deleted"
const context = { sessionID: "ses_parent", messageID: "msg_parent", agent: "sisyphus", abort: new AbortController().signal }
const args = { prompt: "Work", description: "Work", load_skills: [], run_in_background: false }

afterEach(() => {
  mock.restore()
  releasePromptAsyncReservation(sessionID, "model-suggestion-retry")
  deleteSessionTools(sessionID)
})

test.each([
  [false, "session missing"], [true, "session missing"],
  [false, "unexpected EOF"], [true, "unexpected EOF"],
] as const)("#given prompt deletion wrapped=%s message=%s #when sending #then terminal error preserves identity and cleans toast", async (wrapped, message) => {
  const body = { name: "NotFoundError", data: { message } }
  const promptAsync = mock(async () => {
    if (wrapped) throw new Error(body.data.message, { cause: { body, status: 404 } })
    return { error: body, response: { status: 404 } }
  })
  const executor = unsafeTestValue<ExecutorContext>({ client: { session: { promptAsync } } })
  const removeTask = mock(() => {})

  const result = await sendSyncPrompt(executor.client, {
    sessionID, agentToUse: "oracle", args, directory: ".", systemContent: undefined,
    categoryModel: undefined, toastManager: { removeTask }, taskId: "task_deleted",
  })

  expect(result?.startsWith("SessionNotFoundError:")).toBe(true)
  expect(result).toContain(sessionID)
  expect(result).toContain(body.data.message)
  expect(removeTask).toHaveBeenCalledTimes(1)
  expect(promptAsync).toHaveBeenCalledTimes(1)
})

test("#given plain transport EOF without HTTP status #when sending through gate and retry #then ambiguous dispatch stays accepted", async () => {
  const removeTask = mock(() => {})
  const promptAsync = mock(async () => { throw new Error("unexpected EOF") })
  const executor = unsafeTestValue<ExecutorContext>({ client: { session: { promptAsync } } })

  const result = await sendSyncPrompt(executor.client, {
    sessionID, agentToUse: "explore", args, directory: ".", systemContent: undefined,
    categoryModel: undefined, toastManager: { removeTask }, taskId: "task_deleted",
  })

  expect(result).toBeNull()
  expect(removeTask).not.toHaveBeenCalled()
  expect(promptAsync).toHaveBeenCalledTimes(1)
})

test.each([
  [false, false, "session not found"], [true, false, "session not found"],
  [false, false, "unexpected EOF"], [false, true, "unexpected EOF"],
] as const)("#given prompt error provider=%s wrapped=%s message=%s #when running #then only provider failure selects fallback", async (provider, wrapped, message) => {
  const body = { name: "NotFoundError", data: { message } }
  const terminal = new SessionNotFoundError(sessionID, body).message
  const promptAsync = mock(async () => {
    if (wrapped) throw new Error(message, { cause: { body, status: 404 } })
    return { error: body, response: { status: 404 } }
  })
  const executor = unsafeTestValue<ExecutorContext>({ client: { session: { promptAsync } }, directory: "." })
  const sendPrompt = mock(async (client: ExecutorContext["client"], input: Parameters<typeof sendSyncPrompt>[1]) =>
    provider ? "ProviderModelNotFoundError: model not found" : sendSyncPrompt(client, input))
  const retryPrompt = spyOn(fallback, "retrySyncPromptWithFallbacks").mockImplementation(async (input) => {
    await input.sendPrompt({ providerID: "test", modelID: "replacement" })
    return { promptError: "fallback attempted", categoryModel: input.categoryModel }
  })
  const pollSyncSession = mock(async () => null)
  const fetchSyncResult = mock(async () => ({ ok: true as const, textContent: "stale output" }))
  const createSyncSession = mock(async () => ({ ok: false as const, error: "replacement attempted" }))

  const result = await runSyncTaskLoop({
    args, ctx: context, parentContext: context,
    executorCtx: executor,
    agentToUse: "explore", categoryModel: { providerID: "test", modelID: "original" },
    fallbackChain: [{ providers: ["test"], model: "replacement" }],
    deps: { sendSyncPrompt: sendPrompt, pollSyncSession, fetchSyncResult, createSyncSession },
    sessionID, spawnDepth: 1, taskId: "task_deleted", startTime: new Date(),
    syncPollTimeoutMs: 100, systemContent: undefined, toastManager: undefined, modelInfo: undefined,
    registerSyncSession: async () => {}, publishSyncMetadata: async () => {},
    cleanupRetrySession: () => {}, setSyncSessionID: () => {},
  })

  expect(result).toBe(provider ? "fallback attempted" : terminal)
  expect(retryPrompt).toHaveBeenCalledTimes(provider ? 1 : 0)
  expect(sendPrompt).toHaveBeenCalledTimes(provider ? 2 : 1)
  expect(promptAsync).toHaveBeenCalledTimes(provider ? 0 : 1)
  expect(pollSyncSession).not.toHaveBeenCalled()
  expect(fetchSyncResult).not.toHaveBeenCalled()
  expect(createSyncSession).not.toHaveBeenCalled()
})
