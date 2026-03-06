import fs from "node:fs/promises"
import path from "node:path"
import { exists } from "../util"

export async function resolvePluginEntry(rootDir: string, explicitEntry?: string): Promise<string> {
  if (explicitEntry) {
    const resolved = resolveInside(rootDir, explicitEntry)
    if (!(await exists(resolved))) {
      throw new Error(`Configured entrypoint not found: ${resolved}`)
    }
    return resolved
  }

  const pkgPath = path.join(rootDir, "package.json")
  if (await exists(pkgPath)) {
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8")) as {
        exports?: string | Record<string, unknown>
        module?: string
        main?: string
      }
      const exportCandidate = resolveExports(pkg.exports)
      const candidates = [exportCandidate, pkg.module, pkg.main, "index.js", "dist/index.js"].filter(
        (value): value is string => Boolean(value),
      )

      for (const candidate of candidates) {
        const resolved = resolveInside(rootDir, candidate)
        if (await exists(resolved)) {
          return resolved
        }
      }
    } catch {
      // package.json entry resolution is best effort.
    }
  }

  for (const fallback of ["index.js", "plugin.js"]) {
    const resolved = path.join(rootDir, fallback)
    if (await exists(resolved)) return resolved
  }

  throw new Error(`Could not determine plugin entrypoint for ${rootDir}`)
}

function resolveExports(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object") return undefined

  const asRecord = value as Record<string, unknown>
  const dot = asRecord["."]
  if (typeof dot === "string") return dot
  if (dot && typeof dot === "object") {
    const module = (dot as Record<string, unknown>).import
    if (typeof module === "string") return module
  }

  const directImport = asRecord.import
  if (typeof directImport === "string") return directImport

  return undefined
}

export function resolveInside(rootDir: string, relativePath: string): string {
  const resolved = path.resolve(rootDir, relativePath)
  const normalizedRoot = path.resolve(rootDir)
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`Path escapes plugin directory: ${relativePath}`)
  }
  return resolved
}
