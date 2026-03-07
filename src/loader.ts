import type { Hooks, Plugin as PluginFactory, PluginInput } from "@opencode-ai/plugin"
import { pathToFileURL } from "node:url"
import type { LockEntry } from "./types"
import { isTrustedLockEntryPath, type CacheContext } from "./cache"

type LoadedPlugin = {
  id: string
  hooks: Hooks
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
): Promise<LoadedPlugin[]> {
  const loaded: LoadedPlugin[] = []

  for (const entry of entries) {
    try {
      if (!(await isTrustedLockEntryPath(cache, entry))) {
        console.warn(`[plugin-manager] Skipping untrusted plugin path for ${entry.id}: ${entry.resolvedPath}`)
        continue
      }
      const moduleUrl = pathToFileURL(entry.resolvedPath).href
      const mod = (await import(moduleUrl)) as Record<string, unknown>
      const seen = new Set<PluginFactory>()

      for (const exported of Object.values(mod)) {
        if (typeof exported !== "function") continue
        const pluginFactory = exported as PluginFactory
        if (seen.has(pluginFactory)) continue
        seen.add(pluginFactory)

        const hooks = await pluginFactory(input)
        loaded.push({
          id: entry.id,
          hooks,
        })
      }
    } catch (error) {
      console.warn(`[plugin-manager] Failed to load ${entry.id}: ${String(error)}`)
    }
  }

  return loaded
}

export function mergeManagedHooks(getLoaded: () => LoadedPlugin[]): Hooks {
  const merged: Hooks = {}

  merged.event = async (input) => {
    for (const plugin of getLoaded()) {
      try {
        await plugin.hooks.event?.(input)
      } catch (error) {
        console.warn(`[plugin-manager] Hook event failed in ${plugin.id}: ${String(error)}`)
      }
    }
  }

  merged.config = async (input) => {
    for (const plugin of getLoaded()) {
      try {
        await plugin.hooks.config?.(input)
      } catch (error) {
        console.warn(`[plugin-manager] Hook config failed in ${plugin.id}: ${String(error)}`)
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
          console.warn(`[plugin-manager] Hook ${hookName} failed in ${plugin.id}: ${String(error)}`)
        }
      }
    }

    ;(merged as Record<string, unknown>)[hookName] = fn
  }

  const tools: NonNullable<Hooks["tool"]> = {}
  let auth: Hooks["auth"]

  for (const plugin of getLoaded()) {
    if (plugin.hooks.tool) {
      for (const [name, definition] of Object.entries(plugin.hooks.tool)) {
        if (tools[name]) {
          console.warn(`[plugin-manager] Tool collision for '${name}', overriding with ${plugin.id}`)
        }
        tools[name] = definition
      }
    }

    if (plugin.hooks.auth) {
      if (auth) {
        console.warn(`[plugin-manager] Auth hook collision, overriding with ${plugin.id}`)
      }
      auth = plugin.hooks.auth
    }
  }

  if (Object.keys(tools).length) {
    merged.tool = tools
  }
  if (auth) {
    merged.auth = auth
  }

  return merged
}
