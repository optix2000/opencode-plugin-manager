import { z } from "zod"

export const BUILD_COMMAND_TIMEOUT_MS = 30_000

export const BuildSchema = z.object({
  command: z.string().min(1),
  timeout: z.number().int().positive().max(300_000).default(BUILD_COMMAND_TIMEOUT_MS),
})

const NpmPluginSchema = z.object({
  source: z.literal("npm"),
  name: z.string().min(1),
  version: z.string().min(1).optional(),
  entry: z.string().min(1).optional(),
})

const GitPluginSchema = z.object({
  source: z.literal("git"),
  repo: z.string().url(),
  ref: z.string().min(1).optional(),
  entry: z.string().min(1).optional(),
  build: BuildSchema.optional(),
})

const GithubReleasePluginSchema = z.object({
  source: z.literal("github-release"),
  repo: z.string().regex(/^[^/]+\/[^/]+$/),
  tag: z.string().min(1).optional(),
  asset: z.string().min(1).optional(),
  entry: z.string().min(1).optional(),
  assetDigest: z.string().min(1).optional(),
  build: BuildSchema.optional(),
})

export const PluginInputSchema = z.union([z.string().min(1), NpmPluginSchema, GitPluginSchema, GithubReleasePluginSchema])

export const PluginsFileSchema = z.object({
  cacheDir: z.string().min(1).optional(),
  plugins: z.array(PluginInputSchema).default([]),
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
      source: "github-release"
      repo: string
      tag?: string
      asset?: string
      entry?: string
      assetDigest?: string
      build?: z.infer<typeof BuildSchema>
    }

export type ManagedPluginSpec = NormalizedPluginSpec & {
  id: string
  fromFile: string
}

const LockEntryBaseSchema = z.object({
  id: z.string().min(1),
  source: z.enum(["npm", "git", "github-release"]),
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

const GithubReleaseLockEntrySchema = LockEntryBaseSchema.extend({
  source: z.literal("github-release"),
  repo: z.string().regex(/^[^/]+\/[^/]+$/),
  tag: z.string().min(1),
  asset: z.string().min(1).optional(),
})

export const LockEntrySchema = z.discriminatedUnion("source", [
  NpmLockEntrySchema,
  GitLockEntrySchema,
  GithubReleaseLockEntrySchema,
])

export const LockfileSchema = z.object({
  version: z.literal(1),
  plugins: z.record(LockEntrySchema).default({}),
})

export type LockEntry = z.infer<typeof LockEntrySchema>
export type Lockfile = z.infer<typeof LockfileSchema>
