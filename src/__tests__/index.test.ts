import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import semver from "semver"
import type { MergedConfig } from "../config"
import { pluginDisplayName } from "../config"
import type { LockEntry, Lockfile } from "../types"
import { makeCacheContext, makeLockEntry, makeSpec } from "./helpers"

const mockLoadMergedConfig = mock()
const mockResolveCacheContext = mock()
const mockReadLockfile = mock()
const mockWriteLockfile = mock()
const mockWithCacheLock = mock()
const mockPruneCacheDirectories = mock()

const mockResolveCachedPluginPaths = mock()
const mockSyncPlugins = mock()

const mockLoadManagedPlugins = mock()
const mockMergeManagedHooks = mock()

const mockExists = mock()

const mockFsReadFile = mock()
const mockFetch = mock()
const mockAppLog = mock()
const managedConfigHook = mock(async () => undefined)

mock.module("../index.deps", () => ({
  tool: (definition: unknown) => definition,
  loadMergedConfig: mockLoadMergedConfig,
  resolveCacheContext: mockResolveCacheContext,
  readLockfile: mockReadLockfile,
  writeLockfile: mockWriteLockfile,
  withCacheLock: mockWithCacheLock,
  pruneCacheDirectories: mockPruneCacheDirectories,
  resolveCachedPluginPaths: mockResolveCachedPluginPaths,
  syncPlugins: mockSyncPlugins,
  loadManagedPlugins: mockLoadManagedPlugins,
  mergeManagedHooks: mockMergeManagedHooks,
  pluginDisplayName,
  exists: mockExists,
  semver,
  fs: {
    readFile: mockFsReadFile,
  },
}))

const originalFetch = globalThis.fetch

const { PluginManager } = await import("../index")

function makeMergedConfig(overrides: Partial<MergedConfig> = {}): MergedConfig {
  return {
    files: ["/workspace/plugins.json"],
    plugins: [makeSpec("npm", { id: "npm:default", name: "default-plugin" })],
    ...overrides,
  }
}

function makeLockfile(plugins: Record<string, LockEntry> = {}): Lockfile {
  return {
    version: 1,
    plugins,
  }
}

function makeToolContext(): any {
  return {
    metadata: mock(),
  }
}

function makePluginInput(overrides: Record<string, unknown> = {}): any {
  return {
    client: {
      app: {
        log: mockAppLog,
      },
    },
    ...overrides,
  }
}

function hasLogged(level: string, message: string): boolean {
  return mockAppLog.mock.calls.some(([payload]) => payload?.body?.level === level && payload?.body?.message === message)
}


beforeEach(() => {
  for (const fn of [
    mockLoadMergedConfig,
    mockResolveCacheContext,
    mockReadLockfile,
    mockWriteLockfile,
    mockWithCacheLock,
    mockPruneCacheDirectories,
    mockResolveCachedPluginPaths,
    mockSyncPlugins,
    mockLoadManagedPlugins,
    mockMergeManagedHooks,
    mockExists,
    mockFsReadFile,
    mockFetch,
    mockAppLog,
    managedConfigHook,
  ]) {
    fn.mockReset()
  }

  mockLoadMergedConfig.mockResolvedValue(makeMergedConfig())
  mockResolveCacheContext.mockReturnValue(makeCacheContext("/cache"))
  mockReadLockfile.mockResolvedValue(makeLockfile())
  mockWriteLockfile.mockResolvedValue(undefined)
  mockWithCacheLock.mockImplementation(async (_cache: unknown, fn: () => Promise<unknown>) => fn())
  mockPruneCacheDirectories.mockResolvedValue({ removedPaths: [] })

  mockResolveCachedPluginPaths.mockResolvedValue([])
  mockSyncPlugins.mockResolvedValue({
    lockfile: makeLockfile(),
    updated: [],
    reused: [],
    warnings: [],
  })

  mockLoadManagedPlugins.mockResolvedValue([{ id: "loaded-plugin" }])
  mockMergeManagedHooks.mockReturnValue({
    hooks: {
      config: managedConfigHook,
    },
    collectTools: () => ({
      "managed.tool": {
        description: "managed tool",
        args: {},
        execute: async () => "managed",
      },
    }),
    collectAuth: () => "managed-auth",
  })

  mockExists.mockResolvedValue(true)

  mockFsReadFile.mockResolvedValue(JSON.stringify({ version: "1.0.0" }))
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ version: "1.0.0" }),
  })
  mockAppLog.mockResolvedValue(true)

  globalThis.fetch = mockFetch as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("PluginManager config hook", () => {
  test("logs when no plugins.json is found", async () => {
    mockLoadMergedConfig.mockResolvedValue(
      makeMergedConfig({
        files: [],
      }),
    )

    const hooks = (await PluginManager(makePluginInput())) as any
    await hooks.config({})

    expect(hasLogged("info", "[plugin-manager] No plugins.json found")).toBe(true)
    expect(managedConfigHook).toHaveBeenCalledWith({})
  })

  test("logs when plugins.json exists but has no plugin entries", async () => {
    mockLoadMergedConfig.mockResolvedValue(
      makeMergedConfig({
        plugins: [],
      }),
    )

    const hooks = (await PluginManager(makePluginInput())) as any
    await hooks.config({})

    expect(hasLogged("info", "[plugin-manager] plugins.json found, but no plugins are configured")).toBe(true)
  })

  test("logs when plugins are configured but none are loaded", async () => {
    mockLoadManagedPlugins.mockResolvedValue([])

    const hooks = (await PluginManager(makePluginInput())) as any
    await hooks.config({})

    expect(hasLogged("info", "[plugin-manager] No cached plugins loaded. Run tool: opm_install")).toBe(true)
  })

  test("suppresses 'no cached plugins' message when autoinstall is enabled", async () => {
    mockLoadManagedPlugins.mockResolvedValue([])
    mockLoadMergedConfig.mockResolvedValue(makeMergedConfig({ autoinstall: true }))
    mockSyncPlugins.mockResolvedValue({
      lockfile: makeLockfile(),
      updated: [],
      reused: [],
      warnings: [],
    })

    const hooks = (await PluginManager(makePluginInput())) as any
    await hooks.config({})

    expect(hasLogged("info", "[plugin-manager] No cached plugins loaded. Run tool: opm_install")).toBe(false)
  })
})

describe("reportPlugins config hook", () => {
  test("appends loaded plugin display names to config.plugin when reportPlugins is true", async () => {
    const spec = makeSpec("npm", { id: "npm:my-plugin", name: "my-plugin", version: "2.0.0" })
    mockLoadMergedConfig.mockResolvedValue(makeMergedConfig({ plugins: [spec], reportPlugins: true }))
    mockLoadManagedPlugins.mockResolvedValue([{ id: "npm:my-plugin", hooks: {} }])

    const hooks = (await PluginManager(makePluginInput())) as any
    const config: any = { plugin: ["opencode-plugin-manager"] }
    await hooks.config(config)

    expect(config.plugin).toEqual(["opencode-plugin-manager", "my-plugin@2.0.0"])
  })

  test("does not modify config.plugin when reportPlugins is false", async () => {
    const spec = makeSpec("npm", { id: "npm:my-plugin", name: "my-plugin" })
    mockLoadMergedConfig.mockResolvedValue(makeMergedConfig({ plugins: [spec], reportPlugins: false }))
    mockLoadManagedPlugins.mockResolvedValue([{ id: "npm:my-plugin", hooks: {} }])

    const hooks = (await PluginManager(makePluginInput())) as any
    const config: any = { plugin: ["opencode-plugin-manager"] }
    await hooks.config(config)

    expect(config.plugin).toEqual(["opencode-plugin-manager"])
  })

  test("does not modify config.plugin when reportPlugins is not set", async () => {
    const spec = makeSpec("npm", { id: "npm:my-plugin", name: "my-plugin" })
    mockLoadMergedConfig.mockResolvedValue(makeMergedConfig({ plugins: [spec] }))
    mockLoadManagedPlugins.mockResolvedValue([{ id: "npm:my-plugin", hooks: {} }])

    const hooks = (await PluginManager(makePluginInput())) as any
    const config: any = { plugin: ["opencode-plugin-manager"] }
    await hooks.config(config)

    expect(config.plugin).toEqual(["opencode-plugin-manager"])
  })

  test("creates config.plugin array when it is undefined", async () => {
    const spec = makeSpec("npm", { id: "npm:my-plugin", name: "my-plugin" })
    mockLoadMergedConfig.mockResolvedValue(makeMergedConfig({ plugins: [spec], reportPlugins: true }))
    mockLoadManagedPlugins.mockResolvedValue([{ id: "npm:my-plugin", hooks: {} }])

    const hooks = (await PluginManager(makePluginInput())) as any
    const config: any = {}
    await hooks.config(config)

    expect(config.plugin).toEqual(["my-plugin"])
  })

  test("does not add duplicates when plugin name already in config.plugin", async () => {
    const spec = makeSpec("npm", { id: "npm:my-plugin", name: "my-plugin" })
    mockLoadMergedConfig.mockResolvedValue(makeMergedConfig({ plugins: [spec], reportPlugins: true }))
    mockLoadManagedPlugins.mockResolvedValue([{ id: "npm:my-plugin", hooks: {} }])

    const hooks = (await PluginManager(makePluginInput())) as any
    const config: any = { plugin: ["my-plugin"] }
    await hooks.config(config)

    expect(config.plugin).toEqual(["my-plugin"])
  })

  test("replaces the array instead of mutating the original", async () => {
    const spec = makeSpec("npm", { id: "npm:my-plugin", name: "my-plugin" })
    mockLoadMergedConfig.mockResolvedValue(makeMergedConfig({ plugins: [spec], reportPlugins: true }))
    mockLoadManagedPlugins.mockResolvedValue([{ id: "npm:my-plugin", hooks: {} }])

    const hooks = (await PluginManager(makePluginInput())) as any
    const originalArray = ["opencode-plugin-manager"]
    const config: any = { plugin: originalArray }
    await hooks.config(config)

    // The original array should not have been mutated
    expect(originalArray).toEqual(["opencode-plugin-manager"])
    // config.plugin should be a new array with the additions
    expect(config.plugin).toEqual(["opencode-plugin-manager", "my-plugin"])
    expect(config.plugin).not.toBe(originalArray)
  })

  test("reports multiple plugins from different sources", async () => {
    const npmSpec = makeSpec("npm", { id: "npm:pkg-a", name: "pkg-a" })
    const gitSpec = makeSpec("git", { id: "git:https://github.com/org/repo", repo: "https://github.com/org/repo", ref: "main" })
    const localSpec = makeSpec("local", { id: "local:/my/plugin", path: "/my/plugin" })
    mockLoadMergedConfig.mockResolvedValue(
      makeMergedConfig({ plugins: [npmSpec, gitSpec, localSpec], reportPlugins: true }),
    )
    mockLoadManagedPlugins.mockResolvedValue([
      { id: "npm:pkg-a", hooks: {} },
      { id: "git:https://github.com/org/repo", hooks: {} },
      { id: "local:/my/plugin", hooks: {} },
    ])

    const hooks = (await PluginManager(makePluginInput())) as any
    const config: any = { plugin: [] }
    await hooks.config(config)

    expect(config.plugin).toEqual([
      "pkg-a",
      "repo (git:org/repo#main)",
      "plugin (local:/my/plugin)",
    ])
  })

  test("does not report when no plugins are loaded", async () => {
    const spec = makeSpec("npm", { id: "npm:my-plugin", name: "my-plugin" })
    mockLoadMergedConfig.mockResolvedValue(makeMergedConfig({ plugins: [spec], reportPlugins: true }))
    mockLoadManagedPlugins.mockResolvedValue([])

    const hooks = (await PluginManager(makePluginInput())) as any
    const config: any = { plugin: ["opencode-plugin-manager"] }
    await hooks.config(config)

    expect(config.plugin).toEqual(["opencode-plugin-manager"])
  })

  test("skips loaded plugins whose spec is not found", async () => {
    const spec = makeSpec("npm", { id: "npm:known", name: "known" })
    mockLoadMergedConfig.mockResolvedValue(makeMergedConfig({ plugins: [spec], reportPlugins: true }))
    mockLoadManagedPlugins.mockResolvedValue([
      { id: "npm:known", hooks: {} },
      { id: "npm:unknown", hooks: {} },
    ])

    const hooks = (await PluginManager(makePluginInput())) as any
    const config: any = { plugin: [] }
    await hooks.config(config)

    expect(config.plugin).toEqual(["known"])
  })
})

describe("autoinstall", () => {
  test("runs install on startup when autoinstall is enabled", async () => {
    const spec = makeSpec("npm", { id: "npm:auto", name: "auto-plugin" })
    const mergedConfig = makeMergedConfig({ plugins: [spec], autoinstall: true })
    const cache = makeCacheContext("/cache/auto")
    const syncedLock = makeLockfile({
      [spec.id]: makeLockEntry("npm", {
        id: spec.id,
        name: spec.name,
        resolvedVersion: "1.0.0",
        resolvedPath: "/cache/auto/npm/auto-plugin@1.0.0/index.js",
      }),
    })

    mockLoadMergedConfig.mockResolvedValue(mergedConfig)
    mockResolveCacheContext.mockReturnValue(cache)
    mockSyncPlugins.mockResolvedValue({
      lockfile: syncedLock,
      updated: [`${spec.id} (install)`],
      reused: [],
      warnings: [],
    })

    await PluginManager(makePluginInput())

    expect(mockSyncPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "install",
        specs: mergedConfig.plugins,
      }),
    )
    expect(mockWriteLockfile).toHaveBeenCalledWith(cache.lockfilePath, syncedLock)
  })

  test("does not run install on startup when autoinstall is not set", async () => {
    mockLoadMergedConfig.mockResolvedValue(makeMergedConfig())

    await PluginManager(makePluginInput())

    expect(mockSyncPlugins).not.toHaveBeenCalled()
  })

  test("continues with cached plugins when autoinstall fails", async () => {
    mockLoadMergedConfig.mockResolvedValue(makeMergedConfig({ autoinstall: true }))
    mockWithCacheLock.mockRejectedValueOnce(new Error("network failure"))

    const hooks = (await PluginManager(makePluginInput())) as any

    expect(hooks.tool).toBeDefined()
    expect(hasLogged("warn", "[plugin-manager] Autoinstall failed on startup: Error: network failure")).toBe(true)
  })
})

describe("autoprune", () => {
  test("runs prune on startup when autoprune is enabled", async () => {
    const spec = makeSpec("npm", { id: "npm:auto", name: "auto-plugin" })
    const mergedConfig = makeMergedConfig({ plugins: [spec], autoprune: true })
    const cache = makeCacheContext("/cache/auto")

    mockLoadMergedConfig.mockResolvedValue(mergedConfig)
    mockResolveCacheContext.mockReturnValue(cache)
    mockPruneCacheDirectories.mockResolvedValue({ removedPaths: [] })

    await PluginManager(makePluginInput())

    expect(mockPruneCacheDirectories).toHaveBeenCalledWith(cache, expect.anything(), expect.anything())
    expect(mockWriteLockfile).toHaveBeenCalled()
  })

  test("does not run prune on startup when autoprune is not set", async () => {
    mockLoadMergedConfig.mockResolvedValue(makeMergedConfig())

    await PluginManager(makePluginInput())

    expect(mockPruneCacheDirectories).not.toHaveBeenCalled()
  })

  test("continues with cached plugins when autoprune fails", async () => {
    mockLoadMergedConfig.mockResolvedValue(makeMergedConfig({ autoprune: true }))
    mockWithCacheLock.mockRejectedValueOnce(new Error("prune failure"))

    const hooks = (await PluginManager(makePluginInput())) as any

    expect(hooks.tool).toBeDefined()
    expect(hasLogged("warn", "[plugin-manager] Autoprune failed on startup: Error: prune failure")).toBe(true)
  })
})

describe("opm_install", () => {
  test("syncs with install mode, writes lockfile, reloads plugins, and returns install summary", async () => {
    const spec = makeSpec("npm", { id: "npm:install", name: "install-plugin" })
    const mergedConfig = makeMergedConfig({ plugins: [spec] })
    const cache = makeCacheContext("/cache/install")
    const previousEntry = makeLockEntry("npm", {
      id: spec.id,
      name: spec.name,
      resolvedVersion: "1.5.0",
      resolvedPath: "/cache/install/npm/install-plugin@1.5.0/index.js",
    })
    const currentLock = makeLockfile({ [spec.id]: previousEntry })
    const updatedEntry = makeLockEntry("npm", {
      id: spec.id,
      name: spec.name,
      resolvedVersion: "2.0.0",
      resolvedPath: "/cache/install/npm/install-plugin@2.0.0/index.js",
    })
    const syncedLock = makeLockfile({ [spec.id]: updatedEntry })

    mockLoadMergedConfig.mockResolvedValue(mergedConfig)
    mockResolveCacheContext.mockReturnValue(cache)
    mockReadLockfile.mockResolvedValue(currentLock)
    mockSyncPlugins.mockResolvedValue({
      lockfile: syncedLock,
      updated: [`${spec.id} (install)`],
      reused: ["npm:cached-plugin"],
      warnings: ["[plugin-manager] warning"],
    })
    mockResolveCachedPluginPaths.mockResolvedValue([updatedEntry])

    const hooks = (await PluginManager(makePluginInput({ cwd: "/workspace" }))) as any
    const context = makeToolContext()
    const output = await hooks.tool["opm_install"].execute({}, context)

    expect(context.metadata).toHaveBeenCalledWith({ title: "Installing managed plugins" })
    expect(mockSyncPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        specs: mergedConfig.plugins,
        cache,
        currentLock,
        mode: "install",
      }),
    )
    expect(mockWriteLockfile).toHaveBeenCalledWith(cache.lockfilePath, syncedLock)
    expect(mockResolveCachedPluginPaths).toHaveBeenLastCalledWith(
      mergedConfig.plugins,
      syncedLock,
      cache,
      expect.anything(),
    )
    expect(mockLoadManagedPlugins).toHaveBeenLastCalledWith(
      [updatedEntry],
      expect.objectContaining({ cwd: "/workspace" }),
      cache,
      expect.anything(),
      expect.objectContaining({
        cacheBustLocal: true,
        cacheBustToken: expect.any(String),
      }),
    )
    expect(hasLogged("warn", "[plugin-manager] warning")).toBe(true)

    expect(output).toContain("Installed 1 plugin(s).")
    expect(output).toContain(`Installed: ${spec.id} (install)`)
    expect(output).toContain("Reused cache: npm:cached-plugin")
    expect(output).toContain("Warnings:")
    expect(output).toContain("- [plugin-manager] warning")
    expect(output).toContain("State transitions:")
    expect(output).toContain(`${spec.id}: npm:${spec.name}@1.5.0 -> npm:${spec.name}@2.0.0`)
  })
})

describe("opm_update", () => {
  test("syncs with update mode and returns update summary", async () => {
    const spec = makeSpec("git", {
      id: "git:update",
      repo: "https://github.com/test/update",
      ref: "main",
    })
    const mergedConfig = makeMergedConfig({ plugins: [spec] })
    const currentLock = makeLockfile({
      [spec.id]: makeLockEntry("git", {
        id: spec.id,
        repo: spec.repo,
        ref: spec.ref,
        commit: "old-commit",
      }),
    })
    const syncedLock = makeLockfile({
      [spec.id]: makeLockEntry("git", {
        id: spec.id,
        repo: spec.repo,
        ref: spec.ref,
        commit: "new-commit",
      }),
    })

    mockLoadMergedConfig.mockResolvedValue(mergedConfig)
    mockReadLockfile.mockResolvedValue(currentLock)
    mockSyncPlugins.mockResolvedValue({
      lockfile: syncedLock,
      updated: [`${spec.id} (update)`],
      reused: [],
      warnings: [],
    })

    const hooks = (await PluginManager(makePluginInput())) as any
    const context = makeToolContext()
    const output = await hooks.tool["opm_update"].execute({}, context)

    expect(context.metadata).toHaveBeenCalledWith({ title: "Updating managed plugins" })
    expect(mockSyncPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "update",
        specs: mergedConfig.plugins,
      }),
    )
    expect(output).toContain("Updated 1 plugin(s).")
    expect(output).toContain(`Updated: ${spec.id} (update)`)
    expect(output).toContain("State transitions:")
    expect(output).toContain(`${spec.id}: git:${spec.repo}#${spec.ref}@old-commit -> git:${spec.repo}#${spec.ref}@new-commit`)
  })
})

describe("opm_prune and pruneLockfile behavior", () => {
  test("prunes unconfigured and missing entries, keeps existing configured entries, and reports cleanup", async () => {
    const keepSpec = makeSpec("npm", { id: "npm:keep", name: "keep-plugin" })
    const missingSpec = makeSpec("git", {
      id: "git:missing",
      repo: "https://github.com/test/missing",
      ref: "main",
    })
    const mergedConfig = makeMergedConfig({ plugins: [keepSpec, missingSpec] })
    const cache = makeCacheContext("/cache/clean")

    const staleEntry = makeLockEntry("local", {
      id: "local:stale",
      path: "/plugins/stale",
      resolvedPath: "/cache/clean/local/stale/index.js",
    })
    const missingEntry = makeLockEntry("git", {
      id: missingSpec.id,
      repo: missingSpec.repo,
      ref: missingSpec.ref,
      commit: "abc123",
      resolvedPath: "/cache/clean/git/missing/index.js",
    })
    const keepEntry = makeLockEntry("npm", {
      id: keepSpec.id,
      name: keepSpec.name,
      resolvedVersion: "1.0.0",
      resolvedPath: "/cache/clean/npm/keep-plugin@1.0.0/index.js",
    })

    const currentLock = makeLockfile({
      [staleEntry.id]: staleEntry,
      [missingEntry.id]: missingEntry,
      [keepEntry.id]: keepEntry,
    })
    const prunedLock = makeLockfile({
      [keepEntry.id]: keepEntry,
    })

    mockLoadMergedConfig.mockResolvedValue(mergedConfig)
    mockResolveCacheContext.mockReturnValue(cache)
    mockReadLockfile.mockResolvedValue(currentLock)
    mockExists.mockImplementation(async (resolvedPath: string) => resolvedPath === keepEntry.resolvedPath)
    mockPruneCacheDirectories.mockResolvedValue({
      removedPaths: ["/cache/clean/local/stale", "/cache/clean/git/unused"],
    })
    mockResolveCachedPluginPaths.mockResolvedValue([keepEntry])

    const hooks = (await PluginManager(makePluginInput())) as any
    const context = makeToolContext()
    const output = await hooks.tool["opm_prune"].execute({}, context)

    expect(context.metadata).toHaveBeenCalledWith({ title: "Pruning managed plugin cache" })
    expect(mockExists).toHaveBeenCalledWith(missingEntry.resolvedPath)
    expect(mockExists).toHaveBeenCalledWith(keepEntry.resolvedPath)

    expect(mockPruneCacheDirectories).toHaveBeenCalledWith(cache, prunedLock, expect.anything())
    expect(mockWriteLockfile).toHaveBeenCalledWith(cache.lockfilePath, prunedLock)
    expect(mockResolveCachedPluginPaths).toHaveBeenLastCalledWith(
      mergedConfig.plugins,
      prunedLock,
      cache,
      expect.anything(),
    )
    expect(mockLoadManagedPlugins).toHaveBeenLastCalledWith(
      [keepEntry],
      expect.objectContaining({}),
      cache,
      expect.anything(),
      expect.objectContaining({
        cacheBustLocal: true,
        cacheBustToken: expect.any(String),
      }),
    )

    expect(output).toContain("Removed 2 cached plugin directory(s).")
    expect(output).toContain(`Pruned lock entries: ${staleEntry.id}, ${missingEntry.id}`)
    expect(output).toContain("Removed: /cache/clean/local/stale, /cache/clean/git/unused")
  })
})

describe("opm_sync", () => {
  test("runs install then prune sequentially and combines both outputs", async () => {
    const spec = makeSpec("npm", { id: "npm:sync", name: "sync-plugin" })
    const mergedConfig = makeMergedConfig({ plugins: [spec] })
    const cache = makeCacheContext("/cache/sync")
    const lockEntry = makeLockEntry("npm", {
      id: spec.id,
      name: spec.name,
      resolvedVersion: "1.0.0",
      resolvedPath: "/cache/sync/npm/sync-plugin@1.0.0/index.js",
    })
    const syncedLock = makeLockfile({ [spec.id]: lockEntry })

    const callOrder: string[] = []

    mockLoadMergedConfig.mockResolvedValue(mergedConfig)
    mockResolveCacheContext.mockReturnValue(cache)
    mockReadLockfile.mockResolvedValue(syncedLock)
    mockSyncPlugins.mockImplementation(async () => {
      callOrder.push("install")
      return {
        lockfile: syncedLock,
        updated: [spec.id],
        reused: [],
        warnings: [],
      }
    })
    mockExists.mockResolvedValue(true)
    mockPruneCacheDirectories.mockImplementation(async () => {
      callOrder.push("prune")
      return { removedPaths: ["/cache/sync/npm/orphan"] }
    })
    mockResolveCachedPluginPaths.mockResolvedValue([lockEntry])

    const hooks = (await PluginManager(makePluginInput())) as any
    const context = makeToolContext()
    const output = await hooks.tool["opm_sync"].execute({}, context)

    expect(callOrder).toEqual(["install", "prune"])
    expect(context.metadata).toHaveBeenCalledTimes(1)
    expect(context.metadata).toHaveBeenCalledWith({ title: "Syncing managed plugins" })
    expect(mockLoadMergedConfig).toHaveBeenCalledTimes(2)
    expect(mockResolveCacheContext).toHaveBeenCalledTimes(2)

    expect(output).toContain("Installed 1 plugin(s).")
    expect(output).toContain("Removed 1 cached plugin directory(s).")
  })
})

describe("opm_self_update", () => {
  test("returns update instructions when a newer release exists", async () => {
    mockFsReadFile.mockResolvedValue(JSON.stringify({ version: "1.0.0" }))
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: "1.1.0" }),
    })

    const hooks = (await PluginManager(makePluginInput())) as any
    const context = makeToolContext()
    const output = await hooks.tool["opm_self_update"].execute({}, context)

    expect(context.metadata).toHaveBeenCalledWith({ title: "Checking plugin manager updates" })
    expect(mockFetch).toHaveBeenCalledWith(
      "https://registry.npmjs.org/opencode-plugin-manager/latest",
      expect.objectContaining({ signal: expect.anything() }),
    )
    expect(output).toContain("Update available: 1.0.0 -> 1.1.0")
    expect(output).toContain('"plugin": ["opencode-plugin-manager@1.1.0"]')
    expect(output).toContain("Then restart opencode.")
  })

  test("returns up-to-date message when current version is latest", async () => {
    mockFsReadFile.mockResolvedValue(JSON.stringify({ version: "2.0.0" }))
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: "2.0.0" }),
    })

    const hooks = (await PluginManager(makePluginInput())) as any
    const output = await hooks.tool["opm_self_update"].execute({}, makeToolContext())

    expect(output).toBe("opencode-plugin-manager is up to date (2.0.0).")
  })

  test("handles missing version data gracefully", async () => {
    mockFetch.mockRejectedValue(new Error("network failed"))

    const hooks = (await PluginManager(makePluginInput())) as any
    const output = await hooks.tool["opm_self_update"].execute({}, makeToolContext())

    expect(output).toBe("Unable to determine current or latest opencode-plugin-manager version.")
  })
})
