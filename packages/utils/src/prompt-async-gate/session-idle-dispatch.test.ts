import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import {
  dispatchInternalPrompt,
  releaseAllPromptAsyncReservationsForTesting,
} from "../prompt-async-gate"

const routes = [
  { mode: "async", queueBehavior: "enqueue" },
  { mode: "async", queueBehavior: "defer" },
  { mode: "async", queue: false },
  { mode: "sync" },
] as const

describe("fulfilled prompt dispatch responses", () => {
  afterEach(() => {
    mock.restore()
    releaseAllPromptAsyncReservationsForTesting()
  })

  for (const route of routes) {
    describe(JSON.stringify(route), () => {
      const input = { path: { id: "ses_sdk_response" }, body: { parts: [] } }
      const options = {
        ...route,
        sessionID: input.path.id,
        input,
        source: "test:sdk-response",
        settleMs: 0,
        postDispatchHoldMs: 1_000,
        semanticDedupeHoldMs: 10_000,
      }

      test.each([
        { error: { name: "NotFoundError" }, response: { status: 404 } },
        {
          error: {
            name: "ProviderModelNotFoundError",
            data: { providerID: "provider", modelID: "missing", suggestions: ["available"] },
          },
          response: { status: 404 },
        },
      ])("#given fulfilled SDK error %j #when dispatched #then retains the failure envelope", async (envelope) => {
        const dispatch = mock(async () => envelope)
        const client = { session: { prompt: dispatch, promptAsync: dispatch } }
        const retryDispatchFailure = mock((_error: unknown) => false)

        const result = await dispatchInternalPrompt({
          ...options,
          client,
          retryDispatchFailure,
        })

        expect(result.status).toBe("failed")
        if (result.status !== "failed") throw new Error("Expected failed dispatch")
        expect(result.error).toBe(envelope)
        expect(result.dispatchAttempted).toBe(true)
        expect(result.queueRetryable).toBeUndefined()
        expect(retryDispatchFailure).toHaveBeenCalledWith(envelope)
        expect(dispatch).toHaveBeenCalledTimes(1)
      })

      test("#given rejected dispatch #when dispatched #then retains rejection identity", async () => {
        const error = new Error("transport rejected")
        const dispatch = mock(async () => { throw error })
        const client = { session: { prompt: dispatch, promptAsync: dispatch } }

        const result = await dispatchInternalPrompt({
          ...options,
          client,
        })

        expect(result).toEqual({ status: "failed", error, dispatchAttempted: true })
        if (result.status !== "failed") throw new Error("Expected failed dispatch")
        expect(result.error).toBe(error)
        expect(dispatch).toHaveBeenCalledTimes(1)
      })

      test.each([
        undefined,
        { data: undefined, response: { status: 204 } },
        false,
        { data: false },
        { data: false, error: undefined },
        { data: false, error: null },
      ])("#given successful response %j #when dispatched #then preserves success", async (response) => {
        const dispatch = mock(async () => response)
        const client = { session: { prompt: dispatch, promptAsync: dispatch } }

        const result = await dispatchInternalPrompt({
          ...options,
          client,
        })

        expect(result).toEqual({ status: "dispatched", response })
        expect(dispatch).toHaveBeenCalledTimes(1)
      })

      test("#given fulfilled failure #when another prompt arrives #then reservation holds", async () => {
        const dispatch = mock(async () => ({ error: { name: "NotFoundError" }, response: { status: 404 } }))
        const client = { session: { prompt: dispatch, promptAsync: dispatch } }
        await dispatchInternalPrompt({ ...options, client })

        const result = await dispatchInternalPrompt({
          ...options, client, queueBehavior: "defer", source: "test:other", dedupeKey: "different",
        })

        expect(result).toEqual({ status: "reserved", reservedBy: options.source })
        expect(dispatch).toHaveBeenCalledTimes(1)
      })

      test("#given fulfilled failure with expired reservation #when same prompt arrives #then semantic dedupe holds", async () => {
        const now = spyOn(Date, "now")
        now.mockReturnValue(100_000)
        const dispatch = mock(async () => ({ error: { name: "NotFoundError" }, response: { status: 404 } }))
        const client = { session: { prompt: dispatch, promptAsync: dispatch } }
        await dispatchInternalPrompt({ ...options, client })
        now.mockReturnValue(102_000)

        const result = await dispatchInternalPrompt({ ...options, client, source: "test:duplicate" })

        expect(result).toEqual({ status: "queued", queuedBy: options.source, position: 0 })
        expect(dispatch).toHaveBeenCalledTimes(1)
      })
    })
  }
})
