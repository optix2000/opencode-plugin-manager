import { afterAll, describe, test, expect, mock, beforeEach } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { randomUUID } from "node:crypto"

// We test the pure functions directly — they don't need mocking
import { CappedBuffer, expandHome, sanitizeSegment, normalizeGitRepo, parseNpmShorthand, sha256File } from "../util"
import { isGitRepoUrl } from "../types"

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

  test("trailing @ is treated as no version", () => {
    const result = parseNpmShorthand("pkg@")
    expect(result).toEqual({ name: "pkg" })
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

  test("strips .git suffix from SCP-style addresses", () => {
    expect(normalizeGitRepo("git@github.com:user/repo.git")).toBe("git@github.com:user/repo")
  })

  test("passes through clean SCP-style addresses", () => {
    expect(normalizeGitRepo("git@github.com:user/repo")).toBe("git@github.com:user/repo")
  })
})

describe("isGitRepoUrl", () => {
  test("accepts HTTPS URLs", () => {
    expect(isGitRepoUrl("https://github.com/user/repo.git")).toBe(true)
    expect(isGitRepoUrl("https://github.com/user/repo")).toBe(true)
  })

  test("accepts SSH URLs", () => {
    expect(isGitRepoUrl("ssh://git@github.com/user/repo.git")).toBe(true)
  })

  test("accepts git protocol URLs", () => {
    expect(isGitRepoUrl("git://github.com/user/repo.git")).toBe(true)
  })

  test("accepts file URLs", () => {
    expect(isGitRepoUrl("file:///path/to/repo")).toBe(true)
  })

  test("accepts SCP-style addresses with user@host:path", () => {
    expect(isGitRepoUrl("git@github.com:user/repo.git")).toBe(true)
    expect(isGitRepoUrl("git@gitlab.example.com:org/project.git")).toBe(true)
    expect(isGitRepoUrl("deploy@myhost:repos/project")).toBe(true)
  })

  test("accepts SCP-style addresses with IP hosts", () => {
    expect(isGitRepoUrl("git@192.168.1.1:user/repo")).toBe(true)
  })

  test("rejects bare strings without URL or SCP format", () => {
    expect(isGitRepoUrl("not-a-url")).toBe(false)
    expect(isGitRepoUrl("just-a-name")).toBe(false)
    expect(isGitRepoUrl("")).toBe(false)
  })

  test("scheme-like strings that parse as valid URLs are accepted", () => {
    // "https:foo" parses as a valid WHATWG URL (https://foo/), so it passes the URL check.
    // These would fail at git-clone time, but that's runtime validation, not config validation.
    expect(isGitRepoUrl("https:foo")).toBe(true)
  })

  test("rejects strings that are neither valid URLs nor SCP-style", () => {
    expect(isGitRepoUrl("totally invalid")).toBe(false)
    expect(isGitRepoUrl(":no-scheme")).toBe(false)
  })
})

describe("sha256File", () => {
  test("returns sha256-prefixed hash for file content", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opm-util-test-"))
    const filePath = path.join(dir, `${randomUUID()}.txt`)

    try {
      await fs.writeFile(filePath, "hello world", "utf8")

      const hash = await sha256File(filePath)
      expect(hash).toBe("sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("changes when file contents change", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opm-util-test-"))
    const filePath = path.join(dir, `${randomUUID()}.txt`)

    try {
      await fs.writeFile(filePath, "first", "utf8")
      const firstHash = await sha256File(filePath)

      await fs.writeFile(filePath, "second", "utf8")
      const secondHash = await sha256File(filePath)

      expect(firstHash).toMatch(/^sha256:/)
      expect(secondHash).toMatch(/^sha256:/)
      expect(secondHash).not.toBe(firstHash)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe("CappedBuffer", () => {
  test("returns full content when under the cap", () => {
    const buf = new CappedBuffer(1024)
    buf.append(Buffer.from("hello "))
    buf.append(Buffer.from("world"))
    expect(buf.toString()).toBe("hello world")
    expect(buf.truncated).toBe(false)
  })

  test("truncates early chunks and keeps the tail when over the cap", () => {
    const buf = new CappedBuffer(10)
    buf.append(Buffer.from("aaaa")) // 4 bytes
    buf.append(Buffer.from("bbbb")) // 4 bytes, total 8
    buf.append(Buffer.from("cccc")) // 4 bytes, total 12 -> drops "aaaa"
    expect(buf.truncated).toBe(true)
    const result = buf.toString()
    expect(result).toContain("bbbbcccc")
    expect(result).toContain("[truncated: 4 bytes dropped")
    expect(result).not.toContain("aaaa")
  })

  test("handles single chunk exceeding the cap", () => {
    const buf = new CappedBuffer(5)
    buf.append(Buffer.from("abcdefghij")) // 10 bytes, single chunk can't be split
    // Single chunk is kept even if over cap (nothing to drop)
    expect(buf.truncated).toBe(false)
    expect(buf.toString()).toBe("abcdefghij")
  })

  test("drops multiple early chunks to get under the cap", () => {
    const buf = new CappedBuffer(6)
    buf.append(Buffer.from("aa")) // 2
    buf.append(Buffer.from("bb")) // 4
    buf.append(Buffer.from("cc")) // 6
    buf.append(Buffer.from("dd")) // 8 -> drops "aa" -> 6
    expect(buf.truncated).toBe(true)
    expect(buf.toString()).toContain("bbccdd")

    buf.append(Buffer.from("ee")) // 8 -> drops "bb" -> 6
    const result = buf.toString()
    expect(result).toContain("ccddee")
    expect(result).toContain("[truncated: 4 bytes dropped")
  })

  test("empty buffer returns empty string", () => {
    const buf = new CappedBuffer(100)
    expect(buf.toString()).toBe("")
    expect(buf.truncated).toBe(false)
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
    await expect(promise).rejects.toThrow("timed out after 1ms")
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM")
  })

  test("escalates to SIGKILL when process ignores SIGTERM", async () => {
    const eventListeners: Record<string, ((...args: unknown[]) => void)[]> = {}
    const proc = {
      stdout: { on: mock() },
      stderr: { on: mock() },
      on: mock((event: string, cb: (...args: unknown[]) => void) => {
        if (!eventListeners[event]) eventListeners[event] = []
        eventListeners[event].push(cb)
      }),
      kill: mock((signal: string) => {
        if (signal === "SIGKILL") {
          queueMicrotask(() => {
            for (const cb of eventListeners.close ?? []) cb(null)
          })
        }
      }),
    }
    mockSpawn.mockReturnValue(proc)

    const promise = runCommand({ command: "sleep", args: ["999"], timeout: 1 })

    await expect(promise).rejects.toThrow("timed out after 1ms")
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM")
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL")
  })
})
