import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import path from "node:path"
import type { LockEntry, ManagedPluginSpec } from "../types"
import { makeCacheContext, makeSpec } from "./helpers"

const mockFsMkdtemp = mock(async (_prefix: string) => "/cache/.tmp-gh-default")
const mockFsWriteFile = mock(async (_filePath: string, _data: Buffer) => undefined)
const mockFsRm = mock(async (_filePath: string, _options: { recursive: boolean; force: boolean }) => undefined)
const mockFsCopyFile = mock(async (_from: string, _to: string) => undefined)

const mockRunCommand = mock(async (_args: unknown) => ({ stdout: "", stderr: "" }))
const mockSha256File = mock(async (_filePath: string) => "sha256-default")
const mockExists = mock(async (_filePath: string) => true)
const mockEnsureDir = mock(async (_filePath: string) => undefined)

type MoveArgs = {
  targetDir: string
  extractedDir: string
  validateExistingDir: (installDir: string) => Promise<void>
}

const mockMoveExtractedDirIntoPlace = mock(async (args: MoveArgs) => {
  await args.validateExistingDir(args.targetDir)
})
const mockResolvePluginEntry = mock(async (installDir: string, entry?: string) =>
  path.join(installDir, entry ?? "index.js"),
)

const mockGithubInstallDir = mock((_cache: unknown, repo: string, tag: string) => `/cache/github/${repo}/${tag}`)

mock.module("../sources/github.deps", () => ({
  fs: {
    mkdtemp: mockFsMkdtemp,
    writeFile: mockFsWriteFile,
    rm: mockFsRm,
    copyFile: mockFsCopyFile,
  },
  runCommand: mockRunCommand,
  sha256File: mockSha256File,
  exists: mockExists,
  ensureDir: mockEnsureDir,
  moveExtractedDirIntoPlace: mockMoveExtractedDirIntoPlace,
  resolvePluginEntry: mockResolvePluginEntry,
  githubInstallDir: mockGithubInstallDir,
}))

const mockFetch = mock(async (_url: string, _init?: RequestInit) => ({} as Response))
const originalFetch = globalThis.fetch
const originalGithubToken = process.env.GITHUB_TOKEN
const originalGhToken = process.env.GH_TOKEN

const { syncGithubReleasePlugin } = await import("../sources/github")

type GithubSpec = Extract<ManagedPluginSpec, { source: "github-release" }>
type GithubLockEntry = Extract<LockEntry, { source: "github-release" }>
type ReleaseAsset = { name: string; browser_download_url: string }
type ReleasePayload = { tag_name: string; assets: ReleaseAsset[] }

const cache = makeCacheContext("/cache")

function asset(name: string): ReleaseAsset {
  return {
    name,
    browser_download_url: `https://example.com/downloads/${name}`,
  }
}

function queueReleaseResponse(payload: ReleasePayload, status = 200): void {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => `status ${status}`,
  } as unknown as Response)
}

function queueDownloadResponse(
  options: {
    ok?: boolean
    status?: number
    statusText?: string
    body?: unknown
    bytes?: Uint8Array
  } = {},
): void {
  const bytes = options.bytes ?? new Uint8Array([1, 2, 3])
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)

  mockFetch.mockResolvedValueOnce({
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? "OK",
    body: options.body === undefined ? {} : options.body,
    arrayBuffer: async () => arrayBuffer,
    text: async () => options.statusText ?? "OK",
  } as unknown as Response)
}

async function sync(
  overrides: Partial<GithubSpec> = {},
  options: { lockedTag?: string; lockedAsset?: string } = {},
): Promise<GithubLockEntry> {
  const spec = makeSpec("github-release", overrides)
  const result = await syncGithubReleasePlugin(spec, cache, options)
  return result as GithubLockEntry
}


beforeEach(() => {
  for (const fn of [
    mockFsMkdtemp,
    mockFsWriteFile,
    mockFsRm,
    mockFsCopyFile,
    mockRunCommand,
    mockSha256File,
    mockExists,
    mockEnsureDir,
    mockMoveExtractedDirIntoPlace,
    mockResolvePluginEntry,
    mockGithubInstallDir,
    mockFetch,
  ]) {
    fn.mockReset()
  }

  globalThis.fetch = mockFetch as unknown as typeof fetch
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN

  mockFsMkdtemp.mockResolvedValue("/cache/.tmp-gh-123")
  mockFsWriteFile.mockResolvedValue(undefined)
  mockFsRm.mockResolvedValue(undefined)
  mockFsCopyFile.mockResolvedValue(undefined)
  mockRunCommand.mockResolvedValue({ stdout: "", stderr: "" })
  mockSha256File.mockResolvedValue("sha256-default")
  mockExists.mockResolvedValue(true)
  mockEnsureDir.mockResolvedValue(undefined)
  mockMoveExtractedDirIntoPlace.mockImplementation(async (args: MoveArgs) => {
    await args.validateExistingDir(args.targetDir)
  })
  mockResolvePluginEntry.mockImplementation(async (installDir: string, entry?: string) =>
    path.join(installDir, entry ?? "index.js"),
  )
  mockGithubInstallDir.mockImplementation((_ctx: unknown, repo: string, tag: string) => `/cache/github/${repo}/${tag}`)
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN
  else process.env.GITHUB_TOKEN = originalGithubToken
  if (originalGhToken === undefined) delete process.env.GH_TOKEN
  else process.env.GH_TOKEN = originalGhToken
})

describe("syncGithubReleasePlugin asset selection", () => {
  test("throws when the release has no assets", async () => {
    queueReleaseResponse({ tag_name: "v1.0.0", assets: [] })

    await expect(sync()).rejects.toThrow("No matching release asset found for test/plugin")
    expect(mockFsMkdtemp).not.toHaveBeenCalled()
  })

  test("selects the only asset when no asset is requested", async () => {
    queueReleaseResponse({ tag_name: "v1.2.3", assets: [asset("only.js")] })
    queueDownloadResponse()

    const result = await sync()

    expect(result.asset).toBe("only.js")
    expect(mockFetch.mock.calls[1]?.[0]).toBe("https://example.com/downloads/only.js")
  })

  test("prefers plugin.js among multiple assets when no asset is requested", async () => {
    queueReleaseResponse({
      tag_name: "v1.2.3",
      assets: [asset("readme.txt"), asset("plugin.js"), asset("other.js")],
    })
    queueDownloadResponse()

    const result = await sync()

    expect(result.asset).toBe("plugin.js")
    expect(mockFetch.mock.calls[1]?.[0]).toBe("https://example.com/downloads/plugin.js")
  })

  test("falls back to first asset when plugin.js is absent", async () => {
    queueReleaseResponse({
      tag_name: "v1.2.3",
      assets: [asset("first.js"), asset("second.js")],
    })
    queueDownloadResponse()

    const result = await sync()

    expect(result.asset).toBe("first.js")
    expect(mockFetch.mock.calls[1]?.[0]).toBe("https://example.com/downloads/first.js")
  })

  test("matches exact requested asset name", async () => {
    queueReleaseResponse({
      tag_name: "v1.2.3",
      assets: [asset("alpha.js"), asset("beta.js")],
    })
    queueDownloadResponse()

    const result = await sync({ asset: "beta.js" })

    expect(result.asset).toBe("beta.js")
    expect(mockFetch.mock.calls[1]?.[0]).toBe("https://example.com/downloads/beta.js")
  })

  test("supports wildcard requested assets", async () => {
    queueReleaseResponse({
      tag_name: "v1.2.3",
      assets: [asset("plugin-macos.tar.gz"), asset("plugin-linux.tar.gz")],
    })
    queueDownloadResponse()

    const result = await sync({ asset: "*.tar.gz" })

    expect(result.asset).toBe("plugin-macos.tar.gz")
    expect(mockFetch.mock.calls[1]?.[0]).toBe("https://example.com/downloads/plugin-macos.tar.gz")
  })

  test("throws when wildcard requested asset does not match", async () => {
    queueReleaseResponse({
      tag_name: "v1.2.3",
      assets: [asset("plugin.js"), asset("readme.md")],
    })

    await expect(sync({ asset: "*.zip" })).rejects.toThrow("No matching release asset found for test/plugin")
  })
})

describe("syncGithubReleasePlugin archive safety", () => {
  test("accepts safe archive entries", async () => {
    queueReleaseResponse({ tag_name: "v1.0.0", assets: [asset("plugin.zip")] })
    queueDownloadResponse()
    mockRunCommand
      .mockResolvedValueOnce({ stdout: "dist/index.js\nlib/util.js\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })

    await sync()

    const listingCall = mockRunCommand.mock.calls[0]?.[0] as { command: string; args: string[] }
    const extractCall = mockRunCommand.mock.calls[1]?.[0] as { command: string; args: string[] }

    expect(listingCall.command).toBe("unzip")
    expect(listingCall.args).toEqual(["-Z1", "/cache/.tmp-gh-123/plugin.zip"])
    expect(extractCall.command).toBe("unzip")
    expect(extractCall.args).toEqual(["-q", "/cache/.tmp-gh-123/plugin.zip", "-d", "/cache/.tmp-gh-123/content"])
  })

  for (const [label, unsafeEntry] of [
    ["parent traversal", "../../etc/passwd"],
    ["absolute path", "/etc/passwd"],
    ["windows drive path", "C:/Windows/system32"],
    ["null byte", "bad\0entry"],
    ["backslash traversal", "..\\..\\etc\\passwd"],
  ] as const) {
    test(`rejects unsafe archive entry (${label})`, async () => {
      queueReleaseResponse({ tag_name: "v1.0.0", assets: [asset("plugin.zip")] })
      queueDownloadResponse()
      mockRunCommand.mockResolvedValueOnce({ stdout: `${unsafeEntry}\n`, stderr: "" })

      await expect(sync()).rejects.toThrow(`Refusing to extract unsafe archive entry: ${unsafeEntry}`)
      expect(mockRunCommand).toHaveBeenCalledTimes(1)
    })
  }
})

describe("syncGithubReleasePlugin direct-file vs archive entry resolution", () => {
  test("passes undefined entry for archive assets", async () => {
    queueReleaseResponse({ tag_name: "v1.0.0", assets: [asset("plugin.zip")] })
    queueDownloadResponse()

    await sync()

    expect(mockResolvePluginEntry.mock.calls[0]?.[1]).toBeUndefined()
    expect(mockResolvePluginEntry.mock.calls[1]?.[1]).toBeUndefined()
  })

  test("passes asset name as entry for direct-file assets", async () => {
    queueReleaseResponse({ tag_name: "v1.0.0", assets: [asset("plugin.js")] })
    queueDownloadResponse()

    await sync()

    expect(mockResolvePluginEntry.mock.calls[0]?.[1]).toBe("plugin.js")
    expect(mockResolvePluginEntry.mock.calls[1]?.[1]).toBe("plugin.js")
  })
})

describe("syncGithubReleasePlugin full flow", () => {
  test("happy path downloads direct asset, copies it, and returns lock entry", async () => {
    queueReleaseResponse({ tag_name: "v3.1.0", assets: [asset("plugin.js")] })
    queueDownloadResponse()
    mockSha256File.mockResolvedValue("sha256-ok")

    const result = await sync()

    expect(result.id).toBe("github-release:test/plugin")
    expect(result.source).toBe("github-release")
    expect(result.repo).toBe("test/plugin")
    expect(result.tag).toBe("v3.1.0")
    expect(result.asset).toBe("plugin.js")
    expect(result.integrity).toBe("sha256-ok")
    expect(result.resolvedPath).toBe("/cache/github/test/plugin/v3.1.0/plugin.js")
    expect(Number.isNaN(Date.parse(result.updatedAt))).toBe(false)

    expect(mockFsCopyFile).toHaveBeenCalledWith(
      "/cache/.tmp-gh-123/plugin.js",
      "/cache/.tmp-gh-123/content/plugin.js",
    )
    expect(mockGithubInstallDir).toHaveBeenCalledWith(cache, "test/plugin", "v3.1.0")
    expect(mockMoveExtractedDirIntoPlace).toHaveBeenCalledTimes(1)
  })

  test("succeeds when asset digest matches", async () => {
    queueReleaseResponse({ tag_name: "v1.0.0", assets: [asset("plugin.js")] })
    queueDownloadResponse()
    mockSha256File.mockResolvedValue("digest-123")

    const result = await sync({ assetDigest: "digest-123" })

    expect(result.integrity).toBe("digest-123")
  })

  test("throws when asset digest mismatches", async () => {
    queueReleaseResponse({ tag_name: "v1.0.0", assets: [asset("plugin.js")] })
    queueDownloadResponse()
    mockSha256File.mockResolvedValue("actual-digest")

    await expect(sync({ assetDigest: "expected-digest" })).rejects.toThrow(
      "Asset digest mismatch for plugin.js; expected expected-digest, got actual-digest",
    )
  })

  test("throws when download request fails", async () => {
    queueReleaseResponse({ tag_name: "v1.0.0", assets: [asset("plugin.js")] })
    queueDownloadResponse({ ok: false, status: 403, statusText: "Forbidden", body: {} })

    await expect(sync()).rejects.toThrow("Failed to download release asset: 403 Forbidden")
  })

  test("uses GITHUB_TOKEN for API and download requests", async () => {
    process.env.GITHUB_TOKEN = "secret-token"
    queueReleaseResponse({ tag_name: "v1.0.0", assets: [asset("plugin.js")] })
    queueDownloadResponse()

    await sync()

    const releaseHeaders = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>
    const downloadHeaders = mockFetch.mock.calls[1]?.[1]?.headers as Record<string, string>
    expect(releaseHeaders.Authorization).toBe("Bearer secret-token")
    expect(downloadHeaders.Authorization).toBe("Bearer secret-token")
  })

  test("omits Authorization header when no token is present", async () => {
    queueReleaseResponse({ tag_name: "v1.0.0", assets: [asset("plugin.js")] })
    queueDownloadResponse()

    await sync()

    const releaseHeaders = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>
    const downloadHeaders = mockFetch.mock.calls[1]?.[1]?.headers as Record<string, string>
    expect(releaseHeaders.Authorization).toBeUndefined()
    expect(downloadHeaders.Authorization).toBeUndefined()
  })

  test("runs build command after extraction", async () => {
    queueReleaseResponse({ tag_name: "v1.0.0", assets: [asset("plugin.zip")] })
    queueDownloadResponse()

    await sync({
      build: {
        command: "npm run build",
        timeout: 4567,
      },
    })

    const listArchive = mockRunCommand.mock.calls[0]?.[0] as { command: string }
    const extractArchive = mockRunCommand.mock.calls[1]?.[0] as { command: string }
    const buildCall = mockRunCommand.mock.calls[2]?.[0] as {
      command: string
      args: string[]
      cwd: string
      timeout: number
    }

    expect(listArchive.command).toBe("unzip")
    expect(extractArchive.command).toBe("unzip")
    expect(buildCall).toEqual({
      command: "sh",
      args: ["-lc", "npm run build"],
      cwd: "/cache/.tmp-gh-123/content",
      timeout: 4567,
    })
  })

  test("cleans temp directory when sync fails", async () => {
    queueReleaseResponse({ tag_name: "v1.0.0", assets: [asset("plugin.js")] })
    queueDownloadResponse()
    mockSha256File.mockResolvedValue("actual")

    await expect(sync({ assetDigest: "expected" })).rejects.toThrow(
      "Asset digest mismatch for plugin.js; expected expected, got actual",
    )

    expect(mockExists).toHaveBeenCalledWith("/cache/.tmp-gh-123")
    expect(mockFsRm).toHaveBeenCalledWith("/cache/.tmp-gh-123", { recursive: true, force: true })
  })
})
