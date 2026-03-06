import { tool, type Hooks, type Plugin, type ToolContext } from "@opencode-ai/plugin"
import { readLockfile, resolveCacheContext, withCacheLock, writeLockfile } from "./cache"
import { loadMergedConfig } from "./config"
import { loadManagedPlugins, mergeManagedHooks } from "./loader"
import { resolveCachedPluginPaths, syncPlugins, type SyncMode } from "./resolver"
import fs from "node:fs/promises"

export const PluginManager: Plugin = async (input) => {
  let mergedConfig = await loadMergedConfig(input)
  let cache = resolveCacheContext(mergedConfig)

  const initialLockfile = await readLockfile(cache.lockfilePath)
  const initialEntries = await resolveCachedPluginPaths(mergedConfig.plugins, initialLockfile)
  let loaded = await loadManagedPlugins(initialEntries, input)

  const mergedHooks = mergeManagedHooks(() => loaded)

  const installTool = tool({
    description: "Install managed plugins without advancing locked versions",
    args: {},
    execute: async (_, context) => runSync("install", context),
  })

  const updateTool = tool({
    description: "Update managed plugins to newest versions matching constraints",
    args: {},
    execute: async (_, context) => runSync("update", context),
  })

  const selfUpdateTool = tool({
    description: "Check whether opencode-plugin-manager has a newer release",
    args: {},
    execute: async (_, context) => {
      context.metadata({ title: "Checking plugin manager updates" })
      const currentVersion = await getCurrentPluginManagerVersion()
      const latestVersion = await getLatestRegistryVersion()

      if (!currentVersion || !latestVersion) {
        return "Unable to determine current or latest opencode-plugin-manager version."
      }

      if (!isSemverGreater(latestVersion, currentVersion)) {
        return `opencode-plugin-manager is up to date (${currentVersion}).`
      }

      return [
        `Update available: ${currentVersion} -> ${latestVersion}`,
        "Update your opencode plugin entry in opencode.json, for example:",
        '"plugin": ["opencode-plugin-manager@' + latestVersion + '"]',
        "Then restart opencode.",
      ].join("\n")
    },
  })

  const tools: NonNullable<Hooks["tool"]> = {
    ...(mergedHooks.tool ?? {}),
    "opm.install": installTool,
    "opm.update": updateTool,
    "opm.self-update": selfUpdateTool,
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
        console.info("[plugin-manager] No cached plugins loaded. Run tool: opm.install")
      }
    },
  }

  async function runSync(mode: SyncMode, context: ToolContext): Promise<string> {
    const title = mode === "install" ? "Installing managed plugins" : "Updating managed plugins"
    context.metadata({ title })

    mergedConfig = await loadMergedConfig(input)
    cache = resolveCacheContext(mergedConfig)

    const result = await withCacheLock(cache, async () => {
      const current = await readLockfile(cache.lockfilePath)
      const synced = await syncPlugins({
        specs: mergedConfig.plugins,
        cache,
        currentLock: current,
        mode,
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
    const verb = mode === "install" ? "Installed" : "Updated"
    lines.push(`${verb} ${result.updated.length} plugin(s).`)
    if (result.updated.length) lines.push(`${verb}: ${result.updated.join(", ")}`)
    if (result.reused.length) lines.push(`Reused cache: ${result.reused.join(", ")}`)
    if (result.warnings.length) lines.push(`Warnings: ${result.warnings.length}`)
    lines.push("Restart opencode to register newly added tools/auth hooks.")

    return lines.join("\n")
  }
}

export default PluginManager

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
    const response = await fetch("https://registry.npmjs.org/opencode-plugin-manager/latest")
    if (!response.ok) return undefined
    const payload = (await response.json()) as { version?: string }
    return payload.version
  } catch {
    return undefined
  }
}

function isSemverGreater(nextVersion: string, currentVersion: string): boolean {
  const next = parseSemver(nextVersion)
  const current = parseSemver(currentVersion)
  if (!next || !current) return nextVersion !== currentVersion

  if (next.major !== current.major) return next.major > current.major
  if (next.minor !== current.minor) return next.minor > current.minor
  if (next.patch !== current.patch) return next.patch > current.patch

  return false
}

function parseSemver(value: string): { major: number; minor: number; patch: number } | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim())
  if (!match) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}
