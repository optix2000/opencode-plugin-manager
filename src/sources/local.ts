import path from "node:path"
import type { Logger } from "../log"
import type { LockEntry, ManagedPluginSpec } from "../types"
import { fs, resolvePluginEntry, runCommand } from "./local.deps"

type LocalSpec = Extract<ManagedPluginSpec, { source: "local" }>

export async function syncLocalPlugin(spec: LocalSpec, logger: Logger): Promise<LockEntry> {
  const pluginPath = path.resolve(spec.path)
  logger.info("Syncing local plugin", {
    pluginID: spec.id,
    pluginPath,
    hasBuild: Boolean(spec.build),
  })

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
      logger,
    })
  }

  if (stat.isFile() && spec.entry) {
    throw new Error(`'entry' cannot be set when local plugin path points to a file: ${pluginPath}`)
  }

  const resolvedPath = stat.isDirectory() ? await resolvePluginEntry(pluginPath, spec.entry) : pluginPath

  logger.info("Local plugin synced", {
    pluginID: spec.id,
    resolvedPath,
  })

  return {
    id: spec.id,
    source: "local",
    path: pluginPath,
    entry: spec.entry,
    resolvedPath,
    updatedAt: new Date().toISOString(),
  }
}
