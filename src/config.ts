import type { PluginInput as RuntimePluginInput } from "@opencode-ai/plugin"
import path from "node:path"
import { createConsoleLogger, type Logger } from "./log"
import { PluginInputSchema, PluginsFileStructureSchema, type ManagedPluginSpec, type NormalizedPluginSpec, type PluginInput, type PluginsFile } from "./types"
import { exists, expandHome, normalizeGitRepo, os, parseNpmShorthand, readJsoncFile } from "./config.deps"

const CONFIG_FILENAMES = ["plugins.json", "plugins.jsonc"]

export type MergedConfig = {
  files: string[]
  cacheDir?: string
  cacheDirBase?: string
  plugins: ManagedPluginSpec[]
}

export async function loadMergedConfig(input: RuntimePluginInput, logger: Logger = createConsoleLogger()): Promise<MergedConfig> {
  const files = await discoverConfigFiles()
  const merged = new Map<string, ManagedPluginSpec>()

  let cacheDir: string | undefined
  let cacheDirBase: string | undefined

  for (const file of files) {
    const parsed = await parseConfigFile(file, logger)
    if (!parsed) continue

    if (parsed.cacheDir) {
      cacheDir = parsed.cacheDir
      cacheDirBase = path.dirname(file)
    }

    for (const plugin of parsed.plugins) {
      const spec = normalizePlugin(plugin, file)
      merged.delete(spec.id)
      merged.set(spec.id, spec)
    }
  }

  return {
    files,
    cacheDir,
    cacheDirBase,
    plugins: [...merged.values()],
  }
}

export function pluginDisplayName(spec: ManagedPluginSpec): string {
  if (spec.source === "npm") return spec.version ? `${spec.name}@${spec.version}` : spec.name
  if (spec.source === "git") return spec.ref ? `${spec.repo}#${spec.ref}` : spec.repo
  if (spec.source === "local") return spec.path
  const _exhaustive: never = spec
  throw new Error(`Unhandled plugin source in pluginDisplayName: ${JSON.stringify(_exhaustive)}`)
}

function normalizePlugin(plugin: PluginsFile["plugins"][number], fromFile: string): ManagedPluginSpec {
  if (typeof plugin === "string") {
    if (isLocalPathShorthand(plugin)) {
      const resolvedPath = resolveLocalPath(plugin, fromFile)
      return {
        source: "local",
        id: `local:${resolvedPath}`,
        path: resolvedPath,
        fromFile,
      }
    }

    const { name, version } = parseNpmShorthand(plugin)
    return {
      source: "npm",
      id: `npm:${name}`,
      name,
      version,
      fromFile,
    }
  }

  const normalized: NormalizedPluginSpec = plugin
  if (normalized.source === "npm") {
    return {
      ...normalized,
      id: `npm:${normalized.name}`,
      fromFile,
    }
  }

  if (normalized.source === "git") {
    const normalizedRepo = normalizeGitRepo(normalized.repo)
    return {
      ...normalized,
      repo: normalizedRepo,
      id: `git:${normalizedRepo}`,
      fromFile,
    }
  }

  if (normalized.source === "local") {
    const resolvedPath = resolveLocalPath(normalized.path, fromFile)
    return {
      ...normalized,
      path: resolvedPath,
      id: `local:${resolvedPath}`,
      fromFile,
    }
  }

  const _exhaustive: never = normalized
  throw new Error(`Unhandled plugin source in normalizePlugin: ${JSON.stringify(_exhaustive)}`)
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
