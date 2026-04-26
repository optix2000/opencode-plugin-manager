import { afterAll, describe, test, expect, mock, beforeEach } from "bun:test"
import * as fs from "node:fs/promises"
import path from "node:path"
import * as os from "node:os"
import { randomUUID } from "node:crypto"

import { isGitRepoUrl } from "../types"

mock.restore()

// We test the pure functions directly; restoring mocks first keeps this file isolated in full-suite runs.
const { CappedBuffer, expandHome, sanitizeSegment, normalizeGitRepo, parseNpmShorthand, sha256File } = await import(
  "../util"
)

describe("parseNpmShorthand", () => {
  const cases: Array<{ name: string; input: string; expected: { name: string; version?: string } }> = [
    {
      name: "splits name and version on last @",
      input: "foo@1.0",
      expected: { name: "foo", version: "1.0" },
    },
    {
      name: "handles scoped package with version",
      input: "@scope/pkg@^2",
      expected: { name: "@scope/pkg", version: "^2" },
    },
    {
      name: "scoped package without version",
      input: "@scope/pkg",
      expected: { name: "@scope/pkg" },
    },
    {
      name: "plain name with no @ returns no version",
      input: "pkg",
      expected: { name: "pkg" },
    },
    {
      name: "trailing @ is treated as no version",
      input: "pkg@",
      expected: { name: "pkg" },
    },
  ]

  for (const { name, input, expected } of cases) {
    test(name, () => {
      expect(parseNpmShorthand(input)).toEqual(expected)
    })
  }
})

describe("expandHome", () => {
  const home = expandHome("~")
  const cases: Array<{ name: string; input: string; expected: string }> = [
    { name: "exact ~ returns homedir", input: "~", expected: home },
    { name: "~/path joins with homedir", input: "~/foo/bar", expected: path.join(home, "foo/bar") },
    { name: "absolute path passes through unchanged", input: "/absolute/path", expected: "/absolute/path" },
    { name: "relative path passes through unchanged", input: "relative/path", expected: "relative/path" },
  ]

  for (const { name, input, expected } of cases) {
    test(name, () => {
      expect(expandHome(input)).toBe(expected)
    })
  }
})

describe("sanitizeSegment", () => {
  const cases = [
    { name: "replaces non-safe characters with underscore", input: "@scope/pkg", expected: "_scope_pkg" },
    { name: "replaces spaces", input: "a b c", expected: "a_b_c" },
    { name: "preserves safe characters", input: "valid.name-1_2", expected: "valid.name-1_2" },
  ]

  for (const { name, input, expected } of cases) {
    test(name, () => {
      expect(sanitizeSegment(input)).toBe(expected)
    })
  }
})

describe("normalizeGitRepo", () => {
  const cases = [
    {
      name: "strips .git suffix and trims whitespace",
      input: "  https://github.com/foo/bar.git  ",
      expected: "https://github.com/foo/bar",
    },
    {
      name: "passes through already clean URL",
      input: "https://github.com/foo/bar",
      expected: "https://github.com/foo/bar",
    },
    {
      name: "only strips trailing .git",
      input: "https://github.com/.git/bar",
      expected: "https://github.com/.git/bar",
    },
    {
      name: "strips .git suffix from SCP-style addresses",
      input: "git@github.com:user/repo.git",
      expected: "git@github.com:user/repo",
    },
    {
      name: "passes through clean SCP-style addresses",
      input: "git@github.com:user/repo",
      expected: "git@github.com:user/repo",
    },
  ]

  for (const { name, input, expected } of cases) {
    test(name, () => {
      expect(normalizeGitRepo(input)).toBe(expected)
    })
  }
})

describe("isGitRepoUrl", () => {
  test("accepts valid URL and SCP forms", () => {
    const accepted = [
      "https://github.com/user/repo.git",
      "https://github.com/user/repo",
      "ssh://git@github.com/user/repo.git",
      "git://github.com/user/repo.git",
      "file:///path/to/repo",
      "git@github.com:user/repo.git",
      "git@gitlab.example.com:org/project.git",
      "deploy@myhost:repos/project",
      "git@192.168.1.1:user/repo",
    ]

    for (const candidate of accepted) {
      expect(isGitRepoUrl(candidate)).toBe(true)
    }
  })

  test("rejects strings without URL or SCP format", () => {
    const rejected = ["not-a-url", "just-a-name", "", "totally invalid", ":no-scheme"]
    for (const candidate of rejected) {
      expect(isGitRepoUrl(candidate)).toBe(false)
    }
  })

  test("scheme-like strings that parse as valid URLs are accepted", () => {
    // "https:foo" parses as a valid WHATWG URL (https://foo/), so it passes the URL check.
    // These would fail at git-clone time, but that's runtime validation, not config validation.
    expect(isGitRepoUrl("https:foo")).toBe(true)
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
