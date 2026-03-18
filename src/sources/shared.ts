import path from "node:path"
import { createNoopLogger, type Logger } from "../log"
import { exists, fs } from "./shared.deps"

const DEFAULT_ENTRYPOINT = "opencode.plugin.ts"
const EXPORT_CONDITION_PRIORITY = ["bun", "import", "default", "node", "require"] as const

export async function resolvePluginEntry(
  rootDir: string,
  explicitEntry?: string,
  logger: Logger = createNoopLogger(),
): Promise<string> {
  const attemptedPaths: string[] = []

  if (explicitEntry) {
    const resolved = resolveInside(rootDir, explicitEntry)
    attemptedPaths.push(resolved)
    if (!(await exists(resolved))) {
      throw new Error(`Configured entrypoint not found: ${resolved}`)
    }
    return resolved
  }

  const conventionalEntrypoint = path.join(rootDir, DEFAULT_ENTRYPOINT)
  attemptedPaths.push(conventionalEntrypoint)
  if (await exists(conventionalEntrypoint)) {
    return conventionalEntrypoint
  }

  const pkgPath = path.join(rootDir, "package.json")
  if (await exists(pkgPath)) {
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8")) as {
        exports?: unknown
        module?: string
        main?: string
      }
      const exportCandidates = resolveExports(pkg.exports)
      const candidates = [...exportCandidates, pkg.module, pkg.main, "index.js", "dist/index.js"].filter(
        (value): value is string => Boolean(value),
      )

      for (const candidate of candidates) {
        const resolved = resolveInside(rootDir, candidate)
        attemptedPaths.push(resolved)
        if (await exists(resolved)) {
          return resolved
        }
      }
    } catch (error) {
      logger.warn("Failed to parse package.json while resolving plugin entrypoint", {
        rootDir,
        pkgPath,
        error: String(error),
      })
    }
  }

  for (const fallback of ["index.js", "plugin.js"]) {
    const resolved = path.join(rootDir, fallback)
    attemptedPaths.push(resolved)
    if (await exists(resolved)) return resolved
  }

  logger.warn("Could not determine plugin entrypoint", {
    rootDir,
    candidatePaths: [...new Set(attemptedPaths)],
  })

  throw new Error(`Could not determine plugin entrypoint for ${rootDir}`)
}

export async function moveExtractedDirIntoPlace(input: {
  targetDir: string
  extractedDir: string
  validateExistingDir: (targetDir: string) => Promise<void>
}): Promise<void> {
  const { targetDir, extractedDir, validateExistingDir } = input

  try {
    await fs.rename(extractedDir, targetDir)
    return
  } catch (error) {
    if (!isExistingDirectoryError(error)) {
      throw error
    }
  }

  if (await isValidExistingDir(targetDir, validateExistingDir)) {
    return
  }

  await fs.rm(targetDir, { recursive: true, force: true })

  try {
    await fs.rename(extractedDir, targetDir)
  } catch (error) {
    if (!isExistingDirectoryError(error)) {
      throw error
    }

    if (await isValidExistingDir(targetDir, validateExistingDir)) {
      return
    }

    throw new Error(`Install directory exists but remains invalid: ${targetDir} (from ${extractedDir})`)
  }
}

async function isValidExistingDir(
  targetDir: string,
  validateExistingDir: (targetDir: string) => Promise<void>,
): Promise<boolean> {
  try {
    await validateExistingDir(targetDir)
    return true
  } catch {
    return false
  }
}

function isExistingDirectoryError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const code = (error as NodeJS.ErrnoException).code
  return code === "EEXIST" || code === "ENOTEMPTY"
}

function resolveExports(value: unknown): string[] {
  return resolveExportCandidates(value, true)
}

function resolveExportCandidates(value: unknown, rootLevel = false): string[] {
  if (typeof value === "string") return [value]

  if (Array.isArray(value)) {
    return value.flatMap((item) => resolveExportCandidates(item, false))
  }

  if (!isRecord(value)) {
    return []
  }

  if (rootLevel) {
    if (Object.hasOwn(value, ".")) {
      return resolveExportCandidates(value["."], false)
    }

    if (Object.keys(value).some((key) => key.startsWith("."))) {
      return []
    }
  }

  const resolved: string[] = []
  const addResolved = (candidate: unknown): void => {
    for (const item of resolveExportCandidates(candidate, false)) {
      if (!resolved.includes(item)) {
        resolved.push(item)
      }
    }
  }

  for (const condition of EXPORT_CONDITION_PRIORITY) {
    addResolved(value[condition])
  }

  for (const [condition, candidate] of Object.entries(value)) {
    if (EXPORT_CONDITION_PRIORITY.includes(condition as (typeof EXPORT_CONDITION_PRIORITY)[number])) {
      continue
    }
    addResolved(candidate)
  }

  return resolved
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export function resolveInside(rootDir: string, relativePath: string): string {
  const resolved = path.resolve(rootDir, relativePath)
  const normalizedRoot = path.resolve(rootDir)
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`Path escapes plugin directory: ${relativePath}`)
  }
  return resolved
}
