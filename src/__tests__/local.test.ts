import { beforeEach, describe, expect, mock, test } from "bun:test"
import path from "node:path"
import { makeSpec } from "./helpers"

const mockFsStat = mock()

mock.module("node:fs/promises", () => ({
  default: {
    stat: mockFsStat,
  },
}))

const mockRunCommand = mock(async (_args: unknown) => ({ stdout: "", stderr: "" }))

mock.module("../util", () => ({
  runCommand: mockRunCommand,
}))

const mockResolvePluginEntry = mock(async (pluginPath: string, entry?: string) => path.join(pluginPath, entry ?? "index.js"))

mock.module("../sources/shared", () => ({
  resolvePluginEntry: mockResolvePluginEntry,
}))

const { syncLocalPlugin } = await import("../sources/local")

function makeStat(kind: "file" | "directory" | "other") {
  return {
    isFile: () => kind === "file",
    isDirectory: () => kind === "directory",
  }
}


beforeEach(() => {
  mockFsStat.mockReset()
  mockRunCommand.mockReset()
  mockResolvePluginEntry.mockReset()

  mockRunCommand.mockResolvedValue({ stdout: "", stderr: "" })
  mockResolvePluginEntry.mockImplementation(async (pluginPath: string, entry?: string) =>
    path.join(pluginPath, entry ?? "index.js"),
  )
})

describe("syncLocalPlugin", () => {
  test("directory plugin resolves entry and returns lock entry", async () => {
    const pluginPath = "/plugins/local-dir"
    const resolvedPluginPath = path.resolve(pluginPath)
    const resolvedEntry = path.join(resolvedPluginPath, "dist/plugin.js")
    const spec = makeSpec("local", {
      id: "local:dir",
      path: pluginPath,
      entry: "dist/plugin.js",
    })

    mockFsStat.mockResolvedValue(makeStat("directory"))
    mockResolvePluginEntry.mockResolvedValue(resolvedEntry)

    const result = await syncLocalPlugin(spec)

    expect(mockFsStat).toHaveBeenCalledWith(resolvedPluginPath)
    expect(mockResolvePluginEntry).toHaveBeenCalledTimes(1)
    expect(mockResolvePluginEntry).toHaveBeenCalledWith(resolvedPluginPath, "dist/plugin.js")
    expect(result).toMatchObject({
      id: spec.id,
      source: "local",
      path: resolvedPluginPath,
      entry: "dist/plugin.js",
      resolvedPath: resolvedEntry,
    })
    expect(Number.isNaN(Date.parse(result.updatedAt))).toBe(false)
  })

  test("file plugin uses plugin path as resolvedPath without entry resolution", async () => {
    const pluginPath = "/plugins/local-file/plugin.js"
    const resolvedPluginPath = path.resolve(pluginPath)
    const spec = makeSpec("local", {
      id: "local:file",
      path: pluginPath,
    })

    mockFsStat.mockResolvedValue(makeStat("file"))

    const result = await syncLocalPlugin(spec)

    expect(mockResolvePluginEntry).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      id: spec.id,
      source: "local",
      path: resolvedPluginPath,
      entry: undefined,
      resolvedPath: resolvedPluginPath,
    })
    expect(Number.isNaN(Date.parse(result.updatedAt))).toBe(false)
  })

  test("throws when local file plugin has entry configured", async () => {
    const pluginPath = "/plugins/local-file/plugin.js"
    const resolvedPluginPath = path.resolve(pluginPath)
    const spec = makeSpec("local", {
      path: pluginPath,
      entry: "dist/index.js",
    })

    mockFsStat.mockResolvedValue(makeStat("file"))

    await expect(syncLocalPlugin(spec)).rejects.toThrow(
      `'entry' cannot be set when local plugin path points to a file: ${resolvedPluginPath}`,
    )
    expect(mockResolvePluginEntry).not.toHaveBeenCalled()
  })

  test("throws when local plugin path does not exist", async () => {
    const pluginPath = "/plugins/missing"
    const resolvedPluginPath = path.resolve(pluginPath)
    const spec = makeSpec("local", { path: pluginPath })

    mockFsStat.mockRejectedValue(new Error("ENOENT"))

    await expect(syncLocalPlugin(spec)).rejects.toThrow(`Local plugin path does not exist: ${resolvedPluginPath}`)
    expect(mockRunCommand).not.toHaveBeenCalled()
    expect(mockResolvePluginEntry).not.toHaveBeenCalled()
  })

  test("throws when local plugin path is neither file nor directory", async () => {
    const pluginPath = "/plugins/socket"
    const resolvedPluginPath = path.resolve(pluginPath)
    const spec = makeSpec("local", { path: pluginPath })

    mockFsStat.mockResolvedValue(makeStat("other"))

    await expect(syncLocalPlugin(spec)).rejects.toThrow(
      `Local plugin path must be a file or directory: ${resolvedPluginPath}`,
    )
    expect(mockRunCommand).not.toHaveBeenCalled()
    expect(mockResolvePluginEntry).not.toHaveBeenCalled()
  })

  test("runs build command in plugin directory for directory plugins", async () => {
    const pluginPath = "/plugins/local-dir"
    const resolvedPluginPath = path.resolve(pluginPath)
    const spec = makeSpec("local", {
      path: pluginPath,
      build: {
        command: "npm run build",
        timeout: 5000,
      },
    })

    mockFsStat.mockResolvedValue(makeStat("directory"))
    mockResolvePluginEntry.mockResolvedValue(path.join(resolvedPluginPath, "index.js"))

    await syncLocalPlugin(spec)

    expect(mockRunCommand).toHaveBeenCalledTimes(1)
    expect(mockRunCommand).toHaveBeenCalledWith({
      command: "sh",
      args: ["-lc", "npm run build"],
      cwd: resolvedPluginPath,
      timeout: 5000,
    })
  })

  test("runs build command in parent directory for file plugins", async () => {
    const pluginPath = "/plugins/local-file/plugin.js"
    const resolvedPluginPath = path.resolve(pluginPath)
    const spec = makeSpec("local", {
      path: pluginPath,
      build: {
        command: "node build.mjs",
        timeout: 1200,
      },
    })

    mockFsStat.mockResolvedValue(makeStat("file"))

    await syncLocalPlugin(spec)

    expect(mockRunCommand).toHaveBeenCalledTimes(1)
    expect(mockRunCommand).toHaveBeenCalledWith({
      command: "sh",
      args: ["-lc", "node build.mjs"],
      cwd: path.dirname(resolvedPluginPath),
      timeout: 1200,
    })
    expect(mockResolvePluginEntry).not.toHaveBeenCalled()
  })
})
