import { beforeEach, describe, expect, mock, test } from "bun:test"
import path from "node:path"
import { makeSpec } from "./helpers"

const TEST_HOME = "/home/testuser"
const GLOBAL_CONFIG_JSON = path.join(TEST_HOME, ".config", "opencode", "plugins.json")
const GLOBAL_CONFIG_JSONC = path.join(TEST_HOME, ".config", "opencode", "plugins.jsonc")

const mockExists = mock(async (_filePath: string) => false)
const mockReadJsoncFile = mock(async (_filePath: string): Promise<unknown | null> => null)
const mockMkdir = mock(async () => undefined)
const mockWriteFile = mock(async () => undefined)

function realNormalizeGitRepo(value: string): string {
  return value.trim().replace(/\.git$/, "")
}

function realParseNpmShorthand(value: string): { name: string; version?: string } {
  const lastAtIndex = value.lastIndexOf("@")
  if (lastAtIndex <= 0) return { name: value }
  return {
    name: value.slice(0, lastAtIndex),
    version: value.slice(lastAtIndex + 1),
  }
}

function realExpandHome(input: string): string {
  if (input === "~") return TEST_HOME
  if (input.startsWith("~/")) return path.join(TEST_HOME, input.slice(2))
  return input
}

mock.module("../config.deps", () => ({
  fs: {
    mkdir: mockMkdir,
    writeFile: mockWriteFile,
  },
  os: { homedir: () => TEST_HOME },
  exists: mockExists,
  expandHome: realExpandHome,
  normalizeGitRepo: realNormalizeGitRepo,
  parseNpmShorthand: realParseNpmShorthand,
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

beforeEach(() => {
  mockExists.mockClear()
  mockReadJsoncFile.mockClear()
  mockMkdir.mockClear()
  mockWriteFile.mockClear()

  mockExists.mockImplementation(async () => false)
  mockReadJsoncFile.mockImplementation(async () => null)
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

})

describe("loadMergedConfig", () => {
  test("only loads global config files", async () => {
    const workspaceFile = "/repo/.opencode/plugins.json"
    const envOverrideFile = "/tmp/custom/plugins.json"

    process.env.OPENCODE_CONFIG_DIR = "/tmp/custom"
    setExistingFiles([GLOBAL_CONFIG_JSON, workspaceFile, envOverrideFile])
    setConfigFiles({
      [GLOBAL_CONFIG_JSON]: { plugins: ["global@1.0"] },
      [workspaceFile]: { plugins: ["workspace@1.0"] },
      [envOverrideFile]: { plugins: ["env@1.0"] },
    })

    try {
      const result = await loadMergedConfig(input("/repo", "/repo"))
      expect(result.files).toEqual([path.resolve(GLOBAL_CONFIG_JSON)])
      expect(result.plugins).toHaveLength(1)
      expect(result.plugins[0]).toMatchObject({ id: "npm:global", version: "1.0" })
    } finally {
      delete process.env.OPENCODE_CONFIG_DIR
    }
  })

  test("normalizes string shorthands and object plugin sources", async () => {
    setExistingFiles([GLOBAL_CONFIG_JSON])
    setConfigFiles({
      [GLOBAL_CONFIG_JSON]: {
        plugins: [
          "foo@1.0",
          "./plugin",
          "~/my-plugin",
          "/abs/path",
          { source: "git", repo: "https://github.com/Org/Repo.git" },
        ],
      },
    })

    const result = await loadMergedConfig(input("/repo", "/repo"))

    expect(result.files).toEqual([path.resolve(GLOBAL_CONFIG_JSON)])

    const byId = new Map(result.plugins.map((plugin) => [plugin.id, plugin]))

    expect(byId.get("npm:foo")).toMatchObject({
      source: "npm",
      id: "npm:foo",
      name: "foo",
      version: "1.0",
      fromFile: path.resolve(GLOBAL_CONFIG_JSON),
    })

    expect(byId.get(`local:${path.resolve(path.dirname(GLOBAL_CONFIG_JSON), "./plugin")}`)).toMatchObject({
      source: "local",
      path: path.resolve(path.dirname(GLOBAL_CONFIG_JSON), "./plugin"),
      fromFile: path.resolve(GLOBAL_CONFIG_JSON),
    })

    expect(byId.get(`local:${path.join(TEST_HOME, "my-plugin")}`)).toMatchObject({
      source: "local",
      path: path.join(TEST_HOME, "my-plugin"),
      fromFile: path.resolve(GLOBAL_CONFIG_JSON),
    })

    expect(byId.get("local:/abs/path")).toMatchObject({
      source: "local",
      path: "/abs/path",
      fromFile: path.resolve(GLOBAL_CONFIG_JSON),
    })

    expect(byId.get("git:https://github.com/Org/Repo")).toMatchObject({
      source: "git",
      repo: "https://github.com/Org/Repo",
      fromFile: path.resolve(GLOBAL_CONFIG_JSON),
    })

  })

  test("accepts SCP-style git repo addresses", async () => {
    setExistingFiles([GLOBAL_CONFIG_JSON])
    setConfigFiles({
      [GLOBAL_CONFIG_JSON]: {
        plugins: [
          { source: "git", repo: "git@github.com:user/repo.git" },
          { source: "git", repo: "git@gitlab.example.com:org/project.git" },
        ],
      },
    })

    const result = await loadMergedConfig(input("/repo", "/repo"))
    expect(result.plugins).toHaveLength(2)

    const byId = new Map(result.plugins.map((plugin) => [plugin.id, plugin]))

    expect(byId.get("git:git@github.com:user/repo")).toMatchObject({
      source: "git",
      repo: "git@github.com:user/repo",
      fromFile: path.resolve(GLOBAL_CONFIG_JSON),
    })

    expect(byId.get("git:git@gitlab.example.com:org/project")).toMatchObject({
      source: "git",
      repo: "git@gitlab.example.com:org/project",
      fromFile: path.resolve(GLOBAL_CONFIG_JSON),
    })
  })

  test("merges by plugin id and lets plugins.jsonc override plugins.json", async () => {
    setExistingFiles([GLOBAL_CONFIG_JSON, GLOBAL_CONFIG_JSONC])
    setConfigFiles({
      [GLOBAL_CONFIG_JSON]: { plugins: ["foo@1.0"] },
      [GLOBAL_CONFIG_JSONC]: { plugins: ["foo@2.0"] },
    })

    const result = await loadMergedConfig(input("/repo", "/repo/subdir"))

    expect(result.files).toEqual([path.resolve(GLOBAL_CONFIG_JSON), path.resolve(GLOBAL_CONFIG_JSONC)])
    expect(result.plugins).toHaveLength(1)
    expect(result.plugins[0]).toMatchObject({
      id: "npm:foo",
      source: "npm",
      version: "2.0",
      fromFile: path.resolve(GLOBAL_CONFIG_JSONC),
    })
  })

  test("skips invalid plugin entries and continues with valid ones in the same file", async () => {
    setExistingFiles([GLOBAL_CONFIG_JSON])
    setConfigFiles({
      [GLOBAL_CONFIG_JSON]: {
        plugins: [
          { source: "git", repo: "not-a-url" },
          "ok@1.0",
        ],
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
      expect(String(warn.mock.calls[0]?.[0])).toContain(`Skipping invalid plugin at index 0 in ${path.resolve(GLOBAL_CONFIG_JSON)}`)
    } finally {
      console.warn = originalWarn
    }
  })

  test("skips invalid plugin entries across multiple config files", async () => {
    setExistingFiles([GLOBAL_CONFIG_JSON, GLOBAL_CONFIG_JSONC])
    setConfigFiles({
      [GLOBAL_CONFIG_JSON]: {
        plugins: [{ source: "git", repo: "not-a-url" }],
      },
      [GLOBAL_CONFIG_JSONC]: {
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
      expect(String(warn.mock.calls[0]?.[0])).toContain(`Skipping invalid plugin at index 0 in ${path.resolve(GLOBAL_CONFIG_JSON)}`)
    } finally {
      console.warn = originalWarn
    }
  })

  test("rejects config files missing required plugins key", async () => {
    setExistingFiles([GLOBAL_CONFIG_JSON])
    setConfigFiles({
      [GLOBAL_CONFIG_JSON]: {
        plugin: ["ok@1.0"],
      },
    })

    const originalWarn = console.warn
    const warn = mock((..._args: unknown[]) => undefined)
    console.warn = warn as typeof console.warn

    try {
      const result = await loadMergedConfig(input("/repo", "/repo/subdir"))
      expect(result.plugins).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain(`Invalid config at ${path.resolve(GLOBAL_CONFIG_JSON)}`)
    } finally {
      console.warn = originalWarn
    }
  })

  test("accepts config files with $schema and other extra top-level keys", async () => {
    setExistingFiles([GLOBAL_CONFIG_JSON])
    setConfigFiles({
      [GLOBAL_CONFIG_JSON]: {
        $schema: "https://example.com/schema.json",
        plugins: ["my-plugin@1.0"],
      },
    })

    const result = await loadMergedConfig(input("/repo", "/repo/subdir"))
    expect(result.plugins).toHaveLength(1)
    expect(result.plugins[0].source).toBe("npm")
  })

  test("rejects plugin entries with unknown keys", async () => {
    setExistingFiles([GLOBAL_CONFIG_JSON])
    setConfigFiles({
      [GLOBAL_CONFIG_JSON]: {
        plugins: [{ source: "npm", name: "ok", versoin: "1.0" }],
      },
    })

    const originalWarn = console.warn
    const warn = mock((..._args: unknown[]) => undefined)
    console.warn = warn as typeof console.warn

    try {
      const result = await loadMergedConfig(input("/repo", "/repo/subdir"))
      expect(result.plugins).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain(`Skipping invalid plugin at index 0 in ${path.resolve(GLOBAL_CONFIG_JSON)}`)
    } finally {
      console.warn = originalWarn
    }
  })

  test("accepts npm object plugins with valid package names", async () => {
    setExistingFiles([GLOBAL_CONFIG_JSON])
    setConfigFiles({
      [GLOBAL_CONFIG_JSON]: {
        plugins: [{ source: "npm", name: "@scope/pkg.name_foo~bar-1", version: "1.0" }],
      },
    })

    const result = await loadMergedConfig(input("/repo", "/repo/subdir"))
    expect(result.plugins).toHaveLength(1)
    expect(result.plugins[0]).toMatchObject({
      id: "npm:@scope/pkg.name_foo~bar-1",
      source: "npm",
      name: "@scope/pkg.name_foo~bar-1",
      version: "1.0",
      fromFile: path.resolve(GLOBAL_CONFIG_JSON),
    })
  })

  test("rejects npm object plugins with invalid package names", async () => {
    const invalidNames = ["foo bar", "@./bad", "name$bad"]

    for (const invalidName of invalidNames) {
      setExistingFiles([GLOBAL_CONFIG_JSON])
      setConfigFiles({
        [GLOBAL_CONFIG_JSON]: {
          plugins: [{ source: "npm", name: invalidName }],
        },
      })

      const originalWarn = console.warn
      const warn = mock((..._args: unknown[]) => undefined)
      console.warn = warn as typeof console.warn

      try {
        const result = await loadMergedConfig(input("/repo", "/repo/subdir"))
        expect(result.plugins).toEqual([])
        expect(warn).toHaveBeenCalledTimes(1)
        expect(String(warn.mock.calls[0]?.[0])).toContain(`Skipping invalid plugin at index 0 in ${path.resolve(GLOBAL_CONFIG_JSON)}`)
      } finally {
        console.warn = originalWarn
      }
    }
  })

  test("uses cacheDir from the last parsed global file", async () => {
    setExistingFiles([GLOBAL_CONFIG_JSON, GLOBAL_CONFIG_JSONC])
    setConfigFiles({
      [GLOBAL_CONFIG_JSON]: { cacheDir: "cache/root", plugins: [] },
      [GLOBAL_CONFIG_JSONC]: { cacheDir: "cache/leaf", plugins: [] },
    })

    const result = await loadMergedConfig(input("/repo", "/repo/subdir"))

    expect(result.cacheDir).toBe("cache/leaf")
    expect(result.cacheDirBase).toBe(path.dirname(path.resolve(GLOBAL_CONFIG_JSONC)))
  })

  test("returns empty config when no global config files exist", async () => {
    setExistingFiles([])
    const result = await loadMergedConfig(input("/repo", "/repo"))

    expect(result.files).toEqual([])
    expect(result.plugins).toEqual([])
    expect(result.cacheDir).toBeUndefined()
    expect(result.cacheDirBase).toBeUndefined()
    expect(mockReadJsoncFile).not.toHaveBeenCalled()
  })
})
