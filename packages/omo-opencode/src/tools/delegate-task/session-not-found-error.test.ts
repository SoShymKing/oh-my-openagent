import { expect, test } from "bun:test"
import { getSessionNotFoundError } from "./session-not-found-error"

test.each([
  { name: "ProviderModelNotFoundError", status: 404 },
  { error: { name: "ProviderModelNotFoundError" }, response: { status: 404 } },
  new Error("model not found", { cause: { body: { name: "ProviderModelNotFoundError", data: { message: "model not found" } }, status: 404 } }),
  new Error("model not found"),
  new Error("file missing"),
  { data: {} },
  { error: { name: "APIError" }, response: { status: 503 } },
])("#given non-session error %j #when classifying #then not deletion", (error) => {
  expect(getSessionNotFoundError(error, "ses_test")).toBeNull()
})

test.each([
  { name: "NotFoundError" },
  Object.assign(new Error("session missing"), { name: "NotFoundError" }),
  { status: 404 },
  { error: { name: "NotFoundError" }, response: { status: 404 } },
  new Error("Session record missing", { cause: { body: { name: "NotFoundError", data: { message: "Session record missing" } }, status: 404 } }),
])("#given explicit deletion %j #when classifying #then session and cause survive", (error) => {
  const result = getSessionNotFoundError(error, "ses_test")
  expect(result?.sessionID).toBe("ses_test")
  expect(result?.cause).toBe("error" in error ? error.error : error)
})
