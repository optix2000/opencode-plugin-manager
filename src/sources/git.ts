import path from "node:path"
import type { CacheContext } from "../cache"
import { createConsoleLogger, type Logger } from "../log"
import type { LockEntry, ManagedPluginSpec } from "../types"
import {
  ensureDir,
  exists,
  fs,
  gitInstallDir,
  moveExtractedDirIntoPlace,
  resolvePluginEntry,
  runCommand,
} from "./git.deps"

type GitSpec = Extract<ManagedPluginSpec, { source: "git" }>

export async function syncGitPlugin(
  spec: GitSpec,
  cache: CacheContext,
  options: { lockedCommit?: string } = {},
  logger?: Logger,
): Promise<LockEntry> {
  const activeLogger = logger ?? createConsoleLogger()
  const tempDir = await fs.mkdtemp(path.join(cache.rootDir, ".tmp-git-"))
  const cloneDir = path.join(tempDir, "repo")

  activeLogger.info("Syncing git plugin", {
    pluginID: spec.id,
    repo: spec.repo,
    ref: spec.ref,
    lockedCommit: options.lockedCommit,
    tempDir,
  })

  try {
    await runCommand({
      command: "git",
      args: ["-c", "core.hooksPath=/dev/null", "clone", spec.repo, cloneDir],
      ...(logger ? { logger } : {}),
    })

    if (options.lockedCommit) {
      await runCommand({
        command: "git",
        args: ["-C", cloneDir, "-c", "core.hooksPath=/dev/null", "checkout", "--end-of-options", options.lockedCommit],
        ...(logger ? { logger } : {}),
      })
    } else if (spec.ref) {
      await runCommand({
        command: "git",
        args: ["-C", cloneDir, "-c", "core.hooksPath=/dev/null", "checkout", "--end-of-options", spec.ref],
        ...(logger ? { logger } : {}),
      })
    }

    const commit = (await runCommand({
      command: "git",
      args: ["-C", cloneDir, "rev-parse", "--end-of-options", "HEAD"],
      ...(logger ? { logger } : {}),
    })).stdout.trim()

    if (spec.build) {
      await runCommand({
        command: "sh",
        args: ["-lc", spec.build.command],
        cwd: cloneDir,
        timeout: spec.build.timeout,
        ...(logger ? { logger } : {}),
      })
    }

    const targetDir = gitInstallDir(cache, spec.repo, commit)
    await ensureDir(path.dirname(targetDir))

    await moveExtractedDirIntoPlace({
      targetDir,
      extractedDir: cloneDir,
      validateExistingDir: async (installDir) => {
        await resolvePluginEntry(installDir, spec.entry)
      },
    })

    const resolvedPath = await resolvePluginEntry(targetDir, spec.entry)
    activeLogger.info("Git plugin synced", {
      pluginID: spec.id,
      commit,
      resolvedPath,
      targetDir,
    })
    return {
      id: spec.id,
      source: "git",
      repo: spec.repo,
      ref: spec.ref,
      commit,
      resolvedPath,
      updatedAt: new Date().toISOString(),
    }
  } finally {
    if (await exists(tempDir)) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      activeLogger.debug("Removed temporary git sync directory", {
        tempDir,
      })
    }
  }
}
