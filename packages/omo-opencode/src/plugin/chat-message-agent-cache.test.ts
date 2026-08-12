import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import type { OhMyOpenCodeConfig } from "../config"
import { _resetForTesting, getOrLoadSessionAgent } from "../features/claude-code-session-state"
import { createChatMessageHandler } from "./chat-message"
import type { PluginContext } from "./types"

const originalXdgCacheHome = process.env.XDG_CACHE_HOME
let cacheRoot = ""

describe("createChatMessageHandler session agent cache", () => {
  beforeEach(() => {
    _resetForTesting()
    cacheRoot = mkdtempSync(join(tmpdir(), "omo-chat-agent-cache-"))
    process.env.XDG_CACHE_HOME = cacheRoot
  })

  afterEach(() => {
    _resetForTesting()
    if (originalXdgCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME
    } else {
      process.env.XDG_CACHE_HOME = originalXdgCacheHome
    }
    rmSync(cacheRoot, { recursive: true, force: true })
  })

  it("#given a negative cached agent #when chat.message carries a live agent #then later loads skip fallback", async () => {
    // given
    const sessionID = "ses-chat-live"
    let fallbackCalls = 0
    const fallback = async () => {
      fallbackCalls += 1
      return null
    }
    await getOrLoadSessionAgent(sessionID, fallback)
    const handler = createChatMessageHandler({
      ctx: unsafeTestValue<PluginContext>({
        directory: cacheRoot,
        client: { tui: { showToast: async () => undefined } },
      }),
      pluginConfig: unsafeTestValue<OhMyOpenCodeConfig>({}),
      firstMessageVariantGate: {
        shouldOverride: () => false,
        markApplied: () => undefined,
      },
      hooks: {},
    })

    // when
    await handler(
      { sessionID, agent: "hephaestus" },
      { message: {}, parts: [{ type: "text", text: "continue" }] },
    )
    const agent = await getOrLoadSessionAgent(sessionID, fallback)

    // then
    expect(agent).toBe("hephaestus")
    expect(fallbackCalls).toBe(1)
  })
})
