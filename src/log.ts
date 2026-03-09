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
  const hasExtra = (extra?: LogExtra) => extra !== undefined && Object.keys(extra).length > 0

  return {
    debug: (message, extra) => {
      if (hasExtra(extra)) {
        console.debug(format(message), extra)
        return
      }

      console.debug(format(message))
    },
    info: (message, extra) => {
      if (hasExtra(extra)) {
        console.info(format(message), extra)
        return
      }

      console.info(format(message))
    },
    warn: (message, extra) => {
      if (hasExtra(extra)) {
        console.warn(format(message), extra)
        return
      }

      console.warn(format(message))
    },
    error: (message, extra) => {
      if (hasExtra(extra)) {
        console.error(format(message), extra)
        return
      }

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
