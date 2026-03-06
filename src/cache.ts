import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { MergedConfig } from "./config"
import { LockfileSchema, type LockEntry, type Lockfile } from "./types"
import { ensureDir, exists, expandHome, sanitizeSegment, sleep } from "./util"

const LOCKFILE_NAME = "plugins.lock.json"
const LOCK_MUTEX_NAME = ".manager.lock"
const DEFAULT_LOCK_TIMEOUT_MS = 30_000
const DEFAULT_LOCK_RETRY_MS = 125

export type CacheContext = {
  rootDir: string
  lockfilePath: string
  mutexPath: string
}

export function resolveCacheContext(config: MergedConfig): CacheContext {
  const configured = config.cacheDir
    ? path.resolve(config.cacheDirBase ?? process.cwd(), expandHome(config.cacheDir))
    : path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "opencode", "plugins")

  return {
    rootDir: configured,
    lockfilePath: path.join(configured, LOCKFILE_NAME),
    mutexPath: path.join(configured, LOCK_MUTEX_NAME),
  }
}

export async function readLockfile(lockfilePath: string): Promise<Lockfile> {
  if (!(await exists(lockfilePath))) {
    return { version: 1, plugins: {} }
  }

  try {
    const text = await fs.readFile(lockfilePath, "utf8")
    const value = JSON.parse(text) as unknown
    const parsed = LockfileSchema.safeParse(value)
    if (!parsed.success) {
      console.warn(`[plugin-manager] Invalid lockfile ${lockfilePath}: ${parsed.error.message}`)
      return { version: 1, plugins: {} }
    }
    return parsed.data
  } catch (error) {
    console.warn(`[plugin-manager] Failed to read lockfile ${lockfilePath}: ${String(error)}`)
    return { version: 1, plugins: {} }
  }
}

export async function writeLockfile(lockfilePath: string, lockfile: Lockfile): Promise<void> {
  await ensureDir(path.dirname(lockfilePath))
  const tempPath = `${lockfilePath}.${process.pid}.tmp`
  await fs.writeFile(tempPath, `${JSON.stringify(lockfile, null, 2)}\n`, "utf8")
  await fs.rename(tempPath, lockfilePath)
}

export async function withCacheLock<T>(
  cache: CacheContext,
  fn: () => Promise<T>,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
): Promise<T> {
  await ensureDir(cache.rootDir)

  const start = Date.now()
  while (true) {
    try {
      const handle = await fs.open(cache.mutexPath, "wx", 0o600)
      try {
        return await fn()
      } finally {
        await handle.close().catch(() => undefined)
        await fs.unlink(cache.mutexPath).catch(() => undefined)
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "EEXIST") throw error
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for cache lock: ${cache.mutexPath}`)
      }
      await sleep(DEFAULT_LOCK_RETRY_MS)
    }
  }
}

export async function listResolvedEntries(lockfile: Lockfile): Promise<LockEntry[]> {
  const entries = Object.values(lockfile.plugins)
  const existing: LockEntry[] = []
  for (const entry of entries) {
    if (await exists(entry.resolvedPath)) {
      existing.push(entry)
    }
  }
  return existing
}

export function sourceDir(cache: CacheContext, source: LockEntry["source"]): string {
  return path.join(cache.rootDir, source)
}

export function npmInstallDir(cache: CacheContext, name: string, resolvedVersion: string): string {
  return path.join(sourceDir(cache, "npm"), `${sanitizeSegment(name)}@${sanitizeSegment(resolvedVersion)}`)
}

export function gitInstallDir(cache: CacheContext, repo: string, commit: string): string {
  return path.join(sourceDir(cache, "git"), `${sanitizeSegment(repo)}-${sanitizeSegment(commit.slice(0, 12))}`)
}

export function githubInstallDir(cache: CacheContext, repo: string, tag: string): string {
  return path.join(sourceDir(cache, "github-release"), `${sanitizeSegment(repo)}-${sanitizeSegment(tag)}`)
}

export type CleanCacheResult = {
  removedPaths: string[]
}

export async function cleanCacheDirectories(cache: CacheContext, lockfile: Lockfile): Promise<CleanCacheResult> {
  const keep = new Set<string>()
  for (const entry of Object.values(lockfile.plugins)) {
    keep.add(path.resolve(installRootForEntry(cache, entry)))
  }

  const removedPaths: string[] = []
  for (const source of ["npm", "git", "github-release"] as const) {
    const root = sourceDir(cache, source)
    if (!(await exists(root))) continue

    const children = await fs.readdir(root, { withFileTypes: true })
    for (const child of children) {
      if (!child.isDirectory()) continue
      const childPath = path.resolve(path.join(root, child.name))
      if (keep.has(childPath)) continue

      await fs.rm(childPath, { recursive: true, force: true })
      removedPaths.push(childPath)
    }
  }

  return { removedPaths }
}

function installRootForEntry(cache: CacheContext, entry: LockEntry): string {
  if (entry.source === "npm") return npmInstallDir(cache, entry.name, entry.resolvedVersion)
  if (entry.source === "git") return gitInstallDir(cache, entry.repo, entry.commit)
  return githubInstallDir(cache, entry.repo, entry.tag)
}
