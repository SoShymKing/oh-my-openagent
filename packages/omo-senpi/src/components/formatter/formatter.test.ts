import { describe, expect, it } from "bun:test"

import { detectFormatter, formatOnMutationDefaults, resolveFormatMode } from "./formatter"

describe("format-on-mutation policy", () => {
  it("uses marker precedence and never enables prettier beside biome", () => {
    expect(detectFormatter(["biome.json", ".prettierrc"], "src/a.ts")?.tool).toBe("biome")
    expect(detectFormatter([".prettierrc"], "src/a.ts")?.tool).toBe("prettier")
    expect(detectFormatter(["Cargo.toml"], "src/a.rs")?.tool).toBe("rustfmt")
    expect(detectFormatter(["go.mod"], "src/a.go")?.tool).toBe("gofmt")
    expect(detectFormatter(["pyproject.toml"], "src/a.py", "[tool.ruff]\nline-length=88")?.tool).toBe("ruff")
    expect(detectFormatter(["pyproject.toml"], "src/a.py", "[tool.black]\nline-length=88")).toBeUndefined()
  })

  it("has the required defaults and language overrides", () => {
    expect(formatOnMutationDefaults).toEqual({ mode: "best-effort", maxFileBytes: 1048576, timeoutMs: 3000 })
    expect(resolveFormatMode({ mode: "required", languages: { typescript: false } }, "typescript")).toBe("off")
    expect(resolveFormatMode({}, "python")).toBe("best-effort")
    expect(resolveFormatMode({ mode: "required" }, "python")).toBe("required")
  })

  it("contains machine-readable change notice tokens", () => {
    const notice = "(OmO) auto-formatted src/a.ts with biome (+1/-2 lines). File content changed; re-read before exact-text edits."
    expect(notice).toContain("auto-formatted")
    expect(notice).toContain("re-read before exact-text edits")
  })
})
