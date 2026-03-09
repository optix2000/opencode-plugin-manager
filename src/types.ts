import { z } from "zod"

export const BUILD_COMMAND_TIMEOUT_MS = 30_000
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

const NpmPluginSchema = z.object({
  source: z.literal("npm"),
  name: z.string().min(1).regex(NPM_PACKAGE_NAME_REGEX),
  version: z.string().min(1).optional(),
  entry: z.string().min(1).optional(),
}).strict()

const GitPluginSchema = z.object({
  source: z.literal("git"),
  repo: z.string().url(),
  ref: z.string().min(1).optional(),
  entry: z.string().min(1).optional(),
  build: BuildSchema.optional(),
}).strict()

const LocalPluginSchema = z.object({
  source: z.literal("local"),
  path: z.string().min(1),
  entry: z.string().min(1).optional(),
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
  plugins: z.array(PluginInputSchema),
})

export type PluginInput = z.infer<typeof PluginInputSchema>
export type PluginsFile = z.infer<typeof PluginsFileSchema>

export type NormalizedPluginSpec =
  | {
      source: "npm"
      name: string
      version?: string
      entry?: string
    }
  | {
      source: "git"
      repo: string
      ref?: string
      entry?: string
      build?: z.infer<typeof BuildSchema>
    }
  | {
      source: "local"
      path: string
      entry?: string
      build?: z.infer<typeof BuildSchema>
    }
export type ManagedPluginSpec = NormalizedPluginSpec & {
  id: string
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
  repo: z.string().url(),
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
