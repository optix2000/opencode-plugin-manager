import type { Logger } from "../log"
import { gitInstallDir } from "../cache"
import { ensureDir, exists, runCommand, sha256File } from "../util"
import * as fs from "node:fs/promises"
import { moveExtractedDirIntoPlace, resolvePluginEntry as resolvePluginEntryFromShared } from "./shared"

const resolvePluginEntry = (rootDir: string, explicitEntry?: string, logger?: Logger) =>
  resolvePluginEntryFromShared(rootDir, explicitEntry, logger)

export { ensureDir, exists, fs, gitInstallDir, moveExtractedDirIntoPlace, resolvePluginEntry, runCommand, sha256File }
