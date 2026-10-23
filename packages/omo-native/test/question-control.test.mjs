import { afterEach, describe, expect, test } from "bun:test"
import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { planQuestionControl, prepareQuestionControl, questionControlTargets } from "../bin/lib/question-control.js"
import { engineEntry, extensionBase, writeQuestionFixture } from "./question-control.fixture.mjs"

const roots = []
const sessions = []
afterEach(() => {
  for (const { registry, id } of sessions.splice(0)) for (const entry of registry.getPendingQuestions(id)) entry.cancel()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const ask = "dist/core/extensions/builtin/ask-user/"
const answer = { answers: { first: { selected: ["One"] } } }
const request = (waitForAnswer = true, requestId = "question-1") => ({
  requestId, waitForAnswer, timeoutMs: 60_000,
  questions: [
    { id: "first", header: "First", question: "Pick one", multiSelect: false, options: [{ label: "One" }, { label: "Two" }] },
    { id: "second", header: "Second", question: "Pick several", multiSelect: true, options: [{ label: "A" }, { label: "B" }] },
  ],
})

function fixture(prepared = true) {
  const root = mkdtempSync(join(tmpdir(), "omo-question-control-"))
  roots.push(root)
  writeQuestionFixture(root)
  if (prepared) prepareQuestionControl(root)
  return root
}

async function runtime(root = fixture()) {
  const registry = await import(pathToFileURL(join(root, ask, "registry.js")).href)
  const control = await import(pathToFileURL(join(root, ask, "question-control.js")).href)
  // Execute the complete actual builtin; only redirect its imports to the installed dependency
  // graph. The shared registry stays in this fixture, so tool and facade cannot pass independently.
  const toolPath = join(root, ask, "tool.js")
  const source = readFileSync(toolPath, "utf8").replace(/from "([^"]+)"/g, (all, specifier) => specifier === "./registry.js"
    ? all : `from "${new URL(specifier, new URL("builtin/ask-user/tool.js", extensionBase)).href}"`)
  writeFileSync(toolPath, source)
  const builtin = await import(pathToFileURL(toolPath).href)
  const runnerSource = readFileSync(join(root, "dist/core/extensions/runner.js"), "utf8")
  const method = runnerSource.slice(runnerSource.indexOf("    createContext("), runnerSource.indexOf("    /**\n     * Create the context for executing"))
  const createContext = new Function("createQuestionControl", `return ({${method}}).createContext`)(control.createQuestionControl)
  function owner(id = "session-a") {
    const events = []
    const entries = []
    const messages = []
    const notices = []
    const ui = []
    const listeners = new Map()
    const runner = {
      sessionManager: { getSessionId: () => id },
      assertActive() { if (this.stale) throw new Error("stale context") },
      uiContext: {
        notify: (...args) => notices.push(args),
        question(req, opts) {
          const result = Promise.withResolvers()
          const aborted = Promise.withResolvers()
          opts.signal.addEventListener("abort", () => aborted.resolve(opts.signal.reason), { once: true })
          ui.push({ req, opts, result, aborted: aborted.promise })
          return result.promise
        },
      },
      mode: "rpc", hasUI: () => true, isIdleFn: () => true,
      getAskUserSettingsFn: () => ({ enabled: true, timeoutMinutes: 30 }),
    }
    const ctx = createContext.call(runner)
    const pi = {
      events: { emit(name, event) {
        events.push({ name, event })
        for (const listener of listeners.get(name) ?? []) listener(event)
      } },
      appendEntry: (...args) => entries.push(args),
      sendUserMessage: (...args) => messages.push(args),
      getFlag: () => false,
      getActiveTools: () => [],
      setActiveTools() {},
    }
    const state = { timedOut: false, unavailable: false }
    sessions.push({ registry, id })
    return {
      ctx, pi, runner, state, events, entries, messages, notices, ui,
      on(name, listener) { listeners.set(name, [...(listeners.get(name) ?? []), listener]) },
      start(req = request(), signal) { return builtin.startQuestion(pi, ctx, req, signal, state, "codex") },
      closed() { return events.filter(({ name }) => name === "ask-user:closed") },
    }
  }
  return { owner, registry, builtin, createContext }
}

describe("session question control on actual pinned builtin code", () => {
  test("unprepared runner has no facade, while prepared runner has guarded access", async () => {
    const root = fixture(false)
    const source = readFileSync(join(root, "dist/core/extensions/runner.js"), "utf8")
    const method = source.slice(source.indexOf("    createContext("), source.indexOf("    /**\n     * Create the context for executing"))
    const unprepared = new Function(`return ({${method}}).createContext`)().call({})
    expect(unprepared.questions).toBeUndefined()
    prepareQuestionControl(root)
    const { owner } = await runtime(root)
    const a = owner()
    const captured = a.ctx.questions
    a.runner.stale = true
    expect(() => a.ctx.questions).toThrow("stale context")
    expect(() => captured.getPending()).toThrow("stale context")
    expect(() => captured.respond({ requestId: "question-1", ...answer })).toThrow("stale context")
  })

  for (const wait of [true, false]) {
    test(`actual builtin execute returns the authoritative waitForAnswer=${wait} result`, async () => {
      const { owner, builtin } = await runtime()
      const a = owner()
      const asked = Promise.withResolvers()
      a.on("ask-user:asked", asked.resolve)
      const tool = builtin.createAskUserTool("codex", a.pi, a.state)
      const result = tool.execute("question-1", {
        wait_for_answer: wait,
        questions: request().questions.map((question) => ({
          ...question, options: question.options.map((option) => ({ ...option, description: option.label })),
        })),
      }, undefined, undefined, a.ctx)
      await asked.promise
      if (!wait) expect((await result).details).toMatchObject({ accepted: true, status: "pending" })
      expect(a.ctx.questions.respond({ requestId: "question-1", ...answer }).success).toBe(true)
      if (wait) expect((await result).details).toMatchObject({ status: "answered" })
      expect(a.messages).toHaveLength(wait ? 0 : 1)
      expect(a.closed()).toHaveLength(1)
    })

    test(`facade settles waitForAnswer=${wait}, aborts original UI, removes before close and delivers once`, async () => {
      const { owner } = await runtime()
      const a = owner()
      const completion = a.start(request(wait))
      a.on("ask-user:closed", () => expect(a.ctx.questions.getPending()).toEqual([]))
      expect(a.ctx.questions.respond({ requestId: "question-1", ...answer })).toEqual({ success: true, requestId: "question-1", outcome: "answered" })
      expect(await completion).toMatchObject({ status: "answered", resolvedBy: "rpc_connection", unanswered: ["second"] })
      expect(await a.ui[0].aborted).toBe("answered")
      expect(a.closed()).toHaveLength(1)
      expect(a.messages).toHaveLength(wait ? 0 : 1)
      a.ui[0].result.resolve({ status: "cancelled", answers: {}, unanswered: ["first", "second"] })
      await a.ui[0].result.promise
      expect(a.ctx.questions.respond({ requestId: "question-1", ...answer })).toEqual({ success: false, error: "unknown_request" })
      expect(a.closed()).toHaveLength(1)
      expect(a.messages).toHaveLength(wait ? 0 : 1)
    })

    test(`arrival can synchronously respond in waitForAnswer=${wait} without a TDZ or late UI`, async () => {
      const { owner } = await runtime()
      const a = owner()
      a.on("ask-user:asked", () => expect(a.ctx.questions.respond({ requestId: "question-1", ...answer }).success).toBe(true))
      expect((await a.start(request(wait))).status).toBe("answered")
      expect(a.ui).toHaveLength(0)
      expect(a.closed()).toHaveLength(1)
      expect(a.events.filter(({ name }) => name === "herdr:blocked").map(({ event }) => event.active)).toEqual([true, false])
    })
  }

  test("snapshots are detached and scope follows the live runner session at call time", async () => {
    const { owner } = await runtime()
    const a = owner()
    a.start()
    const snapshot = a.ctx.questions.getPending()
    snapshot[0].questions[0].options[0].label = "corrupt"
    snapshot[0].requestId = "corrupt"
    expect(a.ctx.questions.getPending()[0]).toMatchObject({ requestId: "question-1", questions: [{ options: [{ label: "One" }, { label: "Two" }] }, {}] })
    expect(JSON.parse(JSON.stringify(a.ctx.questions.getPending()))).toEqual(a.ctx.questions.getPending())
    const captured = a.ctx.questions
    a.runner.sessionManager = { getSessionId: () => "session-b" }
    expect(captured.getPending()).toEqual([])
    expect(captured.respond({ requestId: "question-1", ...answer })).toEqual({ success: false, error: "unknown_request" })
  })

  test("invalid forms never mutate pending state or renew its deadline", async () => {
    const { owner, registry } = await runtime()
    const a = owner()
    a.start()
    const before = a.ctx.questions.getPending()
    for (const input of [
      null, [], {}, { requestId: 1 }, { requestId: "question-1" },
      { requestId: "question-1", answers: [] }, { requestId: "question-1", answers: {}, comment: 7 },
      { requestId: "question-1", answers: {}, cancelled: "yes" },
      { requestId: "question-1", answers: { missing: { selected: ["One"] } } },
      { requestId: "question-1", answers: { first: { selected: ["missing"] } } },
      { requestId: "question-1", answers: { first: { selected: ["One", "Two"] } } },
      { requestId: "question-1", answers: { first: { selected: ["One", "One"] } } },
      { requestId: "question-1", answers: { first: { selected: "One" } } },
      { requestId: "question-1", answers: { first: { selected: Array(1) } } },
      { requestId: "question-1", answers: { first: { selected: [], text: false } } },
      { requestId: "question-1", ...answer, resolvedBy: "local_ui" },
    ]) {
      expect(a.ctx.questions.respond(input)).toEqual({ success: false, error: "invalid_response" })
      expect(a.ctx.questions.getPending()).toEqual(before)
      expect(registry.getPendingQuestions("session-a")[0].pending.state).toBe("pending")
    }
    for (const answers of [{}, { first: { selected: [], text: " " } }]) {
      expect(a.ctx.questions.respond({ requestId: "question-1", answers, comment: " " })).toEqual({ success: false, error: "question_incomplete" })
    }
    expect(a.closed()).toHaveLength(0)
    expect(a.messages).toHaveLength(0)
  })

  for (const input of [
    { answers: {}, comment: "  only comment  " },
    { answers: { first: { selected: [], text: "  typed words  " } } },
    { answers: { second: { selected: ["A", "B"] } } },
    { ...answer, comment: "  comment  " },
  ]) {
    test(`accepts partial/comment/typed/multiselect ${JSON.stringify(input)}`, async () => {
      const { owner } = await runtime()
      const a = owner()
      const completion = a.start()
      expect(a.ctx.questions.respond({ requestId: "question-1", ...input }).success).toBe(true)
      const response = await completion
      expect(response.answers).toEqual(input.answers)
      expect(response.comment).toBe(input.comment)
      expect(response.resolvedBy).toBe("rpc_connection")
    })
  }

  test("local UI winner defeats a subsequent facade response", async () => {
    const { owner } = await runtime()
    const a = owner()
    const completion = a.start(request(false))
    a.ui[0].result.resolve({ status: "answered", ...answer, unanswered: ["second"], resolvedBy: "local_ui" })
    expect((await completion).resolvedBy).toBe("local_ui")
    expect(a.ctx.questions.respond({ requestId: "question-1", ...answer }).error).toBe("unknown_request")
    expect(a.messages).toHaveLength(1)
    expect(a.closed()).toHaveLength(1)
  })

  test("cancellation takes precedence and abort/timeout retain builtin ownership", async () => {
    const { owner, registry } = await runtime()
    const a = owner()
    const cancelled = a.start(request(false))
    expect(a.ctx.questions.respond({ requestId: "question-1", cancelled: true, answers: null, comment: 4 }).outcome).toBe("cancelled")
    expect((await cancelled).status).toBe("cancelled")
    expect(await a.ui[0].aborted).toBe("cancelled")
    expect(a.messages).toHaveLength(0)
    const signal = new AbortController()
    const aborted = a.start(request(true, "abort"), signal.signal)
    signal.abort()
    expect((await aborted).status).toBe("cancelled")
    const timeout = a.start(request(false, "timeout"))
    registry.getPendingQuestions("session-a")[0].pending.timeout()
    expect((await timeout).status).toBe("timed_out")
    expect(await a.ui[2].aborted).toBe("timed_out")
    expect(a.state.timedOut).toBe(true)
    expect(a.messages).toHaveLength(1)
    expect(a.closed()).toHaveLength(3)
  })

  test("reload detaches UI, rebinds delivery and ignores the old UI result", async () => {
    const { owner, registry } = await runtime()
    const a = owner()
    const completion = a.start(request(false))
    const entry = registry.getPendingQuestions("session-a")[0]
    const deadline = entry.pending.deadlineAtMs
    entry.detach()
    expect(await a.ui[0].aborted).toBe("reload")
    a.runner.stale = true
    const b = owner()
    entry.rebind(b.pi, b.ctx, b.state)
    entry.reattach()
    expect(entry.pending.deadlineAtMs).toBe(deadline)
    a.ui[0].result.resolve({ status: "cancelled", answers: {}, unanswered: ["first", "second"] })
    await a.ui[0].result.promise
    expect(b.ctx.questions.respond({ requestId: "question-1", ...answer }).success).toBe(true)
    expect((await completion).status).toBe("answered")
    expect(a.messages).toHaveLength(0)
    expect(b.messages).toHaveLength(1)
    expect(b.closed()).toHaveLength(1)
  })

  test("timeout while detached queues exactly one delivery for the replacement runner", async () => {
    const { owner, registry } = await runtime()
    const a = owner()
    const completion = a.start(request(false))
    const entry = registry.getPendingQuestions("session-a")[0]
    entry.detach()
    a.runner.stale = true
    entry.pending.timeout()
    expect((await completion).status).toBe("timed_out")
    const b = owner()
    expect(b.ctx.questions.getPending()).toEqual([])
    registry.deliverQueuedQuestionOutcomes("session-a", b.pi, b.ctx)
    registry.deliverQueuedQuestionOutcomes("session-a", b.pi, b.ctx)
    expect(a.messages).toHaveLength(0)
    expect(b.messages).toHaveLength(1)
    expect(b.closed()).toHaveLength(1)
  })
})

describe("question preparation compatibility", () => {
  test("preparing an installed engine never rewrites its shared package-cache hardlinks", () => {
    const root = fixture(false)
    const cached = questionControlTargets.map((relative, index) => {
      const installed = join(root, relative)
      const cache = join(root, `shared-cache-${index}`)
      const original = readFileSync(installed, "utf8")
      linkSync(installed, cache)
      return { cache, original }
    })
    prepareQuestionControl(root)
    for (const { cache, original } of cached) expect(readFileSync(cache, "utf8")).toBe(original)
    expect(planQuestionControl(root).every(({ source, prepared }) => source === prepared)).toBe(true)
  })

  test("second preparation is byte-identical including public declarations and generated module", () => {
    const root = fixture()
    const first = planQuestionControl(root)
    prepareQuestionControl(root)
    expect(planQuestionControl(root)).toEqual(first)
    expect(first.find(({ path }) => path.endsWith("types.d.ts")).prepared).toContain("readonly questions: QuestionControl;")
  })

  for (const prepared of [false, true]) {
    for (const target of questionControlTargets) {
      test(`rejects changed ${prepared ? "prepared" : "upstream"} ${target} before any writes`, () => {
        const root = fixture(prepared)
        const path = join(root, target)
        writeFileSync(path, readFileSync(path, "utf8") + "\nconst unsupported = true;\n")
        const before = questionControlTargets.map((p) => readFileSync(join(root, p), "utf8"))
        expect(() => prepareQuestionControl(root)).toThrow("question_control_incompatible")
        expect(questionControlTargets.map((p) => readFileSync(join(root, p), "utf8"))).toEqual(before)
      })
    }
  }

  test("missing, partial, and corrupt generated bindings fail closed", () => {
    const root = fixture(false)
    const prepared = planQuestionControl(root)
    writeFileSync(prepared[0].path, prepared[0].prepared)
    expect(() => prepareQuestionControl(root)).toThrow("partial_preparation")
    writeFileSync(prepared[0].path, prepared[0].source)
    prepareQuestionControl(root)
    writeFileSync(join(root, ask, "question-control.js"), "export {}\n")
    expect(() => prepareQuestionControl(root)).toThrow("question_control_incompatible: generated")
    rmSync(join(root, "dist/core/extensions/runner.js"))
    expect(() => prepareQuestionControl(root)).toThrow("question_control_incompatible: target_missing")
  })
})
