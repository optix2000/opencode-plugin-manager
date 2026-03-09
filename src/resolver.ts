import type { CacheContext } from "./cache"
import { createConsoleLogger, type Logger } from "./log"
import {
  exists,
  isTrustedLockEntryPath,
  pluginDisplayName,
  syncGitPlugin,
  syncLocalPlugin,
  syncNpmPlugin,
} from "./resolver.deps"
import type { LockEntry, Lockfile, ManagedPluginSpec } from "./types"
import semver from "semver"

export type SyncMode = "install" | "update"

export type SyncPluginsResult = {
  lockfile: Lockfile
  updated: string[]
  reused: string[]
  warnings: string[]
}

export async function syncPlugins(input: {
  specs: ManagedPluginSpec[]
  cache: CacheContext
  currentLock: Lockfile
  mode: SyncMode
  logger?: Logger
}): Promise<SyncPluginsResult> {
  const { specs, cache, currentLock, mode, logger } = input
  const activeLogger = logger ?? createConsoleLogger()
  const nextPlugins: Record<string, LockEntry> = {}

  const updated: string[] = []
  const reused: string[] = []
  const warnings: string[] = []

  activeLogger.info("Starting plugin sync", {
    mode,
    pluginCount: specs.length,
    cacheRoot: cache.rootDir,
  })

  for (const spec of specs) {
    const previous = currentLock.plugins[spec.id]
    const compatibleLock = previous && isCompatibleLock(spec, previous) ? previous : undefined
    const trustedCompatibleLock =
      compatibleLock && (await isTrustedLockEntryPath(cache, compatibleLock)) ? compatibleLock : undefined

    if (mode === "install" && trustedCompatibleLock) {
      nextPlugins[spec.id] = trustedCompatibleLock
      reused.push(`${pluginDisplayName(spec)} (cached)`)
      activeLogger.debug("Reusing trusted cached plugin", {
        pluginID: spec.id,
        resolvedPath: trustedCompatibleLock.resolvedPath,
      })
      continue
    }

    try {
      const synced = await syncSinglePlugin(spec, cache, compatibleLock, mode, activeLogger)
      nextPlugins[spec.id] = synced
      updated.push(`${pluginDisplayName(spec)} (${mode})`)
      activeLogger.debug("Plugin synced", {
        pluginID: spec.id,
        source: spec.source,
        mode,
      })
    } catch (error) {
      const warning = `[plugin-manager] Failed to sync ${pluginDisplayName(spec)}: ${String(error)}`
      warnings.push(warning)
      activeLogger.warn("Plugin sync failed", {
        pluginID: spec.id,
        source: spec.source,
        mode,
        error: String(error),
      })
      if (previous && isCompatibleLock(spec, previous) && (await isTrustedLockEntryPath(cache, previous))) {
        nextPlugins[spec.id] = previous
        reused.push(`${pluginDisplayName(spec)} (fallback cache)`)
        activeLogger.warn("Reusing previous trusted lock entry after sync failure", {
          pluginID: spec.id,
          resolvedPath: previous.resolvedPath,
        })
      }
    }
  }

  activeLogger.info("Completed plugin sync", {
    mode,
    updated: updated.length,
    reused: reused.length,
    warnings: warnings.length,
  })

  return {
    lockfile: {
      version: 1,
      plugins: nextPlugins,
    },
    updated,
    reused,
    warnings,
  }
}

export async function resolveCachedPluginPaths(
  specs: ManagedPluginSpec[],
  lockfile: Lockfile,
  cache: CacheContext,
  logger: Logger = createConsoleLogger(),
): Promise<LockEntry[]> {
  const entries: LockEntry[] = []

  for (const spec of specs) {
    const cached = lockfile.plugins[spec.id]
    if (!cached) continue
    if (!isCompatibleLock(spec, cached)) {
      logger.warn(`[plugin-manager] Ignoring incompatible lock entry for ${pluginDisplayName(spec)}`, {
        pluginID: spec.id,
      })
      continue
    }
    if (!(await exists(cached.resolvedPath))) {
      logger.warn(`[plugin-manager] Cached plugin missing on disk: ${pluginDisplayName(spec)}`, {
        pluginID: spec.id,
        resolvedPath: cached.resolvedPath,
      })
      continue
    }
    if (!(await isTrustedLockEntryPath(cache, cached))) {
      logger.warn(`[plugin-manager] Ignoring untrusted lock path for ${pluginDisplayName(spec)}: ${cached.resolvedPath}`, {
        pluginID: spec.id,
        resolvedPath: cached.resolvedPath,
      })
      continue
    }
    entries.push(cached)
  }

  return entries
}

async function syncSinglePlugin(
  spec: ManagedPluginSpec,
  cache: CacheContext,
  previous: LockEntry | undefined,
  mode: SyncMode,
  logger: Logger,
): Promise<LockEntry> {
  if (spec.source === "npm") {
    const lockedVersion = mode === "install" && previous?.source === "npm" ? previous.resolvedVersion : undefined
    return syncNpmPlugin(spec, cache, { lockedVersion }, logger)
  }

  if (spec.source === "git") {
    const lockedCommit = mode === "install" && previous?.source === "git" ? previous.commit : undefined
    return syncGitPlugin(spec, cache, { lockedCommit }, logger)
  }

  if (spec.source === "local") {
    return syncLocalPlugin(spec, logger)
  }

  const _exhaustive: never = spec
  throw new Error(`Unhandled plugin source in syncSinglePlugin: ${JSON.stringify(_exhaustive)}`)
}

function isCompatibleLock(spec: ManagedPluginSpec, entry: LockEntry): boolean {
  if (spec.source === "npm" && entry.source === "npm") {
    if (!spec.version) return true
    return semver.valid(entry.resolvedVersion)
      ? semver.satisfies(entry.resolvedVersion, spec.version, { includePrerelease: true })
      : entry.resolvedVersion === spec.version
  }

  if (spec.source === "git" && entry.source === "git") {
    if (!spec.ref) return true
    return entry.ref === spec.ref
  }

  if (spec.source === "local" && entry.source === "local") {
    return entry.path === spec.path && entry.entry === spec.entry
  }

  return false
}
