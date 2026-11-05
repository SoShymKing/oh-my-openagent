import { createHash } from "node:crypto"
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const base = "dist/core/extensions/"
const ask = `${base}builtin/ask-user/`
const marker = "// omo question control"
// These are the actual pinned 2026.11.3-3 sources, not invented engine fixtures.
// Fingerprints validate every binding (including unchanged finish/reload ownership) before any write.
const originals = {
  [`${ask}tool.js`]: "85ffdb99851eaca12c96b55e61dc9490352e9d69aaf32e1e918abac38b61e466",
  [`${ask}registry.js`]: "ecd096a968e01a1a5745ffd715af84fd13d4c7d00cf40100f66c57831bb008c7",
  [`${ask}registry.d.ts`]: "3d365792c1ae25c48da60dc8484db835a940bcfeeaef965cc0d70c2fe444cc00",
  [`${base}runner.js`]: "21140d30ce7e12ff5b30bb747fe81c2a39d9aa5be39321bf8820315472dd2c20",
  [`${base}types.d.ts`]: "a88526722d9fb0e941678c071712e113ee6c2635dd536a2308ca918d08e9112b",
}
export const questionControlTargets = Object.keys(originals)
export const questionControlBundleTarget = "dist/bundle/chunks/chunk-OQRGDBY6.js"
const bundleDigest = "7d87dea49abfcae640e078bf789ed9944631febdd6bd5a13e1868f34871b506f"
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

function transformBundle(source, runtime, undo = false) {
  const swap = (before, after) => { source = replace(source, undo ? after : before, undo ? before : after) }
  // The prelinked terminal and session-worker graphs share this chunk's registry. Importing
  // the modular registry here would create a second owner and make pending requests invisible.
  const inline = `function createOmoQuestionControl(sessionId) {\n${runtime
    .replace('import { getPendingQuestions } from "./registry.js"\n', "")
    .replace("export function createQuestionControl", "function createQuestionControl")}
return createQuestionControl(sessionId);\n}\n`
  swap("function getPendingQuestions(sessionId)", `${inline}function getPendingQuestions(sessionId)`)
  swap("get sessionManager(){return runner.assertActive(),runner.boundSessionManager()}", "get questions(){return runner.assertActive(),createOmoQuestionControl(()=>{return runner.assertActive(),runner.boundSessionManager().getSessionId()})},get sessionManager(){return runner.assertActive(),runner.boundSessionManager()}")
  swap("completion:completion.promise,cancel:cancel3", "completion:completion.promise,respond(response){if(settled2)return!1;return accept(response),!0},cancel:cancel3")
  const block = source.match(/unregister=registerPendingQuestion\(sessionId,\{request:request2,[\s\S]*?signal\?\.addEventListener\("abort",abort,\{once:!0\}\);/)?.[0]
  if (!block) throw incompatible("bundled registration/arrival")
  source = source.replace(block, "")
  const arrival = "pi.events.emit(ASK_USER_ASKED_EVENT,{ctx,request:request2,variant})"
  const tail = "return signal?.aborted?abort():attach2(),completion.promise}"
  const guardedTail = `${arrival};return settled2?completion.promise:(signal?.aborted?abort():attach2(),completion.promise)}`
  if (undo) {
    source = replace(source, guardedTail, tail)
    source = replace(source, "let draft={answers:{}},opts=", `${block.replace(";let first=request2.questions[0]", `,${arrival};let first=request2.questions[0]`)}let draft={answers:{}},opts=`)
  } else {
    source = replace(source, tail, `${block.replace(`,${arrival}`, "")}${guardedTail}`)
  }
  return source
}

/** Also used by fixtures to recover the pinned upstream bytes after local preparation. */
export function upstreamQuestionControlSource(relative, source) {
  const prepared = source.startsWith(`${marker}\n`)
  if (relative === questionControlBundleTarget) {
    const runtime = readFileSync(new URL("./question-control-runtime.js", import.meta.url), "utf8")
    const original = prepared ? transformBundle(source.slice(marker.length + 1), runtime, true) : source
    if (digest(original) !== bundleDigest) throw incompatible(`source ${relative}`)
    if (prepared && `${marker}\n${transformBundle(original, runtime)}` !== source) throw incompatible(`prepared ${relative}`)
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
    const path = join(senpiRoot, questionControlBundleTarget)
    if (!existsSync(path)) throw incompatible(`target_missing ${questionControlBundleTarget}`)
    const source = readFileSync(path, "utf8")
    if (source.startsWith(`${marker}\n`) !== states[0]) throw incompatible("partial_preparation")
    const original = upstreamQuestionControlSource(questionControlBundleTarget, source)
    files.push({ path, source, prepared: `${marker}\n${transformBundle(original, runtime)}` })
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
