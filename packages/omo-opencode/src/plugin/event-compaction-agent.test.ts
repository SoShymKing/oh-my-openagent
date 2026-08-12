import { afterEach, describe, expect, it } from "bun:test"

import {
  _resetForTesting,
  getOrLoadSessionAgent,
  getSessionAgent,
  updateSessionAgent,
} from "../features/claude-code-session-state"
import { clearSessionModel, getSessionModel, setSessionModel } from "../shared/session-model-state"
import { clearSessionPromptParams } from "../shared/session-prompt-params-state"
import { createEventHandler } from "./event"

function createMinimalEventHandler() {
  return createEventHandler({
    ctx: {} as never,
    pluginConfig: {} as never,
    firstMessageVariantGate: {
      markSessionCreated: () => {},
      clear: () => {},
    },
    managers: {
      tmuxSessionManager: {
        onSessionCreated: async () => {},
        onSessionDeleted: async () => {},
      },
      skillMcpManager: {
        disconnectSession: async () => {},
      },
    } as never,
    hooks: {
      autoUpdateChecker: { event: async () => {} },
      claudeCodeHooks: { event: async () => {} },
      backgroundNotificationHook: { event: async () => {} },
      sessionNotification: async () => {},
      todoContinuationEnforcer: { handler: async () => {} },
      unstableAgentBabysitter: { event: async () => {} },
      directoryAgentsInjector: { event: async () => {} },
      directoryReadmeInjector: { event: async () => {} },
      rulesInjector: { event: async () => {} },
      thinkMode: { event: async () => {} },
      anthropicContextWindowLimitRecovery: { event: async () => {} },
      runtimeFallback: undefined,
      modelFallback: undefined,
      agentUsageReminder: { event: async () => {} },
      categorySkillReminder: { event: async () => {} },
      interactiveBashSession: { event: async () => {} },
      ralphLoop: { event: async () => {} },
      stopContinuationGuard: { event: async () => {}, isStopped: () => false },
      compactionTodoPreserver: { event: async () => {} },
      writeExistingFileGuard: { event: async () => {} },
      atlasHook: { handler: async () => {} },
    } as never,
  })
}

describe("createEventHandler compaction agent filtering", () => {
  afterEach(() => {
    _resetForTesting()
    clearSessionModel("ses_compaction_poisoning")
    clearSessionModel("ses_compaction_model_poisoning")
    clearSessionModel("ses_compaction_trim_poisoning")
    clearSessionPromptParams("ses_compaction_poisoning")
    clearSessionPromptParams("ses_compaction_model_poisoning")
    clearSessionPromptParams("ses_compaction_trim_poisoning")
  })

  it("does not overwrite the stored session agent with compaction", async () => {
    // given
    const sessionID = "ses_compaction_poisoning"
    updateSessionAgent(sessionID, "atlas")
    const eventHandler = createMinimalEventHandler()
    const input: Parameters<ReturnType<typeof createEventHandler>>[0] = {
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg-compaction",
            sessionID,
            role: "user",
            agent: "compaction",
            time: { created: Date.now() },
            model: { providerID: "anthropic", modelID: "claude-opus-4-7" },
          },
        },
      },
    }

    // when
    await eventHandler(input)

    // then
    expect(getSessionAgent(sessionID)).toBe("atlas")
  })

  it("#given no cached agent #when a normal user message update arrives #then it stores the live agent", async () => {
    // given
    const sessionID = "ses_live_agent_update"
    const eventHandler = createMinimalEventHandler()

    // when
    await eventHandler({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg-live-agent",
            sessionID,
            role: "user",
            agent: "hephaestus",
          },
        },
      },
    })

    // then
    expect(getSessionAgent(sessionID)).toBe("hephaestus")
  })

  it("#given a cached agent #when its session is deleted #then it clears the cache entry", async () => {
    // given
    const sessionID = "ses_deleted_agent"
    updateSessionAgent(sessionID, "atlas")
    const eventHandler = createMinimalEventHandler()

    // when
    await eventHandler({
      event: {
        type: "session.deleted",
        properties: { info: { id: sessionID } },
      },
    })

    // then
    expect(getSessionAgent(sessionID)).toBeUndefined()
  })

  it("#given a negative agent load #when its session is deleted #then the same id can load a fresh agent", async () => {
    // given
    const sessionID = "ses_deleted_negative_agent"
    let loadCalls = 0
    expect(await getOrLoadSessionAgent(sessionID, async () => {
      loadCalls += 1
      return null
    })).toBeNull()
    expect(loadCalls).toBe(1)

    // when
    await createMinimalEventHandler()({
      event: {
        type: "session.deleted",
        properties: { info: { id: sessionID } },
      },
    })
    const agent = await getOrLoadSessionAgent(sessionID, async () => {
      loadCalls += 1
      return "atlas"
    })

    // then
    expect(agent).toBe("atlas")
    expect(loadCalls).toBe(2)
  })

  it("does not overwrite the stored session model with compaction", async () => {
    // given
    const sessionID = "ses_compaction_model_poisoning"
    setSessionModel(sessionID, { providerID: "openai", modelID: "gpt-5" })
    const eventHandler = createMinimalEventHandler()
    const input: Parameters<ReturnType<typeof createEventHandler>>[0] = {
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg-compaction-model",
            sessionID,
            role: "user",
            agent: "compaction",
            providerID: "anthropic",
            modelID: "claude-opus-4-1",
            time: { created: Date.now() },
          },
        },
      },
    }

    // when
    await eventHandler(input)

    // then
    expect(getSessionModel(sessionID)).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    })
  })

  it("does not overwrite the stored session model with whitespace around compaction marker", async () => {
    // given
    const sessionID = "ses_compaction_trim_poisoning"
    setSessionModel(sessionID, { providerID: "openai", modelID: "gpt-5" })
    const eventHandler = createMinimalEventHandler()
    const input: Parameters<ReturnType<typeof createEventHandler>>[0] = {
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg-compaction-trim",
            sessionID,
            role: "user",
            agent: " compaction ",
            providerID: "anthropic",
            modelID: "claude-opus-4-1",
            time: { created: Date.now() },
          },
        },
      },
    }

    // when
    await eventHandler(input)

    // then
    expect(getSessionModel(sessionID)).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    })
  })
})
