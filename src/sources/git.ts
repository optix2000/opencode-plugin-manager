import fs from "node:fs/promises"
import path from "node:path"
import type { CacheContext } from "../cache"
import { gitInstallDir } from "../cache"
import type { LockEntry, ManagedPluginSpec } from "../types"
import { ensureDir, exists, runCommand } from "../util"
import { moveExtractedDirIntoPlace, resolvePluginEntry } from "./shared"

type GitSpec = Extract<ManagedPluginSpec, { source: "git" }>

export async function syncGitPlugin(
  spec: GitSpec,
  cache: CacheContext,
  options: { lockedCommit?: string } = {},
): Promise<LockEntry> {
  const tempDir = await fs.mkdtemp(path.join(cache.rootDir, ".tmp-git-"))
  const cloneDir = path.join(tempDir, "repo")

  try {
    await runCommand({
      command: "git",
      args: ["-c", "core.hooksPath=/dev/null", "clone", spec.repo, cloneDir],
    })

    if (options.lockedCommit) {
      await runCommand({
        command: "git",
        args: ["-C", cloneDir, "-c", "core.hooksPath=/dev/null", "checkout", "--end-of-options", options.lockedCommit],
      })
    } else if (spec.ref) {
      await runCommand({
        command: "git",
        args: ["-C", cloneDir, "-c", "core.hooksPath=/dev/null", "checkout", "--end-of-options", spec.ref],
      })
    }

    const commit = (await runCommand({
      command: "git",
      args: ["-C", cloneDir, "rev-parse", "--end-of-options", "HEAD"],
    })).stdout.trim()

    if (spec.build) {
      await runCommand({
        command: "sh",
        args: ["-lc", spec.build.command],
        cwd: cloneDir,
        timeout: spec.build.timeout,
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
    }
  }
}
