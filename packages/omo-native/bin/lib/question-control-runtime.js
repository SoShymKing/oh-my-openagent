// Copied into the prepared engine; this static import shares the builtin registry in every bundle.
import { getPendingQuestions } from "./registry.js"

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const failure = (error) => ({ success: false, error })

export function createQuestionControl(sessionId) {
  return {
    getPending() {
      return getPendingQuestions(sessionId()).map(({ request, pending }) => JSON.parse(JSON.stringify({
        ...request,
        deadlineAtMs: pending.deadlineAtMs,
      })))
    },
    respond(input) {
      const entries = getPendingQuestions(sessionId())
      if (!record(input) || typeof input.requestId !== "string" || !input.requestId
        || Object.keys(input).some((key) => !["requestId", "answers", "comment", "cancelled"].includes(key))) {
        return failure("invalid_response")
      }
      const entry = entries.find(({ request }) => request.requestId === input.requestId)
      if (!entry) return failure("unknown_request")
      let response
      if (input.cancelled === true) {
        response = { status: "cancelled", answers: {}, unanswered: entry.request.questions.map(({ id }) => id) }
      } else {
        if ((input.cancelled !== undefined && input.cancelled !== false)
          || (input.comment !== undefined && typeof input.comment !== "string") || !record(input.answers)) {
          return failure("invalid_response")
        }
        const answers = {}
        for (const [id, answer] of Object.entries(input.answers)) {
          const question = entry.request.questions.find((question) => question.id === id)
          if (!question || !record(answer) || !Array.isArray(answer.selected)
            || Object.keys(answer).some((key) => key !== "selected" && key !== "text")
            || (answer.text !== undefined && typeof answer.text !== "string")
            || Array.from(answer.selected).some((label) => typeof label !== "string" || !question.options.some((option) => option.label === label))
            || new Set(answer.selected).size !== answer.selected.length
            || (!question.multiSelect && answer.selected.length > 1)) return failure("invalid_response")
          if (answer.selected.length || answer.text?.trim()) {
            Object.defineProperty(answers, id, { enumerable: true, configurable: true, writable: true, value: {
              selected: [...answer.selected],
              ...(answer.text !== undefined ? { text: answer.text } : {}),
            } })
          }
        }
        const hasComment = input.comment !== undefined && input.comment.trim() !== ""
        if (!Object.keys(answers).length && !hasComment) return failure("question_incomplete")
        response = {
          status: hasComment ? "comment-submitted" : "answered",
          resolvedBy: "rpc_connection",
          answers,
          ...(input.comment !== undefined ? { comment: input.comment } : {}),
          unanswered: entry.request.questions.filter(({ id }) => !Object.hasOwn(answers, id)).map(({ id }) => id),
        }
      }
      if (!entry.respond(response)) return failure("unknown_request")
      return { success: true, requestId: input.requestId, outcome: response.status }
    },
  }
}
