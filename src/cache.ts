import os from "node:os"
import path from "node:path"
import type { MergedConfig } from "./config"
import type { Logger } from "./log"
import { CACHEABLE_LOCK_ENTRY_SOURCES, LockfileSchema, type LockEntry, type Lockfile } from "./types"
import { ensureDir, exists, expandHome, fs, sanitizeSegment, sleep } from "./cache.deps"
import { createConsoleLogger } from "./log"

const LOCKFILE_NAME = "plugins.lock.json"
const LOCK_MUTEX_NAME = ".manager.lock"
const DEFAULT_LOCK_TIMEOUT_MS = 30_000
const DEFAULT_LOCK_RETRY_MS = 125
const LOCK_STALE_AFTER_MS = 5 * 60_000

type LockMetadata = {
  pid: number
  createdAt: number
  host?: string
}

export type CacheContext = {
  rootDir: string
  lockfilePath: string
  mutexPath: string
}

export function resolveCacheContext(config: MergedConfig): CacheContext {
  const configured = config.cacheDir
    ? path.resolve(config.cacheDirBase ?? process.cwd(), expandHome(config.cacheDir))
    : path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "opencode", "opm")

  return {
    rootDir: configured,
    lockfilePath: path.join(configured, LOCKFILE_NAME),
    mutexPath: path.join(configured, LOCK_MUTEX_NAME),
  }
}

export async function readLockfile(lockfilePath: string, logger: Logger = createConsoleLogger()): Promise<Lockfile> {
  if (!(await exists(lockfilePath))) {
    return { version: 1, plugins: {} }
  }

  try {
    const text = await fs.readFile(lockfilePath, "utf8")
    const value = JSON.parse(text) as unknown
    const parsed = LockfileSchema.safeParse(value)
    if (!parsed.success) {
      logger.warn("Invalid lockfile; ignoring and continuing", {
        lockfilePath,
        error: parsed.error.message,
      })
      return { version: 1, plugins: {} }
    }
    return parsed.data
  } catch (error) {
    logger.warn("Failed to read lockfile; ignoring and continuing", {
      lockfilePath,
      error: String(error),
    })
    return { version: 1, plugins: {} }
  }
}

export async function writeLockfile(lockfilePath: string, lockfile: Lockfile): Promise<void> {
  await ensureDir(path.dirname(lockfilePath))
  const tempPath = `${lockfilePath}.${process.pid}.tmp`
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(lockfile, null, 2)}\n`, "utf8")
    await fs.rename(tempPath, lockfilePath)
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined)
    throw error
  }
}

export async function withCacheLock<T>(
  cache: CacheContext,
  fn: () => Promise<T>,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  logger: Logger = createConsoleLogger(),
): Promise<T> {
  await ensureDir(cache.rootDir)
  logger.debug("Acquiring cache lock", {
    rootDir: cache.rootDir,
    mutexPath: cache.mutexPath,
    timeoutMs,
  })

  const start = Date.now()
  while (true) {
    try {
      const handle = await fs.open(cache.mutexPath, "wx", 0o600)
      logger.debug("Cache lock acquired", {
        mutexPath: cache.mutexPath,
      })

      const lockMetadata: LockMetadata = {
        pid: process.pid,
        createdAt: Date.now(),
        host: os.hostname(),
      }
      await fs.writeFile(cache.mutexPath, `${JSON.stringify(lockMetadata)}\n`, "utf8").catch(() => undefined)

      try {
        return await fn()
      } finally {
        await handle.close().catch(() => undefined)
        await fs.unlink(cache.mutexPath).catch(() => undefined)
        logger.debug("Cache lock released", {
          mutexPath: cache.mutexPath,
        })
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "EEXIST") throw error

      if (await reclaimStaleLock(cache, logger)) {
        continue
      }

      if (Date.now() - start > timeoutMs) {
        logger.error("Timed out waiting for cache lock", {
          mutexPath: cache.mutexPath,
          timeoutMs,
        })
        throw new Error(`Timed out waiting for cache lock: ${cache.mutexPath}`)
      }
      await sleep(DEFAULT_LOCK_RETRY_MS)
    }
  }
}

async function reclaimStaleLock(cache: CacheContext, logger: Logger): Promise<boolean> {
  const metadata = await readLockMetadata(cache.mutexPath)
  if (metadata) {
    if (isProcessAlive(metadata.pid)) {
      return false
    }

    logger.warn("Reclaiming stale cache lock from dead process", {
      mutexPath: cache.mutexPath,
      pid: metadata.pid,
      createdAt: metadata.createdAt,
      host: metadata.host,
    })
    return await unlinkIfPresent(cache.mutexPath)
  }

  const stat = await fs.stat(cache.mutexPath).catch(() => undefined)
  if (!stat || typeof stat.mtimeMs !== "number" || !Number.isFinite(stat.mtimeMs)) {
    return false
  }

  const ageMs = Date.now() - stat.mtimeMs
  if (ageMs < LOCK_STALE_AFTER_MS) {
    return false
  }

  logger.warn("Reclaiming stale cache lock with unknown owner", {
    mutexPath: cache.mutexPath,
    ageMs,
  })
  return await unlinkIfPresent(cache.mutexPath)
}

async function readLockMetadata(mutexPath: string): Promise<LockMetadata | undefined> {
  try {
    const text = await fs.readFile(mutexPath, "utf8")
    const parsed = JSON.parse(text) as Partial<LockMetadata>
    const pid = parsed.pid
    const createdAt = parsed.createdAt
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined
    if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return undefined
    return {
      pid,
      createdAt,
      ...(typeof parsed.host === "string" ? { host: parsed.host } : {}),
    }
  } catch {
    return undefined
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true

  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code !== "ESRCH"
  }
}

async function unlinkIfPresent(targetPath: string): Promise<boolean> {
  try {
    await fs.unlink(targetPath)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return false
    throw error
  }
}

export async function isTrustedLockEntryPath(cache: CacheContext, entry: LockEntry): Promise<boolean> {
  if (!(await exists(entry.resolvedPath))) return false

  const resolvedPath = await canonicalPath(entry.resolvedPath)

  if (entry.source === "local") {
    const localRoot = await canonicalPath(entry.path)
    const localStat = await fs.stat(localRoot).catch(() => undefined)
    if (!localStat) return false
    if (localStat.isFile()) return resolvedPath === localRoot
    if (!localStat.isDirectory()) return false
    return isPathInside(localRoot, resolvedPath)
  }

  const installRoot = installRootForEntry(cache, entry)
  if (!installRoot) return false

  const trustedRoot = await canonicalPath(installRoot)
  return isPathInside(trustedRoot, resolvedPath)
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

export type CleanCacheResult = {
  removedPaths: string[]
}

export async function cleanCacheDirectories(
  cache: CacheContext,
  lockfile: Lockfile,
  logger: Logger = createConsoleLogger(),
): Promise<CleanCacheResult> {
  const keep = new Set<string>()
  for (const entry of Object.values(lockfile.plugins)) {
    const installRoot = installRootForEntry(cache, entry)
    if (!installRoot) continue
    keep.add(path.resolve(installRoot))
  }

  const removedPaths: string[] = []
  for (const source of CACHEABLE_LOCK_ENTRY_SOURCES) {
    const root = sourceDir(cache, source)
    if (!(await exists(root))) continue

    const children = await fs.readdir(root, { withFileTypes: true })
    for (const child of children) {
      if (!child.isDirectory()) continue
      const childPath = path.resolve(path.join(root, child.name))
      if (keep.has(childPath)) continue

      await fs.rm(childPath, { recursive: true, force: true })
      removedPaths.push(childPath)
      logger.debug("Removed stale cached plugin directory", {
        path: childPath,
      })
    }
  }

  if (await exists(cache.rootDir)) {
    const rootChildren = await fs.readdir(cache.rootDir, { withFileTypes: true })
    for (const child of rootChildren) {
      if (!child.isDirectory()) continue
      if (!child.name.startsWith(".tmp-npm-") && !child.name.startsWith(".tmp-git-")) continue

      const childPath = path.resolve(path.join(cache.rootDir, child.name))
      await fs.rm(childPath, { recursive: true, force: true })
      removedPaths.push(childPath)
      logger.debug("Removed stale temporary cache directory", {
        path: childPath,
      })
    }
  }

  return { removedPaths }
}

function installRootForEntry(cache: CacheContext, entry: LockEntry): string | undefined {
  if (entry.source === "npm") return npmInstallDir(cache, entry.name, entry.resolvedVersion)
  if (entry.source === "git") return gitInstallDir(cache, entry.repo, entry.commit)
  return undefined
}

async function canonicalPath(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath)
  return (await fs.realpath(resolved).catch(() => undefined)) ?? resolved
}

function isPathInside(rootDir: string, candidatePath: string): boolean {
  const relative = path.relative(rootDir, candidatePath)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}
