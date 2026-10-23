import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { questionControlBundleTarget, questionControlTargets, upstreamQuestionControlSource } from "../bin/lib/question-control.js"

export const engineEntry = import.meta.resolve("@code-yeongyu/senpi")
export const extensionBase = new URL("./core/extensions/", engineEntry)

/** Real pinned upstream sources, even when postinstall already prepared this local install. */
export function writeQuestionFixture(root, { bundled = false } = {}) {
  for (const relative of [...questionControlTargets, ...(bundled ? [questionControlBundleTarget] : [])]) {
    const source = readFileSync(new URL(relative.slice("dist/".length), engineEntry), "utf8")
    const path = join(root, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, upstreamQuestionControlSource(relative, source))
  }
  if (bundled) {
    writeFileSync(join(root, "dist/bundle/cli.js"), readFileSync(new URL("./bundle/cli.js", engineEntry), "utf8"))
  }
}
