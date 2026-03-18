import { beforeEach, describe, expect, mock, test } from "bun:test"
import path from "node:path"
import type { Logger } from "../log"
import type { LockEntry, ManagedPluginSpec } from "../types"
import { makeCacheContext, makeSpec } from "./helpers"

const mockFsMkdtemp = mock()
const mockFsWriteFile = mock()
const mockFsReadFile = mock()
const mockFsRm = mock()

const mockRunCommand = mock()
const mockEnsureDir = mock()
const mockExists = mock()

type MoveArgs = {
  targetDir: string
  extractedDir: string
  validateExistingDir: (installDir: string) => Promise<void>
}

const mockMoveExtractedDirIntoPlace = mock(async (args: MoveArgs) => {
  await args.validateExistingDir(args.targetDir)
})
const mockResolvePluginEntry = mock(async (packageDir: string, entry?: string) => path.join(packageDir, entry ?? "index.js"))
const mockSha256File = mock()

const mockNpmInstallDir = mock()

mock.module("../sources/npm.deps", () => ({
  fs: {
    mkdtemp: mockFsMkdtemp,
    writeFile: mockFsWriteFile,
    readFile: mockFsReadFile,
    rm: mockFsRm,
  },
  runCommand: mockRunCommand,
  ensureDir: mockEnsureDir,
  exists: mockExists,
  moveExtractedDirIntoPlace: mockMoveExtractedDirIntoPlace,
  resolvePluginEntry: mockResolvePluginEntry,
  sha256File: mockSha256File,
  npmInstallDir: mockNpmInstallDir,
}))

const { syncNpmPlugin } = await import("../sources/npm")

type NpmSpec = Extract<ManagedPluginSpec, { source: "npm" }>
type NpmLockEntry = Extract<LockEntry, { source: "npm" }>

const TEMP_DIR = "/cache/.tmp-npm-123"
const cache = makeCacheContext("/cache")
const TEST_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

function setExistingPaths(paths: string[]): void {
  const existing = new Set(paths.map((item) => path.resolve(item)))
  mockExists.mockImplementation(async (item: string) => existing.has(path.resolve(item)))
}

function writtenDependencyVersion(name = "test-plugin"): string {
  const pkgJsonText = mockFsWriteFile.mock.calls[0]?.[1]
  if (typeof pkgJsonText !== "string") {
    throw new Error("Expected package.json content to be written as a string")
  }
  const pkgJson = JSON.parse(pkgJsonText) as {
    dependencies: Record<string, string>
  }
  return pkgJson.dependencies[name]
}

async function sync(
  overrides: Partial<NpmSpec> = {},
  options: { lockedVersion?: string } = {},
): Promise<NpmLockEntry> {
  const spec = makeSpec("npm", overrides)
  const result = await syncNpmPlugin(spec, cache, options, TEST_LOGGER)
  return result as NpmLockEntry
}


beforeEach(() => {
  for (const fn of [
    mockFsMkdtemp,
    mockFsWriteFile,
    mockFsReadFile,
    mockFsRm,
    mockRunCommand,
    mockEnsureDir,
    mockExists,
    mockMoveExtractedDirIntoPlace,
    mockResolvePluginEntry,
    mockSha256File,
    mockNpmInstallDir,
  ]) {
    fn.mockReset()
  }

  mockFsMkdtemp.mockResolvedValue(TEMP_DIR)
  mockFsWriteFile.mockResolvedValue(undefined)
  mockFsReadFile.mockResolvedValue(JSON.stringify({ version: "2.0.0" }))
  mockFsRm.mockResolvedValue(undefined)

  mockRunCommand.mockResolvedValue({ stdout: "", stderr: "" })
  mockEnsureDir.mockResolvedValue(undefined)
  setExistingPaths([TEMP_DIR, path.join(TEMP_DIR, "node_modules", "test-plugin")])

  mockMoveExtractedDirIntoPlace.mockImplementation(async (args: MoveArgs) => {
    await args.validateExistingDir(args.targetDir)
  })
  mockResolvePluginEntry.mockImplementation(async (packageDir: string, entry?: string) =>
    path.join(packageDir, entry ?? "index.js"),
  )
  mockNpmInstallDir.mockImplementation((_cache: unknown, name: string, version: string) => `/cache/npm/${name}@${version}`)
  mockSha256File.mockResolvedValue("sha256:npm-integrity")
})

describe("syncNpmPlugin", () => {
  describe("version fallback chain", () => {
    test("uses lockedVersion in dependency install request before spec.version", async () => {
      await sync({ version: "1.0.0" }, { lockedVersion: "9.9.9" })

      expect(writtenDependencyVersion()).toBe("9.9.9")
    })

    test("uses spec.version when lockedVersion is not provided", async () => {
      await sync({ version: "1.2.3" })

      expect(writtenDependencyVersion()).toBe("1.2.3")
    })

    test("uses latest when neither lockedVersion nor spec.version is provided", async () => {
      await sync({ version: undefined })

      expect(writtenDependencyVersion()).toBe("latest")
    })
  })

  test("runs npm install with --ignore-scripts", async () => {
    await sync()

    expect(mockRunCommand).toHaveBeenCalledWith({
      command: "npm",
      args: ["install", "--ignore-scripts"],
      cwd: TEMP_DIR,
      timeout: expect.any(Number),
      logger: TEST_LOGGER,
    })
  })

  test("records integrity from resolved plugin entry file", async () => {
    const result = await sync()

    expect(mockSha256File).toHaveBeenCalledWith(result.resolvedPath)
    expect(result.integrity).toBe("sha256:npm-integrity")
  })

  describe("package version resolution", () => {
    test("uses installed package version when package.json includes version", async () => {
      mockFsReadFile.mockResolvedValueOnce(JSON.stringify({ version: "3.4.5" }))

      const result = await sync()

      expect(result.resolvedVersion).toBe("3.4.5")
      expect(mockNpmInstallDir).toHaveBeenCalledWith(cache, "test-plugin", "3.4.5")
    })

    test("falls back to requestedVersion when installed package version is missing", async () => {
      mockFsReadFile.mockResolvedValueOnce(JSON.stringify({}))

      const result = await sync({ version: undefined }, { lockedVersion: "8.1.0" })

      expect(result.resolvedVersion).toBe("8.1.0")
      expect(mockNpmInstallDir).toHaveBeenCalledWith(cache, "test-plugin", "8.1.0")
    })
  })

  test("throws when install succeeds but package directory is missing", async () => {
    setExistingPaths([TEMP_DIR])

    await expect(sync()).rejects.toThrow("Install succeeded but package was not found: test-plugin")
    expect(mockFsReadFile).not.toHaveBeenCalled()
  })

  test("cleans temp directory when install command fails", async () => {
    mockRunCommand.mockRejectedValueOnce(new Error("install failed"))
    setExistingPaths([TEMP_DIR])

    await expect(sync()).rejects.toThrow("install failed")
    expect(mockExists).toHaveBeenCalledWith(TEMP_DIR)
    expect(mockFsRm).toHaveBeenCalledWith(TEMP_DIR, { recursive: true, force: true })
  })

  describe("LockEntry.requestedVersion", () => {
    test("uses spec.version for lock entry even when lockedVersion drives install version", async () => {
      const result = await sync({ version: "1.0.0" }, { lockedVersion: "9.0.0" })

      expect(writtenDependencyVersion()).toBe("9.0.0")
      expect(result.requestedVersion).toBe("1.0.0")
    })

    test("uses lockedVersion when spec.version is not set", async () => {
      const result = await sync({ version: undefined }, { lockedVersion: "4.5.6" })

      expect(result.requestedVersion).toBe("4.5.6")
    })

    test("is undefined when neither spec.version nor lockedVersion is set", async () => {
      const result = await sync({ version: undefined })

      expect(result.requestedVersion).toBeUndefined()
    })
  })
})
