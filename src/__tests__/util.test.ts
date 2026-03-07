import { afterAll, describe, test, expect, mock, beforeEach } from "bun:test"
import path from "node:path"
import os from "node:os"

// We test the pure functions directly — they don't need mocking
import { expandHome, sanitizeSegment, normalizeGitRepo, parseNpmShorthand } from "../util"

describe("parseNpmShorthand", () => {
  test("splits name and version on last @", () => {
    const result = parseNpmShorthand("foo@1.0")
    expect(result).toEqual({ name: "foo", version: "1.0" })
  })

  test("handles scoped package with version", () => {
    const result = parseNpmShorthand("@scope/pkg@^2")
    expect(result).toEqual({ name: "@scope/pkg", version: "^2" })
  })

  test("scoped package without version (lastAtIndex === 0)", () => {
    const result = parseNpmShorthand("@scope/pkg")
    expect(result).toEqual({ name: "@scope/pkg" })
    expect(result.version).toBeUndefined()
  })

  test("plain name with no @ returns no version", () => {
    const result = parseNpmShorthand("pkg")
    expect(result).toEqual({ name: "pkg" })
    expect(result.version).toBeUndefined()
  })

  test("trailing @ produces empty version string", () => {
    const result = parseNpmShorthand("pkg@")
    expect(result).toEqual({ name: "pkg", version: "" })
  })
})

describe("expandHome", () => {
  test("exact ~ returns homedir", () => {
    expect(expandHome("~")).toBe(os.homedir())
  })

  test("~/path joins with homedir", () => {
    expect(expandHome("~/foo/bar")).toBe(path.join(os.homedir(), "foo/bar"))
  })

  test("absolute path passes through unchanged", () => {
    expect(expandHome("/absolute/path")).toBe("/absolute/path")
  })

  test("relative path passes through unchanged", () => {
    expect(expandHome("relative/path")).toBe("relative/path")
  })
})

describe("sanitizeSegment", () => {
  test("replaces non-safe characters with underscore", () => {
    expect(sanitizeSegment("@scope/pkg")).toBe("_scope_pkg")
  })

  test("replaces spaces", () => {
    expect(sanitizeSegment("a b c")).toBe("a_b_c")
  })

  test("preserves safe characters", () => {
    expect(sanitizeSegment("valid.name-1_2")).toBe("valid.name-1_2")
  })
})

describe("normalizeGitRepo", () => {
  test("strips .git suffix and trims whitespace", () => {
    expect(normalizeGitRepo("  https://github.com/foo/bar.git  ")).toBe("https://github.com/foo/bar")
  })

  test("passes through already clean URL", () => {
    expect(normalizeGitRepo("https://github.com/foo/bar")).toBe("https://github.com/foo/bar")
  })

  test("only strips trailing .git", () => {
    expect(normalizeGitRepo("https://github.com/.git/bar")).toBe("https://github.com/.git/bar")
  })
})

describe("runCommand", () => {
  // These tests mock child_process.spawn to avoid real subprocesses

  let mockSpawn: ReturnType<typeof mock>
  let runCommand: typeof import("../util").runCommand

  afterAll(() => { mock.restore() })

  beforeEach(async () => {
    mockSpawn = mock()
    mock.module("node:child_process", () => ({
      spawn: mockSpawn,
    }))

    // Re-import to pick up the mock
    const util = await import("../util")
    runCommand = util.runCommand
  })

  function createMockProcess(options: { exitCode?: number; stdout?: string; stderr?: string; error?: Error }) {
    const stdoutListeners: ((chunk: Buffer) => void)[] = []
    const stderrListeners: ((chunk: Buffer) => void)[] = []
    const eventListeners: Record<string, ((...args: unknown[]) => void)[]> = {}

    const proc = {
      stdout: {
        on: mock((event: string, cb: (chunk: Buffer) => void) => {
          if (event === "data") stdoutListeners.push(cb)
        }),
      },
      stderr: {
        on: mock((event: string, cb: (chunk: Buffer) => void) => {
          if (event === "data") stderrListeners.push(cb)
        }),
      },
      on: mock((event: string, cb: (...args: unknown[]) => void) => {
        if (!eventListeners[event]) eventListeners[event] = []
        eventListeners[event].push(cb)
      }),
      kill: mock(),
    }

    // Schedule data and close events on next tick
    queueMicrotask(() => {
      if (options.error) {
        for (const cb of eventListeners.error ?? []) cb(options.error)
        return
      }
      if (options.stdout) {
        for (const cb of stdoutListeners) cb(Buffer.from(options.stdout))
      }
      if (options.stderr) {
        for (const cb of stderrListeners) cb(Buffer.from(options.stderr))
      }
      for (const cb of eventListeners.close ?? []) cb(options.exitCode ?? 0)
    })

    return proc
  }

  test("resolves with stdout and stderr on exit code 0", async () => {
    const proc = createMockProcess({ exitCode: 0, stdout: "hello\n", stderr: "" })
    mockSpawn.mockReturnValue(proc)

    const result = await runCommand({ command: "echo", args: ["hello"] })
    expect(result.stdout).toBe("hello\n")
    expect(result.stderr).toBe("")
  })

  test("rejects with error message on non-zero exit", async () => {
    const proc = createMockProcess({ exitCode: 1, stderr: "bad stuff" })
    mockSpawn.mockReturnValue(proc)

    await expect(runCommand({ command: "fail", args: [] })).rejects.toThrow("failed with exit code 1")
  })

  test("passes stdio ignore for stdin", async () => {
    const proc = createMockProcess({ exitCode: 0 })
    mockSpawn.mockReturnValue(proc)

    await runCommand({ command: "test", args: [] })
    const spawnCall = mockSpawn.mock.calls[0]
    expect(spawnCall[2].stdio[0]).toBe("ignore")
  })

  test("merges custom env with process.env", async () => {
    const proc = createMockProcess({ exitCode: 0 })
    mockSpawn.mockReturnValue(proc)

    await runCommand({ command: "test", args: [], env: { CUSTOM: "val" } })
    const spawnCall = mockSpawn.mock.calls[0]
    expect(spawnCall[2].env.CUSTOM).toBe("val")
    // process.env keys should also be present
    expect(spawnCall[2].env.PATH).toBeDefined()
  })

  test("kills process on timeout", async () => {
    const eventListeners: Record<string, ((...args: unknown[]) => void)[]> = {}
    const proc = {
      stdout: { on: mock() },
      stderr: { on: mock() },
      on: mock((event: string, cb: (...args: unknown[]) => void) => {
        if (!eventListeners[event]) eventListeners[event] = []
        eventListeners[event].push(cb)
      }),
      kill: mock(() => {
        // When killed, simulate close with non-zero
        queueMicrotask(() => {
          for (const cb of eventListeners.close ?? []) cb(null)
        })
      }),
    }
    mockSpawn.mockReturnValue(proc)

    const promise = runCommand({ command: "sleep", args: ["999"], timeout: 1 })

    // The timeout of 1ms should fire quickly and kill the process
    await expect(promise).rejects.toThrow()
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM")
  })
})
