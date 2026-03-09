import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import type { Logger } from "./log"

const COMMAND_KILL_GRACE_MS = 250

export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true })
}

export async function readJsoncFile<T>(filePath: string): Promise<T | null> {
  if (!(await exists(filePath))) return null
  const text = await fs.readFile(filePath, "utf8")
  return parseJsonc(text) as T
}

export function expandHome(input: string): string {
  if (input === "~") return os.homedir()
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2))
  return input
}

export function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_")
}

export function sanitizeToolName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_")
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256")
  hash.update(await fs.readFile(filePath))
  return `sha256:${hash.digest("hex")}`
}

export function normalizeGitRepo(value: string): string {
  return value.trim().replace(/\.git$/, "")
}

export function parseNpmShorthand(value: string): { name: string; version?: string } {
  const lastAtIndex = value.lastIndexOf("@")
  if (lastAtIndex <= 0) return { name: value }
  const version = value.slice(lastAtIndex + 1)
  return {
    name: value.slice(0, lastAtIndex),
    ...(version ? { version } : {}),
  }
}

export async function runCommand(input: {
  command: string
  args: string[]
  cwd?: string
  timeout?: number
  env?: NodeJS.ProcessEnv
  logger?: Logger
}): Promise<{ stdout: string; stderr: string }> {
  const { command, args, cwd, timeout, env, logger } = input
  const commandString = [command, ...args].join(" ")
  const startedAt = Date.now()

  logger?.debug("Executing command", {
    command,
    args,
    commandString,
    cwd: cwd ?? process.cwd(),
    timeout,
  })

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })

    let timer: NodeJS.Timeout | undefined
    let killTimer: NodeJS.Timeout | undefined
    if (timeout) {
      timer = setTimeout(() => {
        timedOut = true
        logger?.warn("Command timeout reached; sending SIGTERM", {
          commandString,
          timeout,
          cwd: cwd ?? process.cwd(),
        })
        child.kill("SIGTERM")

        killTimer = setTimeout(() => {
          if (settled) return
          logger?.warn("Command did not exit after SIGTERM; sending SIGKILL", {
            commandString,
            timeout,
            cwd: cwd ?? process.cwd(),
          })
          child.kill("SIGKILL")
        }, COMMAND_KILL_GRACE_MS)
      }, timeout)
    }

    child.on("error", (error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      reject(error)
    })

    child.on("close", (code) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      const durationMs = Date.now() - startedAt

      if (code === 0 && !timedOut) {
        logger?.debug("Command completed", {
          command,
          args,
          commandString,
          cwd: cwd ?? process.cwd(),
          durationMs,
          stdout: stdout.trim() || undefined,
          stderr: stderr.trim() || undefined,
        })
        return resolve({ stdout, stderr })
      }

      if (timedOut) {
        reject(new Error(`${command} ${args.join(" ")} timed out after ${timeout}ms: ${stderr || stdout}`))
        return
      }

      logger?.error("Command failed", {
        command,
        args,
        commandString,
        cwd: cwd ?? process.cwd(),
        durationMs,
        exitCode: code,
        stdout: stdout.trim() || undefined,
        stderr: stderr.trim() || undefined,
      })
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}: ${stderr || stdout}`))
    })
  })
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
