export type LogLevel = "debug" | "info" | "warn" | "error"

export type LogExtra = Record<string, unknown>

export type Logger = {
  debug(message: string, extra?: LogExtra): void
  info(message: string, extra?: LogExtra): void
  warn(message: string, extra?: LogExtra): void
  error(message: string, extra?: LogExtra): void
}

type AppLogClient = {
  app?: {
    log?: (options: {
      body: {
        service: string
        level: LogLevel
        message: string
        extra?: LogExtra
      }
    }) => Promise<unknown>
  }
}

export function createNoopLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }
}

export function createConsoleLogger(prefix = ""): Logger {
  const format = (message: string) => (prefix ? `${prefix} ${message}` : message)

  return {
    debug: (message) => {
      console.debug(format(message))
    },
    info: (message) => {
      console.info(format(message))
    },
    warn: (message) => {
      console.warn(format(message))
    },
    error: (message) => {
      console.error(format(message))
    },
  }
}

export function createOpencodeLogger(
  client: AppLogClient | undefined,
  service: string,
  fallback: Logger = createNoopLogger(),
): Logger {
  const canWrite = typeof client?.app?.log === "function"

  const write = async (level: LogLevel, message: string, extra?: LogExtra) => {
    if (!canWrite) {
      fallback[level](message, extra)
      return
    }

    try {
      await client.app?.log?.({
        body: {
          service,
          level,
          message,
          extra,
        },
      })
    } catch {
      // Logging failures should never break plugin execution.
    }
  }

  return {
    debug: (message, extra) => {
      void write("debug", message, extra)
    },
    info: (message, extra) => {
      void write("info", message, extra)
    },
    warn: (message, extra) => {
      void write("warn", message, extra)
    },
    error: (message, extra) => {
      void write("error", message, extra)
    },
  }
}
