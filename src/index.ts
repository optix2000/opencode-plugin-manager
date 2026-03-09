import type { Plugin, ToolContext } from "@opencode-ai/plugin"
import semver from "semver"
import { createNoopLogger, createOpencodeLogger } from "./log"
import {
  cleanCacheDirectories,
  exists,
  fs,
  loadManagedPlugins,
  loadMergedConfig,
  mergeManagedHooks,
  readLockfile,
  resolveCacheContext,
  resolveCachedPluginPaths,
  syncPlugins,
  tool,
  withCacheLock,
  writeLockfile,
} from "./index.deps"
import type { SyncMode } from "./resolver"
import type { Lockfile } from "./types"

const NPM_REGISTRY_TIMEOUT_MS = 10_000

export const PluginManager: Plugin = async (input) => {
  const logger = createOpencodeLogger(input.client as any, "plugin-manager", createNoopLogger())
  const TOOL_IDS = {
    install: "opm_install",
    update: "opm_update",
    clean: "opm_clean",
    sync: "opm_sync",
    selfUpdate: "opm_self_update",
  } as const

  logger.info("Initializing plugin manager", {
    directory: input.directory,
    worktree: input.worktree,
  })

  let reloadNonce = 0
  let mergedConfig = await loadMergedConfig(input, logger)
  let cache = resolveCacheContext(mergedConfig)

  const initialLockfile = await readLockfile(cache.lockfilePath, logger)
  const initialEntries = await resolveCachedPluginPaths(mergedConfig.plugins, initialLockfile, cache, logger)
  let loaded = await loadManagedPlugins(initialEntries, input, cache, logger, nextReloadOptions("startup"))

  const managed = mergeManagedHooks(() => loaded, logger)

  const installTool = tool({
    description: "Install managed plugins without advancing locked versions",
    args: {},
    execute: async (_, context) => runInstallOrUpdate("install", context),
  })

  const updateTool = tool({
    description: "Update managed plugins to newest versions matching constraints",
    args: {},
    execute: async (_, context) => runInstallOrUpdate("update", context),
  })

  const cleanTool = tool({
    description: "Remove cached plugin versions not referenced by the current config",
    args: {},
    execute: async (_, context) => runClean(context),
  })

  const syncTool = tool({
    description: "Install plugins and then clean stale cached versions",
    args: {},
    execute: async (_, context) => runInstallThenClean(context),
  })

  const selfUpdateTool = tool({
    description: "Check whether opencode-plugin-manager has a newer release",
    args: {},
    execute: async (_, context) => {
      context.metadata({ title: "Checking plugin manager updates" })
      logger.info("Running plugin manager tool", {
        tool: TOOL_IDS.selfUpdate,
      })
      const currentVersion = await getCurrentPluginManagerVersion()
      const latestVersion = await getLatestRegistryVersion()

      if (!currentVersion || !latestVersion) {
        logger.warn("Unable to determine plugin manager versions", {
          currentVersion,
          latestVersion,
        })
        return "Unable to determine current or latest opencode-plugin-manager version."
      }

      if (!semver.gt(latestVersion, currentVersion)) {
        logger.info("Plugin manager already up to date", {
          currentVersion,
        })
        return `opencode-plugin-manager is up to date (${currentVersion}).`
      }

      logger.info("Plugin manager update available", {
        currentVersion,
        latestVersion,
      })

      return [
        `Update available: ${currentVersion} -> ${latestVersion}`,
        "Update your opencode plugin entry in opencode.json, for example:",
        '"plugin": ["opencode-plugin-manager@' + latestVersion + '"]',
        "Then restart opencode.",
      ].join("\n")
    },
  })

  return {
    ...managed.hooks,
    get auth() {
      return managed.collectAuth()
    },
    get tool() {
      return {
        ...managed.collectTools(),
        [TOOL_IDS.install]: installTool,
        [TOOL_IDS.update]: updateTool,
        [TOOL_IDS.clean]: cleanTool,
        [TOOL_IDS.sync]: syncTool,
        [TOOL_IDS.selfUpdate]: selfUpdateTool,
      }
    },
    async config(config) {
      await managed.hooks.config?.(config)

      if (!mergedConfig.files.length) {
        logger.info("[plugin-manager] No plugins.json found")
        return
      }
      if (!mergedConfig.plugins.length) {
        logger.info("[plugin-manager] plugins.json found, but no plugins are configured")
        return
      }
      if (!loaded.length) {
        logger.info(`[plugin-manager] No cached plugins loaded. Run tool: ${TOOL_IDS.install}`)
      }
    },
  }

  async function runInstallOrUpdate(mode: SyncMode, context: ToolContext): Promise<string> {
    const title = mode === "install" ? "Installing managed plugins" : "Updating managed plugins"
    context.metadata({ title })
    logger.info("Running plugin manager tool", {
      tool: mode === "install" ? TOOL_IDS.install : TOOL_IDS.update,
      mode,
    })

    mergedConfig = await loadMergedConfig(input, logger)
    cache = resolveCacheContext(mergedConfig)
    let previousLock: Lockfile = { version: 1, plugins: {} }

    const result = await withCacheLock(cache, async () => {
      const current = await readLockfile(cache.lockfilePath, logger)
      previousLock = current
      const synced = await syncPlugins({
        specs: mergedConfig.plugins,
        cache,
        currentLock: current,
        mode,
        logger,
      })
      await writeLockfile(cache.lockfilePath, synced.lockfile)
      return synced
    }, undefined, logger)

    for (const warning of result.warnings) {
      logger.warn(warning)
    }

    const refreshedEntries = await resolveCachedPluginPaths(mergedConfig.plugins, result.lockfile, cache, logger)
    loaded = await loadManagedPlugins(refreshedEntries, input, cache, logger, nextReloadOptions(`tool:${mode}`))

    const lines: string[] = []
    const verb = mode === "install" ? "Installed" : "Updated"
    lines.push(`${verb} ${result.updated.length} plugin(s).`)
    if (result.updated.length) lines.push(`${verb}: ${result.updated.join(", ")}`)
    if (result.reused.length) lines.push(`Reused cache: ${result.reused.join(", ")}`)
    if (result.warnings.length) lines.push(`Warnings: ${result.warnings.length}`)
    if (mergedConfig.plugins.length) {
      lines.push("State transitions:")
      for (const spec of mergedConfig.plugins) {
        const previous = describeLockState(previousLock.plugins[spec.id])
        const next = describeLockState(result.lockfile.plugins[spec.id])
        lines.push(`${spec.id}: ${previous} -> ${next}`)
      }
    }
    lines.push("Restart opencode to register newly added tools/auth hooks.")

    logger.info("Completed plugin manager tool", {
      tool: mode === "install" ? TOOL_IDS.install : TOOL_IDS.update,
      updated: result.updated.length,
      reused: result.reused.length,
      warnings: result.warnings.length,
    })

    return lines.join("\n")
  }

  async function runClean(context: ToolContext): Promise<string> {
    context.metadata({ title: "Cleaning managed plugin cache" })
    logger.info("Running plugin manager tool", {
      tool: TOOL_IDS.clean,
    })

    mergedConfig = await loadMergedConfig(input, logger)
    cache = resolveCacheContext(mergedConfig)

    const result = await withCacheLock(cache, async () => {
      const current = await readLockfile(cache.lockfilePath, logger)
      const configuredIDs = new Set(mergedConfig.plugins.map((plugin) => plugin.id))
      const pruned = await pruneLockfile(current, configuredIDs)
      const cleaned = await cleanCacheDirectories(cache, pruned.lockfile, logger)
      await writeLockfile(cache.lockfilePath, pruned.lockfile)
      return {
        lockfile: pruned.lockfile,
        prunedIDs: pruned.prunedIDs,
        removedPaths: cleaned.removedPaths,
      }
    }, undefined, logger)

    const refreshedEntries = await resolveCachedPluginPaths(mergedConfig.plugins, result.lockfile, cache, logger)
    loaded = await loadManagedPlugins(refreshedEntries, input, cache, logger, nextReloadOptions("tool:clean"))

    const lines: string[] = []
    lines.push(`Removed ${result.removedPaths.length} cached plugin directory(s).`)
    if (result.prunedIDs.length) lines.push(`Pruned lock entries: ${result.prunedIDs.join(", ")}`)
    if (result.removedPaths.length) lines.push(`Removed: ${result.removedPaths.join(", ")}`)
    logger.info("Completed plugin manager tool", {
      tool: TOOL_IDS.clean,
      removedPaths: result.removedPaths.length,
      prunedIDs: result.prunedIDs.length,
    })
    return lines.join("\n")
  }

  async function runInstallThenClean(context: ToolContext): Promise<string> {
    context.metadata({ title: "Syncing managed plugins" })
    logger.info("Running plugin manager tool", {
      tool: TOOL_IDS.sync,
    })
    const installOutput = await runInstallOrUpdate("install", context)
    const cleanOutput = await runClean(context)
    logger.info("Completed plugin manager tool", {
      tool: TOOL_IDS.sync,
    })
    return [installOutput, "", cleanOutput].join("\n")
  }

  function nextReloadOptions(reason: string) {
    reloadNonce += 1
    return {
      cacheBustLocal: true,
      cacheBustToken: `${Date.now()}-${reloadNonce}-${reason}`,
    }
  }
}

export default PluginManager

function describeLockState(entry: Lockfile["plugins"][string] | undefined): string {
  if (!entry) {
    return "not installed"
  }

  if (entry.source === "npm") {
    return `npm:${entry.name}@${entry.resolvedVersion}`
  }

  if (entry.source === "git") {
    const ref = entry.ref ? `#${entry.ref}` : ""
    return `git:${entry.repo}${ref}@${entry.commit}`
  }

  if (entry.source === "local") {
    return `local:${entry.resolvedPath}`
  }

  const _exhaustive: never = entry
  throw new Error(`Unhandled lock entry source in describeLockState: ${JSON.stringify(_exhaustive)}`)
}

async function getCurrentPluginManagerVersion(): Promise<string | undefined> {
  try {
    const packageJsonPath = new URL("../package.json", import.meta.url)
    const text = await fs.readFile(packageJsonPath, "utf8")
    const json = JSON.parse(text) as { version?: string }
    return json.version
  } catch {
    return undefined
  }
}

async function getLatestRegistryVersion(): Promise<string | undefined> {
  try {
    const response = await fetch("https://registry.npmjs.org/opencode-plugin-manager/latest", {
      signal: AbortSignal.timeout(NPM_REGISTRY_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const payload = (await response.json()) as { version?: string }
    return payload.version
  } catch {
    return undefined
  }
}

async function pruneLockfile(
  current: Lockfile,
  configuredIDs: Set<string>,
): Promise<{ lockfile: Lockfile; prunedIDs: string[] }> {
  const prunedIDs: string[] = []
  const next: Lockfile["plugins"] = {}

  for (const [id, entry] of Object.entries(current.plugins)) {
    if (!configuredIDs.has(id)) {
      prunedIDs.push(id)
      continue
    }
    if (!(await exists(entry.resolvedPath))) {
      prunedIDs.push(id)
      continue
    }
    next[id] = entry
  }

  return {
    lockfile: {
      version: 1,
      plugins: next,
    },
    prunedIDs,
  }
}
