import { tool, type Hooks, type Plugin } from "@opencode-ai/plugin"
import { readLockfile, resolveCacheContext, withCacheLock, writeLockfile } from "./cache"
import { loadMergedConfig } from "./config"
import { loadManagedPlugins, mergeManagedHooks } from "./loader"
import { resolveCachedPluginPaths, syncPlugins } from "./resolver"

export const PluginManager: Plugin = async (input) => {
  let mergedConfig = await loadMergedConfig(input)
  let cache = resolveCacheContext(mergedConfig)

  const initialLockfile = await readLockfile(cache.lockfilePath)
  const initialEntries = await resolveCachedPluginPaths(mergedConfig.plugins, initialLockfile)
  let loaded = await loadManagedPlugins(initialEntries, input)

  const mergedHooks = mergeManagedHooks(() => loaded)

  const syncTool = tool({
    description: "Sync managed plugins from plugins.json into cache",
    args: {
      force: tool.schema.boolean().optional(),
    },
    execute: async ({ force }, context) => {
      context.metadata({ title: "Syncing managed plugins" })

      mergedConfig = await loadMergedConfig(input)
      cache = resolveCacheContext(mergedConfig)

      const result = await withCacheLock(cache, async () => {
        const current = await readLockfile(cache.lockfilePath)
        const synced = await syncPlugins({
          specs: mergedConfig.plugins,
          cache,
          currentLock: current,
          force,
        })
        await writeLockfile(cache.lockfilePath, synced.lockfile)
        return synced
      })

      for (const warning of result.warnings) {
        console.warn(warning)
      }

      const refreshedEntries = await resolveCachedPluginPaths(mergedConfig.plugins, result.lockfile)
      loaded = await loadManagedPlugins(refreshedEntries, input)

      const lines: string[] = []
      lines.push(`Synced ${result.updated.length} plugin(s).`)
      if (result.updated.length) lines.push(`Updated: ${result.updated.join(", ")}`)
      if (result.reused.length) lines.push(`Reused cache: ${result.reused.join(", ")}`)
      if (result.warnings.length) lines.push(`Warnings: ${result.warnings.length}`)
      lines.push("Restart opencode to register newly added tools/auth hooks.")

      return lines.join("\n")
    },
  })

  const tools: NonNullable<Hooks["tool"]> = {
    ...(mergedHooks.tool ?? {}),
    "plugin-manager.sync": syncTool,
  }

  return {
    ...mergedHooks,
    tool: tools,
    async config(config) {
      await mergedHooks.config?.(config)

      if (!mergedConfig.files.length) {
        console.info("[plugin-manager] No plugins.json found")
        return
      }
      if (!mergedConfig.plugins.length) {
        console.info("[plugin-manager] plugins.json found, but no plugins are configured")
        return
      }
      if (!loaded.length) {
        console.info("[plugin-manager] No cached plugins loaded. Run tool: plugin-manager.sync")
      }
    },
  }
}

export default PluginManager
