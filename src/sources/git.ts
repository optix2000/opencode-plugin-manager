import path from "node:path"
import type { CacheContext } from "../cache"
import type { Logger } from "../log"
import type { LockEntry, ManagedPluginSpec } from "../types"
import {
  ensureDir,
  exists,
  fs,
  gitInstallDir,
  moveExtractedDirIntoPlace,
  resolvePluginEntry,
  runCommand,
  sha256File,
} from "./git.deps"

type GitSpec = Extract<ManagedPluginSpec, { source: "git" }>
const GIT_NETWORK_TIMEOUT_MS = 180_000

export async function syncGitPlugin(
  spec: GitSpec,
  cache: CacheContext,
  options: { lockedCommit?: string } = {},
  logger: Logger,
): Promise<LockEntry> {
  const tempDir = await fs.mkdtemp(path.join(cache.rootDir, ".tmp-git-"))
  const cloneDir = path.join(tempDir, "repo")

  logger.info("Syncing git plugin", {
    pluginID: spec.id,
    repo: spec.repo,
    ref: spec.ref,
    lockedCommit: options.lockedCommit,
    tempDir,
  })

  try {
    if (options.lockedCommit) {
      // Shallow-clone HEAD, then try to fetch the specific commit.
      // Not all servers support fetching by SHA, so fall back to a full clone.
      await runCommand({
        command: "git",
        args: ["-c", "core.hooksPath=/dev/null", "clone", "--depth", "1", spec.repo, cloneDir],
        timeout: GIT_NETWORK_TIMEOUT_MS,
        logger,
      })
      try {
        await runCommand({
          command: "git",
          args: ["-C", cloneDir, "-c", "core.hooksPath=/dev/null", "fetch", "--depth", "1", "origin", "--end-of-options", options.lockedCommit],
          timeout: GIT_NETWORK_TIMEOUT_MS,
          logger,
        })
      } catch {
        logger.info("Shallow fetch by commit failed; falling back to full fetch", {
          pluginID: spec.id,
          commit: options.lockedCommit,
        })
        await runCommand({
          command: "git",
          args: ["-C", cloneDir, "-c", "core.hooksPath=/dev/null", "fetch", "--unshallow"],
          timeout: GIT_NETWORK_TIMEOUT_MS,
          logger,
        })
      }
      await runCommand({
        command: "git",
        args: ["-C", cloneDir, "-c", "core.hooksPath=/dev/null", "checkout", "--end-of-options", options.lockedCommit],
        timeout: GIT_NETWORK_TIMEOUT_MS,
        logger,
      })
    } else if (spec.ref) {
      // Shallow-clone directly at the target ref (branch or tag).
      await runCommand({
        command: "git",
        args: ["-c", "core.hooksPath=/dev/null", "clone", "--depth", "1", "--branch", spec.ref, spec.repo, cloneDir],
        timeout: GIT_NETWORK_TIMEOUT_MS,
        logger,
      })
    } else {
      // No ref or locked commit — shallow-clone HEAD.
      await runCommand({
        command: "git",
        args: ["-c", "core.hooksPath=/dev/null", "clone", "--depth", "1", spec.repo, cloneDir],
        timeout: GIT_NETWORK_TIMEOUT_MS,
        logger,
      })
    }

    const commit = (await runCommand({
      command: "git",
      args: ["-C", cloneDir, "rev-parse", "--end-of-options", "HEAD"],
      logger,
    })).stdout.trim()

    if (spec.build) {
      await runCommand({
        command: "sh",
        args: ["-lc", spec.build.command],
        cwd: cloneDir,
        timeout: spec.build.timeout,
        logger,
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
    const integrity = await sha256File(resolvedPath)
    logger.info("Git plugin synced", {
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
      integrity,
      updatedAt: new Date().toISOString(),
    }
  } finally {
    if (await exists(tempDir)) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      logger.debug("Removed temporary git sync directory", {
        tempDir,
      })
    }
  }
}
