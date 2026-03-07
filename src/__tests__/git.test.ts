import { beforeEach, describe, expect, mock, test } from "bun:test"
import path from "node:path"
import type { ManagedPluginSpec } from "../types"
import { makeCacheContext } from "./helpers"

const mockFsMkdtemp = mock()
const mockFsRm = mock()

mock.module("node:fs/promises", () => ({
  default: {
    mkdtemp: mockFsMkdtemp,
    rm: mockFsRm,
  },
}))

const mockRunCommand = mock()
const mockEnsureDir = mock()
const mockExists = mock()

mock.module("../util", () => ({
  runCommand: mockRunCommand,
  ensureDir: mockEnsureDir,
  exists: mockExists,
}))

const mockMoveExtractedDirIntoPlace = mock()
const mockResolvePluginEntry = mock()

mock.module("../sources/shared", () => ({
  moveExtractedDirIntoPlace: mockMoveExtractedDirIntoPlace,
  resolvePluginEntry: mockResolvePluginEntry,
}))

const mockGitInstallDir = mock()

mock.module("../cache", () => ({
  gitInstallDir: mockGitInstallDir,
}))

const { syncGitPlugin } = await import("../sources/git")

type GitSpec = Extract<ManagedPluginSpec, { source: "git" }>

type RunCommandInput = {
  command: string
  args: string[]
  cwd?: string
  timeout?: number
}

const CACHE_ROOT = "/cache-root"
const TEMP_DIR = `${CACHE_ROOT}/.tmp-git-abc123`
const COMMIT = "abc123def456789"
const TARGET_DIR = `${CACHE_ROOT}/installs/git/test-plugin/${COMMIT}`
const RESOLVED_PATH = `${TARGET_DIR}/dist/index.js`

function makeGitSpec(overrides: Partial<GitSpec> = {}): GitSpec {
  return {
    source: "git",
    id: "git:https://github.com/test/plugin",
    repo: "https://github.com/test/plugin",
    fromFile: "/config/plugins.json",
    entry: "dist/index.js",
    ...overrides,
  }
}

function getRunCalls(): RunCommandInput[] {
  return mockRunCommand.mock.calls.map((call) => call[0] as RunCommandInput)
}


beforeEach(() => {
  mockFsMkdtemp.mockReset()
  mockFsRm.mockReset()
  mockRunCommand.mockReset()
  mockEnsureDir.mockReset()
  mockExists.mockReset()
  mockMoveExtractedDirIntoPlace.mockReset()
  mockResolvePluginEntry.mockReset()
  mockGitInstallDir.mockReset()

  mockFsMkdtemp.mockResolvedValue(TEMP_DIR)
  mockFsRm.mockResolvedValue(undefined)

  mockEnsureDir.mockResolvedValue(undefined)
  mockExists.mockResolvedValue(true)
  mockMoveExtractedDirIntoPlace.mockResolvedValue(undefined)
  mockResolvePluginEntry.mockResolvedValue(RESOLVED_PATH)
  mockGitInstallDir.mockReturnValue(TARGET_DIR)
})

describe("syncGitPlugin", () => {
  test("clones and rev-parses without checkout when neither lockedCommit nor ref is set", async () => {
    const cache = makeCacheContext(CACHE_ROOT)
    const spec = makeGitSpec({ ref: undefined })
    const cloneDir = path.join(TEMP_DIR, "repo")

    mockRunCommand.mockImplementation(async ({ command, args }: RunCommandInput) => {
      expect(command).toBe("git")

      if (args[2] === "clone") {
        return { stdout: "", stderr: "" }
      }
      if (args[2] === "rev-parse") {
        return { stdout: `${COMMIT}\n`, stderr: "" }
      }

      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`)
    })

    const result = await syncGitPlugin(spec, cache)
    const runCalls = getRunCalls()

    expect(mockFsMkdtemp).toHaveBeenCalledWith(path.join(cache.rootDir, ".tmp-git-"))
    expect(runCalls).toHaveLength(2)
    expect(runCalls[0]).toEqual({
      command: "git",
      args: ["-c", "core.hooksPath=/dev/null", "clone", spec.repo, cloneDir],
    })
    expect(runCalls[1]).toEqual({
      command: "git",
      args: ["-C", cloneDir, "rev-parse", "--end-of-options", "HEAD"],
    })

    expect(runCalls.some((call) => call.args.includes("checkout"))).toBe(false)

    expect(mockGitInstallDir).toHaveBeenCalledWith(cache, spec.repo, COMMIT)
    expect(mockEnsureDir).toHaveBeenCalledWith(path.dirname(TARGET_DIR))
    expect(mockMoveExtractedDirIntoPlace).toHaveBeenCalledWith(
      expect.objectContaining({
        targetDir: TARGET_DIR,
        extractedDir: cloneDir,
        validateExistingDir: expect.any(Function),
      }),
    )
    expect(mockResolvePluginEntry).toHaveBeenCalledWith(TARGET_DIR, spec.entry)

    expect(result).toEqual({
      id: spec.id,
      source: "git",
      repo: spec.repo,
      ref: undefined,
      commit: COMMIT,
      resolvedPath: RESOLVED_PATH,
      updatedAt: expect.any(String),
    })
    expect(Number.isNaN(Date.parse(result.updatedAt))).toBe(false)

    expect(mockExists).toHaveBeenCalledWith(TEMP_DIR)
    expect(mockFsRm).toHaveBeenCalledWith(TEMP_DIR, { recursive: true, force: true })
  })

  test("uses lockedCommit checkout when both lockedCommit and spec.ref are present", async () => {
    const cache = makeCacheContext(CACHE_ROOT)
    const spec = makeGitSpec({ ref: "main" })
    const lockedCommit = "deadbeefcafebabe"
    const cloneDir = path.join(TEMP_DIR, "repo")

    mockRunCommand.mockImplementation(async ({ args }: RunCommandInput) => {
      if (args[2] === "clone") return { stdout: "", stderr: "" }
      if (args[4] === "checkout") return { stdout: "", stderr: "" }
      if (args[2] === "rev-parse") return { stdout: `${COMMIT}\n`, stderr: "" }
      throw new Error(`Unexpected args: ${args.join(" ")}`)
    })

    await syncGitPlugin(spec, cache, { lockedCommit })

    const checkoutCalls = getRunCalls().filter((call) => call.args.includes("checkout"))
    expect(checkoutCalls).toHaveLength(1)
    expect(checkoutCalls[0]).toEqual({
      command: "git",
      args: [
        "-C",
        cloneDir,
        "-c",
        "core.hooksPath=/dev/null",
        "checkout",
        "--end-of-options",
        lockedCommit,
      ],
    })
  })

  test("checks out spec.ref when lockedCommit is not provided", async () => {
    const cache = makeCacheContext(CACHE_ROOT)
    const spec = makeGitSpec({ ref: "release/v1" })
    const cloneDir = path.join(TEMP_DIR, "repo")

    mockRunCommand.mockImplementation(async ({ args }: RunCommandInput) => {
      if (args[2] === "clone") return { stdout: "", stderr: "" }
      if (args[4] === "checkout") return { stdout: "", stderr: "" }
      if (args[2] === "rev-parse") return { stdout: `${COMMIT}\n`, stderr: "" }
      throw new Error(`Unexpected args: ${args.join(" ")}`)
    })

    await syncGitPlugin(spec, cache)

    const checkoutCalls = getRunCalls().filter((call) => call.args.includes("checkout"))
    expect(checkoutCalls).toHaveLength(1)
    expect(checkoutCalls[0]).toEqual({
      command: "git",
      args: ["-C", cloneDir, "-c", "core.hooksPath=/dev/null", "checkout", "--end-of-options", spec.ref!],
    })
  })

  test("runs build command with cwd and timeout when build is configured", async () => {
    const cache = makeCacheContext(CACHE_ROOT)
    const spec = makeGitSpec({
      build: {
        command: "npm run build",
        timeout: 45_000,
      },
    })
    const cloneDir = path.join(TEMP_DIR, "repo")

    mockRunCommand.mockImplementation(async ({ command, args }: RunCommandInput) => {
      if (command === "git" && args[2] === "clone") return { stdout: "", stderr: "" }
      if (command === "git" && args[2] === "rev-parse") return { stdout: `${COMMIT}\n`, stderr: "" }
      if (command === "sh") return { stdout: "", stderr: "" }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`)
    })

    await syncGitPlugin(spec, cache)

    const buildCalls = getRunCalls().filter((call) => call.command === "sh")
    expect(buildCalls).toHaveLength(1)
    expect(buildCalls[0]).toEqual({
      command: "sh",
      args: ["-lc", spec.build!.command],
      cwd: cloneDir,
      timeout: spec.build!.timeout,
    })
  })

  test("propagates clone error and still cleans temp directory", async () => {
    const cache = makeCacheContext(CACHE_ROOT)
    const spec = makeGitSpec()
    const cloneError = new Error("clone failed")

    mockRunCommand.mockImplementation(async ({ args }: RunCommandInput) => {
      if (args[2] === "clone") throw cloneError
      throw new Error(`Unexpected args: ${args.join(" ")}`)
    })

    await expect(syncGitPlugin(spec, cache)).rejects.toBe(cloneError)

    expect(getRunCalls()).toHaveLength(1)
    expect(mockEnsureDir).not.toHaveBeenCalled()
    expect(mockMoveExtractedDirIntoPlace).not.toHaveBeenCalled()
    expect(mockResolvePluginEntry).not.toHaveBeenCalled()

    expect(mockExists).toHaveBeenCalledWith(TEMP_DIR)
    expect(mockFsRm).toHaveBeenCalledWith(TEMP_DIR, { recursive: true, force: true })
  })
})
