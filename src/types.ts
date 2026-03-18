import { z } from "zod"

export const BUILD_COMMAND_TIMEOUT_MS = 30_000

// SCP-style git address: user@host:path (e.g. git@github.com:user/repo.git)
// Requires user@ prefix to distinguish from bare URL schemes like "https:foo".
const SCP_GIT_REGEX = /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9][a-zA-Z0-9._-]*:.+$/

export function isGitRepoUrl(value: string): boolean {
  try {
    new URL(value)
    return true
  } catch {
    // Not a standard URL — check SCP-style
  }
  return SCP_GIT_REGEX.test(value)
}

const gitRepoString = z.string().min(1).refine(isGitRepoUrl, {
  message: "Must be a valid URL or SCP-style git address (e.g. git@github.com:user/repo.git)",
})
export const LOCK_ENTRY_SOURCES = ["npm", "git", "local"] as const
export type LockEntrySource = (typeof LOCK_ENTRY_SOURCES)[number]

const LOCK_ENTRY_SOURCE_IS_CACHED = {
  npm: true,
  git: true,
  local: false,
} as const satisfies Record<LockEntrySource, boolean>

export type CachedLockEntrySource = {
  [Source in LockEntrySource]: (typeof LOCK_ENTRY_SOURCE_IS_CACHED)[Source] extends true ? Source : never
}[LockEntrySource]

export const CACHEABLE_LOCK_ENTRY_SOURCES = LOCK_ENTRY_SOURCES.filter(
  (source): source is CachedLockEntrySource => LOCK_ENTRY_SOURCE_IS_CACHED[source],
)

export const BuildSchema = z.object({
  command: z.string().min(1),
  timeout: z.number().int().positive().max(300_000).default(BUILD_COMMAND_TIMEOUT_MS),
}).strict()

const NPM_PACKAGE_NAME_REGEX = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

const EntrySchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional()

const NpmPluginSchema = z.object({
  source: z.literal("npm"),
  name: z.string().min(1).regex(NPM_PACKAGE_NAME_REGEX),
  version: z.string().min(1).optional(),
  entry: EntrySchema,
}).strict()

const GitPluginSchema = z.object({
  source: z.literal("git"),
  repo: gitRepoString,
  ref: z.string().min(1).optional(),
  entry: EntrySchema,
  build: BuildSchema.optional(),
}).strict()

const LocalPluginSchema = z.object({
  source: z.literal("local"),
  path: z.string().min(1),
  entry: EntrySchema,
  build: BuildSchema.optional(),
}).strict()

export const PluginInputSchema = z.union([
  z.string().min(1),
  NpmPluginSchema,
  GitPluginSchema,
  LocalPluginSchema,
])

export const PluginsFileSchema = z.object({
  cacheDir: z.string().min(1).optional(),
  autoinstall: z.boolean().optional(),
  autoprune: z.boolean().optional(),
  reportPlugins: z.boolean().optional(),
  plugins: z.array(PluginInputSchema),
})

/** Loose schema that validates file structure without validating individual plugin entries. */
export const PluginsFileStructureSchema = z.object({
  cacheDir: z.string().min(1).optional(),
  autoinstall: z.boolean().optional(),
  autoprune: z.boolean().optional(),
  reportPlugins: z.boolean().optional(),
  plugins: z.array(z.unknown()),
})

export type PluginInput = z.infer<typeof PluginInputSchema>
export type PluginsFile = z.infer<typeof PluginsFileSchema>

export type NormalizedPluginInput =
  | {
      source: "npm"
      name: string
      version?: string
      entry?: string | string[]
    }
  | {
      source: "git"
      repo: string
      ref?: string
      entry?: string | string[]
      build?: z.infer<typeof BuildSchema>
    }
  | {
      source: "local"
      path: string
      entry?: string | string[]
      build?: z.infer<typeof BuildSchema>
    }
export type ManagedPluginSpec =
  | {
      source: "npm"
      id: string
      name: string
      version?: string
      entry?: string
      fromFile: string
    }
  | {
      source: "git"
      id: string
      repo: string
      ref?: string
      entry?: string
      build?: z.infer<typeof BuildSchema>
      fromFile: string
    }
  | {
      source: "local"
      id: string
      path: string
      entry?: string
      build?: z.infer<typeof BuildSchema>
      fromFile: string
    }

const LockEntryBaseSchema = z.object({
  id: z.string().min(1),
  source: z.enum(LOCK_ENTRY_SOURCES),
  resolvedPath: z.string().min(1),
  updatedAt: z.string().datetime(),
  integrity: z.string().min(1).optional(),
})

const NpmLockEntrySchema = LockEntryBaseSchema.extend({
  source: z.literal("npm"),
  name: z.string().min(1),
  requestedVersion: z.string().min(1).optional(),
  resolvedVersion: z.string().min(1),
})

const GitLockEntrySchema = LockEntryBaseSchema.extend({
  source: z.literal("git"),
  repo: gitRepoString,
  ref: z.string().min(1).optional(),
  commit: z.string().min(1),
})

const LocalLockEntrySchema = LockEntryBaseSchema.extend({
  source: z.literal("local"),
  path: z.string().min(1),
  entry: z.string().min(1).optional(),
})

export const LockEntrySchema = z.discriminatedUnion("source", [
  NpmLockEntrySchema,
  GitLockEntrySchema,
  LocalLockEntrySchema,
])

export const LockfileSchema = z.object({
  version: z.literal(1),
  plugins: z.record(LockEntrySchema).default({}),
})

export type LockEntry = z.infer<typeof LockEntrySchema>
export type Lockfile = z.infer<typeof LockfileSchema>
