import path from "node:path"
import type { CacheContext } from "../cache"
import type { LockEntry, ManagedPluginSpec } from "../types"
import {
  ensureDir,
  exists,
  fs,
  moveExtractedDirIntoPlace,
  npmInstallDir,
  resolvePluginEntry,
  runCommand,
} from "./npm.deps"

type NpmSpec = Extract<ManagedPluginSpec, { source: "npm" }>

export async function syncNpmPlugin(
  spec: NpmSpec,
  cache: CacheContext,
  options: { lockedVersion?: string } = {},
): Promise<LockEntry> {
  const requestedVersion = options.lockedVersion ?? spec.version ?? "latest"
  const tempDir = await fs.mkdtemp(path.join(cache.rootDir, ".tmp-npm-"))

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
    })

    const moduleRoot = path.join(tempDir, "node_modules", spec.name)
    if (!(await exists(moduleRoot))) {
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
        await resolvePluginEntry(packageDir, spec.entry)
      },
    })

    const packageDir = path.join(targetDir, "node_modules", spec.name)
    const resolvedPath = await resolvePluginEntry(packageDir, spec.entry)

    return {
      id: spec.id,
      source: "npm",
      name: spec.name,
      requestedVersion: spec.version ?? options.lockedVersion,
      resolvedVersion,
      resolvedPath,
      updatedAt: new Date().toISOString(),
    }
  } finally {
    if (await exists(tempDir)) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
