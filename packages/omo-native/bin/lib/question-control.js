import { createHash } from "node:crypto"
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const base = "dist/core/extensions/"
const ask = `${base}builtin/ask-user/`
const marker = "// omo question control"
// These fingerprints are for the pinned Senpi 2026.11.23 package.
// Fingerprints validate every binding (including unchanged finish/reload ownership) before any write.
const originals = {
  [`${ask}tool.js`]: "e023b605df0d30ead81e9915e866daba03ecbc7284f8aa08db17f242e692f132",
  [`${ask}registry.js`]: "ecd096a968e01a1a5745ffd715af84fd13d4c7d00cf40100f66c57831bb008c7",
  [`${ask}registry.d.ts`]: "3d365792c1ae25c48da60dc8484db835a940bcfeeaef965cc0d70c2fe444cc00",
  [`${base}runner.js`]: "0b631b874c5141ce6de58c6f9a98240d291e07dcdedb0f8fc750b5d7aeac7303",
  [`${base}types.d.ts`]: "e56fcab3d8ba4739f473dec50849d00b352be4846c5b9aea7111a64a04a1a121",
}
export const questionControlTargets = Object.keys(originals)
const bundles = {
  "dist/bundle/chunks/chunk-COYDUAEE.js": {
    digest: "a558f15902a53adca6f42e239fb840e10aad2033a5232929079c466f5898a405",
    request: "request2", pi: "pi", cancel: "cancel3", abort: "abort", attach: "attach2", opts: "opts",
  },
  "dist/bundle/chunks/session-worker.js": {
    digest: "682c5ff44ce3aa3e895a6b2318cc68804334f8b3ed6654c2f8be702797b915dc",
    request: "request3", pi: "pi2", cancel: "cancel4", abort: "abort3", attach: "attach5", opts: "opts2",
  },
}
export const questionControlBundleTargets = Object.keys(bundles)
const digest = (source) => createHash("sha256").update(source).digest("hex")
const incompatible = (detail) => new Error(`omo-ai: question_control_incompatible: ${detail}`)
const runnerImport = 'import { createQuestionControl } from "./builtin/ask-user/question-control.js";\n'
const getter = `            get questions() {
                runner.assertActive();
                return createQuestionControl(() => {
                    runner.assertActive();
                    return runner.boundSessionManager().getSessionId();
                });
            },
`
const responder = `        respond(response) {
            if (settled)
                return false;
            accept(response);
            return true;
        },
`
const declarations = `export interface QuestionControl {
    getPending(): Array<QuestionRequest & { deadlineAtMs: number }>;
    respond(input: {
        requestId: string;
        answers?: QuestionResponse["answers"];
        comment?: string;
        cancelled?: boolean;
    }): { success: true; requestId: string; outcome: QuestionResponse["status"] }
        | { success: false; error: "unknown_request" | "question_incomplete" | "invalid_response" };
}
`
const asked = "    pi.events.emit(ASK_USER_ASKED_EVENT, { ctx, request, variant });\n"
const registration = /    unregister = registerPendingQuestion\(sessionId, \{[\s\S]*?    signal\?\.addEventListener\("abort", abort, \{ once: true \}\);\n/

function replace(source, before, after) {
  if (source.split(before).length !== 2) throw incompatible(`binding ${before.slice(0, 90)}`)
  return source.replace(before, after)
}

function transform(relative, source, undo = false) {
  const swap = (before, after) => { source = replace(source, undo ? after : before, undo ? before : after) }
  if (relative === `${ask}tool.js`) {
    swap("        completion: completion.promise,\n", `        completion: completion.promise,\n${responder}`)
    const block = source.match(registration)?.[0]
    if (!block) throw incompatible("registration/arrival")
    source = source.replace(block, "")
    if (undo) {
      source = replace(source, `${asked}    if (settled)\n        return completion.promise;\n`, "")
      source = replace(source, "    let draft = { answers: {} };\n", `${block.replace('    const first = request.questions[0];', `${asked}    const first = request.questions[0];`)}    let draft = { answers: {} };\n`)
    } else {
      source = replace(source, "    if (signal?.aborted)\n", `${block.replace(asked, "")}${asked}    if (settled)\n        return completion.promise;\n    if (signal?.aborted)\n`)
    }
  } else if (relative === `${base}runner.js`) {
    swap('import { basename } from "node:path";\n', `import { basename } from "node:path";\n${runnerImport}`)
    swap("            get sessionManager() {\n", `${getter}            get sessionManager() {\n`)
  } else if (relative === `${base}types.d.ts`) {
    swap("export interface ExtensionContext {\n", `${declarations}export interface ExtensionContext {\n    readonly questions: QuestionControl;\n`)
  } else if (relative === `${ask}registry.d.ts`) {
    swap("    completion: Promise<QuestionResponse>;\n", "    completion: Promise<QuestionResponse>;\n    respond(response: QuestionResponse): boolean;\n")
  }
  return source
}

function transformBundle(relative, source, undo = false) {
  const runtime = readFileSync(new URL("./question-control-runtime.js", import.meta.url), "utf8")
  const { request, pi, cancel, abort, attach, opts } = bundles[relative]
  const swap = (before, after) => { source = replace(source, undo ? after : before, undo ? before : after) }
  // Terminal and session-worker bundles each own a registry. Keep the facade in that
  // graph; importing the modular registry would make its pending requests invisible.
  const inline = `function createOmoQuestionControl(sessionId) {\n${runtime
    .replace('import { getPendingQuestions } from "./registry.js"\n', "")
    .replace("export function createQuestionControl", "function createQuestionControl")}
return createQuestionControl(sessionId);\n}\n`
  swap("function getPendingQuestions(sessionId)", `${inline}function getPendingQuestions(sessionId)`)
  swap("get sessionManager(){return runner.assertActive(),runner.boundSessionManager()}", "get questions(){return runner.assertActive(),createOmoQuestionControl(()=>{return runner.assertActive(),runner.boundSessionManager().getSessionId()})},get sessionManager(){return runner.assertActive(),runner.boundSessionManager()}")
  swap(`completion:completion.promise,cancel:${cancel}`, `completion:completion.promise,respond(response){if(settled2)return!1;return accept(response),!0},cancel:${cancel}`)
  const block = source.match(new RegExp(`unregister=registerPendingQuestion\\(sessionId,\\{request:${request},[\\s\\S]*?signal2\\?\\.addEventListener\\("abort",${abort},\\{once:!0\\}\\);`))?.[0]
  if (!block) throw incompatible("bundled registration/arrival")
  source = source.replace(block, "")
  const arrival = `${pi}.events.emit(ASK_USER_ASKED_EVENT,{ctx,request:${request},variant})`
  const tail = `return signal2?.aborted?${abort}():${attach}(),completion.promise}`
  const guardedTail = `${arrival};return settled2?completion.promise:(signal2?.aborted?${abort}():${attach}(),completion.promise)}`
  if (undo) {
    source = replace(source, guardedTail, tail)
    source = replace(source, `let draft={answers:{}},${opts}=`, `${block.replace(`;let first=${request}.questions[0]`, `,${arrival};let first=${request}.questions[0]`)}let draft={answers:{}},${opts}=`)
  } else {
    source = replace(source, tail, `${block.replace(`,${arrival}`, "")}${guardedTail}`)
  }
  return source
}

/** Also used by fixtures to recover the pinned upstream bytes after local preparation. */
export function upstreamQuestionControlSource(relative, source) {
  const prepared = source.startsWith(`${marker}\n`)
  if (Object.hasOwn(bundles, relative)) {
    const original = prepared ? transformBundle(relative, source.slice(marker.length + 1), true) : source
    if (digest(original) !== bundles[relative].digest) throw incompatible(`source ${relative}`)
    if (prepared && `${marker}\n${transformBundle(relative, original)}` !== source) throw incompatible(`prepared ${relative}`)
    return original
  }
  const original = prepared ? transform(relative, source.slice(marker.length + 1), true) : source
  if (digest(original) !== originals[relative]) throw incompatible(`source ${relative}`)
  // Reverse validation alone must not accept a corrupted or partly prepared output.
  if (prepared && `${marker}\n${transform(relative, original)}` !== source) throw incompatible(`prepared ${relative}`)
  return original
}

/** Preflight every file first; callers can preflight before other installed-engine preparations. */
export function planQuestionControl(senpiRoot) {
  const files = []
  const states = []
  for (const relative of questionControlTargets) {
    const path = join(senpiRoot, relative)
    if (!existsSync(path)) throw incompatible(`target_missing ${relative}`)
    const source = readFileSync(path, "utf8")
    const original = upstreamQuestionControlSource(relative, source)
    states.push(source.startsWith(`${marker}\n`))
    files.push({ path, source, prepared: `${marker}\n${transform(relative, original)}` })
  }
  const runtime = readFileSync(new URL("./question-control-runtime.js", import.meta.url), "utf8")
  const generated = [
    [`${ask}question-control.js`, runtime],
    [`${ask}question-control.d.ts`, 'import type { QuestionControl } from "../../types.js";\nexport declare function createQuestionControl(sessionId: () => string): QuestionControl;\n'],
  ]
  if (states.some(Boolean) && !states.every(Boolean)) throw incompatible("partial_preparation")
  for (const [relative, prepared] of generated) {
    const path = join(senpiRoot, relative)
    const source = existsSync(path) ? readFileSync(path, "utf8") : undefined
    if (states[0] ? source !== prepared : source !== undefined) throw incompatible(`generated ${relative}`)
    files.push({ path, source, prepared })
  }
  // Source-built engines may omit the prelinked bundle. A declared bundled CLI must have
  // the reviewed question owner; never silently prepare just the unused modular graph.
  if (existsSync(join(senpiRoot, "dist/bundle/cli.js"))) {
    for (const relative of questionControlBundleTargets) {
      const path = join(senpiRoot, relative)
      if (!existsSync(path)) throw incompatible(`target_missing ${relative}`)
      const source = readFileSync(path, "utf8")
      if (source.startsWith(`${marker}\n`) !== states[0]) throw incompatible("partial_preparation")
      const original = upstreamQuestionControlSource(relative, source)
      files.push({ path, source, prepared: `${marker}\n${transformBundle(relative, original)}` })
    }
  }
  return files
}

export function prepareQuestionControl(senpiRoot) {
  for (const { path, source, prepared } of planQuestionControl(senpiRoot)) {
    if (source !== prepared) {
      // Bun installs can hardlink these files to a shared package cache.
      // Replace the installed directory entry instead of modifying that shared inode.
      const temporary = `${path}.omo-question-${process.pid}`
      writeFileSync(temporary, prepared)
      renameSync(temporary, path)
    }
  }
}
