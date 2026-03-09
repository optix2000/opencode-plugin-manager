import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { LockEntry, Lockfile, ManagedPluginSpec } from "../types"
import { makeCacheContext, makeLockEntry, makeSpec } from "./helpers"

type NpmSpec = Extract<ManagedPluginSpec, { source: "npm" }>
type GitSpec = Extract<ManagedPluginSpec, { source: "git" }>
type LocalSpec = Extract<ManagedPluginSpec, { source: "local" }>

const mockIsTrustedLockEntryPath = mock()
const mockExists = mock()

const mockSyncNpmPlugin = mock()
const mockSyncGitPlugin = mock()
const mockSyncLocalPlugin = mock()

mock.module("../resolver.deps", () => ({
  isTrustedLockEntryPath: mockIsTrustedLockEntryPath,
  exists: mockExists,
  syncNpmPlugin: mockSyncNpmPlugin,
  syncGitPlugin: mockSyncGitPlugin,
  syncLocalPlugin: mockSyncLocalPlugin,
  pluginDisplayName: (spec: { id: string }) => spec.id,
}))

const { resolveCachedPluginPaths, syncPlugins } = await import("../resolver")

const cache = makeCacheContext("/cache")

function emptyLockfile(): Lockfile {
  return {
    version: 1,
    plugins: {},
  }
}

function lockfileWith(spec: ManagedPluginSpec, entry: LockEntry): Lockfile {
  return {
    version: 1,
    plugins: {
      [spec.id]: entry,
    },
  }
}

async function runSyncPlugins(specs: ManagedPluginSpec[], currentLock: Lockfile, mode: "install" | "update") {
  return syncPlugins({ specs, cache, currentLock, mode })
}


beforeEach(() => {
  for (const fn of [
    mockIsTrustedLockEntryPath,
    mockExists,
    mockSyncNpmPlugin,
    mockSyncGitPlugin,
    mockSyncLocalPlugin,
  ]) {
    fn.mockReset()
  }

  mockIsTrustedLockEntryPath.mockResolvedValue(true)
  mockExists.mockResolvedValue(true)

  mockSyncNpmPlugin.mockImplementation(async (specArg: unknown) => {
    const spec = specArg as NpmSpec
    return makeLockEntry("npm", {
      id: spec.id,
      name: spec.name,
      requestedVersion: spec.version,
      resolvedVersion: "9.9.9",
    })
  })

  mockSyncGitPlugin.mockImplementation(async (specArg: unknown) => {
    const spec = specArg as GitSpec
    return makeLockEntry("git", {
      id: spec.id,
      repo: spec.repo,
      ref: spec.ref,
      commit: "new-commit",
    })
  })

  mockSyncLocalPlugin.mockImplementation(async (specArg: unknown) => {
    const spec = specArg as LocalSpec
    return makeLockEntry("local", {
      id: spec.id,
      path: spec.path,
      entry: spec.entry,
      resolvedPath: `${spec.path}/${spec.entry ?? "index.js"}`,
    })
  })

})

describe("syncPlugins flow control", () => {
  describe("install mode", () => {
    test("reuses trusted compatible lock and skips backend sync", async () => {
      const spec = makeSpec("npm", { id: "npm:cached", name: "cached-plugin" })
      const previous = makeLockEntry("npm", {
        id: spec.id,
        name: spec.name,
        resolvedVersion: "1.2.3",
      })

      const result = await runSyncPlugins([spec], lockfileWith(spec, previous), "install")

      expect(result.lockfile.plugins[spec.id]).toBe(previous)
      expect(result.updated).toEqual([])
      expect(result.reused).toEqual([`${spec.id} (cached)`])
      expect(result.warnings).toEqual([])

      expect(mockIsTrustedLockEntryPath).toHaveBeenCalledWith(cache, previous)
      expect(mockSyncNpmPlugin).not.toHaveBeenCalled()
      expect(mockSyncGitPlugin).not.toHaveBeenCalled()
      expect(mockSyncLocalPlugin).not.toHaveBeenCalled()
    })

    test("syncs when lock is compatible but untrusted", async () => {
      const spec = makeSpec("npm", { id: "npm:untrusted", name: "pkg-untrusted" })
      const previous = makeLockEntry("npm", {
        id: spec.id,
        name: spec.name,
        resolvedVersion: "1.0.0",
      })
      mockIsTrustedLockEntryPath.mockResolvedValue(false)

      const result = await runSyncPlugins([spec], lockfileWith(spec, previous), "install")

      expect(result.updated).toEqual([`${spec.id} (install)`])
      expect(result.reused).toEqual([])
      expect(result.warnings).toEqual([])
      expect(result.lockfile.plugins[spec.id]).toEqual(
        makeLockEntry("npm", {
          id: spec.id,
          name: spec.name,
          requestedVersion: spec.version,
          resolvedVersion: "9.9.9",
        }),
      )
      expect(mockSyncNpmPlugin).toHaveBeenCalledWith(spec, cache, { lockedVersion: previous.resolvedVersion }, expect.anything())
    })

    test("syncs when lock is incompatible", async () => {
      const spec = makeSpec("npm", {
        id: "npm:range-mismatch",
        name: "pkg-range",
        version: "^2.0.0",
      })
      const previous = makeLockEntry("npm", {
        id: spec.id,
        name: spec.name,
        resolvedVersion: "1.4.0",
      })

      const result = await runSyncPlugins([spec], lockfileWith(spec, previous), "install")

      expect(result.updated).toEqual([`${spec.id} (install)`])
      expect(result.reused).toEqual([])
      expect(mockSyncNpmPlugin).toHaveBeenCalledWith(spec, cache, { lockedVersion: undefined }, expect.anything())
      expect(mockIsTrustedLockEntryPath).not.toHaveBeenCalled()
    })

    test("syncs when no previous lock entry exists", async () => {
      const spec = makeSpec("git", { id: "git:no-lock", ref: "main" })

      const result = await runSyncPlugins([spec], emptyLockfile(), "install")

      expect(result.updated).toEqual([`${spec.id} (install)`])
      expect(result.reused).toEqual([])
      expect(result.warnings).toEqual([])
      expect(mockSyncGitPlugin).toHaveBeenCalledWith(spec, cache, { lockedCommit: undefined }, expect.anything())
      expect(mockIsTrustedLockEntryPath).not.toHaveBeenCalled()
    })
  })

  describe("update mode", () => {
    test("always syncs even when lock is trusted and compatible", async () => {
      const spec = makeSpec("git", {
        id: "git:update-compatible",
        repo: "https://github.com/test/update-compatible",
        ref: "main",
      })
      const previous = makeLockEntry("git", {
        id: spec.id,
        repo: spec.repo,
        ref: "main",
        commit: "old-commit",
      })

      const result = await runSyncPlugins([spec], lockfileWith(spec, previous), "update")

      expect(result.updated).toEqual([`${spec.id} (update)`])
      expect(result.reused).toEqual([])
      expect(result.warnings).toEqual([])
      expect(mockSyncGitPlugin).toHaveBeenCalledWith(spec, cache, { lockedCommit: undefined }, expect.anything())
    })
  })

  describe("error handling", () => {
    test("falls back to trusted compatible previous lock when backend fails", async () => {
      const spec = makeSpec("npm", {
        id: "npm:fallback",
        name: "fallback-plugin",
        version: "^1.0.0",
      })
      const previous = makeLockEntry("npm", {
        id: spec.id,
        name: spec.name,
        resolvedVersion: "1.2.3",
      })

      mockSyncNpmPlugin.mockRejectedValueOnce(new Error("backend down"))

      const result = await runSyncPlugins([spec], lockfileWith(spec, previous), "update")

      expect(result.lockfile.plugins[spec.id]).toBe(previous)
      expect(result.updated).toEqual([])
      expect(result.reused).toEqual([`${spec.id} (fallback cache)`])
      expect(result.warnings).toEqual([`[plugin-manager] Failed to sync ${spec.id}: Error: backend down`])
      expect(mockIsTrustedLockEntryPath).toHaveBeenCalledTimes(2)
    })

    test("records warning and omits plugin when backend fails with no previous lock", async () => {
      const spec = makeSpec("local", { id: "local:missing-fallback", path: "/plugins/missing-fallback" })
      mockSyncLocalPlugin.mockRejectedValueOnce(new Error("local sync failed"))

      const result = await runSyncPlugins([spec], emptyLockfile(), "install")

      expect(result.lockfile.plugins[spec.id]).toBeUndefined()
      expect(result.updated).toEqual([])
      expect(result.reused).toEqual([])
      expect(result.warnings).toEqual([`[plugin-manager] Failed to sync ${spec.id}: Error: local sync failed`])
    })

    test("records warning without fallback when previous lock is untrusted", async () => {
      const spec = makeSpec("git", {
        id: "git:untrusted-fallback",
        repo: "https://github.com/test/untrusted-fallback",
        ref: "main",
      })
      const previous = makeLockEntry("git", {
        id: spec.id,
        repo: spec.repo,
        ref: "main",
        commit: "abc123",
      })

      mockIsTrustedLockEntryPath.mockResolvedValue(false)
      mockSyncGitPlugin.mockRejectedValueOnce(new Error("git sync failed"))

      const result = await runSyncPlugins([spec], lockfileWith(spec, previous), "update")

      expect(result.lockfile.plugins[spec.id]).toBeUndefined()
      expect(result.updated).toEqual([])
      expect(result.reused).toEqual([])
      expect(result.warnings).toEqual([`[plugin-manager] Failed to sync ${spec.id}: Error: git sync failed`])
      expect(mockIsTrustedLockEntryPath).toHaveBeenCalledTimes(2)
    })
  })

  test("processes multiple specs independently and aggregates results", async () => {
    const cachedSpec = makeSpec("npm", { id: "npm:cached-multi", name: "cached-multi" })
    const updatedSpec = makeSpec("git", {
      id: "git:updated-multi",
      repo: "https://github.com/test/updated-multi",
      ref: "v2",
    })
    const failedSpec = makeSpec("local", {
      id: "local:failed-multi",
      path: "/plugins/failed-multi",
    })

    const cachedPrevious = makeLockEntry("npm", {
      id: cachedSpec.id,
      name: cachedSpec.name,
      resolvedVersion: "1.0.0",
    })
    const incompatibleGitPrevious = makeLockEntry("git", {
      id: updatedSpec.id,
      repo: updatedSpec.repo,
      ref: "v1",
      commit: "old-commit",
    })

    mockIsTrustedLockEntryPath.mockImplementation(async (_cacheArg: unknown, entryArg: unknown) => {
      const entry = entryArg as LockEntry
      return entry.id === cachedSpec.id
    })
    mockSyncGitPlugin.mockResolvedValueOnce(
      makeLockEntry("git", {
        id: updatedSpec.id,
        repo: updatedSpec.repo,
        ref: updatedSpec.ref,
        commit: "new-commit-multi",
      }),
    )
    mockSyncLocalPlugin.mockRejectedValueOnce(new Error("local failed"))

    const result = await runSyncPlugins(
      [cachedSpec, updatedSpec, failedSpec],
      {
        version: 1,
        plugins: {
          [cachedSpec.id]: cachedPrevious,
          [updatedSpec.id]: incompatibleGitPrevious,
        },
      },
      "install",
    )

    expect(result.reused).toEqual([`${cachedSpec.id} (cached)`])
    expect(result.updated).toEqual([`${updatedSpec.id} (install)`])
    expect(result.warnings).toEqual([`[plugin-manager] Failed to sync ${failedSpec.id}: Error: local failed`])
    expect(result.lockfile.plugins[cachedSpec.id]).toBe(cachedPrevious)
    expect(result.lockfile.plugins[updatedSpec.id]).toEqual(
      makeLockEntry("git", {
        id: updatedSpec.id,
        repo: updatedSpec.repo,
        ref: updatedSpec.ref,
        commit: "new-commit-multi",
      }),
    )
    expect(result.lockfile.plugins[failedSpec.id]).toBeUndefined()
  })
})

describe("isCompatibleLock behavior via syncPlugins", () => {
  test("npm lock is compatible with no version constraint", async () => {
    const spec = makeSpec("npm", { id: "npm:no-version", version: undefined })
    const previous = makeLockEntry("npm", {
      id: spec.id,
      name: spec.name,
      resolvedVersion: "3.4.5",
    })

    const result = await runSyncPlugins([spec], lockfileWith(spec, previous), "install")

    expect(result.reused).toEqual([`${spec.id} (cached)`])
    expect(mockSyncNpmPlugin).not.toHaveBeenCalled()
  })

  test("npm lock is compatible when resolved version matches range", async () => {
    const spec = makeSpec("npm", {
      id: "npm:range-match",
      name: "range-match",
      version: "^1.0.0",
    })
    const previous = makeLockEntry("npm", {
      id: spec.id,
      name: spec.name,
      resolvedVersion: "1.9.0",
    })

    const result = await runSyncPlugins([spec], lockfileWith(spec, previous), "install")

    expect(result.reused).toEqual([`${spec.id} (cached)`])
    expect(mockSyncNpmPlugin).not.toHaveBeenCalled()
  })

  test("git lock is compatible when spec has no ref", async () => {
    const spec = makeSpec("git", {
      id: "git:no-ref",
      repo: "https://github.com/test/no-ref",
      ref: undefined,
    })
    const previous = makeLockEntry("git", {
      id: spec.id,
      repo: spec.repo,
      ref: "any-ref",
      commit: "abc",
    })

    const result = await runSyncPlugins([spec], lockfileWith(spec, previous), "install")

    expect(result.reused).toEqual([`${spec.id} (cached)`])
    expect(mockSyncGitPlugin).not.toHaveBeenCalled()
  })

  test("git lock is compatible when refs match", async () => {
    const spec = makeSpec("git", {
      id: "git:ref-match",
      repo: "https://github.com/test/ref-match",
      ref: "main",
    })
    const previous = makeLockEntry("git", {
      id: spec.id,
      repo: spec.repo,
      ref: "main",
      commit: "abc",
    })

    const result = await runSyncPlugins([spec], lockfileWith(spec, previous), "install")

    expect(result.reused).toEqual([`${spec.id} (cached)`])
    expect(mockSyncGitPlugin).not.toHaveBeenCalled()
  })

  test("git lock is incompatible when ref changes", async () => {
    const spec = makeSpec("git", {
      id: "git:ref-mismatch",
      repo: "https://github.com/test/ref-mismatch",
      ref: "main",
    })
    const previous = makeLockEntry("git", {
      id: spec.id,
      repo: spec.repo,
      ref: "develop",
      commit: "abc",
    })

    const result = await runSyncPlugins([spec], lockfileWith(spec, previous), "install")

    expect(result.updated).toEqual([`${spec.id} (install)`])
    expect(mockSyncGitPlugin).toHaveBeenCalledWith(spec, cache, { lockedCommit: undefined }, expect.anything())
  })

  test("local lock is compatible when path and entry match", async () => {
    const spec = makeSpec("local", {
      id: "local:match",
      path: "/plugins/match",
      entry: "dist/index.js",
    })
    const previous = makeLockEntry("local", {
      id: spec.id,
      path: "/plugins/match",
      entry: "dist/index.js",
      resolvedPath: "/plugins/match/dist/index.js",
    })

    const result = await runSyncPlugins([spec], lockfileWith(spec, previous), "install")

    expect(result.reused).toEqual([`${spec.id} (cached)`])
    expect(mockSyncLocalPlugin).not.toHaveBeenCalled()
  })

  test("local lock is incompatible when path changes", async () => {
    const spec = makeSpec("local", {
      id: "local:path-mismatch",
      path: "/plugins/new",
      entry: "dist/index.js",
    })
    const previous = makeLockEntry("local", {
      id: spec.id,
      path: "/plugins/old",
      entry: "dist/index.js",
      resolvedPath: "/plugins/old/dist/index.js",
    })

    const result = await runSyncPlugins([spec], lockfileWith(spec, previous), "install")

    expect(result.updated).toEqual([`${spec.id} (install)`])
    expect(mockSyncLocalPlugin).toHaveBeenCalledWith(spec, expect.anything())
  })

  test("treats source type mismatch as incompatible", async () => {
    const sharedId = "plugin:source-mismatch"
    const spec = makeSpec("npm", {
      id: sharedId,
      name: "source-mismatch",
    })
    const previous = makeLockEntry("git", {
      id: sharedId,
      repo: "https://github.com/test/source-mismatch",
      ref: "main",
      commit: "abc123",
    })

    const result = await runSyncPlugins([spec], lockfileWith(spec, previous), "install")

    expect(result.updated).toEqual([`${spec.id} (install)`])
    expect(mockSyncNpmPlugin).toHaveBeenCalledWith(spec, cache, { lockedVersion: undefined }, expect.anything())
    expect(mockIsTrustedLockEntryPath).not.toHaveBeenCalled()
  })
})

describe("syncSinglePlugin dispatch via syncPlugins", () => {
  test("npm sync receives lockedVersion in install mode", async () => {
    const spec = makeSpec("npm", { id: "npm:dispatch-install", name: "dispatch-install" })
    const previous = makeLockEntry("npm", {
      id: spec.id,
      name: spec.name,
      resolvedVersion: "2.1.0",
    })

    mockIsTrustedLockEntryPath.mockResolvedValue(false)
    await runSyncPlugins([spec], lockfileWith(spec, previous), "install")

    expect(mockSyncNpmPlugin).toHaveBeenCalledWith(spec, cache, { lockedVersion: "2.1.0" }, expect.anything())
  })

  test("git sync receives lockedCommit in install mode", async () => {
    const spec = makeSpec("git", {
      id: "git:dispatch-install",
      repo: "https://github.com/test/dispatch-install",
      ref: "main",
    })
    const previous = makeLockEntry("git", {
      id: spec.id,
      repo: spec.repo,
      ref: "main",
      commit: "commit-123",
    })

    mockIsTrustedLockEntryPath.mockResolvedValue(false)
    await runSyncPlugins([spec], lockfileWith(spec, previous), "install")

    expect(mockSyncGitPlugin).toHaveBeenCalledWith(spec, cache, { lockedCommit: "commit-123" }, expect.anything())
  })

  test("local specs dispatch to syncLocalPlugin", async () => {
    const spec = makeSpec("local", { id: "local:dispatch", path: "/plugins/dispatch" })

    await runSyncPlugins([spec], emptyLockfile(), "install")

    expect(mockSyncLocalPlugin).toHaveBeenCalledWith(spec, expect.anything())
    expect(mockSyncNpmPlugin).not.toHaveBeenCalled()
    expect(mockSyncGitPlugin).not.toHaveBeenCalled()
  })

  test("update mode never forwards locked values to npm/git backends", async () => {
    const npmSpec = makeSpec("npm", { id: "npm:update-no-locked", name: "update-no-locked" })
    const gitSpec = makeSpec("git", {
      id: "git:update-no-locked",
      repo: "https://github.com/test/update-no-locked",
      ref: "main",
    })

    const currentLock: Lockfile = {
      version: 1,
      plugins: {
        [npmSpec.id]: makeLockEntry("npm", {
          id: npmSpec.id,
          name: npmSpec.name,
          resolvedVersion: "1.0.0",
        }),
        [gitSpec.id]: makeLockEntry("git", {
          id: gitSpec.id,
          repo: gitSpec.repo,
          ref: "main",
          commit: "old-commit",
        }),
      },
    }

    await runSyncPlugins([npmSpec, gitSpec], currentLock, "update")

    expect(mockSyncNpmPlugin).toHaveBeenCalledWith(npmSpec, cache, { lockedVersion: undefined }, expect.anything())
    expect(mockSyncGitPlugin).toHaveBeenCalledWith(gitSpec, cache, { lockedCommit: undefined }, expect.anything())
  })
})

describe("resolveCachedPluginPaths", () => {
  test("includes compatible, existing, trusted cached entries", async () => {
    const spec = makeSpec("npm", {
      id: "npm:resolve-valid",
      name: "resolve-valid",
      version: "^1.0.0",
    })
    const entry = makeLockEntry("npm", {
      id: spec.id,
      name: spec.name,
      resolvedVersion: "1.3.0",
      resolvedPath: "/cache/npm/resolve-valid/index.js",
    })

    const result = await resolveCachedPluginPaths([spec], lockfileWith(spec, entry), cache)

    expect(result).toEqual([entry])
    expect(mockExists).toHaveBeenCalledWith(entry.resolvedPath)
    expect(mockIsTrustedLockEntryPath).toHaveBeenCalledWith(cache, entry)
  })

  test("skips specs that do not exist in lockfile", async () => {
    const spec = makeSpec("npm", { id: "npm:resolve-missing", name: "resolve-missing" })

    const result = await resolveCachedPluginPaths([spec], emptyLockfile(), cache)

    expect(result).toEqual([])
    expect(mockExists).not.toHaveBeenCalled()
    expect(mockIsTrustedLockEntryPath).not.toHaveBeenCalled()
  })

  test("excludes incompatible lock entries and warns", async () => {
    const spec = makeSpec("git", {
      id: "git:resolve-incompatible",
      repo: "https://github.com/test/resolve-incompatible",
      ref: "main",
    })
    const entry = makeLockEntry("git", {
      id: spec.id,
      repo: spec.repo,
      ref: "develop",
      commit: "abc",
    })

    const originalWarn = console.warn
    const warnSpy = mock(() => undefined)
    console.warn = warnSpy as typeof console.warn

    try {
      const result = await resolveCachedPluginPaths([spec], lockfileWith(spec, entry), cache)

      expect(result).toEqual([])
      expect(warnSpy).toHaveBeenCalledWith(
        `[plugin-manager] Ignoring incompatible lock entry for ${spec.id}`,
        expect.objectContaining({
          pluginID: spec.id,
        }),
      )
      expect(mockExists).not.toHaveBeenCalled()
      expect(mockIsTrustedLockEntryPath).not.toHaveBeenCalled()
    } finally {
      console.warn = originalWarn
    }
  })

  test("excludes missing resolved paths and warns", async () => {
    const spec = makeSpec("npm", {
      id: "npm:resolve-missing-path",
      name: "resolve-missing-path",
    })
    const entry = makeLockEntry("npm", {
      id: spec.id,
      name: spec.name,
      resolvedVersion: "1.0.0",
      resolvedPath: "/cache/npm/resolve-missing-path/index.js",
    })

    mockExists.mockResolvedValue(false)
    const originalWarn = console.warn
    const warnSpy = mock(() => undefined)
    console.warn = warnSpy as typeof console.warn

    try {
      const result = await resolveCachedPluginPaths([spec], lockfileWith(spec, entry), cache)

      expect(result).toEqual([])
      expect(warnSpy).toHaveBeenCalledWith(
        `[plugin-manager] Cached plugin missing on disk: ${spec.id}`,
        expect.objectContaining({
          pluginID: spec.id,
          resolvedPath: entry.resolvedPath,
        }),
      )
      expect(mockIsTrustedLockEntryPath).not.toHaveBeenCalled()
    } finally {
      console.warn = originalWarn
    }
  })

  test("excludes untrusted paths and warns", async () => {
    const spec = makeSpec("npm", {
      id: "npm:resolve-untrusted",
      name: "resolve-untrusted",
    })
    const entry = makeLockEntry("npm", {
      id: spec.id,
      name: spec.name,
      resolvedVersion: "1.0.0",
      resolvedPath: "/cache/npm/resolve-untrusted/index.js",
    })

    mockExists.mockResolvedValue(true)
    mockIsTrustedLockEntryPath.mockResolvedValue(false)
    const originalWarn = console.warn
    const warnSpy = mock(() => undefined)
    console.warn = warnSpy as typeof console.warn

    try {
      const result = await resolveCachedPluginPaths([spec], lockfileWith(spec, entry), cache)

      expect(result).toEqual([])
      expect(warnSpy).toHaveBeenCalledWith(
        `[plugin-manager] Ignoring untrusted lock path for ${spec.id}: ${entry.resolvedPath}`,
        expect.objectContaining({
          pluginID: spec.id,
          resolvedPath: entry.resolvedPath,
        }),
      )
      expect(mockIsTrustedLockEntryPath).toHaveBeenCalledWith(cache, entry)
    } finally {
      console.warn = originalWarn
    }
  })
})
