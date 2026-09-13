import { isRecord } from "@oh-my-opencode/utils"
import { extractErrorMessage, extractErrorName, extractErrorStatusCode } from "../../features/background-agent/error-classifier"

export class SessionNotFoundError extends Error {
  override readonly name = "SessionNotFoundError"

  constructor(readonly sessionID: string, cause: unknown) {
    super(`SessionNotFoundError: ${extractErrorMessage(cause) ?? "Session not found"}\n\nSession ID: ${sessionID}`, { cause })
  }
}

export function getSessionNotFoundError(value: unknown, sessionID: string): SessionNotFoundError | null {
  if (value instanceof SessionNotFoundError) return value
  const error = isRecord(value) && value.error != null ? value.error : value
  const name = extractErrorName(error)
  if (name === "ProviderModelNotFoundError") return null
  if (name !== "NotFoundError" && extractErrorStatusCode(value) !== 404 && extractErrorStatusCode(error) !== 404) return null
  return new SessionNotFoundError(sessionID, error)
}

export function isSessionNotFoundPollError(error: string): boolean {
  return error.startsWith("SessionNotFoundError:")
}
