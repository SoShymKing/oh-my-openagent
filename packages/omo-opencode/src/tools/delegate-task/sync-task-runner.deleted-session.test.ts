import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { runSyncTaskLoop } from "./sync-task-runner"
import * as fallback from "./sync-task-fallback"
import type { ExecutorContext } from "./executor-types"
import { SessionNotFoundError } from "./session-not-found-error"

afterEach(() => mock.restore())

test.each(["session not found", "AbortError: session not found"])("#given deleted session (%s) and reachable fallback #when poll fails #then no replacement or stale recovery", async (message) => {
  const terminal = new SessionNotFoundError("ses_deleted", { name: "NotFoundError", message }).message
  const nextFallback = spyOn(fallback, "getNextSyncFallbackModel").mockReturnValue({ providerID: "test", modelID: "replacement" })
  const createSyncSession = mock(async () => ({ ok: false as const, error: "replacement attempted" }))
  const fetchSyncResult = mock(async () => ({ ok: true as const, textContent: "stale result" }))
  const sendSyncPrompt = mock(async () => null)
  const cleanupRetrySession = mock(() => {})
  const context = { sessionID: "ses_parent", messageID: "msg_parent", agent: "sisyphus", abort: new AbortController().signal }

  const result = await runSyncTaskLoop({
    args: { prompt: "Work", description: "Work", load_skills: [], run_in_background: false },
    ctx: context,
    executorCtx: unsafeTestValue<ExecutorContext>({ client: {}, directory: "." }),
    parentContext: context,
    agentToUse: "explore",
    categoryModel: { providerID: "test", modelID: "original" },
    fallbackChain: [{ providers: ["test"], model: "replacement" }],
    deps: { sendSyncPrompt, pollSyncSession: async () => terminal, fetchSyncResult, createSyncSession },
    sessionID: "ses_deleted", spawnDepth: 1, taskId: "task_deleted", startTime: new Date(),
    syncPollTimeoutMs: 100, systemContent: undefined, toastManager: undefined, modelInfo: undefined,
    registerSyncSession: async () => {}, publishSyncMetadata: async () => {},
    cleanupRetrySession, setSyncSessionID: () => {},
  })

  expect(result).toBe(terminal)
  expect(sendSyncPrompt).toHaveBeenCalledTimes(1)
  expect(fetchSyncResult).not.toHaveBeenCalled()
  expect(nextFallback).not.toHaveBeenCalled()
  expect(createSyncSession).not.toHaveBeenCalled()
  expect(cleanupRetrySession).not.toHaveBeenCalled()
})
