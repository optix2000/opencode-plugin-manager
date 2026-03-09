import type { LockEntry, ManagedPluginSpec } from "../types"

const NOW = new Date().toISOString()

export function makeLockEntry(
  source: "npm",
  overrides?: Partial<Extract<LockEntry, { source: "npm" }>>,
): Extract<LockEntry, { source: "npm" }>
export function makeLockEntry(
  source: "git",
  overrides?: Partial<Extract<LockEntry, { source: "git" }>>,
): Extract<LockEntry, { source: "git" }>
export function makeLockEntry(
  source: "local",
  overrides?: Partial<Extract<LockEntry, { source: "local" }>>,
): Extract<LockEntry, { source: "local" }>
export function makeLockEntry(source: string, overrides: Record<string, unknown> = {}): LockEntry {
  const base = {
    id: `${source}:test`,
    resolvedPath: `/cache/${source}/test/index.js`,
    updatedAt: NOW,
  }
  switch (source) {
    case "npm":
      return {
        ...base,
        source: "npm",
        name: "test-plugin",
        resolvedVersion: "1.0.0",
        ...overrides,
      }
    case "git":
      return {
        ...base,
        source: "git",
        repo: "https://github.com/test/plugin",
        commit: "abc123def456",
        ...overrides,
      }
    case "local":
      return {
        ...base,
        source: "local",
        path: "/local/plugin",
        resolvedPath: "/local/plugin/index.js",
        ...overrides,
      }
    default:
      throw new Error(`Unknown source: ${source}`)
  }
}

export function makeSpec(
  source: "npm",
  overrides?: Partial<Extract<ManagedPluginSpec, { source: "npm" }>>,
): Extract<ManagedPluginSpec, { source: "npm" }>
export function makeSpec(
  source: "git",
  overrides?: Partial<Extract<ManagedPluginSpec, { source: "git" }>>,
): Extract<ManagedPluginSpec, { source: "git" }>
export function makeSpec(
  source: "local",
  overrides?: Partial<Extract<ManagedPluginSpec, { source: "local" }>>,
): Extract<ManagedPluginSpec, { source: "local" }>
export function makeSpec(source: string, overrides: Record<string, unknown> = {}): ManagedPluginSpec {
  const base = {
    fromFile: "/config/plugins.json",
  }
  switch (source) {
    case "npm":
      return {
        ...base,
        source: "npm",
        id: "npm:test-plugin",
        name: "test-plugin",
        ...overrides,
      }
    case "git":
      return {
        ...base,
        source: "git",
        id: "git:https://github.com/test/plugin",
        repo: "https://github.com/test/plugin",
        ...overrides,
      }
    case "local":
      return {
        ...base,
        source: "local",
        id: "local:/local/plugin",
        path: "/local/plugin",
        ...overrides,
      }
    default:
      throw new Error(`Unknown source: ${source}`)
  }
}

export function makeCacheContext(rootDir = "/cache") {
  return {
    rootDir,
    lockfilePath: `${rootDir}/plugins.lock.json`,
    mutexPath: `${rootDir}/.manager.lock`,
  }
}
