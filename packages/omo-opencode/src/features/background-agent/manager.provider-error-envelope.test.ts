import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { _resetMemCacheForTesting, writeProviderModelsCache } from "../../shared/connected-providers-cache"
import { releaseAllPromptAsyncReservationsForTesting } from "../../shared/prompt-async-gate"
import { BackgroundManager } from "./manager"
import { clearBackgroundTaskRegistryForTesting } from "./task-registry"
import type { BackgroundTask } from "./types"

let directory: string
let previousCacheHome: string | undefined
let manager: BackgroundManager | undefined

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "omo-provider-envelope-"))
  previousCacheHome = process.env.XDG_CACHE_HOME
  process.env.XDG_CACHE_HOME = directory
  _resetMemCacheForTesting()
  writeProviderModelsCache({ connected: ["p"], models: { p: ["available"] } })
})

afterEach(() => {
  manager?.shutdown()
  manager = undefined
  releaseAllPromptAsyncReservationsForTesting()
  clearBackgroundTaskRegistryForTesting()
  _resetMemCacheForTesting()
  if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = previousCacheHome
  rmSync(directory, { recursive: true, force: true })
})

describe("BackgroundManager fulfilled provider errors", () => {
  test.each(["launch", "resume"] as const)("uses available fallback after %s envelope failure", async (operation) => {
    // given
    const calls: Array<{ path: { id: string }; body?: { model?: { providerID: string; modelID: string } } }> = []
    let created = 0
    const client = {
      session: {
        get: async () => ({ data: { directory } }),
        create: async () => ({ data: { id: `child-${++created}` } }),
        status: async () => ({ data: {} }),
        messages: async () => ({ data: [] }),
        abort: async () => ({}),
        promptAsync: async (input: typeof calls[number]) => {
          calls.push(input)
          return calls.length === 1
            ? { error: { name: "ProviderModelNotFoundError", data: { providerID: "p", modelID: "m", suggestions: ["available"] } }, response: { status: 404 } }
            : { data: {} }
        },
      },
    }
    manager = new BackgroundManager({
      pluginContext: unsafeTestValue<PluginInput>({ client, directory }),
      enableParentSessionNotifications: false,
    })
    const input = {
      description: "provider envelope regression", prompt: "work", agent: "explore",
      parentSessionId: "parent", parentMessageId: "message",
      model: { providerID: "p", modelID: "m" },
      fallbackChain: [{ providers: ["p"], model: "available" }],
    }
    const completedTask: BackgroundTask = {
      ...input, id: "resume-task", sessionId: "completed-child", status: "completed",
      startedAt: new Date(), completedAt: new Date(), concurrencyGroup: "p/m",
    }
    if (operation === "resume") {
      unsafeTestValue<{ tasks: Map<string, BackgroundTask> }>(manager).tasks.set(completedTask.id, completedTask)
    }
    // when
    const result = operation === "launch"
      ? await manager.launch(input)
      : await manager.resume({ sessionId: "completed-child", prompt: "continue", parentSessionId: "parent", parentMessageId: "next" })
    for (let turn = 0; turn < 200; turn++) await Promise.resolve()
    const task = manager.getTask(result.id)
    // then
    expect(task?.status).toBe("running")
    expect(task?.attemptCount).toBe(1)
    expect(task?.model).toMatchObject({ providerID: "p", modelID: "available" })
    expect(calls).toHaveLength(2)
    expect(calls[1]?.body?.model).toEqual({ providerID: "p", modelID: "available" })
    expect(task?.sessionId).toBe(`child-${created}`)
    expect(created).toBe(operation === "launch" ? 2 : 1)
  })
})
