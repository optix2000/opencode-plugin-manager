import fs from "node:fs/promises"
import path from "node:path"
import type { LockEntry, ManagedPluginSpec } from "../types"
import { runCommand } from "../util"
import { resolvePluginEntry } from "./shared"

type LocalSpec = Extract<ManagedPluginSpec, { source: "local" }>

export async function syncLocalPlugin(spec: LocalSpec): Promise<LockEntry> {
  const pluginPath = path.resolve(spec.path)
  const stat = await fs.stat(pluginPath).catch(() => undefined)
  if (!stat) {
    throw new Error(`Local plugin path does not exist: ${pluginPath}`)
  }

  if (!stat.isDirectory() && !stat.isFile()) {
    throw new Error(`Local plugin path must be a file or directory: ${pluginPath}`)
  }

  const buildCwd = stat.isDirectory() ? pluginPath : path.dirname(pluginPath)
  if (spec.build) {
    await runCommand({
      command: "sh",
      args: ["-lc", spec.build.command],
      cwd: buildCwd,
      timeout: spec.build.timeout,
    })
  }

  if (stat.isFile() && spec.entry) {
    throw new Error(`'entry' cannot be set when local plugin path points to a file: ${pluginPath}`)
  }

  const resolvedPath = stat.isDirectory() ? await resolvePluginEntry(pluginPath, spec.entry) : pluginPath

  return {
    id: spec.id,
    source: "local",
    path: pluginPath,
    entry: spec.entry,
    resolvedPath,
    updatedAt: new Date().toISOString(),
  }
}
