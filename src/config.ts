import type { PluginInput as RuntimePluginInput } from "@opencode-ai/plugin"
import path from "node:path"
import { PluginsFileSchema, type ManagedPluginSpec, type NormalizedPluginSpec, type PluginsFile } from "./types"
import { exists, expandHome, fs, normalizeGitRepo, os, parseNpmShorthand, readJsoncFile } from "./config.deps"

const CONFIG_FILENAMES = ["plugins.json", "plugins.jsonc"]

export type MergedConfig = {
  files: string[]
  cacheDir?: string
  cacheDirBase?: string
  plugins: ManagedPluginSpec[]
}

export async function loadMergedConfig(input: RuntimePluginInput): Promise<MergedConfig> {
  const files = await discoverConfigFiles(input)
  const merged = new Map<string, ManagedPluginSpec>()

  let cacheDir: string | undefined
  let cacheDirBase: string | undefined

  for (const file of files) {
    const parsed = await parseConfigFile(file)
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
  if (spec.source === "github-release") return spec.tag ? `${spec.repo}@${spec.tag}` : spec.repo
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
    return {
      ...normalized,
      repo: normalizeGitRepo(normalized.repo),
      id: `git:${normalizeGitRepo(normalized.repo)}`,
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

  return {
    ...normalized,
    repo: normalized.repo.toLowerCase(),
    id: `github-release:${normalized.repo.toLowerCase()}`,
    fromFile,
  }
}

function isLocalPathShorthand(value: string): boolean {
  return (
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~/") ||
    value.startsWith("/") ||
    path.isAbsolute(value)
  )
}

function resolveLocalPath(value: string, fromFile: string): string {
  const baseDir = path.dirname(fromFile)
  return path.resolve(baseDir, expandHome(value))
}

async function parseConfigFile(filePath: string): Promise<PluginsFile | null> {
  const raw = await readJsoncFile<unknown>(filePath)
  if (!raw) return null
  const parsed = PluginsFileSchema.safeParse(raw)
  if (!parsed.success) {
    console.warn(`[plugin-manager] Invalid config at ${filePath}: ${parsed.error.message}`)
    return null
  }
  return parsed.data
}

async function discoverConfigFiles(input: RuntimePluginInput): Promise<string[]> {
  const candidates: string[] = []

  for (const file of CONFIG_FILENAMES) {
    candidates.push(path.join(os.homedir(), ".config", "opencode", file))
    candidates.push(path.join(os.homedir(), ".config", "opencode", ".opencode", file))
  }

  const chain = directoryChain(input.worktree, input.directory)
  for (const dir of chain) {
    for (const file of CONFIG_FILENAMES) {
      candidates.push(path.join(dir, ".opencode", file))
      candidates.push(path.join(dir, file))
    }
  }

  const configDir = process.env.OPENCODE_CONFIG_DIR
  if (configDir) {
    for (const file of CONFIG_FILENAMES) {
      candidates.push(path.join(configDir, file))
    }
  }

  const deduped: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const normalized = path.resolve(candidate)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    if (await exists(normalized)) deduped.push(normalized)
  }
  return deduped
}

function directoryChain(root: string, leaf: string): string[] {
  const rootResolved = path.resolve(root)
  let current = path.resolve(leaf)

  const result = new Set<string>()
  while (true) {
    result.add(current)
    if (current === rootResolved) break
    const parent = path.dirname(current)
    if (parent === current) break
    const relative = path.relative(rootResolved, parent)
    if (relative.startsWith("..") || path.isAbsolute(relative)) break
    current = parent
  }

  const ordered = [...result]
  ordered.reverse()
  return ordered
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}
