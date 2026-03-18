import path from "node:path"
import type { CacheContext } from "../cache"
import type { Logger } from "../log"
import type { LockEntry, ManagedPluginSpec } from "../types"
import {
  ensureDir,
  exists,
  fs,
  moveExtractedDirIntoPlace,
  npmInstallDir,
  resolvePluginEntry,
  runCommand,
  sha256File,
} from "./npm.deps"

type NpmSpec = Extract<ManagedPluginSpec, { source: "npm" }>
const NPM_INSTALL_TIMEOUT_MS = 180_000

export async function syncNpmPlugin(
  spec: NpmSpec,
  cache: CacheContext,
  options: { lockedVersion?: string } = {},
  logger: Logger,
): Promise<LockEntry> {
  const requestedVersion = options.lockedVersion ?? spec.version ?? "latest"
  const tempDir = await fs.mkdtemp(path.join(cache.rootDir, ".tmp-npm-"))

  logger.info("Syncing npm plugin", {
    pluginID: spec.id,
    package: spec.name,
    requestedVersion,
    tempDir,
  })

  const pkgJsonPath = path.join(tempDir, "package.json")
  await fs.writeFile(
    pkgJsonPath,
    `${JSON.stringify({
      name: "opencode-plugin-manager-install",
      private: true,
      dependencies: { [spec.name]: requestedVersion },
    })}\n`,
    "utf8",
  )

  try {
    await runCommand({
      command: "bun",
      args: ["install", "--ignore-scripts"],
      cwd: tempDir,
      timeout: NPM_INSTALL_TIMEOUT_MS,
      logger,
    })

    const moduleRoot = path.join(tempDir, "node_modules", spec.name)
    if (!(await exists(moduleRoot))) {
      logger.error("Npm install succeeded but expected package directory was missing", {
        pluginID: spec.id,
        package: spec.name,
        moduleRoot,
      })
      throw new Error(`Install succeeded but package was not found: ${spec.name}`)
    }

    const installedPackageJson = JSON.parse(await fs.readFile(path.join(moduleRoot, "package.json"), "utf8")) as {
      version?: string
    }

    const resolvedVersion = installedPackageJson.version ?? requestedVersion
    const targetDir = npmInstallDir(cache, spec.name, resolvedVersion)
    await ensureDir(path.dirname(targetDir))

    await moveExtractedDirIntoPlace({
      targetDir,
      extractedDir: tempDir,
      validateExistingDir: async (installDir) => {
        const packageDir = path.join(installDir, "node_modules", spec.name)
        await resolvePluginEntry(packageDir, spec.entry, logger)
      },
    })

    const packageDir = path.join(targetDir, "node_modules", spec.name)
    const resolvedPath = await resolvePluginEntry(packageDir, spec.entry, logger)
    const integrity = await sha256File(resolvedPath)

    logger.info("Npm plugin synced", {
      pluginID: spec.id,
      package: spec.name,
      resolvedVersion,
      resolvedPath,
      targetDir,
    })

    return {
      id: spec.id,
      source: "npm",
      name: spec.name,
      requestedVersion: spec.version ?? options.lockedVersion,
      resolvedVersion,
      resolvedPath,
      integrity,
      updatedAt: new Date().toISOString(),
    }
  } finally {
    if (await exists(tempDir)) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      logger.debug("Removed temporary npm sync directory", {
        tempDir,
      })
    }
  }
}
