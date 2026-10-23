import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { ensureEnginePrepared, ENGINE_PREPARED_STAMP, prepareInstalledEngine } from "../bin/lib/engine-prepare.js"
import { planQuestionControl, questionControlBundleTarget, questionControlTargets, upstreamQuestionControlSource } from "../bin/lib/question-control.js"
import { engineEntry, writeQuestionFixture } from "./question-control.fixture.mjs"

const roots = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const patchScript = fileURLToPath(new URL("../bin/senpi-patch.mjs", import.meta.url))
const rpc = "dist/modes/rpc/rpc-mode.js"
const ua = "node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js"
const generated = ["dist/core/extensions/builtin/ask-user/question-control.js", "dist/core/extensions/builtin/ask-user/question-control.d.ts"]
const observed = [...questionControlTargets, questionControlBundleTarget, ...generated, rpc, ua, "dist/bundle/ua-fixture.js", ENGINE_PREPARED_STAMP]
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omo-question-package-"))
  roots.push(root)
  writeQuestionFixture(root, { bundled: true })
  for (const [relative, source] of [
    [rpc, readFileSync(new URL("./modes/rpc/rpc-mode.js", engineEntry), "utf8")],
    [ua, 'const claudeCodeVersion = "2.1.251";\n'],
    ["dist/bundle/ua-fixture.js", 'const claudeCodeVersion = "2.1.251";\n'],
  ]) {
    const path = join(root, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, source)
  }
  return root
}
const snapshot = (root) => observed.map((relative) => existsSync(join(root, relative)) ? readFileSync(join(root, relative), "utf8") : null)
const patch = (root) => spawnSync(process.execPath, [patchScript], { env: { ...process.env, OMO_SENPI_PATCH_ROOT: root }, encoding: "utf8" })

describe("shared question preparation", () => {
  test("postinstall and the engine-swap invocation prepare the actual graph once", () => {
    const root = fixture()
    const result = patch(root)
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
    expect(planQuestionControl(root).every(({ source, prepared }) => source === prepared)).toBe(true)
    expect(readFileSync(join(root, ua), "utf8")).toContain("2.1.280")
    expect(readFileSync(join(root, rpc), "utf8")).toContain("invalid_stream_event")
    const first = snapshot(root)
    expect(patch(root).status).toBe(0)
    expect(snapshot(root)).toEqual(first)
  })

  test("same-version launch stamp cannot conceal missing facade preparation", () => {
    const root = fixture()
    writeFileSync(join(root, ENGINE_PREPARED_STAMP), "5.1.43\n")
    const reports = []
    ensureEnginePrepared({ senpiRoot: root, omoVersion: "5.1.43", reinstallCommand: "reinstall", report: (line) => reports.push(line) })
    expect(reports).toEqual([])
    expect(planQuestionControl(root).every(({ source, prepared }) => source === prepared)).toBe(true)
    writeFileSync(join(root, generated[0]), "export {}\n")
    ensureEnginePrepared({ senpiRoot: root, omoVersion: "5.1.43", reinstallCommand: "reinstall", report: (line) => reports.push(line) })
    expect(reports[0]).toContain("question_control_incompatible")
    expect(readFileSync(join(root, generated[0]), "utf8")).toBe("export {}\n")
  })

  for (const defect of ["missing target", "missing bundle owner", "renamed binding", "renamed bundled binding", "partial preparation", "partial bundled preparation", "malformed prepared module"]) {
    test(`postinstall rejects ${defect} before writing any engine file`, () => {
      const root = fixture()
      if (defect === "missing target") rmSync(join(root, questionControlTargets[0]))
      if (defect === "missing bundle owner") rmSync(join(root, questionControlBundleTarget))
      if (defect === "renamed binding") {
        const path = join(root, questionControlTargets[0])
        writeFileSync(path, readFileSync(path, "utf8").replace("const accept =", "const renamedAccept ="))
      }
      if (defect === "renamed bundled binding") {
        const path = join(root, questionControlBundleTarget)
        writeFileSync(path, readFileSync(path, "utf8").replace("function startQuestion(", "function renamedStartQuestion("))
      }
      if (defect === "partial preparation") {
        const first = planQuestionControl(root)[0]
        writeFileSync(first.path, first.prepared)
      }
      if (defect === "partial bundled preparation") {
        prepareInstalledEngine(root)
        const path = join(root, questionControlBundleTarget)
        writeFileSync(path, upstreamQuestionControlSource(questionControlBundleTarget, readFileSync(path, "utf8")))
      }
      if (defect === "malformed prepared module") {
        prepareInstalledEngine(root)
        writeFileSync(join(root, generated[0]), "export {}\n")
      }
      const before = snapshot(root)
      const result = patch(root)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain("question_control_incompatible")
      expect(snapshot(root)).toEqual(before)
    })
  }

  test("direct binary build preflights the installed graph before staging or compilation", async () => {
    const root = fixture()
    rmSync(join(root, questionControlTargets[0]))
    const source = readFileSync(new URL("../../../script/build-omo-binary.ts", import.meta.url), "utf8")
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source)
    const start = js.indexOf("async function buildReleaseBinary(")
    const end = js.indexOf("function parseBuildInfoValue(", start)
    expect(start).toBeGreaterThan(0)
    const build = new Function("existsSync", "compileEntry", "prepareInstalledEngine", "senpiPackageDir", `${js.slice(start, end)}; return buildReleaseBinary`)(
      () => true, "compile-entry.ts", prepareInstalledEngine, root,
    )
    await expect(build({}, {})).rejects.toThrow("question_control_incompatible")
  })

  test("the generated module and registry are statically bundled and work without source files", async () => {
    const root = fixture()
    prepareInstalledEngine(root)
    const entry = join(root, "probe.js")
    writeFileSync(entry, `
import { createQuestionControl } from "./dist/core/extensions/builtin/ask-user/question-control.js";
import { registerPendingQuestion } from "./dist/core/extensions/builtin/ask-user/registry.js";
const request = { requestId: "bundled", questions: [], waitForAnswer: false, timeoutMs: 123 };
let accepted = 0;
let remove;
remove = registerPendingQuestion("scope", { request, pending: { deadlineAtMs: 123 }, respond() { accepted++; remove(); return true; } });
const control = createQuestionControl(() => "scope");
if (control.getPending().length !== 1 || !control.respond({ requestId: "bundled", answers: {}, comment: "yes" }).success
  || control.getPending().length !== 0 || accepted !== 1) throw new Error("broken compiled question graph");
console.log("question-graph-ok");
`)
    const output = join(root, process.platform === "win32" ? "probe.exe" : "probe")
    const build = spawnSync(process.execPath, ["build", "--compile", "--no-compile-autoload-bunfig", entry, "--outfile", output], { encoding: "utf8" })
    expect(build.stderr).not.toContain("error:")
    expect(build.status).toBe(0)
    rmSync(join(root, "dist"), { recursive: true, force: true })
    rmSync(entry)
    const execution = spawnSync(output, [], { encoding: "utf8", cwd: root })
    expect(execution.status).toBe(0)
    expect(execution.stdout.trim()).toBe("question-graph-ok")
  })
})
