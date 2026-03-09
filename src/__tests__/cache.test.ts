import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import type { MergedConfig } from "../config"
import type { Lockfile } from "../types"
import { makeCacheContext, makeLockEntry } from "./helpers"

const mockFsReadFile = mock()
const mockFsWriteFile = mock()
const mockFsRename = mock()
const mockFsUnlink = mock()
const mockFsOpen = mock()
const mockFsRealpath = mock()
const mockFsStat = mock()
const mockFsReaddir = mock()
const mockFsRm = mock()

const mockExists = mock()
const mockEnsureDir = mock()
const mockSleep = mock()

function realExpandHome(input: string): string {
  if (input === "~") return os.homedir()
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2))
  return input
}

function realSanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_")
}

mock.module("../cache.deps", () => ({
  fs: {
    readFile: mockFsReadFile,
    writeFile: mockFsWriteFile,
    rename: mockFsRename,
    unlink: mockFsUnlink,
    open: mockFsOpen,
    realpath: mockFsRealpath,
    stat: mockFsStat,
    readdir: mockFsReaddir,
    rm: mockFsRm,
  },
  os,
  path,
  exists: mockExists,
  ensureDir: mockEnsureDir,
  sleep: mockSleep,
  expandHome: realExpandHome,
  sanitizeSegment: realSanitizeSegment,
}))

const cache = await import("../cache")

const EMPTY_LOCKFILE: Lockfile = { version: 1, plugins: {} }
const originalXdgCacheHome = process.env.XDG_CACHE_HOME

function makeDirent(name: string, directory: boolean) {
  return {
    name,
    isDirectory: () => directory,
  }
}

function makeStat(kind: "file" | "directory" | "other") {
  return {
    isFile: () => kind === "file",
    isDirectory: () => kind === "directory",
  }
}


beforeEach(() => {
  mockFsReadFile.mockReset()
  mockFsReadFile.mockResolvedValue("")

  mockFsWriteFile.mockReset()
  mockFsWriteFile.mockResolvedValue(undefined)

  mockFsRename.mockReset()
  mockFsRename.mockResolvedValue(undefined)

  mockFsUnlink.mockReset()
  mockFsUnlink.mockResolvedValue(undefined)

  mockFsOpen.mockReset()
  mockFsOpen.mockResolvedValue({ close: mock().mockResolvedValue(undefined) })

  mockFsRealpath.mockReset()
  mockFsRealpath.mockImplementation(async (targetPath: string) => path.resolve(targetPath))

  mockFsStat.mockReset()
  mockFsStat.mockResolvedValue(makeStat("other"))

  mockFsReaddir.mockReset()
  mockFsReaddir.mockResolvedValue([])

  mockFsRm.mockReset()
  mockFsRm.mockResolvedValue(undefined)

  mockExists.mockReset()
  mockExists.mockResolvedValue(false)

  mockEnsureDir.mockReset()
  mockEnsureDir.mockResolvedValue(undefined)

  mockSleep.mockReset()
  mockSleep.mockResolvedValue(undefined)

  process.env.XDG_CACHE_HOME = originalXdgCacheHome
})

afterEach(() => {
  process.env.XDG_CACHE_HOME = originalXdgCacheHome
})

describe("resolveCacheContext", () => {
  test("resolves custom cacheDir relative to cacheDirBase", () => {
    const config: MergedConfig = {
      files: [],
      plugins: [],
      cacheDir: "./plugin-cache",
      cacheDirBase: "/workspace",
    }

    const rootDir = path.resolve("/workspace", "./plugin-cache")
    expect(cache.resolveCacheContext(config)).toEqual({
      rootDir,
      lockfilePath: path.join(rootDir, "plugins.lock.json"),
      mutexPath: path.join(rootDir, ".manager.lock"),
    })
  })

  test("applies expandHome for custom cacheDir with ~", () => {
    const config: MergedConfig = {
      files: [],
      plugins: [],
      cacheDir: "~/my-cache",
      cacheDirBase: "/ignored",
    }

    const rootDir = path.join(os.homedir(), "my-cache")
    expect(cache.resolveCacheContext(config)).toEqual({
      rootDir,
      lockfilePath: path.join(rootDir, "plugins.lock.json"),
      mutexPath: path.join(rootDir, ".manager.lock"),
    })
  })

  test("uses XDG cache path when cacheDir is not set", () => {
    process.env.XDG_CACHE_HOME = "/tmp/xdg-cache"

    const config: MergedConfig = {
      files: [],
      plugins: [],
    }

    const rootDir = path.join("/tmp/xdg-cache", "opencode", "opm")
    expect(cache.resolveCacheContext(config)).toEqual({
      rootDir,
      lockfilePath: path.join(rootDir, "plugins.lock.json"),
      mutexPath: path.join(rootDir, ".manager.lock"),
    })
  })

  test("falls back to ~/.cache/opencode/opm when XDG_CACHE_HOME is unset", () => {
    delete process.env.XDG_CACHE_HOME

    const config: MergedConfig = {
      files: [],
      plugins: [],
    }

    const rootDir = path.join(os.homedir(), ".cache", "opencode", "opm")
    expect(cache.resolveCacheContext(config)).toEqual({
      rootDir,
      lockfilePath: path.join(rootDir, "plugins.lock.json"),
      mutexPath: path.join(rootDir, ".manager.lock"),
    })
  })
})

describe("readLockfile", () => {
  test("returns empty lockfile when file is missing", async () => {
    mockExists.mockResolvedValue(false)

    await expect(cache.readLockfile("/cache/plugins.lock.json")).resolves.toEqual(EMPTY_LOCKFILE)
    expect(mockFsReadFile).not.toHaveBeenCalled()
  })

  test("warns and returns empty lockfile for invalid JSON", async () => {
    const originalWarn = console.warn
    const warnSpy = mock(() => undefined)
    console.warn = warnSpy as typeof console.warn
    mockExists.mockResolvedValue(true)
    mockFsReadFile.mockResolvedValue("{invalid-json")

    try {
      await expect(cache.readLockfile("/cache/plugins.lock.json")).resolves.toEqual(EMPTY_LOCKFILE)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to read lockfile"))
    } finally {
      console.warn = originalWarn
    }
  })

  test("warns and returns empty lockfile for valid JSON with wrong shape", async () => {
    const originalWarn = console.warn
    const warnSpy = mock(() => undefined)
    console.warn = warnSpy as typeof console.warn
    mockExists.mockResolvedValue(true)
    mockFsReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        plugins: {
          bad: {
            source: "npm",
          },
        },
      }),
    )

    try {
      await expect(cache.readLockfile("/cache/plugins.lock.json")).resolves.toEqual(EMPTY_LOCKFILE)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid lockfile"))
    } finally {
      console.warn = originalWarn
    }
  })
})

describe("writeLockfile", () => {
  test("writes via temp file then renames on success", async () => {
    const lockfilePath = "/cache/plugins.lock.json"
    const tempPath = `${lockfilePath}.${process.pid}.tmp`

    await cache.writeLockfile(lockfilePath, EMPTY_LOCKFILE)

    expect(mockEnsureDir).toHaveBeenCalledWith("/cache")
    expect(mockFsWriteFile).toHaveBeenCalledWith(tempPath, `${JSON.stringify(EMPTY_LOCKFILE, null, 2)}\n`, "utf8")
    expect(mockFsRename).toHaveBeenCalledWith(tempPath, lockfilePath)
    expect(mockFsUnlink).not.toHaveBeenCalled()
  })

  test("unlinks temp file and rethrows when rename fails", async () => {
    const lockfilePath = "/cache/plugins.lock.json"
    const tempPath = `${lockfilePath}.${process.pid}.tmp`
    const error = new Error("rename failed")
    mockFsRename.mockRejectedValue(error)

    await expect(cache.writeLockfile(lockfilePath, EMPTY_LOCKFILE)).rejects.toBe(error)
    expect(mockFsUnlink).toHaveBeenCalledWith(tempPath)
  })
})

describe("withCacheLock", () => {
  test("acquires lock, runs fn, closes handle, and unlinks mutex", async () => {
    const cacheContext = makeCacheContext("/cache")
    const close = mock().mockResolvedValue(undefined)
    mockFsOpen.mockResolvedValue({ close })
    const fn = mock(async () => "ok")

    const result = await cache.withCacheLock(cacheContext, fn)

    expect(result).toBe("ok")
    expect(mockEnsureDir).toHaveBeenCalledWith(cacheContext.rootDir)
    expect(mockFsOpen).toHaveBeenCalledWith(cacheContext.mutexPath, "wx", 0o600)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(mockFsUnlink).toHaveBeenCalledWith(cacheContext.mutexPath)
  })

  test("retries on EEXIST and eventually succeeds", async () => {
    const cacheContext = makeCacheContext("/cache")
    const close = mock().mockResolvedValue(undefined)
    const lockBusyError = Object.assign(new Error("busy"), { code: "EEXIST" })
    mockFsOpen.mockRejectedValueOnce(lockBusyError)
    mockFsOpen.mockResolvedValueOnce({ close })

    const fn = mock(async () => "done")
    const result = await cache.withCacheLock(cacheContext, fn, 1_000)

    expect(result).toBe("done")
    expect(mockFsOpen).toHaveBeenCalledTimes(2)
    expect(mockSleep).toHaveBeenCalledWith(125)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test("reclaims stale lock when owner pid is dead", async () => {
    const cacheContext = makeCacheContext("/cache")
    const close = mock().mockResolvedValue(undefined)
    const lockBusyError = Object.assign(new Error("busy"), { code: "EEXIST" })
    mockFsOpen.mockRejectedValueOnce(lockBusyError)
    mockFsOpen.mockResolvedValueOnce({ close })
    mockFsReadFile.mockResolvedValue(JSON.stringify({ pid: 999_999, createdAt: 1, host: "host" }))

    const originalKill = process.kill
    process.kill = mock((_pid: number, _signal?: number) => {
      const error = Object.assign(new Error("missing"), { code: "ESRCH" })
      throw error
    }) as typeof process.kill

    const fn = mock(async () => "done")

    try {
      const result = await cache.withCacheLock(cacheContext, fn, 1_000)
      expect(result).toBe("done")
      expect(mockFsUnlink).toHaveBeenCalledWith(cacheContext.mutexPath)
      expect(mockSleep).not.toHaveBeenCalled()
      expect(fn).toHaveBeenCalledTimes(1)
    } finally {
      process.kill = originalKill
    }
  })

  test("reclaims stale lock by age when metadata is unreadable", async () => {
    const cacheContext = makeCacheContext("/cache")
    const close = mock().mockResolvedValue(undefined)
    const lockBusyError = Object.assign(new Error("busy"), { code: "EEXIST" })
    mockFsOpen.mockRejectedValueOnce(lockBusyError)
    mockFsOpen.mockResolvedValueOnce({ close })
    mockFsReadFile.mockResolvedValue("not-json")
    mockFsStat.mockResolvedValue({ mtimeMs: 0 })

    const originalNow = Date.now
    Date.now = mock(() => 600_000) as typeof Date.now

    const fn = mock(async () => "ok")

    try {
      const result = await cache.withCacheLock(cacheContext, fn, 1_000)
      expect(result).toBe("ok")
      expect(mockFsUnlink).toHaveBeenCalledWith(cacheContext.mutexPath)
      expect(mockSleep).not.toHaveBeenCalled()
      expect(fn).toHaveBeenCalledTimes(1)
    } finally {
      Date.now = originalNow
    }
  })

  test("does not reclaim lock when owner pid is still alive", async () => {
    const cacheContext = makeCacheContext("/cache")
    const lockBusyError = Object.assign(new Error("busy"), { code: "EEXIST" })
    mockFsOpen.mockRejectedValue(lockBusyError)
    mockFsReadFile.mockResolvedValue(JSON.stringify({ pid: process.pid, createdAt: 1 }))

    const originalNow = Date.now
    const nowSpy = mock(() => {
      const value = nowSpy.mock.calls.length
      return value === 1 ? 0 : 31
    })
    Date.now = nowSpy as typeof Date.now

    try {
      await expect(cache.withCacheLock(cacheContext, async () => "never", 30)).rejects.toThrow(
        `Timed out waiting for cache lock: ${cacheContext.mutexPath}`,
      )
      expect(mockFsUnlink).not.toHaveBeenCalled()
      expect(mockSleep).not.toHaveBeenCalled()
    } finally {
      Date.now = originalNow
    }
  })

  test("throws timeout error when lock remains busy", async () => {
    const cacheContext = makeCacheContext("/cache")
    const lockBusyError = Object.assign(new Error("busy"), { code: "EEXIST" })
    mockFsOpen.mockRejectedValue(lockBusyError)
    const originalNow = Date.now
    const nowSpy = mock(() => {
      const value = nowSpy.mock.calls.length
      return value === 1 ? 0 : 31
    })
    Date.now = nowSpy as typeof Date.now

    try {
      await expect(cache.withCacheLock(cacheContext, async () => "never", 30)).rejects.toThrow(
        `Timed out waiting for cache lock: ${cacheContext.mutexPath}`,
      )
      expect(mockSleep).not.toHaveBeenCalled()
    } finally {
      Date.now = originalNow
    }
  })

  test("cleans up lock file when fn throws", async () => {
    const cacheContext = makeCacheContext("/cache")
    const close = mock().mockResolvedValue(undefined)
    mockFsOpen.mockResolvedValue({ close })
    const failure = new Error("boom")

    await expect(
      cache.withCacheLock(cacheContext, async () => {
        throw failure
      }),
    ).rejects.toBe(failure)

    expect(close).toHaveBeenCalledTimes(1)
    expect(mockFsUnlink).toHaveBeenCalledWith(cacheContext.mutexPath)
  })

  test("rethrows non-EEXIST open errors without retrying", async () => {
    const cacheContext = makeCacheContext("/cache")
    const openError = Object.assign(new Error("permission denied"), { code: "EACCES" })
    mockFsOpen.mockRejectedValue(openError)

    await expect(cache.withCacheLock(cacheContext, async () => "ok", 1_000)).rejects.toBe(openError)
    expect(mockSleep).not.toHaveBeenCalled()
    expect(mockFsOpen).toHaveBeenCalledTimes(1)
  })
})

describe("isTrustedLockEntryPath", () => {
  test("returns false when resolved path does not exist", async () => {
    const cacheContext = makeCacheContext("/cache")
    const entry = makeLockEntry("npm", { resolvedPath: "/cache/npm/test/index.js" })
    mockExists.mockResolvedValue(false)

    await expect(cache.isTrustedLockEntryPath(cacheContext, entry)).resolves.toBe(false)
    expect(mockFsRealpath).not.toHaveBeenCalled()
  })

  test("returns true for npm entry with resolved path inside expected install root", async () => {
    const cacheContext = makeCacheContext("/cache")
    const entry = makeLockEntry("npm", {
      name: "test-plugin",
      resolvedVersion: "1.0.0",
      resolvedPath: "/cache/npm/test-plugin@1.0.0/index.js",
    })
    mockExists.mockResolvedValue(true)

    await expect(cache.isTrustedLockEntryPath(cacheContext, entry)).resolves.toBe(true)
  })

  test("returns false for npm entry with resolved path outside cache", async () => {
    const cacheContext = makeCacheContext("/cache")
    const entry = makeLockEntry("npm", {
      name: "test-plugin",
      resolvedVersion: "1.0.0",
      resolvedPath: "/tmp/escaped/index.js",
    })
    mockExists.mockResolvedValue(true)

    await expect(cache.isTrustedLockEntryPath(cacheContext, entry)).resolves.toBe(false)
  })

  test("returns true for local file when resolved path matches exactly", async () => {
    const cacheContext = makeCacheContext("/cache")
    const entry = makeLockEntry("local", {
      path: "/local/plugin/index.js",
      resolvedPath: "/local/plugin/index.js",
    })
    mockExists.mockResolvedValue(true)
    mockFsStat.mockResolvedValue(makeStat("file"))

    await expect(cache.isTrustedLockEntryPath(cacheContext, entry)).resolves.toBe(true)
  })

  test("returns true for local directory when resolved path is inside directory", async () => {
    const cacheContext = makeCacheContext("/cache")
    const entry = makeLockEntry("local", {
      path: "/local/plugin",
      resolvedPath: "/local/plugin/sub/index.js",
    })
    mockExists.mockResolvedValue(true)
    mockFsStat.mockResolvedValue(makeStat("directory"))

    await expect(cache.isTrustedLockEntryPath(cacheContext, entry)).resolves.toBe(true)
  })

  test("returns false for local directory when resolved path escapes directory", async () => {
    const cacheContext = makeCacheContext("/cache")
    const entry = makeLockEntry("local", {
      path: "/local/plugin",
      resolvedPath: "/local/other/index.js",
    })
    mockExists.mockResolvedValue(true)
    mockFsStat.mockResolvedValue(makeStat("directory"))

    await expect(cache.isTrustedLockEntryPath(cacheContext, entry)).resolves.toBe(false)
  })

  test("falls back to path.resolve when realpath fails", async () => {
    const cacheContext = makeCacheContext("/cache")
    const entry = makeLockEntry("npm", {
      name: "test-plugin",
      resolvedVersion: "1.0.0",
      resolvedPath: "/cache/npm/test-plugin@1.0.0/main.js",
    })
    mockExists.mockResolvedValue(true)
    mockFsRealpath.mockRejectedValue(new Error("realpath failed"))

    await expect(cache.isTrustedLockEntryPath(cacheContext, entry)).resolves.toBe(true)
  })
})

describe("cleanCacheDirectories", () => {
  test("removes orphan directories and preserves lockfile-referenced directories", async () => {
    const cacheContext = makeCacheContext("/cache")
    const keepEntry = makeLockEntry("npm", {
      name: "kept",
      resolvedVersion: "1.2.3",
      resolvedPath: "/cache/npm/kept@1.2.3/index.js",
    })
    const lockfile: Lockfile = {
      version: 1,
      plugins: {
        kept: keepEntry,
      },
    }

    mockExists.mockResolvedValue(true)
    mockFsReaddir.mockImplementation(async (dirPath: string) => {
      if (dirPath === path.join(cacheContext.rootDir, "npm")) {
        return [
          makeDirent("kept@1.2.3", true),
          makeDirent("orphan", true),
          makeDirent("README.md", false),
        ]
      }
      if (dirPath === path.join(cacheContext.rootDir, "git")) {
        return [makeDirent("stale-git", true)]
      }
      return []
    })

    const result = await cache.cleanCacheDirectories(cacheContext, lockfile)

    const removedNpmPath = path.resolve(path.join(cacheContext.rootDir, "npm", "orphan"))
    const removedGitPath = path.resolve(path.join(cacheContext.rootDir, "git", "stale-git"))
    const keptPath = path.resolve(path.join(cacheContext.rootDir, "npm", "kept@1.2.3"))

    expect(result.removedPaths.sort()).toEqual([removedGitPath, removedNpmPath].sort())
    expect(mockFsRm).toHaveBeenCalledWith(removedNpmPath, { recursive: true, force: true })
    expect(mockFsRm).toHaveBeenCalledWith(removedGitPath, { recursive: true, force: true })
    expect(mockFsRm).not.toHaveBeenCalledWith(keptPath, expect.anything())
  })

  test("skips non-existent source directories", async () => {
    const cacheContext = makeCacheContext("/cache")
    mockExists.mockResolvedValue(false)

    await expect(cache.cleanCacheDirectories(cacheContext, EMPTY_LOCKFILE)).resolves.toEqual({ removedPaths: [] })
    expect(mockFsReaddir).not.toHaveBeenCalled()
    expect(mockFsRm).not.toHaveBeenCalled()
  })
})

describe("path construction", () => {
  test("npmInstallDir builds a sanitized path", () => {
    const cacheContext = makeCacheContext("/cache")
    expect(cache.npmInstallDir(cacheContext, "@scope/pkg", "1.0.0/beta")).toBe(
      path.join("/cache", "npm", "_scope_pkg@1.0.0_beta"),
    )
  })

  test("gitInstallDir truncates commit hash to 12 chars", () => {
    const cacheContext = makeCacheContext("/cache")
    expect(cache.gitInstallDir(cacheContext, "https://github.com/foo/bar.git", "1234567890abcdef")).toBe(
      path.join("/cache", "git", "https___github.com_foo_bar.git-1234567890ab"),
    )
  })

})
