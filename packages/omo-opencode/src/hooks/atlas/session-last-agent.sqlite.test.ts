export {}
const { describe, expect, test } = require("bun:test")

const { getLastAgentFromSession } = await import("./session-last-agent")

describe("getLastAgentFromSession SQLite backend ordering", () => {
  test("uses only the session path when bounded request options are omitted", async () => {
    // given
    const calls: Array<{
      readonly path: { readonly id: string }
      readonly query?: { readonly directory: string; readonly limit: number }
    }> = []
    const client = {
      session: {
        messages: async (input: {
          readonly path: { readonly id: string }
          readonly query?: { readonly directory: string; readonly limit: number }
        }) => {
          calls.push(input)
          return { data: [] }
        },
      },
    }

    // when
    await getLastAgentFromSession("ses_default_request", client, { isSqliteBackend: () => true })

    // then
    expect(calls).toEqual([{ path: { id: "ses_default_request" } }])
  })

  test("uses the session path with directory and limit for a bounded request", async () => {
    // given
    const calls: Array<{
      readonly path: { readonly id: string }
      readonly query?: { readonly directory: string; readonly limit: number }
    }> = []
    const client = {
      session: {
        messages: async (input: {
          readonly path: { readonly id: string }
          readonly query?: { readonly directory: string; readonly limit: number }
        }) => {
          calls.push(input)
          return { data: [] }
        },
      },
    }

    // when
    await getLastAgentFromSession(
      "ses_bounded_request",
      client,
      { isSqliteBackend: () => true },
      { directory: "C:/work/project", limit: 20 },
    )

    // then
    expect(calls).toEqual([
      {
        path: { id: "ses_bounded_request" },
        query: { directory: "C:/work/project", limit: 20 },
      },
    ])
  })

  test("treats a bounded empty response as authoritative on the legacy backend", async () => {
    // given
    let messageCalls = 0
    let messageDirCalls = 0
    const client = {
      session: {
        messages: async () => {
          messageCalls += 1
          return { data: [] }
        },
      },
    }

    // when
    const result = await getLastAgentFromSession(
      "ses_bounded_legacy_empty",
      client,
      {
        isSqliteBackend: () => false,
        getMessageDir: () => {
          messageDirCalls += 1
          return null
        },
      },
      { directory: "C:/work/project", limit: 20 },
    )

    // then
    expect(result).toBeNull()
    expect(messageCalls).toBe(1)
    expect(messageDirCalls).toBe(0)
  })

  test("returns newest non-compaction agent using time.created and id tie-breaker", async () => {
    // given
    const client = {
      session: {
        messages: async () => ({
          data: [
            { id: "msg_0001", info: { agent: "atlas", time: { created: 100 } } },
            { id: "msg_0003", info: { agent: "compaction", time: { created: 200 } } },
            { id: "msg_0002", info: { agent: "sisyphus-junior", time: { created: 100 } } },
          ],
        }),
      },
    }

    // when
    const result = await getLastAgentFromSession("ses_sqlite_last_agent", client as never, {
      isSqliteBackend: () => true,
    })

    // then
    expect(result).toBe("sisyphus-junior")
  })

  test("handles equal timestamps with random-looking ids deterministically", async () => {
    // given
    const client = {
      session: {
        messages: async () => ({
          data: [
            { id: "msg_a91f00ab", info: { agent: "atlas", time: { created: 100 } } },
            { id: "msg_f0e1d2c3", info: { agent: "compaction", time: { created: 200 } } },
            { id: "msg_d4c3b2a1", info: { agent: "sisyphus-junior", time: { created: 100 } } },
          ],
        }),
      },
    }

    // when
    const result = await getLastAgentFromSession("ses_sqlite_last_agent_equal_time", client as never, {
      isSqliteBackend: () => true,
    })

    // then
    expect(result).toBe("sisyphus-junior")
  })

  test("skips compaction marker user messages that retain the original agent", async () => {
    // given
    const client = {
      session: {
        messages: async () => ({
          data: [
            { id: "msg_real", info: { agent: "sisyphus", time: { created: 100 } } },
            {
              id: "msg_compaction",
              info: { agent: "atlas", time: { created: 200 } },
              parts: [{ type: "compaction" }],
            },
          ],
        }),
      },
    }

    // when
    const result = await getLastAgentFromSession("ses_sqlite_compaction_marker", client as never, {
      isSqliteBackend: () => true,
    })

    // then
    expect(result).toBe("sisyphus")
  })

  test("returns null instead of throwing when SQLite message lookup fails", async () => {
    // given
    const client = {
      session: {
        messages: async () => {
          throw new Error("sqlite lookup failed")
        },
      },
    }

    // when
    const result = await getLastAgentFromSession("ses_sqlite_error", client as never, {
      isSqliteBackend: () => true,
    })

    // then
    expect(result).toBeNull()
  })
})
