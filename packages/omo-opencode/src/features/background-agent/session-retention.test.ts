import { afterEach, describe, expect, mock, test } from "bun:test"

import { releaseAllPromptAsyncReservationsForTesting } from "../../hooks/shared/prompt-async-gate"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import type { OpencodeClient } from "./opencode-client"
import {
  SESSION_RETENTION_METADATA_KEY,
  SessionOperationLeases,
  deleteSessionIfEligible,
  getSessionRetentionDeadline,
  parseSessionRetentionCheckpoint,
  readSessionRetentionCheckpoint,
  reconcilePersistedSessionRetention,
  reconcileSessionRetention,
  writeSessionRetentionCheckpoint,
  type SessionRetentionCheckpoint,
} from "./session-retention"

const checkpoint: SessionRetentionCheckpoint = {
  version: 1,
  mode: "background",
  sessionID: "ses_child",
  taskID: "bg_task",
  parentSessionID: "ses_parent",
  parentMessageID: "msg_parent",
  agent: "explore",
  model: { providerID: "provider", modelID: "model", variant: "high" },
  category: "deep",
  autoDelete: true,
  terminalStatus: "completed",
  terminalAt: 1_000,
  handoffConfirmedAt: 2_000,
}

function retentionMessage(value: unknown): unknown {
  return {
    info: { role: "user" },
    parts: [{ type: "text", text: "", metadata: { [SESSION_RETENTION_METADATA_KEY]: value } }],
  }
}

function deletionClient(input?: {
  readonly get?: () => Promise<unknown>
  readonly children?: () => Promise<unknown>
  readonly deleteSession?: () => Promise<unknown>
}): {
  readonly client: OpencodeClient
  readonly get: ReturnType<typeof mock>
  readonly children: ReturnType<typeof mock>
  readonly deleteSession: ReturnType<typeof mock>
} {
  const get = mock(input?.get ?? (async () => ({ data: { id: checkpoint.sessionID } })))
  const children = mock(input?.children ?? (async () => ({ data: [] })))
  const deleteSession = mock(input?.deleteSession ?? (async () => ({ data: true })))
  return {
    client: unsafeTestValue<OpencodeClient>({ session: { get, children, delete: deleteSession } }),
    get,
    children,
    deleteSession,
  }
}

afterEach(() => {
  releaseAllPromptAsyncReservationsForTesting()
})

describe("session retention checkpoints", () => {
  test("#given a versioned checkpoint #when parsed #then retains only lifecycle routing data", () => {
    expect(parseSessionRetentionCheckpoint(checkpoint)).toEqual(checkpoint)
    expect(parseSessionRetentionCheckpoint({ ...checkpoint, terminalAt: "now" })).toBeUndefined()
    expect(parseSessionRetentionCheckpoint({ ...checkpoint, version: 2 })).toBeUndefined()
  })

  test("#given a checkpoint #when written #then stores synthetic noReply part metadata", async () => {
    const promptAsync = mock(async () => ({ data: undefined }))
    const client = unsafeTestValue<OpencodeClient>({ session: { promptAsync } })

    const accepted = await writeSessionRetentionCheckpoint(client, checkpoint, "/project")

    expect(accepted).toBe(true)
    expect(promptAsync).toHaveBeenCalledTimes(1)
    const call = promptAsync.mock.calls[0]?.[0] as {
      body: { noReply: boolean; parts: Array<{ synthetic?: boolean; metadata?: Record<string, unknown> }> }
      query?: { directory?: string }
    }
    expect(call.body.noReply).toBe(true)
    expect(call.body.parts[0]?.synthetic).toBe(true)
    expect(call.body.parts[0]?.metadata?.[SESSION_RETENTION_METADATA_KEY]).toEqual(checkpoint)
    expect(call.query?.directory).toBe("/project")
  })

  test("#given multiple lifecycle markers #when read #then returns the newest checkpoint", async () => {
    const latest = { ...checkpoint, handoffConfirmedAt: 3_000 }
    const messages = mock(async () => ({ data: [retentionMessage(checkpoint), retentionMessage(latest)] }))
    const client = unsafeTestValue<OpencodeClient>({ session: { messages } })

    const result = await readSessionRetentionCheckpoint(client, checkpoint.sessionID)

    expect(result).toEqual({ status: "checkpoint", checkpoint: latest })
  })

  test("#given a malformed newest marker #when read #then fails closed", async () => {
    const messages = mock(async () => ({ data: [retentionMessage(checkpoint), retentionMessage({ ...checkpoint, autoDelete: "yes" })] }))
    const client = unsafeTestValue<OpencodeClient>({ session: { messages } })

    expect(await readSessionRetentionCheckpoint(client, checkpoint.sessionID)).toEqual({ status: "unavailable" })
  })
})

describe("session retention eligibility", () => {
  test("#given terminal and handoff timestamps #when computing deadline #then uses the later timestamp once", () => {
    expect(getSessionRetentionDeadline(checkpoint)).toBe(602_000)
    expect(getSessionRetentionDeadline({ ...checkpoint, handoffConfirmedAt: undefined })).toBeUndefined()
  })

  test("#given nested operations #when leases release #then activity remains until the final release", () => {
    const leases = new SessionOperationLeases()
    const releaseFirst = leases.acquire(checkpoint.sessionID)
    const releaseSecond = leases.acquire(checkpoint.sessionID)

    releaseFirst()
    expect(leases.hasActive(checkpoint.sessionID)).toBe(true)
    releaseFirst()
    releaseSecond()
    expect(leases.hasActive(checkpoint.sessionID)).toBe(false)
  })

  test("#given an eligible leaf session #when deletion runs #then deletes it", async () => {
    const { client, deleteSession } = deletionClient()

    const result = await deleteSessionIfEligible({
      client,
      checkpoint,
      leases: new SessionOperationLeases(),
      now: 602_000,
    })

    expect(result).toEqual({ status: "deleted" })
    expect(deleteSession).toHaveBeenCalledWith({ path: { id: checkpoint.sessionID } })
  })

  test("#given an active operation #when deletion runs #then preserves without native calls", async () => {
    const { client, get, deleteSession } = deletionClient()
    const leases = new SessionOperationLeases()
    leases.acquire(checkpoint.sessionID)

    const result = await deleteSessionIfEligible({ client, checkpoint, leases, now: 602_000 })

    expect(result).toEqual({ status: "preserved", reason: "active-operation" })
    expect(get).not.toHaveBeenCalled()
    expect(deleteSession).not.toHaveBeenCalled()
  })

  test("#given child sessions #when deletion runs #then preserves the parent", async () => {
    const { client, deleteSession } = deletionClient({
      children: async () => ({ data: [{ id: "ses_grandchild" }] }),
    })

    const result = await deleteSessionIfEligible({
      client,
      checkpoint,
      leases: new SessionOperationLeases(),
      now: 602_000,
    })

    expect(result).toEqual({ status: "preserved", reason: "has-children" })
    expect(deleteSession).not.toHaveBeenCalled()
  })

  test("#given native lookup failure #when deletion runs #then preserves the session", async () => {
    const { client } = deletionClient({
      get: async () => ({ error: { name: "UnknownError", data: { message: "unavailable" } }, response: { status: 500 } }),
    })

    expect(await deleteSessionIfEligible({
      client,
      checkpoint,
      leases: new SessionOperationLeases(),
      now: 602_000,
    })).toEqual({ status: "preserved", reason: "native-check-failed" })
  })

  test("#given a confirmed session 404 #when deletion runs #then reports it missing", async () => {
    const { client } = deletionClient({
      get: async () => ({ error: { name: "NotFoundError" }, response: { status: 404 } }),
    })

    expect(await deleteSessionIfEligible({
      client,
      checkpoint,
      leases: new SessionOperationLeases(),
      now: 602_000,
    })).toEqual({ status: "missing" })
  })

  test("#given a provider-model 404 #when deletion runs #then does not treat the session as missing", async () => {
    const { client } = deletionClient({
      get: async () => ({ error: { name: "ProviderModelNotFoundError" }, response: { status: 404 } }),
    })

    expect(await deleteSessionIfEligible({
      client,
      checkpoint,
      leases: new SessionOperationLeases(),
      now: 602_000,
    })).toEqual({ status: "preserved", reason: "native-check-failed" })
  })

  test("#given a persisted eligible checkpoint #when reconciled #then reads and deletes the session", async () => {
    const messages = mock(async () => ({ data: [retentionMessage(checkpoint)] }))
    const deleteSession = mock(async () => ({ data: true }))
    const client = unsafeTestValue<OpencodeClient>({
      session: {
        messages,
        get: async () => ({ data: { id: checkpoint.sessionID } }),
        children: async () => ({ data: [] }),
        delete: deleteSession,
      },
    })

    const result = await reconcileSessionRetention({
      client,
      sessionID: checkpoint.sessionID,
      leases: new SessionOperationLeases(),
      now: 602_000,
    })

    expect(result).toEqual({ status: "deleted" })
    expect(messages).toHaveBeenCalledTimes(1)
    expect(deleteSession).toHaveBeenCalledTimes(1)
  })
})

describe("startup session retention reconciliation", () => {
  test("#given current auto-delete is disabled #when startup reconciles #then native sessions are not listed", async () => {
    const list = mock(async () => ({ data: [{ id: checkpoint.sessionID }] }))
    const client = unsafeTestValue<OpencodeClient>({ session: { list } })

    const result = await reconcilePersistedSessionRetention({
      client,
      leases: new SessionOperationLeases(),
      autoDelete: false,
    })

    expect(result).toEqual({
      status: "disabled",
      scanned: 0,
      deleted: 0,
      missing: 0,
      preserved: 0,
    })
    expect(list).not.toHaveBeenCalled()
  })

  test("#given native session listing is unavailable #when startup reconciles #then it fails closed", async () => {
    const list = mock(async () => {
      throw new Error("native list unavailable")
    })
    const messages = mock(async () => ({ data: [retentionMessage(checkpoint)] }))
    const client = unsafeTestValue<OpencodeClient>({ session: { list, messages } })

    const result = await reconcilePersistedSessionRetention({
      client,
      leases: new SessionOperationLeases(),
      autoDelete: true,
    })

    expect(result).toEqual({
      status: "unavailable",
      scanned: 0,
      deleted: 0,
      missing: 0,
      preserved: 0,
    })
    expect(messages).not.toHaveBeenCalled()
  })

  test("#given mixed persisted sessions #when startup reconciles #then only the eligible leaf is deleted", async () => {
    const eligibleID = "ses_eligible"
    const markerlessID = "ses_markerless"
    const activeID = "ses_active"
    const parentID = "ses_with_child"
    const unavailableID = "ses_unavailable"
    const sessionIDs = [eligibleID, markerlessID, activeID, parentID, unavailableID]
    const list = mock(async () => ({ data: sessionIDs.map((id) => ({ id })) }))
    const messages = mock(async (input: { path: { id: string } }) => ({
      data: input.path.id === markerlessID
        ? []
        : [retentionMessage({ ...checkpoint, sessionID: input.path.id })],
    }))
    const get = mock(async (input: { path: { id: string } }) => input.path.id === unavailableID
      ? { error: { name: "UnknownError" }, response: { status: 500 } }
      : { data: { id: input.path.id } })
    const children = mock(async (input: { path: { id: string } }) => ({
      data: input.path.id === parentID ? [{ id: "ses_grandchild" }] : [],
    }))
    const deleteSession = mock(async () => ({ data: true }))
    const client = unsafeTestValue<OpencodeClient>({
      session: { list, messages, get, children, delete: deleteSession },
    })
    const leases = new SessionOperationLeases()
    leases.acquire(activeID)

    const result = await reconcilePersistedSessionRetention({
      client,
      leases,
      autoDelete: true,
      directory: "/project",
      now: 602_000,
    })

    expect(result).toEqual({
      status: "completed",
      scanned: 5,
      deleted: 1,
      missing: 0,
      preserved: 4,
    })
    expect(deleteSession).toHaveBeenCalledTimes(1)
    expect(deleteSession).toHaveBeenCalledWith({
      path: { id: eligibleID },
      query: { directory: "/project" },
    })
    expect(get.mock.calls.some(([input]) => input.path.id === activeID)).toBe(false)
  })
})
