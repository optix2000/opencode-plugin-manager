import type { Logger } from "../log"
import fs from "node:fs/promises"
import { runCommand, sha256File } from "../util"
import { resolvePluginEntry as resolvePluginEntryFromShared } from "./shared"

const resolvePluginEntry = (rootDir: string, explicitEntry?: string, logger?: Logger) =>
  resolvePluginEntryFromShared(rootDir, explicitEntry, logger)

export { fs, resolvePluginEntry, runCommand, sha256File }
