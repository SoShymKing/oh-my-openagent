import { beforeEach, describe, expect, it } from "bun:test"

import { _resetForTesting, updateSessionAgent } from "../claude-code-session-state"
import { buildTuiRuntimeSnapshot } from "./snapshot-builder"
import type { TuiMirrorClient } from "./snapshot-builder"

type MessageInput = {
  readonly path: { readonly id: string }
  readonly query?: { readonly directory: string; readonly limit: number }
}

function createClient(loadMessages: (input: MessageInput) => Promise<unknown>): TuiMirrorClient {
  return {
    session: {
      status: async () => ({ data: {} }),
      messages: loadMessages,
    },
  }
}

function build(client: TuiMirrorClient, sessionID: string) {
  return buildTuiRuntimeSnapshot({
    client,
    projectDir: process.cwd(),
    backgroundManager: { getTasksSnapshot: () => [] },
    getStatuses: async () => ({ [sessionID]: { type: "running" } }),
  })
}

describe("TUI snapshot session agent cache", () => {
  beforeEach(() => {
    _resetForTesting()
  })

  it("#given a cached agent #when building a snapshot #then it makes zero message requests", async () => {
    // given
    let messageCalls = 0
    updateSessionAgent("ses-hit", "hephaestus")
    const client = createClient(async () => {
      messageCalls += 1
      return { data: [] }
    })

    // when
    const snapshot = await build(client, "ses-hit")

    // then
    expect(snapshot.activeAgents).toEqual([{ name: "hephaestus", status: "running" }])
    expect(messageCalls).toBe(0)
  })

  it("#given an uncached agent #when building twice #then one bounded request serves both builds", async () => {
    // given
    const calls: MessageInput[] = []
    const client = createClient(async (input) => {
      calls.push(input)
      return { data: [{ id: "msg-agent", info: { agent: "atlas", time: { created: 1 } } }] }
    })

    // when
    const first = await build(client, "ses-miss")
    const second = await build(client, "ses-miss")

    // then
    expect(first.activeAgents).toEqual([{ name: "atlas", status: "running" }])
    expect(second.activeAgents).toEqual(first.activeAgents)
    expect(calls).toEqual([
      {
        path: { id: "ses-miss" },
        query: { directory: process.cwd(), limit: 20 },
      },
    ])
  })

  it("#given an empty history miss #when building twice #then it does not retry", async () => {
    // given
    let messageCalls = 0
    const client = createClient(async () => {
      messageCalls += 1
      return { data: [] }
    })

    // when
    const first = await build(client, "ses-empty")
    const second = await build(client, "ses-empty")

    // then
    expect(first.activeAgents).toEqual([{ name: "ses-empty", status: "running" }])
    expect(second.activeAgents).toEqual(first.activeAgents)
    expect(messageCalls).toBe(1)
  })

  it("#given a history request error #when building twice #then it does not retry", async () => {
    // given
    let messageCalls = 0
    const client = createClient(async () => {
      messageCalls += 1
      throw new Error("history unavailable")
    })

    // when
    const first = await build(client, "ses-error")
    const second = await build(client, "ses-error")

    // then
    expect(first.activeAgents).toEqual([{ name: "ses-error", status: "running" }])
    expect(second.activeAgents).toEqual(first.activeAgents)
    expect(messageCalls).toBe(1)
  })

  it("#given concurrent builds for an uncached agent #when history is pending #then they share one request", async () => {
    // given
    const response = Promise.withResolvers<unknown>()
    const requestStarted = Promise.withResolvers<void>()
    const calls: MessageInput[] = []
    const client = createClient((input) => {
      calls.push(input)
      requestStarted.resolve()
      return response.promise
    })
    const first = build(client, "ses-concurrent")
    await requestStarted.promise

    // when
    const second = build(client, "ses-concurrent")
    response.resolve({ data: [{ id: "msg-agent", info: { agent: "atlas", time: { created: 1 } } }] })
    const snapshots = await Promise.all([first, second])

    // then
    expect(snapshots.map((snapshot) => snapshot.activeAgents)).toEqual([
      [{ name: "atlas", status: "running" }],
      [{ name: "atlas", status: "running" }],
    ])
    expect(calls).toEqual([
      {
        path: { id: "ses-concurrent" },
        query: { directory: process.cwd(), limit: 20 },
      },
    ])
  })

  it("#given a negative history result #when a live update arrives #then later builds use the live agent", async () => {
    // given
    let messageCalls = 0
    const client = createClient(async () => {
      messageCalls += 1
      return { data: [] }
    })
    await build(client, "ses-live")

    // when
    updateSessionAgent("ses-live", "prometheus")
    const snapshot = await build(client, "ses-live")

    // then
    expect(snapshot.activeAgents).toEqual([{ name: "prometheus", status: "running" }])
    expect(messageCalls).toBe(1)
  })
})
