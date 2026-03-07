import type { Hooks, Plugin as PluginFactory, PluginInput } from "@opencode-ai/plugin"
import { pathToFileURL } from "node:url"
import type { CacheContext } from "./cache"
import { isTrustedLockEntryPath } from "./loader.deps"
import type { LockEntry } from "./types"

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
      loaded.push({
        id: entry.id,
        hooks,
      })
    } catch (error) {
      console.warn(`[plugin-manager] Failed to load ${entry.id}: ${String(error)}`)
    }
  }

  return loaded
}

export type MergedManagedHooks = {
  hooks: Hooks
  collectTools: () => NonNullable<Hooks["tool"]>
  collectAuth: () => Hooks["auth"]
}

export function mergeManagedHooks(getLoaded: () => LoadedPlugin[]): MergedManagedHooks {
  const hooks: Hooks = {}

  hooks.event = async (input) => {
    for (const plugin of getLoaded()) {
      try {
        await plugin.hooks.event?.(input)
      } catch (error) {
        console.warn(`[plugin-manager] Hook event failed in ${plugin.id}: ${String(error)}`)
      }
    }
  }

  hooks.config = async (input) => {
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

    ;(hooks as Record<string, unknown>)[hookName] = fn
  }

  const collectTools = (): NonNullable<Hooks["tool"]> => {
    const tools: NonNullable<Hooks["tool"]> = {}
    for (const plugin of getLoaded()) {
      if (!plugin.hooks.tool) continue
      for (const [name, definition] of Object.entries(plugin.hooks.tool)) {
        if (tools[name]) {
          console.warn(`[plugin-manager] Tool collision for '${name}', overriding with ${plugin.id}`)
        }
        tools[name] = definition
      }
    }
    return tools
  }

  const collectAuth = (): Hooks["auth"] => {
    let auth: Hooks["auth"]
    for (const plugin of getLoaded()) {
      if (!plugin.hooks.auth) continue
      if (auth) {
        console.warn(`[plugin-manager] Auth hook collision, overriding with ${plugin.id}`)
      }
      auth = plugin.hooks.auth
    }
    return auth
  }

  return { hooks, collectTools, collectAuth }
}
