import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { _resetForTesting } from "../claude-code-session-state"
import { HEARTBEAT_MS, WRITE_DEBOUNCE_MS } from "./constants"
import { TuiStateMirror } from "./mirror-manager"
import type { TuiMirrorClient } from "./snapshot-builder"

type MessageInput = Parameters<TuiMirrorClient["session"]["messages"]>[0]

const originalXdgDataHome = process.env.XDG_DATA_HOME
const tempDirs: string[] = []

function makeTempDir(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `omo-mirror-cache-${label}-`))
  tempDirs.push(directory)
  return directory
}

describe("TuiStateMirror session agent cache", () => {
  beforeEach(() => {
    _resetForTesting()
    process.env.XDG_DATA_HOME = makeTempDir("xdg")
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
    _resetForTesting()
    if (originalXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME
    } else {
      process.env.XDG_DATA_HOME = originalXdgDataHome
    }
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("#given an uncached active session #when two heartbeat cycles flush #then one bounded history request serves both", async () => {
    // given
    const projectDir = makeTempDir("project")
    const calls: MessageInput[] = []
    const client: TuiMirrorClient = {
      session: {
        status: async () => ({ data: { "ses-heartbeat": { type: "running" } } }),
        messages: async (input) => {
          calls.push(input)
          return { data: [{ id: "msg-agent", info: { agent: "atlas", time: { created: 1 } } }] }
        },
      },
    }
    const mirror = new TuiStateMirror({
      client,
      projectDir,
      backgroundManager: { getTasksSnapshot: () => [] },
    })
    mirror.start()

    // when
    jest.advanceTimersByTime(HEARTBEAT_MS)
    const firstFlush = mirror.flush()
    jest.advanceTimersByTime(WRITE_DEBOUNCE_MS)
    await firstFlush
    jest.advanceTimersByTime(HEARTBEAT_MS)
    const secondFlush = mirror.flush()
    jest.advanceTimersByTime(WRITE_DEBOUNCE_MS)
    await secondFlush
    mirror.stop()

    // then
    expect(calls).toEqual([
      {
        path: { id: "ses-heartbeat" },
        query: { directory: projectDir, limit: 20 },
      },
    ])
  })
})
