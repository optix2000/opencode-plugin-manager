import * as fs from "node:fs/promises"
import path from "node:path"
import type { Hooks, Plugin as PluginFactory, PluginInput } from "@opencode-ai/plugin"
import { pathToFileURL } from "node:url"
import type { CacheContext } from "./cache"
import { createConsoleLogger, type Logger } from "./log"
import { isTrustedLockEntryPath, sha256File } from "./loader.deps"
import type { LockEntry } from "./types"
import { sanitizeToolName } from "./util"

const LOCAL_RELOAD_COPY_MARKER = ".opm-reload-"
const localReloadCopyByPluginID = new Map<string, string>()

type LoadedPlugin = {
  id: string
  hooks: Hooks
}

export type LoadManagedPluginsOptions = {
  cacheBustLocal?: boolean
  cacheBustToken?: string
}

type NonTwoArgHook = "event" | "config" | "tool" | "auth"
type TwoArgHook = Exclude<keyof Hooks, NonTwoArgHook>

const TWO_ARG_HOOKS = {
  "chat.message": true,
  "chat.params": true,
  "chat.headers": true,
  "permission.ask": true,
  "command.execute.before": true,
  "tool.execute.before": true,
  "shell.env": true,
  "tool.execute.after": true,
  "experimental.chat.messages.transform": true,
  "experimental.chat.system.transform": true,
  "experimental.session.compacting": true,
  "experimental.text.complete": true,
  "tool.definition": true,
} satisfies Record<TwoArgHook, true>

export async function loadManagedPlugins(
  entries: LockEntry[],
  input: PluginInput,
  cache: CacheContext,
  logger: Logger = createConsoleLogger(),
  options: LoadManagedPluginsOptions = {},
): Promise<LoadedPlugin[]> {
  const loaded: LoadedPlugin[] = []

  const settled = await Promise.allSettled(
    entries.map(async (entry) => {
      if (!(await isTrustedLockEntryPath(cache, entry))) {
        logger.warn(`[plugin-manager] Skipping untrusted plugin path for ${entry.id}: ${entry.resolvedPath}`, {
          pluginID: entry.id,
          resolvedPath: entry.resolvedPath,
        })
        return undefined
      }

      if (entry.integrity) {
        const actualIntegrity = await sha256File(entry.resolvedPath).catch(() => undefined)
        if (actualIntegrity !== entry.integrity) {
          logger.warn(`[plugin-manager] Skipping plugin with integrity mismatch for ${entry.id}: ${entry.resolvedPath}`, {
            pluginID: entry.id,
            resolvedPath: entry.resolvedPath,
            expectedIntegrity: entry.integrity,
            actualIntegrity,
          })
          return undefined
        }
      }

      const moduleUrl = await moduleUrlForEntry(entry, options, logger)
      logger.debug("Loading managed plugin module", {
        pluginID: entry.id,
        moduleUrl,
      })
      const mod = (await import(moduleUrl)) as Record<string, unknown>
      const defaultExport = mod.default
      let pluginFactory: PluginFactory | undefined

      if (typeof defaultExport === "function") {
        pluginFactory = defaultExport as PluginFactory
      } else {
        const namedExports = Object.entries(mod).filter(([name]) => name !== "default")
        if (namedExports.length !== 1 || typeof namedExports[0][1] !== "function") {
          throw new Error(
            "Plugin module must export a default function or exactly one named function export",
          )
        }
        pluginFactory = namedExports[0][1] as PluginFactory
      }

      const hooks = await pluginFactory(input)
      logger.info("Managed plugin loaded", {
        pluginID: entry.id,
      })
      return {
        id: entry.id,
        hooks,
      }
    }),
  )

  for (const [index, outcome] of settled.entries()) {
    const entry = entries[index]
    if (outcome.status === "fulfilled") {
      if (outcome.value) {
        loaded.push(outcome.value)
      }
      continue
    }

    logger.warn(`[plugin-manager] Failed to load ${entry.id}: ${String(outcome.reason)}`, {
      pluginID: entry.id,
      error: String(outcome.reason),
    })
  }

  return loaded
}

async function moduleUrlForEntry(
  entry: LockEntry,
  options: LoadManagedPluginsOptions,
  logger: Logger,
): Promise<string> {
  const baseUrl = pathToFileURL(entry.resolvedPath).href
  if (!options.cacheBustLocal || entry.source !== "local") return baseUrl

  const token = options.cacheBustToken ?? String(Date.now())
  const reloadedPath = await createLocalReloadCopy(entry, token, logger)
  if (reloadedPath) return pathToFileURL(reloadedPath).href

  // Bun currently has no documented runtime API to invalidate the ESM module cache.
  // If creating a temporary on-disk copy fails (for example, a read-only plugin path),
  // we fall back to query-string cache busting. This relies on Bun treating
  // `file:///.../plugin.js?opm_reload=...` as a distinct module cache key.
  // If Bun ever changes this behavior, replace this fallback by importing from a
  // unique on-disk module path that preserves relative import resolution.
  const separator = baseUrl.includes("?") ? "&" : "?"
  return `${baseUrl}${separator}opm_reload=${encodeURIComponent(token)}`
}

async function createLocalReloadCopy(entry: LockEntry, token: string, logger: Logger): Promise<string | undefined> {
  const destinationPath = localReloadCopyPath(entry.resolvedPath, token)
  try {
    await fs.copyFile(entry.resolvedPath, destinationPath)
  } catch (error) {
    logger.warn(`[plugin-manager] Failed to create local reload copy for ${entry.id}: ${String(error)}`, {
      pluginID: entry.id,
      resolvedPath: entry.resolvedPath,
      destinationPath,
      error: String(error),
    })
    return undefined
  }

  const previousCopyPath = localReloadCopyByPluginID.get(entry.id)
  localReloadCopyByPluginID.set(entry.id, destinationPath)

  if (previousCopyPath && previousCopyPath !== destinationPath) {
    await fs.unlink(previousCopyPath).catch(() => undefined)
  }

  await cleanupStaleLocalReloadCopies(entry.resolvedPath, destinationPath)
  return destinationPath
}

function localReloadCopyPath(resolvedPath: string, token: string): string {
  const parsed = path.parse(resolvedPath)
  const safeToken = sanitizeReloadToken(token)
  return path.join(parsed.dir, `${parsed.name}${LOCAL_RELOAD_COPY_MARKER}${safeToken}${parsed.ext}`)
}

async function cleanupStaleLocalReloadCopies(resolvedPath: string, keepPath: string): Promise<void> {
  const parsed = path.parse(resolvedPath)
  const prefix = `${parsed.name}${LOCAL_RELOAD_COPY_MARKER}`
  const siblings = await fs.readdir(parsed.dir, { withFileTypes: true }).catch(() => [])

  for (const sibling of siblings) {
    if (!sibling.isFile()) continue
    if (!sibling.name.startsWith(prefix)) continue
    if (parsed.ext && !sibling.name.endsWith(parsed.ext)) continue

    const siblingPath = path.join(parsed.dir, sibling.name)
    if (siblingPath === keepPath) continue
    await fs.unlink(siblingPath).catch(() => undefined)
  }
}

function sanitizeReloadToken(token: string): string {
  const safe = token.replace(/[^a-zA-Z0-9._-]/g, "_")
  return safe || String(Date.now())
}

export type MergedManagedHooks = {
  hooks: Hooks
  collectTools: () => NonNullable<Hooks["tool"]>
  collectAuth: () => Hooks["auth"]
}

export function mergeManagedHooks(getLoaded: () => LoadedPlugin[], logger: Logger = createConsoleLogger()): MergedManagedHooks {
  const hooks: Hooks = {}

  hooks.event = async (input) => {
    for (const plugin of getLoaded()) {
      try {
        await plugin.hooks.event?.(input)
      } catch (error) {
        logger.warn(`[plugin-manager] Hook event failed in ${plugin.id}: ${String(error)}`, { hook: "event", pluginID: plugin.id })
      }
    }
  }

  hooks.config = async (input) => {
    for (const plugin of getLoaded()) {
      try {
        await plugin.hooks.config?.(input)
      } catch (error) {
        logger.warn(`[plugin-manager] Hook config failed in ${plugin.id}: ${String(error)}`, { hook: "config", pluginID: plugin.id })
      }
    }
  }

  for (const hookName of Object.keys(TWO_ARG_HOOKS) as TwoArgHook[]) {
    const fn = async (input: unknown, output: unknown) => {
      for (const plugin of getLoaded()) {
        const hook = plugin.hooks[hookName]
        if (!hook) continue
        try {
          await (hook as (input: unknown, output: unknown) => Promise<void>)(input, output)
        } catch (error) {
          logger.warn(`[plugin-manager] Hook ${hookName} failed in ${plugin.id}: ${String(error)}`, {
            hook: hookName,
            pluginID: plugin.id,
          })
        }
      }
    }

    ;(hooks as Record<string, unknown>)[hookName] = fn
  }

  const collectTools = (): NonNullable<Hooks["tool"]> => {
    const tools: NonNullable<Hooks["tool"]> = {}
    for (const plugin of getLoaded()) {
      if (!plugin.hooks.tool) continue
      for (const [name, definition] of Object.entries(plugin.hooks.tool)) {
        const sanitizedName = sanitizeToolName(name)
        if (sanitizedName !== name) {
          logger.warn(`[plugin-manager] Sanitized invalid tool name '${name}' -> '${sanitizedName}'`, {
            pluginID: plugin.id,
            originalName: name,
            sanitizedName,
          })
        }

        if (tools[sanitizedName]) {
          logger.warn(`[plugin-manager] Tool collision for '${sanitizedName}', overriding with ${plugin.id}`, {
            toolName: sanitizedName,
            pluginID: plugin.id,
          })
        }
        tools[sanitizedName] = definition
      }
    }
    return tools
  }

  const collectAuth = (): Hooks["auth"] => {
    let auth: Hooks["auth"]
    for (const plugin of getLoaded()) {
      if (!plugin.hooks.auth) continue
      if (auth) {
        logger.warn(`[plugin-manager] Auth hook collision, overriding with ${plugin.id}`, { pluginID: plugin.id })
      }
      auth = plugin.hooks.auth
    }
    return auth
  }

  return { hooks, collectTools, collectAuth }
}
