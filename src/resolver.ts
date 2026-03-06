import type { CacheContext } from "./cache"
import type { LockEntry, Lockfile, ManagedPluginSpec } from "./types"
import { exists } from "./util"
import { syncGitPlugin } from "./sources/git"
import { syncGithubReleasePlugin } from "./sources/github"
import { syncNpmPlugin } from "./sources/npm"
import { pluginDisplayName } from "./config"

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
  force?: boolean
}): Promise<SyncPluginsResult> {
  const { specs, cache, currentLock, force = false } = input
  const nextPlugins: Record<string, LockEntry> = {}

  const updated: string[] = []
  const reused: string[] = []
  const warnings: string[] = []

  for (const spec of specs) {
    const previous = currentLock.plugins[spec.id]
    if (!force && previous && (await exists(previous.resolvedPath))) {
      nextPlugins[spec.id] = previous
      reused.push(`${pluginDisplayName(spec)} (cached)`)
      continue
    }

    try {
      const synced = await syncSinglePlugin(spec, cache)
      nextPlugins[spec.id] = synced
      updated.push(pluginDisplayName(spec))
    } catch (error) {
      warnings.push(`[plugin-manager] Failed to sync ${pluginDisplayName(spec)}: ${String(error)}`)
      if (previous && (await exists(previous.resolvedPath))) {
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

export async function resolveCachedPluginPaths(specs: ManagedPluginSpec[], lockfile: Lockfile): Promise<LockEntry[]> {
  const entries: LockEntry[] = []

  for (const spec of specs) {
    const cached = lockfile.plugins[spec.id]
    if (!cached) continue
    if (!(await exists(cached.resolvedPath))) {
      console.warn(`[plugin-manager] Cached plugin missing on disk: ${pluginDisplayName(spec)}`)
      continue
    }
    entries.push(cached)
  }

  return entries
}

async function syncSinglePlugin(spec: ManagedPluginSpec, cache: CacheContext): Promise<LockEntry> {
  if (spec.source === "npm") return syncNpmPlugin(spec, cache)
  if (spec.source === "git") return syncGitPlugin(spec, cache)
  return syncGithubReleasePlugin(spec, cache)
}
