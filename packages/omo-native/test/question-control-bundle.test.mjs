import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareQuestionControl, questionControlBundleTarget } from "../bin/lib/question-control.js"
import { extensionBase, writeQuestionFixture } from "./question-control.fixture.mjs"

const { createPendingQuestion } = await import(new URL("builtin/ask-user/pending.js", extensionBase).href)
const { formatUserMessage } = await import(new URL("builtin/ask-user/format.js", extensionBase).href)
const { releaseQuestionInput } = await import(new URL("../question-input.js", extensionBase).href)
const { WAKE_SOURCE_STATE_EVENT } = await import(new URL("builtin/monitor-state-event.js", extensionBase).href)
const roots = []
const pending = []
afterEach(() => {
  for (const cancel of pending.splice(0)) cancel()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omo-question-bundle-"))
  roots.push(root)
  writeQuestionFixture(root, { bundled: true })
  return root
}
function runtime(root) {
  prepareQuestionControl(root)
  const source = readFileSync(join(root, questionControlBundleTarget), "utf8")
  const registry = source.slice(source.indexOf("var sessions=new Map,outcomes=new Map;"), source.indexOf("function copyAnswers("))
  const tool = source.slice(source.indexOf("function deliverAnswer("), source.indexOf("function createAskUserTool("))
  const runnerStart = source.indexOf("createContext(exclude")
  const runner = source.slice(runnerStart, source.indexOf("createToolContext(", runnerStart))
  // These are the actual prelinked owner functions, not separately implemented stand-ins.
  return new Function("createPendingQuestion", "formatUserMessage", "releaseQuestionInput", "WAKE_SOURCE_STATE_EVENT", `
    ${registry}${tool}
    return { startQuestion, getPendingQuestions, deliverQueuedQuestionOutcomes,
      createContext: ({${runner}}).createContext };
  `)(createPendingQuestion, formatUserMessage, releaseQuestionInput, WAKE_SOURCE_STATE_EVENT)
}
function owner(runtime, sessionId) {
  const events = []
  const messages = []
  const ui = []
  let onAsked
  const runner = {
    sessionManager: { getSessionId: () => sessionId },
    assertActive() { if (this.stale) throw new Error("stale context") },
    isIdleFn: () => true,
    uiContext: { notify() {}, question(request, options) {
      const result = Promise.withResolvers()
      ui.push({ result, options })
      return result.promise
    } },
  }
  const ctx = runtime.createContext.call(runner)
  const pi = { appendEntry() {}, sendUserMessage: (...args) => messages.push(args), events: { emit(name, value) {
    events.push({ name, value })
    if (name === "ask-user:asked") onAsked?.()
    if (name === "ask-user:closed") expect(ctx.questions.getPending()).toEqual([])
  } } }
  pending.push(() => { for (const entry of runtime.getPendingQuestions(sessionId)) entry.cancel() })
  return { runner, ctx, pi, events, messages, ui, onAsked: (fn) => { onAsked = fn } }
}
const request = (waitForAnswer) => ({
  requestId: "question", waitForAnswer, timeoutMs: 60_000,
  questions: [{ id: "q", header: "Q", question: "Choose", multiSelect: false, options: [{ label: "A" }, { label: "B" }] }],
})
const answer = { requestId: "question", answers: { q: { selected: ["A"] } } }

for (const wait of [true, false]) {
  test(`prelinked waitForAnswer=${wait} shares registry, guarded facade, UI completion and exactly-once delivery`, async () => {
    const r = runtime(fixture())
    const a = owner(r, "a")
    const b = owner(r, "b")
    const completion = r.startQuestion(a.pi, a.ctx, request(wait), undefined, {}, "codex")
    expect(b.ctx.questions.respond(answer)).toEqual({ success: false, error: "unknown_request" })
    const snapshot = a.ctx.questions.getPending()
    snapshot[0].questions[0].options[0].label = "bad"
    expect(a.ctx.questions.respond({ ...answer, answers: { q: { selected: ["bad"] } } }).error).toBe("invalid_response")
    expect(a.ctx.questions.respond(answer).success).toBe(true)
    expect((await completion).resolvedBy).toBe("rpc_connection")
    expect(a.ui[0].options.signal.aborted).toBe(true)
    expect(a.ui[0].options.signal.reason).toBe("answered")
    a.ui[0].result.resolve({ status: "cancelled", answers: {}, unanswered: ["q"] })
    await a.ui[0].result.promise
    expect(a.ctx.questions.respond(answer).error).toBe("unknown_request")
    expect(a.events.filter(({ name }) => name === "ask-user:closed")).toHaveLength(1)
    expect(a.messages).toHaveLength(wait ? 0 : 1)
    const captured = a.ctx.questions
    a.runner.stale = true
    expect(() => captured.getPending()).toThrow("stale context")
  })

  test(`prelinked arrival observer can settle waitForAnswer=${wait} before UI attachment`, async () => {
    const r = runtime(fixture())
    const a = owner(r, "a")
    a.onAsked(() => expect(a.ctx.questions.respond(answer).success).toBe(true))
    expect((await r.startQuestion(a.pi, a.ctx, request(wait), undefined, {}, "codex")).status).toBe("answered")
    expect(a.ui).toHaveLength(0)
    expect(a.events.filter(({ name }) => name === "herdr:blocked").map(({ value }) => value.active)).toEqual([true, false])
  })
}

test("prelinked detached timeout delivers once through the rebound owner", async () => {
  const r = runtime(fixture())
  const a = owner(r, "a")
  const completion = r.startQuestion(a.pi, a.ctx, request(false), undefined, {}, "codex")
  const entry = r.getPendingQuestions("a")[0]
  entry.detach()
  a.runner.stale = true
  entry.pending.timeout()
  expect((await completion).status).toBe("timed_out")
  const b = owner(r, "a")
  r.deliverQueuedQuestionOutcomes("a", b.pi, b.ctx)
  r.deliverQueuedQuestionOutcomes("a", b.pi, b.ctx)
  expect(a.messages).toHaveLength(0)
  expect(b.messages).toHaveLength(1)
})

test("prelinked preparation revalidates byte-stable output and rejects mutations", () => {
  const root = fixture()
  prepareQuestionControl(root)
  const path = join(root, questionControlBundleTarget)
  const first = readFileSync(path, "utf8")
  prepareQuestionControl(root)
  expect(readFileSync(path, "utf8")).toBe(first)
  writeFileSync(path, first.replace("get questions(){", "get renamedQuestions(){"))
  expect(() => prepareQuestionControl(root)).toThrow("question_control_incompatible")
})
