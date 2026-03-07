import { beforeEach, describe, expect, mock, test } from "bun:test"
import path from "node:path"

const mockFsRename = mock()
const mockFsRm = mock()
const mockFsReadFile = mock()

mock.module("node:fs/promises", () => ({
  default: {
    rename: mockFsRename,
    rm: mockFsRm,
    readFile: mockFsReadFile,
  },
}))

const mockExists = mock()

mock.module("../util", () => ({
  exists: mockExists,
}))

const { moveExtractedDirIntoPlace, resolveInside, resolvePluginEntry } = await import("../sources/shared")

const ROOT_DIR = "/root/plugin"

function setExistingPaths(paths: string[]): void {
  const existing = new Set(paths.map((item) => path.resolve(item)))
  mockExists.mockImplementation(async (item: string) => existing.has(path.resolve(item)))
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}


beforeEach(() => {
  mockFsRename.mockReset()
  mockFsRm.mockReset()
  mockFsReadFile.mockReset()
  mockExists.mockReset()
  mockExists.mockResolvedValue(false)
})

describe("resolveInside", () => {
  test("resolves a normal relative path", () => {
    expect(resolveInside("/root", "dist/index.js")).toBe(path.resolve("/root", "dist/index.js"))
  })

  test("throws on ../ traversal", () => {
    expect(() => resolveInside("/root", "../etc/passwd")).toThrow("Path escapes plugin directory")
  })

  test("throws on nested traversal that escapes root", () => {
    expect(() => resolveInside("/root", "a/../../etc")).toThrow("Path escapes plugin directory")
  })

  test("throws on absolute path injection", () => {
    expect(() => resolveInside("/root", "/etc/passwd")).toThrow("Path escapes plugin directory")
  })
})

describe("resolvePluginEntry", () => {
  test("returns explicit entry when found", async () => {
    const expected = path.resolve(ROOT_DIR, "dist/index.js")
    setExistingPaths([expected])

    await expect(resolvePluginEntry(ROOT_DIR, "dist/index.js")).resolves.toBe(expected)
  })

  test("throws when explicit entry is missing", async () => {
    const expected = path.resolve(ROOT_DIR, "dist/missing.js")
    setExistingPaths([])

    await expect(resolvePluginEntry(ROOT_DIR, "dist/missing.js")).rejects.toThrow(
      `Configured entrypoint not found: ${expected}`,
    )
  })

  test("throws when explicit entry escapes root", async () => {
    await expect(resolvePluginEntry(ROOT_DIR, "../etc/passwd")).rejects.toThrow("Path escapes plugin directory")
  })

  test("prefers opencode.plugin.ts over package.json", async () => {
    const conventional = path.join(ROOT_DIR, "opencode.plugin.ts")
    const pkgPath = path.join(ROOT_DIR, "package.json")
    setExistingPaths([conventional, pkgPath])

    await expect(resolvePluginEntry(ROOT_DIR)).resolves.toBe(conventional)
    expect(mockFsReadFile).not.toHaveBeenCalled()
  })

  test("uses package exports string candidate", async () => {
    const pkgPath = path.join(ROOT_DIR, "package.json")
    const entry = path.resolve(ROOT_DIR, "./dist/main.js")
    setExistingPaths([pkgPath, entry])
    mockFsReadFile.mockResolvedValue(JSON.stringify({ exports: "./dist/main.js" }))

    await expect(resolvePluginEntry(ROOT_DIR)).resolves.toBe(entry)
  })

  test("uses package exports dot-string candidate", async () => {
    const pkgPath = path.join(ROOT_DIR, "package.json")
    const entry = path.resolve(ROOT_DIR, "./lib.js")
    setExistingPaths([pkgPath, entry])
    mockFsReadFile.mockResolvedValue(JSON.stringify({ exports: { ".": "./lib.js" } }))

    await expect(resolvePluginEntry(ROOT_DIR)).resolves.toBe(entry)
  })

  test("uses package exports dot-import candidate", async () => {
    const pkgPath = path.join(ROOT_DIR, "package.json")
    const entry = path.resolve(ROOT_DIR, "./lib.js")
    setExistingPaths([pkgPath, entry])
    mockFsReadFile.mockResolvedValue(JSON.stringify({ exports: { ".": { import: "./lib.js" } } }))

    await expect(resolvePluginEntry(ROOT_DIR)).resolves.toBe(entry)
  })

  test("uses package exports top-level import candidate", async () => {
    const pkgPath = path.join(ROOT_DIR, "package.json")
    const entry = path.resolve(ROOT_DIR, "./lib.js")
    setExistingPaths([pkgPath, entry])
    mockFsReadFile.mockResolvedValue(JSON.stringify({ exports: { import: "./lib.js" } }))

    await expect(resolvePluginEntry(ROOT_DIR)).resolves.toBe(entry)
  })

  test("falls through from unsupported exports shape to module/main", async () => {
    const pkgPath = path.join(ROOT_DIR, "package.json")
    const moduleEntry = path.resolve(ROOT_DIR, "./module.js")
    const mainEntry = path.resolve(ROOT_DIR, "./main.js")
    setExistingPaths([pkgPath, moduleEntry, mainEntry])
    mockFsReadFile.mockResolvedValue(
      JSON.stringify({
        exports: { ".": { default: "x.js" } },
        module: "./module.js",
        main: "./main.js",
      }),
    )

    await expect(resolvePluginEntry(ROOT_DIR)).resolves.toBe(moduleEntry)
  })

  test("falls through to default file checks when package.json is malformed", async () => {
    const pkgPath = path.join(ROOT_DIR, "package.json")
    const indexEntry = path.join(ROOT_DIR, "index.js")
    setExistingPaths([pkgPath, indexEntry])
    mockFsReadFile.mockResolvedValue("{bad json")

    await expect(resolvePluginEntry(ROOT_DIR)).resolves.toBe(indexEntry)
  })

  test("finds index.js when no package.json or conventional entry exists", async () => {
    const indexEntry = path.join(ROOT_DIR, "index.js")
    setExistingPaths([indexEntry])

    await expect(resolvePluginEntry(ROOT_DIR)).resolves.toBe(indexEntry)
  })

  test("finds plugin.js when index.js does not exist", async () => {
    const pluginEntry = path.join(ROOT_DIR, "plugin.js")
    setExistingPaths([pluginEntry])

    await expect(resolvePluginEntry(ROOT_DIR)).resolves.toBe(pluginEntry)
  })

  test("throws when no candidate entrypoint exists", async () => {
    setExistingPaths([])

    await expect(resolvePluginEntry(ROOT_DIR)).rejects.toThrow(
      `Could not determine plugin entrypoint for ${ROOT_DIR}`,
    )
  })
})

describe("moveExtractedDirIntoPlace", () => {
  const targetDir = "/plugins/acme"
  const extractedDir = "/tmp/extracted"

  test("moves directory cleanly when target does not exist", async () => {
    mockFsRename.mockResolvedValue(undefined)
    const validateExistingDir = mock(async () => {})

    await moveExtractedDirIntoPlace({ targetDir, extractedDir, validateExistingDir })

    expect(mockFsRename).toHaveBeenCalledTimes(1)
    expect(mockFsRename).toHaveBeenCalledWith(extractedDir, targetDir)
    expect(mockFsRm).not.toHaveBeenCalled()
    expect(validateExistingDir).not.toHaveBeenCalled()
  })

  test("returns silently when rename races and existing directory is valid", async () => {
    mockFsRename.mockRejectedValueOnce(errno("EEXIST"))
    const validateExistingDir = mock(async () => {})

    await moveExtractedDirIntoPlace({ targetDir, extractedDir, validateExistingDir })

    expect(mockFsRename).toHaveBeenCalledTimes(1)
    expect(validateExistingDir).toHaveBeenCalledTimes(1)
    expect(validateExistingDir).toHaveBeenCalledWith(targetDir)
    expect(mockFsRm).not.toHaveBeenCalled()
  })

  test("removes and retries when existing directory is invalid", async () => {
    mockFsRename.mockRejectedValueOnce(errno("EEXIST")).mockResolvedValueOnce(undefined)
    const validateExistingDir = mock(async () => {
      throw new Error("invalid")
    })

    await moveExtractedDirIntoPlace({ targetDir, extractedDir, validateExistingDir })

    expect(validateExistingDir).toHaveBeenCalledTimes(1)
    expect(mockFsRm).toHaveBeenCalledTimes(1)
    expect(mockFsRm).toHaveBeenCalledWith(targetDir, { recursive: true, force: true })
    expect(mockFsRename).toHaveBeenCalledTimes(2)
  })

  test("returns when retry races and validator then sees valid directory", async () => {
    mockFsRename.mockRejectedValueOnce(errno("EEXIST")).mockRejectedValueOnce(errno("EEXIST"))
    const validateExistingDir = mock(async () => {
      if (validateExistingDir.mock.calls.length === 1) {
        throw new Error("invalid")
      }
    })

    await moveExtractedDirIntoPlace({ targetDir, extractedDir, validateExistingDir })

    expect(mockFsRename).toHaveBeenCalledTimes(2)
    expect(validateExistingDir).toHaveBeenCalledTimes(2)
    expect(mockFsRm).toHaveBeenCalledTimes(1)
  })

  test("throws when directory remains invalid after retry race", async () => {
    mockFsRename.mockRejectedValueOnce(errno("EEXIST")).mockRejectedValueOnce(errno("EEXIST"))
    const validateExistingDir = mock(async () => {
      throw new Error("invalid")
    })

    await expect(moveExtractedDirIntoPlace({ targetDir, extractedDir, validateExistingDir })).rejects.toThrow(
      `Install directory exists but remains invalid: ${targetDir}`,
    )

    expect(mockFsRename).toHaveBeenCalledTimes(2)
    expect(validateExistingDir).toHaveBeenCalledTimes(2)
    expect(mockFsRm).toHaveBeenCalledTimes(1)
  })

  test("propagates non-existing-directory rename errors", async () => {
    const renameError = errno("EPERM")
    mockFsRename.mockRejectedValue(renameError)
    const validateExistingDir = mock(async () => {})

    await expect(moveExtractedDirIntoPlace({ targetDir, extractedDir, validateExistingDir })).rejects.toBe(renameError)

    expect(validateExistingDir).not.toHaveBeenCalled()
    expect(mockFsRm).not.toHaveBeenCalled()
  })
})
