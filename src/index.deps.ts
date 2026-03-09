import { tool } from "@opencode-ai/plugin"
import fs from "node:fs/promises"
import { pruneCacheDirectories, readLockfile, resolveCacheContext, withCacheLock, writeLockfile } from "./cache"
import { loadMergedConfig } from "./config"
import { loadManagedPlugins, mergeManagedHooks } from "./loader"
import { resolveCachedPluginPaths, syncPlugins } from "./resolver"
import { exists } from "./util"

export {
  exists,
  fs,
  loadManagedPlugins,
  loadMergedConfig,
  mergeManagedHooks,
  pruneCacheDirectories,
  readLockfile,
  resolveCacheContext,
  resolveCachedPluginPaths,
  syncPlugins,
  tool,
  withCacheLock,
  writeLockfile,
}
