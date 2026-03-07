import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import type { CacheContext } from "../cache"
import { githubInstallDir } from "../cache"
import type { LockEntry, ManagedPluginSpec } from "../types"
import { ensureDir, exists, runCommand, sha256File } from "../util"
import { resolvePluginEntry } from "./shared"

type GithubSpec = Extract<ManagedPluginSpec, { source: "github-release" }>

const GithubReleaseSchema = z.object({
  tag_name: z.string().min(1),
  assets: z.array(
    z.object({
      name: z.string().min(1),
      browser_download_url: z.string().url(),
    }),
  ),
})

type GithubRelease = z.infer<typeof GithubReleaseSchema>

export async function syncGithubReleasePlugin(
  spec: GithubSpec,
  cache: CacheContext,
  options: { lockedTag?: string; lockedAsset?: string } = {},
): Promise<LockEntry> {
  const release = await fetchRelease(spec, options.lockedTag)
  const tag = release.tag_name
  const asset = selectAsset(release, options.lockedAsset ?? spec.asset)

  if (!asset) {
    throw new Error(`No matching release asset found for ${spec.repo}`)
  }

  const tempDir = await fs.mkdtemp(path.join(cache.rootDir, ".tmp-gh-"))
  const downloadPath = path.join(tempDir, asset.name)

  try {
    const headers = githubHeaders()
    const response = await fetch(asset.browser_download_url, { headers })
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download release asset: ${response.status} ${response.statusText}`)
    }

    const bytes = await response.arrayBuffer()
    await fs.writeFile(downloadPath, Buffer.from(bytes))

    const digest = await sha256File(downloadPath)
    if (spec.assetDigest && spec.assetDigest !== digest) {
      throw new Error(`Asset digest mismatch for ${asset.name}; expected ${spec.assetDigest}, got ${digest}`)
    }

    const extractedDir = path.join(tempDir, "content")
    await ensureDir(extractedDir)
    await materializeAsset(downloadPath, extractedDir)

    if (spec.build) {
      await runCommand({
        command: "sh",
        args: ["-lc", spec.build.command],
        cwd: extractedDir,
        timeout: spec.build.timeout,
      })
    }

    const targetDir = githubInstallDir(cache, spec.repo, tag)
    await ensureDir(path.dirname(targetDir))
    if (!(await exists(targetDir))) {
      await fs.rename(extractedDir, targetDir)
    }

    const resolvedPath = await resolvePluginEntry(targetDir, spec.entry ?? maybeDirectFileEntry(asset.name, targetDir))

    return {
      id: spec.id,
      source: "github-release",
      repo: spec.repo,
      tag,
      asset: asset.name,
      resolvedPath,
      integrity: digest,
      updatedAt: new Date().toISOString(),
    }
  } finally {
    if (await exists(tempDir)) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

function maybeDirectFileEntry(assetName: string, rootDir: string): string | undefined {
  const lower = assetName.toLowerCase()
  if (lower.endsWith(".zip") || lower.endsWith(".tar") || lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    return undefined
  }
  return path.relative(rootDir, path.join(rootDir, assetName))
}

function selectAsset(release: GithubRelease, requestedAsset?: string): GithubRelease["assets"][number] | undefined {
  if (!release.assets.length) return undefined
  if (!requestedAsset) {
    if (release.assets.length === 1) return release.assets[0]
    return release.assets.find((item) => item.name === "plugin.js") ?? release.assets[0]
  }

  if (requestedAsset.includes("*")) {
    const pattern = new RegExp(`^${requestedAsset.split("*").map(escapeRegex).join(".*")}$`)
    return release.assets.find((item) => pattern.test(item.name))
  }
  return release.assets.find((item) => item.name === requestedAsset)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function fetchRelease(spec: GithubSpec, lockedTag?: string): Promise<GithubRelease> {
  const tag = lockedTag ?? spec.tag
  const endpoint = tag
    ? `https://api.github.com/repos/${spec.repo}/releases/tags/${encodeURIComponent(tag)}`
    : `https://api.github.com/repos/${spec.repo}/releases/latest`

  const response = await fetch(endpoint, { headers: githubHeaders() })
  if (!response.ok) {
    throw new Error(`GitHub release lookup failed (${response.status}): ${await response.text()}`)
  }

  const raw = (await response.json()) as unknown
  const parsed = GithubReleaseSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`GitHub release lookup returned invalid response payload: ${parsed.error.message}`)
  }

  return parsed.data
}

function githubHeaders(): HeadersInit {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (!token) {
    return {
      Accept: "application/vnd.github+json",
      "User-Agent": "opencode-plugin-manager",
    }
  }

  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "opencode-plugin-manager",
  }
}

async function materializeAsset(downloadPath: string, outputDir: string): Promise<void> {
  const lower = downloadPath.toLowerCase()
  if (lower.endsWith(".zip")) {
    await assertArchiveEntriesSafe(downloadPath, "zip")
    await runCommand({ command: "unzip", args: ["-q", downloadPath, "-d", outputDir] })
    return
  }
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    await assertArchiveEntriesSafe(downloadPath, "tar.gz")
    await runCommand({ command: "tar", args: ["-xzf", downloadPath, "-C", outputDir] })
    return
  }
  if (lower.endsWith(".tar")) {
    await assertArchiveEntriesSafe(downloadPath, "tar")
    await runCommand({ command: "tar", args: ["-xf", downloadPath, "-C", outputDir] })
    return
  }

  const target = path.join(outputDir, path.basename(downloadPath))
  await fs.copyFile(downloadPath, target)
}

async function assertArchiveEntriesSafe(downloadPath: string, format: "zip" | "tar.gz" | "tar"): Promise<void> {
  const command = format === "zip" ? "unzip" : "tar"
  const args =
    format === "zip" ? ["-Z1", downloadPath] : format === "tar.gz" ? ["-tzf", downloadPath] : ["-tf", downloadPath]

  const { stdout } = await runCommand({ command, args })
  for (const rawEntry of stdout.split(/\r?\n/)) {
    const entry = rawEntry.trim()
    if (!entry) continue
    if (isUnsafeArchiveEntry(entry)) {
      throw new Error(`Refusing to extract unsafe archive entry: ${entry}`)
    }
  }
}

function isUnsafeArchiveEntry(entry: string): boolean {
  if (entry.includes("\0")) return true

  const normalized = path.posix.normalize(entry.replace(/\\/g, "/"))
  if (normalized === ".." || normalized.startsWith("../")) return true
  if (path.posix.isAbsolute(normalized)) return true
  if (/^[a-zA-Z]:\//.test(normalized)) return true
  return false
}
