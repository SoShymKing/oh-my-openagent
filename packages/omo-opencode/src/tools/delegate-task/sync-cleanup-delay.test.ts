import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { TASK_CLEANUP_DELAY_MS } from "../../features/background-agent/constants"
import { SESSION_RETENTION_METADATA_KEY, type SessionRetentionCheckpoint } from "../../features/background-agent/session-retention"
import { handedBackSyncSessions } from "../../features/claude-code-session-state"
import { releaseAllPromptAsyncReservationsForTesting } from "../../shared/prompt-async-gate"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { executeSyncContinuation } from "./sync-continuation"
import type { SyncContinuationDeps } from "./sync-continuation-deps"
import { cancelSyncSessionDeletion, recordSyncSessionRetentionCheckpoint, scheduleSyncSessionDeletion } from "./sync-session-cleanup"
import { executeSyncTask } from "./sync-task"
import type { SyncTaskDeps } from "./sync-task-deps"
import type { ExecutorContext } from "./executor-types"
import type { OpencodeClient, ToolContextWithMetadata } from "./types"

type RecordedTimer = {
  readonly delay: number
  readonly callback: () => unknown
  readonly handle: ReturnType<typeof setTimeout>
}

const SESSION_IDS = ["ses_cleanup_custom", "ses_cleanup_default", "ses_cleanup_resume", "ses_cleanup_prompt_fail"] as const
const parentContext = { sessionID: "parent-session", messageID: "parent-message" }
const toolContext: ToolContextWithMetadata = {
  ...parentContext,
  agent: "test-agent",
  abort: new AbortController().signal,
  metadata: () => {},
}

function createClient(promptAsync = mock(async () => ({})), checkpoint?: SessionRetentionCheckpoint) {
  const deleteSession = mock(async (_input: { path: { id: string } }) => ({ data: true }))
  const client = unsafeTestValue<OpencodeClient>({
    session: {
      delete: deleteSession,
      get: async (input: { path: { id: string } }) => ({ data: { id: input.path.id } }),
      children: async () => ({ data: [] }),
      abort: async () => ({}),
      messages: async () => ({
        data: checkpoint
          ? [{ parts: [{ metadata: { [SESSION_RETENTION_METADATA_KEY]: checkpoint } }] }]
          : [],
      }),
      promptAsync: async (input: { body?: { noReply?: boolean } }) => input.body?.noReply ? {} : promptAsync(),
      status: async () => ({ data: {} }),
    },
  })
  return { client, deleteSession }
}

function createExecutorContext(client: OpencodeClient, taskCleanupDelayMs?: number): ExecutorContext {
  return unsafeTestValue<ExecutorContext>({
    client,
    directory: "/tmp",
    manager: {
      assertCanSpawn: async () => ({ rootSessionID: "parent-session", parentDepth: 0, childDepth: 1 }),
    },
    taskCleanupDelayMs,
  })
}

function createSyncTaskDeps(sessionID: string): SyncTaskDeps {
  return {
    createSyncSession: async () => ({ ok: true, sessionID, parentDirectory: "/tmp" }),
    sendSyncPrompt: async () => null,
    pollSyncSession: async () => null,
    fetchSyncResult: async () => ({ ok: true, textContent: "done" }),
  }
}

const continuationDeps: SyncContinuationDeps = {
  pollSyncSession: async () => null,
  fetchSyncResult: async () => ({ ok: true, textContent: "done" }),
}

describe("sync cleanup delay threading", () => {
  let recordedTimers: RecordedTimer[]
  let timerSpy: ReturnType<typeof spyOn<typeof globalThis, "setTimeout">>
  let clearTimerSpy: ReturnType<typeof spyOn<typeof globalThis, "clearTimeout">>
  let clock: ReturnType<typeof spyOn<typeof Date, "now">>

  const pendingTimers = (): RecordedTimer[] => recordedTimers.filter(
    (timer) => !clearTimerSpy.mock.calls.some(([handle]) => handle === timer.handle),
  )

  beforeEach(() => {
    recordedTimers = []
    clock = spyOn(Date, "now").mockReturnValue(1_000)
    const originalSetTimeout = globalThis.setTimeout
    timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(unsafeTestValue<typeof setTimeout>(
      (callback: (...args: unknown[]) => unknown, delay?: number, ...args: unknown[]) => {
        const handle = originalSetTimeout(callback, delay, ...args)
        if (delay !== undefined && delay >= 60000) {
          recordedTimers.push({ delay, callback: () => callback(...args), handle })
        }
        return handle
      },
    ))
    clearTimerSpy = spyOn(globalThis, "clearTimeout")
  })

  afterEach(() => {
    for (const id of SESSION_IDS) cancelSyncSessionDeletion(id)
    for (const timer of recordedTimers) clearTimeout(timer.handle)
    clearTimerSpy.mockRestore()
    timerSpy.mockRestore()
    clock.mockRestore()
    releaseAllPromptAsyncReservationsForTesting()
    handedBackSyncSessions.clear()
  })

  test("#when a sync task completes with a configured delay #then its deletion uses that delay", async () => {
    const sessionID = SESSION_IDS[0]
    const { client, deleteSession } = createClient()

    await executeSyncTask(
      { description: "test task", prompt: "test prompt", run_in_background: false, load_skills: [] },
      toolContext, createExecutorContext(client, 120000), parentContext,
      "test-agent", undefined, undefined, undefined, undefined, createSyncTaskDeps(sessionID),
    )

    const deletionTimer = pendingTimers().slice(-1)[0]
    expect(deletionTimer?.delay).toBe(120000)
    clock.mockReturnValue(121_000)
    await deletionTimer?.callback()
    expect(deleteSession).toHaveBeenCalledWith({ path: { id: sessionID }, query: { directory: "/tmp" } })
  })

  test("#when a sync task completes without a configured delay #then its deletion uses the default", async () => {
    const sessionID = SESSION_IDS[1]
    const { client } = createClient()

    await executeSyncTask(
      { description: "test task", prompt: "test prompt", run_in_background: false, load_skills: [] },
      toolContext, createExecutorContext(client), parentContext,
      "test-agent", undefined, undefined, undefined, undefined, createSyncTaskDeps(sessionID),
    )

    expect(pendingTimers().slice(-1)[0]?.delay).toBe(TASK_CLEANUP_DELAY_MS)
  })

  test.each([
    { configuredDelay: 120_000, expectedDelay: 120_000 },
    { configuredDelay: undefined, expectedDelay: 900_000 },
  ])("#given continuation delay $configuredDelay #when it completes #then saved or overridden delay is $expectedDelay", async ({ configuredDelay, expectedDelay }) => {
    // given
    const sessionID = SESSION_IDS[2]
    const checkpoint: SessionRetentionCheckpoint = {
      version: 1,
      mode: "sync",
      sessionID,
      autoDelete: true,
      terminalStatus: "completed",
      terminalAt: Date.now(),
      handoffConfirmedAt: Date.now(),
      taskCleanupDelayMs: 900_000,
    }
    const { client } = createClient(undefined, checkpoint)
    await recordSyncSessionRetentionCheckpoint(client, checkpoint)
    scheduleSyncSessionDeletion(client, sessionID)
    const earlierTimer = recordedTimers[0]

    // when
    await executeSyncContinuation(
      { task_id: sessionID, description: "test continuation", prompt: "continue", run_in_background: false, load_skills: [] },
      toolContext, createExecutorContext(client, configuredDelay), parentContext, continuationDeps,
    )

    // then
    expect(clearTimerSpy).toHaveBeenCalledWith(earlierTimer?.handle)
    expect(pendingTimers().slice(-1)[0]?.delay).toBe(expectedDelay)
  })

  test("#when a continuation prompt fails #then deletion is re-armed with the configured delay", async () => {
    const sessionID = SESSION_IDS[3]
    const { client } = createClient(mock(async () => { throw new Error("Session not found") }))

    await executeSyncContinuation(
      { task_id: sessionID, description: "test continuation", prompt: "continue", run_in_background: false, load_skills: [] },
      toolContext, createExecutorContext(client, 120000), parentContext, continuationDeps,
    )

    expect(pendingTimers().slice(-1)[0]?.delay).toBe(120000)
  })
})
