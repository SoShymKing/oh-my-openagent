import { describe, expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { getSessionNotFoundError } from "../../tools/delegate-task/session-not-found-error"
import { extractErrorName, extractErrorStatusCode } from "./error-classifier"

describe("SDK error extraction", () => {
  test.each([
    { body: { name: "NotFoundError", data: { message: "gone" } }, status: 404, name: "NotFoundError", missing: true },
    { body: {}, status: 404, name: "Error", missing: true },
    { body: null, status: 404, name: "Error", missing: true },
    { body: "", status: 404, name: "Error", missing: true },
    { body: "gone", status: 404, name: "Error", missing: true },
    { body: { name: "ProviderModelNotFoundError", data: { providerID: "p", modelID: "m", suggestions: ["available"] } }, status: 404, name: "ProviderModelNotFoundError", missing: false },
    { body: { name: "APIError", data: { message: "busy" } }, status: 503, name: "APIError", missing: false },
    { body: null, status: 403, name: "Error", missing: false },
  ])("preserves $name and HTTP $status from SDK body $body", async ({ body, status, name, missing }) => {
    // given
    const client = createOpencodeClient({
      baseUrl: "http://sdk.invalid",
      fetch: async () => Response.json(body, { status }),
    })
    // when
    const error: unknown = await client.session.get({ path: { id: "deleted" }, throwOnError: true })
      .then(() => undefined, (rejected: unknown) => rejected)
    // then
    expect(error).toBeInstanceOf(Error)
    expect(extractErrorName(error)).toBe(name)
    expect(extractErrorStatusCode(error)).toBe(status)
    expect(getSessionNotFoundError(error, "deleted") !== null).toBe(missing)
  })

  test.each([
    { error: { name: "ProviderModelNotFoundError" }, response: { status: 404 } },
    { name: "Error", error: { name: "ProviderModelNotFoundError" }, response: { status: 404 } },
  ])("preserves provider identity in envelope %#", (envelope) => {
    // given / when
    const name = extractErrorName(envelope)
    // then
    expect(name).toBe("ProviderModelNotFoundError")
    expect(extractErrorStatusCode(envelope)).toBe(404)
    expect(getSessionNotFoundError(envelope, "existing")).toBeNull()
  })

  test("keeps specific outer names ahead of nested causes", () => {
    // given
    const error = new TypeError("bad input", { cause: { body: { name: "NotFoundError" }, status: 400 } })
    // when / then
    expect(extractErrorName(error)).toBe("TypeError")
  })

  test.each([
    { value: { statusCode: 429, status: 401, response: { status: 502 }, cause: { status: 404 } }, expected: 429 },
    { value: { status: "401", response: { status: 502 }, cause: { status: 404 } }, expected: 401 },
    { value: { response: { status: 502 }, cause: { status: 404 } }, expected: 502 },
    { value: { cause: { status: "503" } }, expected: 503 },
    { value: { cause: { status: 999 } }, expected: undefined },
  ])("preserves HTTP status precedence %#", ({ value, expected }) => {
    // given / when / then
    expect(extractErrorStatusCode(value)).toBe(expected)
  })

  test("does not recurse through cyclic unknown wrappers", () => {
    // given
    const error: Record<string, unknown> = { name: "Error" }
    error.error = error
    error.cause = { body: error }
    // when / then
    expect(extractErrorName(error)).toBe("Error")
    expect(extractErrorStatusCode(error)).toBeUndefined()
  })
})
