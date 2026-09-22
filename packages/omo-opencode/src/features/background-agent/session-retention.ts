import { isRecord } from "@oh-my-opencode/utils"

import {
  createInternalAgentTextPart,
  withInternalNoReplyMarker,
} from "../../shared"
import {
  dispatchInternalPrompt,
  isInternalPromptDispatchAccepted,
} from "../../hooks/shared/prompt-async-gate"
import { TASK_CLEANUP_DELAY_MS } from "./constants"
import { extractErrorName, extractErrorStatusCode } from "./error-classifier"
import type { OpencodeClient } from "./opencode-client"

export const SESSION_RETENTION_METADATA_KEY = "omo_session_retention"

export type SessionRetentionCheckpoint = {
  readonly version: 1
  readonly mode: "background" | "sync"
  readonly sessionID: string
  readonly taskID?: string
  readonly parentSessionID?: string
  readonly parentMessageID?: string
  readonly agent?: string
  readonly model?: {
    readonly providerID: string
    readonly modelID: string
    readonly variant?: string
  }
  readonly category?: string
  readonly autoDelete: boolean
  readonly terminalStatus?: "completed" | "error" | "cancelled" | "interrupt"
  readonly terminalAt?: number
  readonly handoffConfirmedAt?: number
}

export type SessionRetentionResult =
  | { readonly status: "deleted" }
  | { readonly status: "missing" }
  | { readonly status: "preserved"; readonly reason: string; readonly retryAt?: number }

export type SessionRetentionReadResult =
  | { readonly status: "checkpoint"; readonly checkpoint: SessionRetentionCheckpoint }
  | { readonly status: "none" }
  | { readonly status: "missing" }
  | { readonly status: "unavailable" }

function optionalString(record: Record<string, unknown>, key: string): string | undefined | null {
  const value = record[key]
  if (value === undefined) return undefined
  return typeof value === "string" && value.length > 0 ? value : null
}

function optionalTimestamp(record: Record<string, unknown>, key: string): number | undefined | null {
  const value = record[key]
  if (value === undefined) return undefined
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

export function parseSessionRetentionCheckpoint(value: unknown): SessionRetentionCheckpoint | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined
  if (value.mode !== "background" && value.mode !== "sync") return undefined
  if (typeof value.sessionID !== "string" || value.sessionID.length === 0) return undefined
  if (typeof value.autoDelete !== "boolean") return undefined

  const taskID = optionalString(value, "taskID")
  const parentSessionID = optionalString(value, "parentSessionID")
  const parentMessageID = optionalString(value, "parentMessageID")
  const agent = optionalString(value, "agent")
  const category = optionalString(value, "category")
  const terminalAt = optionalTimestamp(value, "terminalAt")
  const handoffConfirmedAt = optionalTimestamp(value, "handoffConfirmedAt")
  if (
    taskID === null
    || parentSessionID === null
    || parentMessageID === null
    || agent === null
    || category === null
    || terminalAt === null
    || handoffConfirmedAt === null
  ) {
    return undefined
  }

  const terminalStatus = value.terminalStatus
  if (terminalStatus !== undefined && !["completed", "error", "cancelled", "interrupt"].includes(String(terminalStatus))) {
    return undefined
  }

  let model: SessionRetentionCheckpoint["model"]
  if (value.model !== undefined) {
    if (!isRecord(value.model)) return undefined
    const providerID = optionalString(value.model, "providerID")
    const modelID = optionalString(value.model, "modelID")
    const variant = optionalString(value.model, "variant")
    if (providerID == null || modelID == null || variant === null) return undefined
    model = { providerID, modelID, ...(variant === undefined ? {} : { variant }) }
  }

  return {
    version: 1,
    mode: value.mode,
    sessionID: value.sessionID,
    autoDelete: value.autoDelete,
    ...(taskID === undefined ? {} : { taskID }),
    ...(parentSessionID === undefined ? {} : { parentSessionID }),
    ...(parentMessageID === undefined ? {} : { parentMessageID }),
    ...(agent === undefined ? {} : { agent }),
    ...(model === undefined ? {} : { model }),
    ...(category === undefined ? {} : { category }),
    ...(terminalStatus === undefined ? {} : { terminalStatus: terminalStatus as SessionRetentionCheckpoint["terminalStatus"] }),
    ...(terminalAt === undefined ? {} : { terminalAt }),
    ...(handoffConfirmedAt === undefined ? {} : { handoffConfirmedAt }),
  }
}

export function getSessionRetentionDeadline(checkpoint: SessionRetentionCheckpoint): number | undefined {
  if (checkpoint.terminalAt === undefined || checkpoint.handoffConfirmedAt === undefined) return undefined
  return Math.max(checkpoint.terminalAt, checkpoint.handoffConfirmedAt) + TASK_CLEANUP_DELAY_MS
}

export class SessionOperationLeases {
  private readonly counts = new Map<string, number>()

  acquire(sessionID: string): () => void {
    this.counts.set(sessionID, (this.counts.get(sessionID) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const count = this.counts.get(sessionID) ?? 0
      if (count <= 1) this.counts.delete(sessionID)
      else this.counts.set(sessionID, count - 1)
    }
  }

  hasActive(sessionID: string): boolean {
    return (this.counts.get(sessionID) ?? 0) > 0
  }
}

export const sessionOperationLeases = new SessionOperationLeases()

export async function writeSessionRetentionCheckpoint(
  client: OpencodeClient,
  checkpoint: SessionRetentionCheckpoint,
  directory?: string,
): Promise<boolean> {
  const part = withInternalNoReplyMarker({
    ...createInternalAgentTextPart("Session retention checkpoint"),
    synthetic: true,
    metadata: { [SESSION_RETENTION_METADATA_KEY]: checkpoint },
  })
  const result = await dispatchInternalPrompt({
    mode: "async",
    client,
    sessionID: checkpoint.sessionID,
    source: "session-retention-checkpoint",
    dedupeKey: `session-retention-checkpoint:${JSON.stringify(checkpoint)}`,
    queueBehavior: "enqueue",
    settleMs: 0,
    checkStatus: false,
    checkToolState: false,
    input: {
      path: { id: checkpoint.sessionID },
      body: { noReply: true, parts: [part] },
      ...(directory === undefined ? {} : { query: { directory } }),
    },
  })
  return isInternalPromptDispatchAccepted(result)
}

function responseError(response: unknown): unknown | undefined {
  if (!isRecord(response) || response.error === undefined || response.error === null) return undefined
  return response.error
}

function responseData(response: unknown): unknown {
  return isRecord(response) && "data" in response ? response.data : response
}

function isConfirmedMissing(value: unknown): boolean {
  const error = responseError(value) ?? value
  if (extractErrorName(error) === "ProviderModelNotFoundError") return false
  return extractErrorStatusCode(value) === 404 || extractErrorStatusCode(error) === 404
}

export async function readSessionRetentionCheckpoint(
  client: OpencodeClient,
  sessionID: string,
  directory?: string,
): Promise<SessionRetentionReadResult> {
  try {
    const response = await client.session.messages({
      path: { id: sessionID },
      ...(directory === undefined ? {} : { query: { directory } }),
    })
    if (responseError(response) !== undefined) {
      return isConfirmedMissing(response) ? { status: "missing" } : { status: "unavailable" }
    }
    const messages = responseData(response)
    if (!Array.isArray(messages)) return { status: "unavailable" }

    for (const message of messages.toReversed()) {
      if (!isRecord(message) || !Array.isArray(message.parts)) continue
      for (const part of message.parts.toReversed()) {
        if (!isRecord(part) || !isRecord(part.metadata)) continue
        if (!Object.hasOwn(part.metadata, SESSION_RETENTION_METADATA_KEY)) continue
        const checkpoint = parseSessionRetentionCheckpoint(part.metadata[SESSION_RETENTION_METADATA_KEY])
        return checkpoint === undefined ? { status: "unavailable" } : { status: "checkpoint", checkpoint }
      }
    }
    return { status: "none" }
  } catch (error) {
    return isConfirmedMissing(error) ? { status: "missing" } : { status: "unavailable" }
  }
}

export async function deleteSessionIfEligible(input: {
  readonly client: OpencodeClient
  readonly checkpoint: SessionRetentionCheckpoint
  readonly leases: SessionOperationLeases
  readonly directory?: string
  readonly now?: number
}): Promise<SessionRetentionResult> {
  const { checkpoint } = input
  if (!checkpoint.autoDelete) return { status: "preserved", reason: "auto-delete-disabled" }
  const deadline = getSessionRetentionDeadline(checkpoint)
  if (deadline === undefined) return { status: "preserved", reason: "missing-timestamp" }
  if ((input.now ?? Date.now()) < deadline) return { status: "preserved", reason: "before-deadline", retryAt: deadline }
  if (input.leases.hasActive(checkpoint.sessionID)) return { status: "preserved", reason: "active-operation" }

  const request = {
    path: { id: checkpoint.sessionID },
    ...(input.directory === undefined ? {} : { query: { directory: input.directory } }),
  }
  try {
    const getResponse = await input.client.session.get(request)
    if (responseError(getResponse) !== undefined) {
      return isConfirmedMissing(getResponse) ? { status: "missing" } : { status: "preserved", reason: "native-check-failed" }
    }
    if (!isRecord(responseData(getResponse))) return { status: "preserved", reason: "native-check-failed" }

    const childrenResponse = await input.client.session.children(request)
    if (responseError(childrenResponse) !== undefined) {
      return isConfirmedMissing(childrenResponse) ? { status: "missing" } : { status: "preserved", reason: "native-check-failed" }
    }
    const children = responseData(childrenResponse)
    if (!Array.isArray(children)) return { status: "preserved", reason: "native-check-failed" }
    if (children.length > 0) return { status: "preserved", reason: "has-children" }
    if (input.leases.hasActive(checkpoint.sessionID)) return { status: "preserved", reason: "active-operation" }

    const deleteResponse = await input.client.session.delete(request)
    if (responseError(deleteResponse) !== undefined) {
      return isConfirmedMissing(deleteResponse) ? { status: "missing" } : { status: "preserved", reason: "delete-failed" }
    }
    return responseData(deleteResponse) === true
      ? { status: "deleted" }
      : { status: "preserved", reason: "delete-failed" }
  } catch (error) {
    return isConfirmedMissing(error) ? { status: "missing" } : { status: "preserved", reason: "native-check-failed" }
  }
}

export async function reconcileSessionRetention(input: {
  readonly client: OpencodeClient
  readonly sessionID: string
  readonly leases: SessionOperationLeases
  readonly directory?: string
  readonly now?: number
}): Promise<SessionRetentionResult> {
  const read = await readSessionRetentionCheckpoint(input.client, input.sessionID, input.directory)
  if (read.status === "missing") return { status: "missing" }
  if (read.status !== "checkpoint") return { status: "preserved", reason: read.status }
  return deleteSessionIfEligible({ ...input, checkpoint: read.checkpoint })
}

export type SessionRetentionReconciliationReport = {
  readonly status: "completed" | "disabled" | "unavailable"
  readonly scanned: number
  readonly deleted: number
  readonly missing: number
  readonly preserved: number
}

export async function reconcilePersistedSessionRetention(input: {
  readonly client: OpencodeClient
  readonly leases: SessionOperationLeases
  readonly autoDelete: boolean
  readonly directory?: string
  readonly now?: number
}): Promise<SessionRetentionReconciliationReport> {
  const emptyReport = { scanned: 0, deleted: 0, missing: 0, preserved: 0 }
  if (!input.autoDelete) return { status: "disabled", ...emptyReport }

  let response: unknown
  try {
    response = await input.client.session.list()
  } catch {
    return { status: "unavailable", ...emptyReport }
  }
  if (responseError(response) !== undefined) return { status: "unavailable", ...emptyReport }

  const sessions = responseData(response)
  if (!Array.isArray(sessions)) return { status: "unavailable", ...emptyReport }
  const sessionIDs = [...new Set(sessions.flatMap((session) => (
    isRecord(session) && typeof session.id === "string" && session.id.length > 0
      ? [session.id]
      : []
  )))]
  let deleted = 0
  let missing = 0
  let preserved = 0
  for (const sessionID of sessionIDs) {
    const result = await reconcileSessionRetention({
      client: input.client,
      sessionID,
      leases: input.leases,
      directory: input.directory,
      now: input.now,
    })
    if (result.status === "deleted") deleted += 1
    else if (result.status === "missing") missing += 1
    else preserved += 1
  }
  return {
    status: "completed",
    scanned: sessionIDs.length,
    deleted,
    missing,
    preserved,
  }
}
