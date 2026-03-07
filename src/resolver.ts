import type { CacheContext } from "./cache"
import {
  exists,
  isTrustedLockEntryPath,
  pluginDisplayName,
  syncGitPlugin,
  syncGithubReleasePlugin,
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
}): Promise<SyncPluginsResult> {
  const { specs, cache, currentLock, mode } = input
  const nextPlugins: Record<string, LockEntry> = {}

  const updated: string[] = []
  const reused: string[] = []
  const warnings: string[] = []

  for (const spec of specs) {
    const previous = currentLock.plugins[spec.id]
    const compatibleLock = previous && isCompatibleLock(spec, previous) ? previous : undefined
    const trustedCompatibleLock =
      compatibleLock && (await isTrustedLockEntryPath(cache, compatibleLock)) ? compatibleLock : undefined

    if (mode === "install" && trustedCompatibleLock) {
      nextPlugins[spec.id] = trustedCompatibleLock
      reused.push(`${pluginDisplayName(spec)} (cached)`)
      continue
    }

    try {
      const synced = await syncSinglePlugin(spec, cache, compatibleLock, mode)
      nextPlugins[spec.id] = synced
      updated.push(`${pluginDisplayName(spec)} (${mode})`)
    } catch (error) {
      warnings.push(`[plugin-manager] Failed to sync ${pluginDisplayName(spec)}: ${String(error)}`)
      if (previous && isCompatibleLock(spec, previous) && (await isTrustedLockEntryPath(cache, previous))) {
        nextPlugins[spec.id] = previous
        reused.push(`${pluginDisplayName(spec)} (fallback cache)`)
      }
    }
  }

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
): Promise<LockEntry[]> {
  const entries: LockEntry[] = []

  for (const spec of specs) {
    const cached = lockfile.plugins[spec.id]
    if (!cached) continue
    if (!isCompatibleLock(spec, cached)) {
      console.warn(`[plugin-manager] Ignoring incompatible lock entry for ${pluginDisplayName(spec)}`)
      continue
    }
    if (!(await exists(cached.resolvedPath))) {
      console.warn(`[plugin-manager] Cached plugin missing on disk: ${pluginDisplayName(spec)}`)
      continue
    }
    if (!(await isTrustedLockEntryPath(cache, cached))) {
      console.warn(`[plugin-manager] Ignoring untrusted lock path for ${pluginDisplayName(spec)}: ${cached.resolvedPath}`)
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
): Promise<LockEntry> {
  if (spec.source === "npm") {
    const lockedVersion = mode === "install" && previous?.source === "npm" ? previous.resolvedVersion : undefined
    return syncNpmPlugin(spec, cache, { lockedVersion })
  }

  if (spec.source === "git") {
    const lockedCommit = mode === "install" && previous?.source === "git" ? previous.commit : undefined
    return syncGitPlugin(spec, cache, { lockedCommit })
  }

  if (spec.source === "local") {
    return syncLocalPlugin(spec)
  }

  const lockedTag = mode === "install" && previous?.source === "github-release" ? previous.tag : undefined
  const lockedAsset = mode === "install" && previous?.source === "github-release" ? previous.asset : undefined
  return syncGithubReleasePlugin(spec, cache, { lockedTag, lockedAsset })
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

  if (spec.source === "github-release" && entry.source === "github-release") {
    if (!spec.tag) return true
    return entry.tag === spec.tag
  }

  return false
}
