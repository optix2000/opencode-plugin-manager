import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import path from "node:path"
import { makeSpec } from "./helpers"

const TEST_HOME = "/home/testuser"

const mockExists = mock(async (_filePath: string) => false)
const mockReadJsoncFile = mock(async (_filePath: string): Promise<unknown | null> => null)
const mockMkdir = mock(async () => undefined)
const mockWriteFile = mock(async () => undefined)

mock.module("node:os", () => ({
  default: { homedir: () => TEST_HOME },
  homedir: () => TEST_HOME,
}))

mock.module("node:fs/promises", () => ({
  default: {
    mkdir: mockMkdir,
    writeFile: mockWriteFile,
  },
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
}))

const realUtil = await import("../util")

mock.module("../util", () => ({
  ...realUtil,
  exists: mockExists,
  readJsoncFile: mockReadJsoncFile,
}))

const { loadMergedConfig, pluginDisplayName } = await import("../config")

type LoadMergedConfigInput = Parameters<typeof loadMergedConfig>[0]

function input(worktree: string, directory: string): LoadMergedConfigInput {
  return { worktree, directory } as LoadMergedConfigInput
}

function setExistingFiles(files: string[]): void {
  const existing = new Set(files.map((file) => path.resolve(file)))
  mockExists.mockImplementation(async (candidate: string) => existing.has(path.resolve(candidate)))
}

function setConfigFiles(configByFile: Record<string, unknown | null>): void {
  const entries = new Map(Object.entries(configByFile).map(([filePath, config]) => [path.resolve(filePath), config]))
  mockReadJsoncFile.mockImplementation(async (filePath: string) => {
    const key = path.resolve(filePath)
    if (!entries.has(key)) return null
    return entries.get(key) ?? null
  })
}

let previousConfigDir: string | undefined


beforeEach(() => {
  previousConfigDir = process.env.OPENCODE_CONFIG_DIR
  delete process.env.OPENCODE_CONFIG_DIR

  mockExists.mockClear()
  mockReadJsoncFile.mockClear()
  mockMkdir.mockClear()
  mockWriteFile.mockClear()

  mockExists.mockImplementation(async () => false)
  mockReadJsoncFile.mockImplementation(async () => null)
})

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = previousConfigDir
})

describe("pluginDisplayName", () => {
  test("formats npm plugin with version", () => {
    expect(pluginDisplayName(makeSpec("npm", { name: "pkg", version: "1.2.3" }))).toBe("pkg@1.2.3")
  })

  test("formats npm plugin without version", () => {
    expect(pluginDisplayName(makeSpec("npm", { name: "pkg", version: undefined }))).toBe("pkg")
  })

  test("formats git plugin with ref", () => {
    expect(pluginDisplayName(makeSpec("git", { repo: "https://github.com/org/repo", ref: "main" }))).toBe(
      "https://github.com/org/repo#main",
    )
  })

  test("formats git plugin without ref", () => {
    expect(pluginDisplayName(makeSpec("git", { repo: "https://github.com/org/repo", ref: undefined }))).toBe(
      "https://github.com/org/repo",
    )
  })

  test("formats local plugin", () => {
    expect(pluginDisplayName(makeSpec("local", { path: "/local/plugin" }))).toBe("/local/plugin")
  })

  test("formats github-release plugin with tag", () => {
    expect(pluginDisplayName(makeSpec("github-release", { repo: "owner/repo", tag: "v1.0.0" }))).toBe(
      "owner/repo@v1.0.0",
    )
  })

  test("formats github-release plugin without tag", () => {
    expect(pluginDisplayName(makeSpec("github-release", { repo: "owner/repo", tag: undefined }))).toBe("owner/repo")
  })
})

describe("loadMergedConfig", () => {
  test("normalizes string shorthands and object plugin sources", async () => {
    const configFile = "/repo/plugins.json"
    setExistingFiles([configFile])
    setConfigFiles({
      [configFile]: {
        plugins: [
          "foo@1.0",
          "./plugin",
          "~/my-plugin",
          "/abs/path",
          { source: "git", repo: "https://github.com/Org/Repo.git" },
          { source: "github-release", repo: "Owner/MyPlugin", tag: "v2.0.0" },
        ],
      },
    })

    const result = await loadMergedConfig(input("/repo", "/repo"))

    expect(result.files).toEqual([path.resolve(configFile)])

    const byId = new Map(result.plugins.map((plugin) => [plugin.id, plugin]))

    expect(byId.get("npm:foo")).toMatchObject({
      source: "npm",
      id: "npm:foo",
      name: "foo",
      version: "1.0",
      fromFile: path.resolve(configFile),
    })

    expect(byId.get(`local:${path.resolve("/repo", "./plugin")}`)).toMatchObject({
      source: "local",
      path: path.resolve("/repo", "./plugin"),
      fromFile: path.resolve(configFile),
    })

    expect(byId.get(`local:${path.join(TEST_HOME, "my-plugin")}`)).toMatchObject({
      source: "local",
      path: path.join(TEST_HOME, "my-plugin"),
      fromFile: path.resolve(configFile),
    })

    expect(byId.get("local:/abs/path")).toMatchObject({
      source: "local",
      path: "/abs/path",
      fromFile: path.resolve(configFile),
    })

    expect(byId.get("git:https://github.com/Org/Repo")).toMatchObject({
      source: "git",
      repo: "https://github.com/Org/Repo",
      fromFile: path.resolve(configFile),
    })

    expect(byId.get("github-release:owner/myplugin")).toMatchObject({
      source: "github-release",
      repo: "owner/myplugin",
      tag: "v2.0.0",
      fromFile: path.resolve(configFile),
    })
  })

  test("merges by plugin id and lets later files win", async () => {
    const rootFile = "/repo/plugins.json"
    const leafFile = "/repo/subdir/plugins.json"

    setExistingFiles([rootFile, leafFile])
    setConfigFiles({
      [rootFile]: { plugins: ["foo@1.0"] },
      [leafFile]: { plugins: ["foo@2.0"] },
    })

    const result = await loadMergedConfig(input("/repo", "/repo/subdir"))

    expect(result.files).toEqual([path.resolve(rootFile), path.resolve(leafFile)])
    expect(result.plugins).toHaveLength(1)
    expect(result.plugins[0]).toMatchObject({
      id: "npm:foo",
      source: "npm",
      version: "2.0",
      fromFile: path.resolve(leafFile),
    })
  })

  test("keeps plugins from different ids across multiple files", async () => {
    const rootFile = "/repo/plugins.json"
    const leafFile = "/repo/subdir/plugins.json"

    setExistingFiles([rootFile, leafFile])
    setConfigFiles({
      [rootFile]: { plugins: ["foo@1.0"] },
      [leafFile]: { plugins: [{ source: "git", repo: "https://github.com/example/another.git" }] },
    })

    const result = await loadMergedConfig(input("/repo", "/repo/subdir"))
    const ids = result.plugins.map((plugin) => plugin.id)

    expect(ids).toEqual(["npm:foo", "git:https://github.com/example/another"])
  })

  test("returns empty config when no config files exist", async () => {
    setExistingFiles([])
    const result = await loadMergedConfig(input("/repo", "/repo"))

    expect(result.files).toEqual([])
    expect(result.plugins).toEqual([])
    expect(result.cacheDir).toBeUndefined()
    expect(result.cacheDirBase).toBeUndefined()
    expect(mockReadJsoncFile).not.toHaveBeenCalled()
  })

  test("skips invalid config files and continues with valid ones", async () => {
    const invalidFile = "/repo/plugins.json"
    const validFile = "/repo/subdir/plugins.json"

    setExistingFiles([invalidFile, validFile])
    setConfigFiles({
      [invalidFile]: {
        plugins: [{ source: "git", repo: "not-a-url" }],
      },
      [validFile]: {
        plugins: ["ok@1.0"],
      },
    })

    const originalWarn = console.warn
    const warn = mock((..._args: unknown[]) => undefined)
    console.warn = warn as typeof console.warn

    try {
      const result = await loadMergedConfig(input("/repo", "/repo/subdir"))
      expect(result.plugins).toHaveLength(1)
      expect(result.plugins[0]).toMatchObject({ id: "npm:ok", version: "1.0" })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain(`Invalid config at ${path.resolve(invalidFile)}`)
    } finally {
      console.warn = originalWarn
    }
  })

  test("uses cacheDir from the last parsed file and tracks its base directory", async () => {
    const rootFile = "/repo/plugins.json"
    const leafFile = "/repo/subdir/plugins.json"

    setExistingFiles([rootFile, leafFile])
    setConfigFiles({
      [rootFile]: { cacheDir: "cache/root", plugins: [] },
      [leafFile]: { cacheDir: "cache/leaf", plugins: [] },
    })

    const result = await loadMergedConfig(input("/repo", "/repo/subdir"))

    expect(result.cacheDir).toBe("cache/leaf")
    expect(result.cacheDirBase).toBe(path.dirname(path.resolve(leafFile)))
  })
})

describe("directoryChain behavior through loadMergedConfig", () => {
  test("when leaf equals root, only root directory candidates are considered", async () => {
    const rootFile = "/repo/plugins.json"
    const parentFile = "/plugins.json"

    setExistingFiles([rootFile, parentFile])
    setConfigFiles({ [rootFile]: { plugins: [] }, [parentFile]: { plugins: [] } })

    const result = await loadMergedConfig(input("/repo", "/repo"))

    expect(result.files).toEqual([path.resolve(rootFile)])
  })

  test("builds a root-first chain from worktree to leaf", async () => {
    const rootFile = "/repo/plugins.json"
    const middleFile = "/repo/packages/plugins.json"
    const leafFile = "/repo/packages/app/plugins.json"

    setExistingFiles([rootFile, middleFile, leafFile])
    setConfigFiles({
      [rootFile]: { plugins: [] },
      [middleFile]: { plugins: [] },
      [leafFile]: { plugins: [] },
    })

    const result = await loadMergedConfig(input("/repo", "/repo/packages/app"))

    expect(result.files).toEqual([path.resolve(rootFile), path.resolve(middleFile), path.resolve(leafFile)])
  })

  test("stops at boundary when leaf is outside root", async () => {
    const outsideLeafFile = "/outside/project/plugins.json"
    const rootFile = "/repo/plugins.json"

    setExistingFiles([outsideLeafFile, rootFile])
    setConfigFiles({
      [outsideLeafFile]: { plugins: [] },
      [rootFile]: { plugins: [] },
    })

    const result = await loadMergedConfig(input("/repo", "/outside/project"))

    expect(result.files).toEqual([path.resolve(outsideLeafFile)])
  })
})
