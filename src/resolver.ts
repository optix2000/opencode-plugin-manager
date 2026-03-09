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

  const settled = await Promise.allSettled(
    specs.map(async (spec) => {
      const previous = currentLock.plugins[spec.id]
      const compatibleLock = previous && isCompatibleLock(spec, previous) ? previous : undefined

      try {
        const trustedCompatibleLock =
          compatibleLock && (await isTrustedLockEntryPath(cache, compatibleLock)) ? compatibleLock : undefined

        if (mode === "install" && trustedCompatibleLock) {
          activeLogger.debug("Reusing trusted cached plugin", {
            pluginID: spec.id,
            resolvedPath: trustedCompatibleLock.resolvedPath,
          })
          return {
            entry: trustedCompatibleLock,
            reused: `${pluginDisplayName(spec)} (cached)`,
          }
        }

        const synced = await syncSinglePlugin(spec, cache, compatibleLock, mode, activeLogger)
        activeLogger.debug("Plugin synced", {
          pluginID: spec.id,
          source: spec.source,
          mode,
        })
        return {
          entry: synced,
          updated: `${pluginDisplayName(spec)} (${mode})`,
        }
      } catch (error) {
        const warning = `[plugin-manager] Failed to sync ${pluginDisplayName(spec)}: ${String(error)}`
        activeLogger.warn("Plugin sync failed", {
          pluginID: spec.id,
          source: spec.source,
          mode,
          error: String(error),
        })

        if (previous && isCompatibleLock(spec, previous) && (await isTrustedLockEntryPath(cache, previous))) {
          activeLogger.warn("Reusing previous trusted lock entry after sync failure", {
            pluginID: spec.id,
            resolvedPath: previous.resolvedPath,
          })
          return {
            entry: previous,
            reused: `${pluginDisplayName(spec)} (fallback cache)`,
            warning,
          }
        }

        return { warning }
      }
    }),
  )

  for (const [index, outcome] of settled.entries()) {
    const spec = specs[index]
    if (outcome.status === "fulfilled") {
      if (outcome.value.entry) {
        nextPlugins[spec.id] = outcome.value.entry
      }
      if (outcome.value.updated) {
        updated.push(outcome.value.updated)
      }
      if (outcome.value.reused) {
        reused.push(outcome.value.reused)
      }
      if (outcome.value.warning) {
        warnings.push(outcome.value.warning)
      }
      continue
    }

    const warning = `[plugin-manager] Failed to sync ${pluginDisplayName(spec)}: ${String(outcome.reason)}`
    warnings.push(warning)
    activeLogger.warn("Plugin sync failed", {
      pluginID: spec.id,
      source: spec.source,
      mode,
      error: String(outcome.reason),
    })

    const previous = currentLock.plugins[spec.id]
    if (previous && isCompatibleLock(spec, previous) && (await isTrustedLockEntryPath(cache, previous))) {
      nextPlugins[spec.id] = previous
      reused.push(`${pluginDisplayName(spec)} (fallback cache)`)
      activeLogger.warn("Reusing previous trusted lock entry after sync failure", {
        pluginID: spec.id,
        resolvedPath: previous.resolvedPath,
      })
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
