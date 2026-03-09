import { beforeEach, describe, expect, mock, test } from "bun:test"
import path from "node:path"
import type { Logger } from "../log"
import type { ManagedPluginSpec } from "../types"
import { makeCacheContext } from "./helpers"

const mockFsMkdtemp = mock()
const mockFsRm = mock()

const mockRunCommand = mock()
const mockEnsureDir = mock()
const mockExists = mock()

const mockMoveExtractedDirIntoPlace = mock()
const mockResolvePluginEntry = mock()
const mockSha256File = mock()

const mockGitInstallDir = mock()

mock.module("../sources/git.deps", () => ({
  fs: {
    mkdtemp: mockFsMkdtemp,
    rm: mockFsRm,
  },
  runCommand: mockRunCommand,
  ensureDir: mockEnsureDir,
  exists: mockExists,
  moveExtractedDirIntoPlace: mockMoveExtractedDirIntoPlace,
  resolvePluginEntry: mockResolvePluginEntry,
  sha256File: mockSha256File,
  gitInstallDir: mockGitInstallDir,
}))

const { syncGitPlugin } = await import("../sources/git")

type GitSpec = Extract<ManagedPluginSpec, { source: "git" }>

type RunCommandInput = {
  command: string
  args: string[]
  cwd?: string
  timeout?: number
  logger?: Logger
}

const TEST_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
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
  mockSha256File.mockReset()
  mockGitInstallDir.mockReset()

  mockFsMkdtemp.mockResolvedValue(TEMP_DIR)
  mockFsRm.mockResolvedValue(undefined)

  mockEnsureDir.mockResolvedValue(undefined)
  mockExists.mockResolvedValue(true)
  mockMoveExtractedDirIntoPlace.mockResolvedValue(undefined)
  mockResolvePluginEntry.mockResolvedValue(RESOLVED_PATH)
  mockSha256File.mockResolvedValue("sha256:git-integrity")
  mockGitInstallDir.mockReturnValue(TARGET_DIR)
})

describe("syncGitPlugin", () => {
  test("shallow-clones HEAD without checkout when neither lockedCommit nor ref is set", async () => {
    const cache = makeCacheContext(CACHE_ROOT)
    const spec = makeGitSpec({ ref: undefined })
    const cloneDir = path.join(TEMP_DIR, "repo")

    mockRunCommand.mockImplementation(async ({ command, args }: RunCommandInput) => {
      if (command === "bun") {
        return { stdout: "", stderr: "" }
      }
      expect(command).toBe("git")

      if (args.includes("clone")) {
        return { stdout: "", stderr: "" }
      }
      if (args.includes("rev-parse")) {
        return { stdout: `${COMMIT}\n`, stderr: "" }
      }

      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`)
    })

    const result = await syncGitPlugin(spec, cache, {}, TEST_LOGGER)
    const runCalls = getRunCalls()

    expect(mockFsMkdtemp).toHaveBeenCalledWith(path.join(cache.rootDir, ".tmp-git-"))
    expect(runCalls).toHaveLength(3)
    expect(runCalls[0]).toEqual({
      command: "git",
      args: ["-c", "core.hooksPath=/dev/null", "clone", "--depth", "1", spec.repo, cloneDir],
      timeout: expect.any(Number),
      logger: TEST_LOGGER,
    })
    expect(runCalls[1]).toEqual({
      command: "git",
      args: ["-C", cloneDir, "rev-parse", "--verify", "HEAD"],
      logger: TEST_LOGGER,
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
    expect(mockSha256File).toHaveBeenCalledWith(RESOLVED_PATH)

    expect(result).toEqual({
      id: spec.id,
      source: "git",
      repo: spec.repo,
      ref: undefined,
      commit: COMMIT,
      resolvedPath: RESOLVED_PATH,
      integrity: "sha256:git-integrity",
      updatedAt: expect.any(String),
    })
    expect(Number.isNaN(Date.parse(result.updatedAt))).toBe(false)

    expect(mockExists).toHaveBeenCalledWith(TEMP_DIR)
    expect(mockFsRm).toHaveBeenCalledWith(TEMP_DIR, { recursive: true, force: true })
  })

  test("shallow-clones then fetches lockedCommit when both lockedCommit and spec.ref are present", async () => {
    const cache = makeCacheContext(CACHE_ROOT)
    const spec = makeGitSpec({ ref: "main" })
    const lockedCommit = "deadbeefcafebabe"
    const cloneDir = path.join(TEMP_DIR, "repo")

    mockRunCommand.mockImplementation(async ({ args }: RunCommandInput) => {
      if (args.includes("clone")) return { stdout: "", stderr: "" }
      if (args.includes("fetch")) return { stdout: "", stderr: "" }
      if (args.includes("checkout")) return { stdout: "", stderr: "" }
      if (args.includes("rev-parse")) return { stdout: `${COMMIT}\n`, stderr: "" }
      if (args.includes("install")) return { stdout: "", stderr: "" }
      throw new Error(`Unexpected args: ${args.join(" ")}`)
    })

    await syncGitPlugin(spec, cache, { lockedCommit }, TEST_LOGGER)
    const runCalls = getRunCalls()

    // Should shallow-clone first
    expect(runCalls[0]).toEqual({
      command: "git",
      args: ["-c", "core.hooksPath=/dev/null", "clone", "--depth", "1", spec.repo, cloneDir],
      timeout: expect.any(Number),
      logger: TEST_LOGGER,
    })

    // Then shallow-fetch the specific commit
    const fetchCalls = runCalls.filter((call) => call.args.includes("fetch"))
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]).toEqual({
      command: "git",
      args: ["-C", cloneDir, "-c", "core.hooksPath=/dev/null", "fetch", "--depth", "1", "origin", "--end-of-options", lockedCommit],
      timeout: expect.any(Number),
      logger: TEST_LOGGER,
    })

    // Then checkout the commit
    const checkoutCalls = runCalls.filter((call) => call.args.includes("checkout"))
    expect(checkoutCalls).toHaveLength(1)
    expect(checkoutCalls[0]).toEqual({
      command: "git",
      args: ["-C", cloneDir, "-c", "core.hooksPath=/dev/null", "checkout", "--end-of-options", lockedCommit],
      timeout: expect.any(Number),
      logger: TEST_LOGGER,
    })
  })

  test("falls back to full fetch when shallow fetch by commit fails", async () => {
    const cache = makeCacheContext(CACHE_ROOT)
    const spec = makeGitSpec({ ref: "main" })
    const lockedCommit = "deadbeefcafebabe"
    const cloneDir = path.join(TEMP_DIR, "repo")

    mockRunCommand.mockImplementation(async ({ args }: RunCommandInput) => {
      if (args.includes("clone")) return { stdout: "", stderr: "" }
      if (args.includes("fetch") && args.includes(lockedCommit)) throw new Error("server does not allow request for unadvertised object")
      if (args.includes("--unshallow")) return { stdout: "", stderr: "" }
      if (args.includes("checkout")) return { stdout: "", stderr: "" }
      if (args.includes("rev-parse")) return { stdout: `${COMMIT}\n`, stderr: "" }
      if (args.includes("install")) return { stdout: "", stderr: "" }
      throw new Error(`Unexpected args: ${args.join(" ")}`)
    })

    await syncGitPlugin(spec, cache, { lockedCommit }, TEST_LOGGER)
    const runCalls = getRunCalls()

    // Should have: clone, fetch (fails), unshallow, checkout, rev-parse
    const fetchCalls = runCalls.filter((call) => call.args.includes("fetch"))
    expect(fetchCalls).toHaveLength(2)

    // First fetch: shallow by commit (fails)
    expect(fetchCalls[0].args).toContain(lockedCommit)

    // Second fetch: full unshallow
    expect(fetchCalls[1]).toEqual({
      command: "git",
      args: ["-C", cloneDir, "-c", "core.hooksPath=/dev/null", "fetch", "--unshallow"],
      timeout: expect.any(Number),
      logger: TEST_LOGGER,
    })

    // Checkout still happens
    const checkoutCalls = runCalls.filter((call) => call.args.includes("checkout"))
    expect(checkoutCalls).toHaveLength(1)
    expect(checkoutCalls[0].args).toContain(lockedCommit)
  })

  test("shallow-clones at spec.ref with --branch when lockedCommit is not provided", async () => {
    const cache = makeCacheContext(CACHE_ROOT)
    const spec = makeGitSpec({ ref: "release/v1" })
    const cloneDir = path.join(TEMP_DIR, "repo")

    mockRunCommand.mockImplementation(async ({ args }: RunCommandInput) => {
      if (args.includes("clone")) return { stdout: "", stderr: "" }
      if (args.includes("rev-parse")) return { stdout: `${COMMIT}\n`, stderr: "" }
      if (args.includes("install")) return { stdout: "", stderr: "" }
      throw new Error(`Unexpected args: ${args.join(" ")}`)
    })

    await syncGitPlugin(spec, cache, {}, TEST_LOGGER)
    const runCalls = getRunCalls()

    // Should shallow-clone with --branch, no separate checkout
    expect(runCalls[0]).toEqual({
      command: "git",
      args: ["-c", "core.hooksPath=/dev/null", "clone", "--depth", "1", "--branch", spec.ref!, spec.repo, cloneDir],
      timeout: expect.any(Number),
      logger: TEST_LOGGER,
    })

    const checkoutCalls = runCalls.filter((call) => call.args.includes("checkout"))
    expect(checkoutCalls).toHaveLength(0)
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
      if (command === "git" && args.includes("clone")) return { stdout: "", stderr: "" }
      if (command === "git" && args.includes("rev-parse")) return { stdout: `${COMMIT}\n`, stderr: "" }
      if (command === "bun") return { stdout: "", stderr: "" }
      if (command === "sh") return { stdout: "", stderr: "" }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`)
    })

    await syncGitPlugin(spec, cache, {}, TEST_LOGGER)

    const buildCalls = getRunCalls().filter((call) => call.command === "sh")
    expect(buildCalls).toHaveLength(1)
    expect(buildCalls[0]).toEqual({
      command: "sh",
      args: ["-lc", spec.build!.command],
      cwd: cloneDir,
      timeout: spec.build!.timeout,
      logger: TEST_LOGGER,
    })
  })

  test("runs bun install when package.json exists in clone directory", async () => {
    const cache = makeCacheContext(CACHE_ROOT)
    const spec = makeGitSpec()
    const cloneDir = path.join(TEMP_DIR, "repo")

    mockRunCommand.mockImplementation(async ({ command, args }: RunCommandInput) => {
      if (command === "git" && args.includes("clone")) return { stdout: "", stderr: "" }
      if (command === "git" && args.includes("rev-parse")) return { stdout: `${COMMIT}\n`, stderr: "" }
      if (command === "bun") return { stdout: "", stderr: "" }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`)
    })

    await syncGitPlugin(spec, cache, {}, TEST_LOGGER)
    const runCalls = getRunCalls()

    const bunCalls = runCalls.filter((call) => call.command === "bun")
    expect(bunCalls).toHaveLength(1)
    expect(bunCalls[0]).toEqual({
      command: "bun",
      args: ["install", "--ignore-scripts"],
      cwd: cloneDir,
      timeout: expect.any(Number),
      logger: TEST_LOGGER,
    })
  })

  test("skips bun install when no package.json exists in clone directory", async () => {
    const cache = makeCacheContext(CACHE_ROOT)
    const spec = makeGitSpec()

    mockExists.mockImplementation(async (p: string) => {
      if (p.endsWith("package.json")) return false
      return true
    })

    mockRunCommand.mockImplementation(async ({ command, args }: RunCommandInput) => {
      if (command === "git" && args.includes("clone")) return { stdout: "", stderr: "" }
      if (command === "git" && args.includes("rev-parse")) return { stdout: `${COMMIT}\n`, stderr: "" }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`)
    })

    await syncGitPlugin(spec, cache, {}, TEST_LOGGER)
    const runCalls = getRunCalls()

    const bunCalls = runCalls.filter((call) => call.command === "bun")
    expect(bunCalls).toHaveLength(0)
  })

  test("runs bun install before build command", async () => {
    const cache = makeCacheContext(CACHE_ROOT)
    const spec = makeGitSpec({
      build: {
        command: "npm run build",
        timeout: 45_000,
      },
    })
    const cloneDir = path.join(TEMP_DIR, "repo")
    const callOrder: string[] = []

    mockRunCommand.mockImplementation(async ({ command, args }: RunCommandInput) => {
      if (command === "git" && args.includes("clone")) return { stdout: "", stderr: "" }
      if (command === "git" && args.includes("rev-parse")) return { stdout: `${COMMIT}\n`, stderr: "" }
      if (command === "bun") {
        callOrder.push("bun-install")
        return { stdout: "", stderr: "" }
      }
      if (command === "sh") {
        callOrder.push("build")
        return { stdout: "", stderr: "" }
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`)
    })

    await syncGitPlugin(spec, cache, {}, TEST_LOGGER)

    expect(callOrder).toEqual(["bun-install", "build"])
  })

  test("propagates bun install error and still cleans temp directory", async () => {
    const cache = makeCacheContext(CACHE_ROOT)
    const spec = makeGitSpec()
    const installError = new Error("bun install failed")

    mockRunCommand.mockImplementation(async ({ command, args }: RunCommandInput) => {
      if (command === "git" && args.includes("clone")) return { stdout: "", stderr: "" }
      if (command === "git" && args.includes("rev-parse")) return { stdout: `${COMMIT}\n`, stderr: "" }
      if (command === "bun") throw installError
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`)
    })

    await expect(syncGitPlugin(spec, cache, {}, TEST_LOGGER)).rejects.toBe(installError)

    expect(mockEnsureDir).not.toHaveBeenCalled()
    expect(mockMoveExtractedDirIntoPlace).not.toHaveBeenCalled()

    expect(mockExists).toHaveBeenCalledWith(TEMP_DIR)
    expect(mockFsRm).toHaveBeenCalledWith(TEMP_DIR, { recursive: true, force: true })
  })

  test("propagates clone error and still cleans temp directory", async () => {
    const cache = makeCacheContext(CACHE_ROOT)
    const spec = makeGitSpec()
    const cloneError = new Error("clone failed")

    mockRunCommand.mockImplementation(async ({ args }: RunCommandInput) => {
      if (args.includes("clone")) throw cloneError
      throw new Error(`Unexpected args: ${args.join(" ")}`)
    })

    await expect(syncGitPlugin(spec, cache, {}, TEST_LOGGER)).rejects.toBe(cloneError)

    expect(getRunCalls()).toHaveLength(1)
    expect(mockEnsureDir).not.toHaveBeenCalled()
    expect(mockMoveExtractedDirIntoPlace).not.toHaveBeenCalled()
    expect(mockResolvePluginEntry).not.toHaveBeenCalled()

    expect(mockExists).toHaveBeenCalledWith(TEMP_DIR)
    expect(mockFsRm).toHaveBeenCalledWith(TEMP_DIR, { recursive: true, force: true })
  })
})
