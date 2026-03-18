import type { PluginInput as RuntimePluginInput } from "@opencode-ai/plugin"
import path from "node:path"
import { createConsoleLogger, type Logger } from "./log"
import { PluginInputSchema, PluginsFileStructureSchema, type ManagedPluginSpec, type NormalizedPluginInput, type PluginInput, type PluginsFile } from "./types"
import { exists, expandHome, normalizeGitRepo, os, parseNpmShorthand, readJsoncFile } from "./config.deps"

const CONFIG_FILENAMES = ["plugins.json", "plugins.jsonc"]

export type MergedConfig = {
  files: string[]
  cacheDir?: string
  cacheDirBase?: string
  autoinstall?: boolean
  autoprune?: boolean
  reportPlugins?: boolean
  plugins: ManagedPluginSpec[]
}

export async function loadMergedConfig(input: RuntimePluginInput, logger: Logger = createConsoleLogger()): Promise<MergedConfig> {
  const files = await discoverConfigFiles()
  const merged = new Map<string, ManagedPluginSpec>()

  let cacheDir: string | undefined
  let cacheDirBase: string | undefined
  let autoinstall: boolean | undefined
  let autoprune: boolean | undefined
  let reportPlugins: boolean | undefined

  for (const file of files) {
    const parsed = await parseConfigFile(file, logger)
    if (!parsed) continue

    if (parsed.cacheDir) {
      cacheDir = parsed.cacheDir
      cacheDirBase = path.dirname(file)
    }

    if (parsed.autoinstall !== undefined) {
      autoinstall = parsed.autoinstall
    }

    if (parsed.autoprune !== undefined) {
      autoprune = parsed.autoprune
    }

    if (parsed.reportPlugins !== undefined) {
      reportPlugins = parsed.reportPlugins
    }

    for (const plugin of parsed.plugins) {
      const specs = normalizePlugin(plugin, file)
      for (const spec of specs) {
        merged.delete(spec.id)
        merged.set(spec.id, spec)
      }
    }
  }

  return {
    files,
    cacheDir,
    cacheDirBase,
    autoinstall,
    autoprune,
    reportPlugins,
    plugins: [...merged.values()],
  }
}

export function pluginDisplayName(spec: ManagedPluginSpec): string {
  let name: string
  if (spec.source === "npm") {
    name = spec.version ? `${spec.name}@${spec.version}` : spec.name
  } else if (spec.source === "git") {
    name = spec.ref ? `${spec.repo}#${spec.ref}` : spec.repo
  } else if (spec.source === "local") {
    name = spec.path
  } else {
    const _exhaustive: never = spec
    throw new Error(`Unhandled plugin source in pluginDisplayName: ${JSON.stringify(_exhaustive)}`)
  }
  return spec.entry ? `${name} (${spec.entry})` : name
}

function normalizePlugin(plugin: PluginsFile["plugins"][number], fromFile: string): ManagedPluginSpec[] {
  if (typeof plugin === "string") {
    if (isLocalPathShorthand(plugin)) {
      const resolvedPath = resolveLocalPath(plugin, fromFile)
      return [{
        source: "local",
        id: `local:${resolvedPath}`,
        path: resolvedPath,
        fromFile,
      }]
    }

    const { name, version } = parseNpmShorthand(plugin)
    return [{
      source: "npm",
      id: `npm:${name}`,
      name,
      version,
      fromFile,
    }]
  }

  const normalized: NormalizedPluginInput = plugin
  if (normalized.source === "npm") {
    return expandEntries(normalized.entry, (entry) => ({
      source: "npm",
      name: normalized.name,
      version: normalized.version,
      entry,
      id: pluginId("npm", normalized.name, entry),
      fromFile,
    }))
  }

  if (normalized.source === "git") {
    const normalizedRepo = normalizeGitRepo(normalized.repo)
    return expandEntries(normalized.entry, (entry) => ({
      source: "git",
      repo: normalizedRepo,
      ref: normalized.ref,
      build: normalized.build,
      entry,
      id: pluginId("git", normalizedRepo, entry),
      fromFile,
    }))
  }

  if (normalized.source === "local") {
    const resolvedPath = resolveLocalPath(normalized.path, fromFile)
    return expandEntries(normalized.entry, (entry) => ({
      source: "local",
      path: resolvedPath,
      build: normalized.build,
      entry,
      id: pluginId("local", resolvedPath, entry),
      fromFile,
    }))
  }

  const _exhaustive: never = normalized
  throw new Error(`Unhandled plugin source in normalizePlugin: ${JSON.stringify(_exhaustive)}`)
}

function pluginId(prefix: string, base: string, entry?: string): string {
  return entry ? `${prefix}:${base}#${entry}` : `${prefix}:${base}`
}

function expandEntries<T>(
  entry: string | string[] | undefined,
  makeSpec: (entry?: string) => T,
): T[] {
  if (Array.isArray(entry)) {
    return entry.map((e) => makeSpec(e))
  }
  return [makeSpec(entry)]
}

function isLocalPathShorthand(value: string): boolean {
  return value.startsWith("./") || value.startsWith("../") || value.startsWith("~/") || path.isAbsolute(value)
}

function resolveLocalPath(value: string, fromFile: string): string {
  const baseDir = path.dirname(fromFile)
  return path.resolve(baseDir, expandHome(value))
}

async function parseConfigFile(filePath: string, logger: Logger): Promise<PluginsFile | null> {
  const raw = await readJsoncFile<unknown>(filePath)
  if (!raw) return null

  // Validate file structure (top-level keys) without validating individual entries
  const structure = PluginsFileStructureSchema.safeParse(raw)
  if (!structure.success) {
    logger.warn(`[plugin-manager] Invalid config at ${filePath}: ${structure.error.message}`, {
      filePath,
      error: structure.error.message,
    })
    return null
  }

  // Validate each plugin entry individually so one bad entry doesn't reject the whole file
  const validPlugins: PluginInput[] = []
  for (const [index, entry] of structure.data.plugins.entries()) {
    const parsed = PluginInputSchema.safeParse(entry)
    if (parsed.success) {
      validPlugins.push(parsed.data)
    } else {
      logger.warn(
        `[plugin-manager] Skipping invalid plugin at index ${index} in ${filePath}: ${parsed.error.message}`,
        { filePath, index, error: parsed.error.message },
      )
    }
  }

  return {
    cacheDir: structure.data.cacheDir,
    autoinstall: structure.data.autoinstall,
    autoprune: structure.data.autoprune,
    reportPlugins: structure.data.reportPlugins,
    plugins: validPlugins,
  }
}

async function discoverConfigFiles(): Promise<string[]> {
  const candidates = CONFIG_FILENAMES.map((file) => path.join(os.homedir(), ".config", "opencode", file))
  const existing: string[] = []
  for (const candidate of candidates) {
    const normalized = path.resolve(candidate)
    if (await exists(normalized)) existing.push(normalized)
  }
  return existing
}
