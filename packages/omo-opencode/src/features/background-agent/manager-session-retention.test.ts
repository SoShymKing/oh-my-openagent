import { tmpdir } from "node:os"
import { afterEach, describe, expect, mock, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"

import {
  releaseAllPromptAsyncReservationsForTesting,
  releasePromptAsyncReservation,
} from "../../hooks/shared/prompt-async-gate"
import { BackgroundManager } from "./manager"
import {
  SESSION_RETENTION_METADATA_KEY,
  type SessionRetentionCheckpoint,
} from "./session-retention"
import type { BackgroundTask } from "./types"

type PromptAsyncCall = {
  readonly body: {
    readonly parts: ReadonlyArray<{
      readonly metadata?: Record<string, unknown>
    }>
  }
}

type RetentionManagerInternals = {
  readonly sessionRetentionCheckpoints: Map<string, SessionRetentionCheckpoint>
  readonly persistTaskRetentionCheckpoint: (task: BackgroundTask) => Promise<void>
}

let managerUnderTest: BackgroundManager | undefined

afterEach(async () => {
  await managerUnderTest?.shutdown()
  managerUnderTest = undefined
  releaseAllPromptAsyncReservationsForTesting()
})

function createManager(autoDelete = true): {
  readonly manager: BackgroundManager
  readonly promptAsync: ReturnType<typeof mock>
} {
  const promptAsync = mock(async () => ({ data: undefined }))
  const client = {
    session: {
      promptAsync,
      abort: async () => ({}),
    },
  }
  const pluginContext = {
    client: client as PluginInput["client"],
    project: {} as PluginInput["project"],
    directory: tmpdir(),
    worktree: tmpdir(),
    serverUrl: new URL("http://localhost"),
    $: {} as PluginInput["$"],
  }
  const manager = new BackgroundManager({
    pluginContext,
    config: { autoDelete },
    enableParentSessionNotifications: false,
  })
  managerUnderTest = manager
  return { manager, promptAsync }
}

function createTask(): BackgroundTask {
  return {
    id: "bg_task",
    sessionId: "ses_child",
    parentSessionId: "ses_parent",
    parentMessageId: "msg_parent",
    description: "retention test",
    prompt: "test",
    agent: "explore",
    model: { providerID: "provider", modelID: "model", variant: "high" },
    category: "deep",
    status: "running",
    startedAt: new Date(1_000),
  }
}

function internals(manager: BackgroundManager): RetentionManagerInternals {
  return manager as unknown as RetentionManagerInternals
}

function checkpointFromCall(promptAsync: ReturnType<typeof mock>, index: number): SessionRetentionCheckpoint {
  const call = promptAsync.mock.calls[index]?.[0] as PromptAsyncCall | undefined
  const checkpoint = call?.body.parts[0]?.metadata?.[SESSION_RETENTION_METADATA_KEY]
  if (!checkpoint) throw new Error(`Missing retention checkpoint call ${index}`)
  return checkpoint as SessionRetentionCheckpoint
}

function retentionMessage(checkpoint: unknown): unknown {
  return {
    info: { role: "user" },
    parts: [{
      type: "text",
      text: "Session retention checkpoint",
      metadata: { [SESSION_RETENTION_METADATA_KEY]: checkpoint },
    }],
  }
}

function createRecoveryManager(messagesResult: unknown): {
  readonly manager: BackgroundManager
  readonly create: ReturnType<typeof mock>
  readonly promptAsync: ReturnType<typeof mock>
} {
  const create = mock(async () => ({ data: { id: "unexpected-session" } }))
  const promptAsync = mock(async () => ({ data: undefined }))
  const client = {
    session: {
      create,
      messages: async () => messagesResult,
      promptAsync,
      abort: async () => ({}),
    },
  }
  const pluginContext = {
    client: client as PluginInput["client"],
    project: {} as PluginInput["project"],
    directory: tmpdir(),
    worktree: tmpdir(),
    serverUrl: new URL("http://localhost"),
    $: {} as PluginInput["$"],
  }
  const manager = new BackgroundManager({
    pluginContext,
    enableParentSessionNotifications: false,
  })
  managerUnderTest = manager
  return { manager, create, promptAsync }
}

describe("BackgroundManager session retention lifecycle", () => {
  test("#given a running background session #when it becomes terminal #then checkpoints keep the first terminal timestamp", async () => {
    const { manager, promptAsync } = createManager(false)
    const task = createTask()
    const retention = internals(manager)

    await retention.persistTaskRetentionCheckpoint(task)
    releasePromptAsyncReservation(task.sessionId!, "session-retention-checkpoint")
    task.status = "completed"
    task.completedAt = new Date(2_000)
    await retention.persistTaskRetentionCheckpoint(task)
    task.completedAt = new Date(3_000)
    await retention.persistTaskRetentionCheckpoint(task)

    expect(promptAsync).toHaveBeenCalledTimes(2)
    expect(checkpointFromCall(promptAsync, 0)).toEqual({
      version: 1,
      mode: "background",
      sessionID: "ses_child",
      taskID: "bg_task",
      parentSessionID: "ses_parent",
      parentMessageID: "msg_parent",
      agent: "explore",
      model: { providerID: "provider", modelID: "model", variant: "high" },
      category: "deep",
      autoDelete: false,
    })
    expect(checkpointFromCall(promptAsync, 1)).toMatchObject({
      terminalStatus: "completed",
      terminalAt: 2_000,
    })
  })

  test("#given a terminal checkpoint #when handoff is confirmed twice #then the first confirmation timestamp remains fixed", async () => {
    const { manager, promptAsync } = createManager()
    const task = createTask()
    task.status = "completed"
    task.completedAt = new Date(2_000)
    const retention = internals(manager)

    await retention.persistTaskRetentionCheckpoint(task)
    releasePromptAsyncReservation(task.sessionId!, "session-retention-checkpoint")
    await manager.confirmBackgroundOutputHandoff(task.sessionId!, 5_000)
    await manager.confirmBackgroundOutputHandoff(task.sessionId!, 6_000)

    expect(promptAsync).toHaveBeenCalledTimes(2)
    expect(checkpointFromCall(promptAsync, 1)).toMatchObject({
      terminalAt: 2_000,
      handoffConfirmedAt: 5_000,
    })
    expect(retention.sessionRetentionCheckpoints.get(task.sessionId!)).toMatchObject({
      handoffConfirmedAt: 5_000,
    })
  })
})

describe("BackgroundManager background continuation recovery", () => {
  const recoveredCheckpoint: SessionRetentionCheckpoint = {
    version: 1,
    mode: "background",
    sessionID: "ses_recovered",
    taskID: "bg_recovered",
    parentSessionID: "ses_old_parent",
    parentMessageID: "msg_old_parent",
    agent: "explore",
    model: { providerID: "provider", modelID: "model", variant: "high" },
    category: "deep",
    autoDelete: true,
    terminalStatus: "completed",
    terminalAt: 2_000,
    handoffConfirmedAt: 3_000,
  }

  test("#given an evicted task with a valid native checkpoint #when resumed #then recovers it without creating a session", async () => {
    const { manager, create, promptAsync } = createRecoveryManager({
      data: [retentionMessage(recoveredCheckpoint)],
    })

    const task = await manager.resume({
      sessionId: recoveredCheckpoint.sessionID,
      prompt: "continue",
      parentSessionId: "ses_new_parent",
      parentMessageId: "msg_new_parent",
    })
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()

    expect(task).toMatchObject({
      id: recoveredCheckpoint.taskID,
      sessionId: recoveredCheckpoint.sessionID,
      parentSessionId: "ses_new_parent",
      parentMessageId: "msg_new_parent",
      agent: recoveredCheckpoint.agent,
      model: recoveredCheckpoint.model,
      category: recoveredCheckpoint.category,
      status: "running",
    })
    expect(create).not.toHaveBeenCalled()
    expect(promptAsync.mock.calls.some((call) => {
      const input = call[0] as { path?: { id?: string }; body?: { agent?: string } }
      return input.path?.id === recoveredCheckpoint.sessionID && input.body?.agent === recoveredCheckpoint.agent
    })).toBe(true)
    expect(internals(manager).sessionRetentionCheckpoints.get(recoveredCheckpoint.sessionID)).toEqual({
      version: 1,
      mode: "background",
      sessionID: recoveredCheckpoint.sessionID,
      taskID: recoveredCheckpoint.taskID,
      parentSessionID: "ses_new_parent",
      parentMessageID: "msg_new_parent",
      agent: recoveredCheckpoint.agent,
      model: recoveredCheckpoint.model,
      category: recoveredCheckpoint.category,
      autoDelete: true,
    })
  })

  test.each([
    ["confirmed missing", { error: { name: "NotFoundError" }, response: { status: 404 } }],
    ["unavailable", { error: { name: "ServerError" }, response: { status: 500 } }],
    ["malformed", { data: [retentionMessage({ ...recoveredCheckpoint, autoDelete: "yes" })] }],
  ])("#given %s native state #when resumed after cache miss #then fails closed without creating a session", async (_case, messagesResult) => {
    const { manager, create, promptAsync } = createRecoveryManager(messagesResult)

    await expect(manager.resume({
      sessionId: recoveredCheckpoint.sessionID,
      prompt: "continue",
      parentSessionId: "ses_new_parent",
      parentMessageId: "msg_new_parent",
    })).rejects.toThrow(`Task not found for session: ${recoveredCheckpoint.sessionID}`)

    expect(create).not.toHaveBeenCalled()
    expect(promptAsync).not.toHaveBeenCalled()
  })
})
