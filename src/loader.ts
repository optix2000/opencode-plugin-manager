import type { Hooks, Plugin as PluginFactory, PluginInput } from "@opencode-ai/plugin"
import { pathToFileURL } from "node:url"
import type { CacheContext } from "./cache"
import { createConsoleLogger, type Logger } from "./log"
import { isTrustedLockEntryPath } from "./loader.deps"
import type { LockEntry } from "./types"
import { sanitizeToolName } from "./util"

type LoadedPlugin = {
  id: string
  hooks: Hooks
}

export type LoadManagedPluginsOptions = {
  cacheBustLocal?: boolean
  cacheBustToken?: string
}

const TWO_ARG_HOOKS: (keyof Hooks)[] = [
  "chat.message",
  "chat.params",
  "chat.headers",
  "permission.ask",
  "command.execute.before",
  "tool.execute.before",
  "shell.env",
  "tool.execute.after",
  "experimental.chat.messages.transform",
  "experimental.chat.system.transform",
  "experimental.session.compacting",
  "experimental.text.complete",
  "tool.definition",
]

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
      const moduleUrl = moduleUrlForEntry(entry, options)
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

function moduleUrlForEntry(entry: LockEntry, options: LoadManagedPluginsOptions): string {
  const baseUrl = pathToFileURL(entry.resolvedPath).href
  if (!options.cacheBustLocal || entry.source !== "local") return baseUrl

  const token = options.cacheBustToken ?? String(Date.now())
  const separator = baseUrl.includes("?") ? "&" : "?"
  return `${baseUrl}${separator}opm_reload=${encodeURIComponent(token)}`
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

  for (const hookName of TWO_ARG_HOOKS) {
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
