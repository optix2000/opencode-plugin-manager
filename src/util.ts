import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parse as parseJsonc } from "jsonc-parser"

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
  return {
    name: value.slice(0, lastAtIndex),
    version: value.slice(lastAtIndex + 1),
  }
}

export async function runCommand(input: {
  command: string
  args: string[]
  cwd?: string
  timeout?: number
  env?: NodeJS.ProcessEnv
}): Promise<{ stdout: string; stderr: string }> {
  const { command, args, cwd, timeout, env } = input

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })

    let timer: NodeJS.Timeout | undefined
    if (timeout) {
      timer = setTimeout(() => {
        child.kill("SIGTERM")
      }, timeout)
    }

    child.on("error", reject)
    child.on("close", (code) => {
      if (timer) clearTimeout(timer)
      if (code === 0) return resolve({ stdout, stderr })
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}: ${stderr || stdout}`))
    })
  })
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
