import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import path from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import type { Logger } from "./log"

const COMMAND_KILL_GRACE_MS = 250
const COMMAND_OUTPUT_MAX_BYTES = 10 * 1024 * 1024 // 10 MB

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

export class CappedBuffer {
  private chunks: Buffer[] = []
  private totalBytes = 0
  private droppedBytes = 0
  private readonly maxBytes: number

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes
  }

  append(chunk: Buffer): void {
    this.totalBytes += chunk.length
    this.chunks.push(chunk)

    while (this.byteLength() > this.maxBytes && this.chunks.length > 1) {
      const removed = this.chunks.shift()!
      this.droppedBytes += removed.length
    }
  }

  get truncated(): boolean {
    return this.droppedBytes > 0
  }

  private byteLength(): number {
    let total = 0
    for (const chunk of this.chunks) total += chunk.length
    return total
  }

  toString(): string {
    const content = Buffer.concat(this.chunks).toString()
    if (!this.truncated) return content
    return `[truncated: ${this.droppedBytes} bytes dropped, keeping last ${this.byteLength()} bytes]\n${content}`
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

    const stdout = new CappedBuffer(COMMAND_OUTPUT_MAX_BYTES)
    const stderr = new CappedBuffer(COMMAND_OUTPUT_MAX_BYTES)
    let timedOut = false
    let settled = false
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.append(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.append(chunk)
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

      const stdoutStr = stdout.toString()
      const stderrStr = stderr.toString()

      if (code === 0 && !timedOut) {
        logger?.debug("Command completed", {
          command,
          args,
          commandString,
          cwd: cwd ?? process.cwd(),
          durationMs,
          stdout: stdoutStr.trim() || undefined,
          stderr: stderrStr.trim() || undefined,
        })
        return resolve({ stdout: stdoutStr, stderr: stderrStr })
      }

      if (timedOut) {
        reject(new Error(`${command} ${args.join(" ")} timed out after ${timeout}ms: ${stderrStr || stdoutStr}`))
        return
      }

      logger?.error("Command failed", {
        command,
        args,
        commandString,
        cwd: cwd ?? process.cwd(),
        durationMs,
        exitCode: code,
        stdout: stdoutStr.trim() || undefined,
        stderr: stderrStr.trim() || undefined,
      })
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}: ${stderrStr || stdoutStr}`))
    })
  })
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
