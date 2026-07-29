import { type Logger } from './Logger.js'
import { LogRuntime } from './runtime.js'
import type { LogContext } from './types.js'

const logRuntime = new LogRuntime()

const LoggerFactory = {
  create(scope: string, context: LogContext = {}): Logger {
    return logRuntime.tag(scope, context)
  },
}

export { LoggerFactory, logRuntime }
