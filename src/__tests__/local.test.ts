import { beforeEach, describe, expect, mock, test } from "bun:test"
import path from "node:path"
import type { Logger } from "../log"
import { makeSpec } from "./helpers"

const mockFsStat = mock()
const mockRunCommand = mock(async (_args: unknown) => ({ stdout: "", stderr: "" }))
const mockResolvePluginEntry = mock(async (pluginPath: string, entry?: string) => path.join(pluginPath, entry ?? "index.js"))
const mockSha256File = mock()

mock.module("../sources/local.deps", () => ({
  fs: {
    stat: mockFsStat,
  },
  runCommand: mockRunCommand,
  resolvePluginEntry: mockResolvePluginEntry,
  sha256File: mockSha256File,
}))

const { syncLocalPlugin } = await import("../sources/local")
const TEST_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

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
  mockSha256File.mockReset()

  mockRunCommand.mockResolvedValue({ stdout: "", stderr: "" })
  mockResolvePluginEntry.mockImplementation(async (pluginPath: string, entry?: string) =>
    path.join(pluginPath, entry ?? "index.js"),
  )
  mockSha256File.mockResolvedValue("sha256:local-integrity")
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

    const result = await syncLocalPlugin(spec, TEST_LOGGER)

    expect(mockFsStat).toHaveBeenCalledWith(resolvedPluginPath)
    expect(mockResolvePluginEntry).toHaveBeenCalledTimes(1)
    expect(mockResolvePluginEntry).toHaveBeenCalledWith(resolvedPluginPath, "dist/plugin.js")
    expect(result).toMatchObject({
      id: spec.id,
      source: "local",
      path: resolvedPluginPath,
      entry: "dist/plugin.js",
      resolvedPath: resolvedEntry,
      integrity: "sha256:local-integrity",
    })
    expect(mockSha256File).toHaveBeenCalledWith(resolvedEntry)
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

    const result = await syncLocalPlugin(spec, TEST_LOGGER)

    expect(mockResolvePluginEntry).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      id: spec.id,
      source: "local",
      path: resolvedPluginPath,
      entry: undefined,
      resolvedPath: resolvedPluginPath,
      integrity: "sha256:local-integrity",
    })
    expect(mockSha256File).toHaveBeenCalledWith(resolvedPluginPath)
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

    await expect(syncLocalPlugin(spec, TEST_LOGGER)).rejects.toThrow(
      `'entry' cannot be set when local plugin path points to a file: ${resolvedPluginPath}`,
    )
    expect(mockResolvePluginEntry).not.toHaveBeenCalled()
  })

  test("throws when local plugin path does not exist", async () => {
    const pluginPath = "/plugins/missing"
    const resolvedPluginPath = path.resolve(pluginPath)
    const spec = makeSpec("local", { path: pluginPath })

    mockFsStat.mockRejectedValue(new Error("ENOENT"))

    await expect(syncLocalPlugin(spec, TEST_LOGGER)).rejects.toThrow(`Local plugin path does not exist: ${resolvedPluginPath}`)
    expect(mockRunCommand).not.toHaveBeenCalled()
    expect(mockResolvePluginEntry).not.toHaveBeenCalled()
  })

  test("throws when local plugin path is neither file nor directory", async () => {
    const pluginPath = "/plugins/socket"
    const resolvedPluginPath = path.resolve(pluginPath)
    const spec = makeSpec("local", { path: pluginPath })

    mockFsStat.mockResolvedValue(makeStat("other"))

    await expect(syncLocalPlugin(spec, TEST_LOGGER)).rejects.toThrow(
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

    await syncLocalPlugin(spec, TEST_LOGGER)

    expect(mockRunCommand).toHaveBeenCalledTimes(1)
    expect(mockRunCommand).toHaveBeenCalledWith({
      command: "sh",
      args: ["-lc", "npm run build"],
      cwd: resolvedPluginPath,
      timeout: 5000,
      logger: TEST_LOGGER,
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

    await syncLocalPlugin(spec, TEST_LOGGER)

    expect(mockRunCommand).toHaveBeenCalledTimes(1)
    expect(mockRunCommand).toHaveBeenCalledWith({
      command: "sh",
      args: ["-lc", "node build.mjs"],
      cwd: path.dirname(resolvedPluginPath),
      timeout: 1200,
      logger: TEST_LOGGER,
    })
    expect(mockResolvePluginEntry).not.toHaveBeenCalled()
  })
})
