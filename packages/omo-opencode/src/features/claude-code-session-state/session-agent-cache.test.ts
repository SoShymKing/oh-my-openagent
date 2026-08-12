import { beforeEach, describe, expect, it } from "bun:test"

import {
  _resetForTesting,
  clearSessionAgent,
  getOrLoadSessionAgent,
  getSessionAgent,
  updateSessionAgent,
} from "./state"

describe("session agent cache", () => {
  beforeEach(() => {
    _resetForTesting()
  })

  it("#given a cached agent #when loading it #then it skips the loader", async () => {
    // given
    let loaderCalls = 0
    updateSessionAgent("ses-hit", "atlas")

    // when
    const agent = await getOrLoadSessionAgent("ses-hit", async () => {
      loaderCalls += 1
      return "sisyphus"
    })

    // then
    expect(agent).toBe("atlas")
    expect(loaderCalls).toBe(0)
  })

  it("#given concurrent cache misses #when loading an agent #then they share one loader call", async () => {
    // given
    const load = Promise.withResolvers<string | null>()
    let loaderCalls = 0
    const loader = () => {
      loaderCalls += 1
      return load.promise
    }

    // when
    const first = getOrLoadSessionAgent("ses-single-flight", loader)
    const second = getOrLoadSessionAgent("ses-single-flight", loader)
    load.resolve("atlas")

    // then
    await expect(Promise.all([first, second])).resolves.toEqual(["atlas", "atlas"])
    expect(loaderCalls).toBe(1)
  })

  it("#given a loader returns no agent #when loading again #then it retains the negative result", async () => {
    // given
    let loaderCalls = 0
    const loader = async () => {
      loaderCalls += 1
      return null
    }

    // when
    const first = await getOrLoadSessionAgent("ses-empty", loader)
    const second = await getOrLoadSessionAgent("ses-empty", loader)

    // then
    expect([first, second]).toEqual([null, null])
    expect(loaderCalls).toBe(1)
  })

  it("#given a loader rejects #when loading again #then it retains a negative result", async () => {
    // given
    let loaderCalls = 0
    const loader = async (): Promise<string | null> => {
      loaderCalls += 1
      throw new Error("history unavailable")
    }

    // when
    const first = await getOrLoadSessionAgent("ses-error", loader)
    const second = await getOrLoadSessionAgent("ses-error", loader)

    // then
    expect([first, second]).toEqual([null, null])
    expect(loaderCalls).toBe(1)
  })

  it("#given a pending fallback #when a live agent update arrives #then the live agent wins", async () => {
    // given
    const load = Promise.withResolvers<string | null>()
    const fallback = getOrLoadSessionAgent("ses-live", () => load.promise)

    // when
    updateSessionAgent("ses-live", "hephaestus")
    load.resolve("atlas")

    // then
    await fallback
    expect(getSessionAgent("ses-live")).toBe("hephaestus")
  })

  it("#given a pending fallback #when the session is cleared #then a fresh lookup replaces stale completion", async () => {
    // given
    const staleLoad = Promise.withResolvers<string | null>()
    const staleFallback = getOrLoadSessionAgent("ses-cleared", () => staleLoad.promise)
    clearSessionAgent("ses-cleared")

    // when
    const freshFallback = getOrLoadSessionAgent("ses-cleared", async () => "sisyphus")
    staleLoad.resolve("atlas")

    // then
    await expect(freshFallback).resolves.toBe("sisyphus")
    await staleFallback
    expect(getSessionAgent("ses-cleared")).toBe("sisyphus")
  })

  it("#given a negative loader result #when state resets #then a fresh lookup can load an agent", async () => {
    // given
    await getOrLoadSessionAgent("ses-reset", async () => null)

    // when
    _resetForTesting()
    const agent = await getOrLoadSessionAgent("ses-reset", async () => "prometheus")

    // then
    expect(agent).toBe("prometheus")
  })
})
