import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { makeCacheContext, makeLockEntry } from "./helpers"

const mockIsTrustedLockEntryPath = mock()

mock.module("../cache", () => ({
  isTrustedLockEntryPath: mockIsTrustedLockEntryPath,
}))

const { loadManagedPlugins, mergeManagedHooks } = await import("../loader")

const warnSpy = mock((_message: unknown) => undefined)
let originalWarn: typeof console.warn

function warningMessages(): string[] {
  return warnSpy.mock.calls.map(([message]) => String(message))
}


beforeEach(() => {
  mockIsTrustedLockEntryPath.mockReset()
  mockIsTrustedLockEntryPath.mockResolvedValue(true)

  warnSpy.mockReset()
  originalWarn = console.warn
  console.warn = warnSpy as typeof console.warn
})

afterEach(() => {
  console.warn = originalWarn
})

describe("mergeManagedHooks", () => {
  test("event hook fan-out calls both plugins", async () => {
    const calls: string[] = []
    const plugins = [
      {
        id: "a",
        hooks: {
          event: async () => {
            calls.push("a")
          },
        },
      },
      {
        id: "b",
        hooks: {
          event: async () => {
            calls.push("b")
          },
        },
      },
    ]

    const merged = mergeManagedHooks(() => plugins as any)
    await merged.hooks.event?.({} as any)

    expect(calls).toEqual(["a", "b"])
  })

  test("event hook errors are isolated so later plugins still run", async () => {
    const calls: string[] = []
    const plugins = [
      {
        id: "a",
        hooks: {
          event: async () => {
            calls.push("a")
            throw new Error("event failed")
          },
        },
      },
      {
        id: "b",
        hooks: {
          event: async () => {
            calls.push("b")
          },
        },
      },
    ]

    const merged = mergeManagedHooks(() => plugins as any)
    await merged.hooks.event?.({} as any)

    expect(calls).toEqual(["a", "b"])
    expect(warningMessages().some((message) => message.includes("Hook event failed in a"))).toBe(true)
  })

  test("two-arg hooks fan out to all plugins with input and output", async () => {
    const calls: Array<{ plugin: string; input: unknown; output: unknown }> = []
    const input = { text: "hello" }
    const output = { accepted: true }
    const plugins = [
      {
        id: "a",
        hooks: {
          ["chat.message"]: async (receivedInput: unknown, receivedOutput: unknown) => {
            calls.push({ plugin: "a", input: receivedInput, output: receivedOutput })
          },
        },
      },
      {
        id: "b",
        hooks: {
          ["chat.message"]: async (receivedInput: unknown, receivedOutput: unknown) => {
            calls.push({ plugin: "b", input: receivedInput, output: receivedOutput })
          },
        },
      },
    ]

    const merged = mergeManagedHooks(() => plugins as any)
    const chatMessageHook = merged.hooks["chat.message"] as
      | ((hookInput: unknown, hookOutput: unknown) => Promise<void>)
      | undefined
    await chatMessageHook?.(input, output)

    expect(calls).toEqual([
      { plugin: "a", input, output },
      { plugin: "b", input, output },
    ])
  })

  test("two-arg hook errors are isolated so later plugins still run", async () => {
    const calls: string[] = []
    const plugins = [
      {
        id: "a",
        hooks: {
          ["chat.message"]: async () => {
            calls.push("a")
            throw new Error("chat failed")
          },
        },
      },
      {
        id: "b",
        hooks: {
          ["chat.message"]: async () => {
            calls.push("b")
          },
        },
      },
    ]

    const merged = mergeManagedHooks(() => plugins as any)
    const chatMessageHook = merged.hooks["chat.message"] as
      | ((hookInput: unknown, hookOutput: unknown) => Promise<void>)
      | undefined
    await chatMessageHook?.({}, {})

    expect(calls).toEqual(["a", "b"])
    expect(warningMessages().some((message) => message.includes("Hook chat.message failed in a"))).toBe(true)
  })

  test("collectTools merges different tool names", () => {
    const alphaTool = { description: "alpha" } as any
    const betaTool = { description: "beta" } as any
    const plugins = [
      { id: "a", hooks: { tool: { alpha: alphaTool } } },
      { id: "b", hooks: { tool: { beta: betaTool } } },
    ]

    const merged = mergeManagedHooks(() => plugins as any)
    const tools = merged.collectTools()

    expect(tools).toEqual({ alpha: alphaTool, beta: betaTool })
  })

  test("collectTools resolves collisions by letting last plugin win", () => {
    const firstTool = { description: "first" } as any
    const secondTool = { description: "second" } as any
    const plugins = [
      { id: "a", hooks: { tool: { shared: firstTool } } },
      { id: "b", hooks: { tool: { shared: secondTool } } },
    ]

    const merged = mergeManagedHooks(() => plugins as any)
    const tools = merged.collectTools()

    expect(tools.shared).toBe(secondTool)
    expect(warningMessages().some((message) => message.includes("Tool collision for 'shared', overriding with b"))).toBe(
      true,
    )
  })

  test("collectAuth returns single auth when only one plugin provides it", () => {
    const auth = { challenge: async () => ({ token: "x" }) } as any
    const plugins = [{ id: "a", hooks: { auth } }, { id: "b", hooks: {} }]

    const merged = mergeManagedHooks(() => plugins as any)

    expect(merged.collectAuth()).toBe(auth)
  })

  test("collectAuth resolves collisions by letting last plugin win", () => {
    const firstAuth = { challenge: async () => ({ token: "first" }) } as any
    const secondAuth = { challenge: async () => ({ token: "second" }) } as any
    const plugins = [
      { id: "a", hooks: { auth: firstAuth } },
      { id: "b", hooks: { auth: secondAuth } },
    ]

    const merged = mergeManagedHooks(() => plugins as any)

    expect(merged.collectAuth()).toBe(secondAuth)
    expect(warningMessages().some((message) => message.includes("Auth hook collision, overriding with b"))).toBe(true)
  })

  test("uses fresh getLoaded results each time", async () => {
    const calls: string[] = []
    const plugins: Array<{ id: string; hooks: Record<string, unknown> }> = [
      {
        id: "a",
        hooks: {
          event: async () => {
            calls.push("a")
          },
        },
      },
    ]
    const getLoaded = mock(() => plugins as any)
    const merged = mergeManagedHooks(getLoaded)

    await merged.hooks.event?.({} as any)

    plugins.push({
      id: "b",
      hooks: {
        event: async () => {
          calls.push("b")
        },
      },
    })

    await merged.hooks.event?.({} as any)

    expect(calls).toEqual(["a", "a", "b"])
    expect(getLoaded).toHaveBeenCalledTimes(2)
  })
})

describe("loadManagedPlugins", () => {
  test("skips untrusted entries before import", async () => {
    const cache = makeCacheContext("/cache")
    const entry = makeLockEntry("npm", {
      id: "npm:untrusted",
      resolvedPath: "/virtual/plugins/untrusted-missing.js",
    })
    mockIsTrustedLockEntryPath.mockResolvedValue(false)

    const loaded = await loadManagedPlugins([entry], {} as any, cache)

    expect(loaded).toEqual([])
    expect(mockIsTrustedLockEntryPath).toHaveBeenCalledWith(cache, entry)
    expect(
      warningMessages().some((message) =>
        message.includes("Skipping untrusted plugin path for npm:untrusted: /virtual/plugins/untrusted-missing.js"),
      ),
    ).toBe(true)
    expect(warningMessages().some((message) => message.includes("Failed to load npm:untrusted"))).toBe(false)
  })

  test("warns and excludes trusted entry when dynamic import fails", async () => {
    const cache = makeCacheContext("/cache")
    const entry = makeLockEntry("npm", {
      id: "npm:missing",
      resolvedPath: "/virtual/plugins/trusted-but-missing.js",
    })
    const loaded = await loadManagedPlugins([entry], {} as any, cache)

    expect(loaded).toEqual([])
    expect(warningMessages().some((message) => message.includes("Failed to load npm:missing"))).toBe(true)
  })

  test("continues processing entries after failures", async () => {
    const cache = makeCacheContext("/cache")
    const firstTrustedMissing = makeLockEntry("npm", {
      id: "npm:first",
      resolvedPath: "/virtual/plugins/first-missing.js",
    })
    const skippedUntrusted = makeLockEntry("npm", {
      id: "npm:skip",
      resolvedPath: "/virtual/plugins/skip-missing.js",
    })
    const secondTrustedMissing = makeLockEntry("npm", {
      id: "npm:second",
      resolvedPath: "/virtual/plugins/second-missing.js",
    })

    mockIsTrustedLockEntryPath
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    const loaded = await loadManagedPlugins([firstTrustedMissing, skippedUntrusted, secondTrustedMissing], {} as any, cache)

    expect(loaded).toEqual([])
    expect(mockIsTrustedLockEntryPath).toHaveBeenCalledTimes(3)
    expect(warningMessages().some((message) => message.includes("Failed to load npm:first"))).toBe(true)
    expect(warningMessages().some((message) => message.includes("Skipping untrusted plugin path for npm:skip"))).toBe(true)
    expect(warningMessages().some((message) => message.includes("Failed to load npm:second"))).toBe(true)
  })
})
