import fs from "node:fs/promises"
import path from "node:path"
import type { CacheContext } from "../cache"
import { githubInstallDir } from "../cache"
import type { LockEntry, ManagedPluginSpec } from "../types"
import { ensureDir, exists, runCommand, sha256File } from "../util"
import { resolvePluginEntry } from "./shared"

type GithubSpec = Extract<ManagedPluginSpec, { source: "github-release" }>

type GithubRelease = {
  tag_name: string
  assets: {
    name: string
    browser_download_url: string
  }[]
}

export async function syncGithubReleasePlugin(spec: GithubSpec, cache: CacheContext): Promise<LockEntry> {
  const release = await fetchRelease(spec)
  const tag = release.tag_name
  const asset = selectAsset(release, spec.asset)

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

async function fetchRelease(spec: GithubSpec): Promise<GithubRelease> {
  const endpoint = spec.tag
    ? `https://api.github.com/repos/${spec.repo}/releases/tags/${encodeURIComponent(spec.tag)}`
    : `https://api.github.com/repos/${spec.repo}/releases/latest`

  const response = await fetch(endpoint, { headers: githubHeaders() })
  if (!response.ok) {
    throw new Error(`GitHub release lookup failed (${response.status}): ${await response.text()}`)
  }

  return (await response.json()) as GithubRelease
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
    await runCommand({ command: "unzip", args: ["-q", downloadPath, "-d", outputDir] })
    return
  }
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    await runCommand({ command: "tar", args: ["-xzf", downloadPath, "-C", outputDir] })
    return
  }
  if (lower.endsWith(".tar")) {
    await runCommand({ command: "tar", args: ["-xf", downloadPath, "-C", outputDir] })
    return
  }

  const target = path.join(outputDir, path.basename(downloadPath))
  await fs.copyFile(downloadPath, target)
}
