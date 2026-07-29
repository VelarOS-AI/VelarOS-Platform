import type { AppErrorOptions } from '../error'

import type { Logger } from './Logger'

export type LogLevel = 'trace' | 'debug' | 'info' | 'success' | 'warn' | 'error' | 'fatal'

export type LogEnvironment = 'development' | 'production' | 'test'

export type LogPlatform =
  | 'browser'
  | 'electron-main'
  | 'electron-renderer'
  | 'worker'
  | 'node'
  | 'unknown'

export type LogContext = Record<string, unknown>

export interface LogRuntimeOptions {
  appName?: string
  serviceName?: string
  environment?: LogEnvironment
  platform?: LogPlatform
  level?: LogLevel
  consoleEnabled?: boolean
  staticContext?: LogContext
}

export type LogErrorOptions = AppErrorOptions

export interface LogMessageRecord {
  kind: 'message'
  scope: string
  level: LogLevel
  message: string
  args: unknown[]
  error?: unknown
  timestamp: Date
  environment: LogEnvironment
  platform: LogPlatform
  appName?: string
  serviceName?: string
  context: LogContext
}

export interface LogEventRecord {
  kind: 'event'
  scope: string
  name: string
  payload: LogContext
  timestamp: Date
  environment: LogEnvironment
  platform: LogPlatform
  appName?: string
  serviceName?: string
  context: LogContext
}

export type LogRecord = LogMessageRecord | LogEventRecord
export type LogEntry = LogMessageRecord

export interface LogTransport {
  id: string
  enabled?: boolean
  minLevel?: LogLevel
  accepts?: (record: LogRecord) => boolean
  write: (record: LogRecord) => void | Promise<void>
  flush?: () => void | Promise<void>
  dispose?: () => void | Promise<void>
}

export interface ScopedLog {
  readonly scope: string
  child(scope: string, context?: LogContext): ScopedLog
  withContext(context: LogContext): ScopedLog
  trace(message: string, ...args: unknown[]): void
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  success(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  fatal(message: string, ...args: unknown[]): void
  caught(message: string, error: unknown, ...args: unknown[]): void
  event(name: string, payload?: LogContext): void
  check(condition: unknown, message: string, options?: LogErrorOptions): void
  ensure<T>(value: T, message: string, options?: LogErrorOptions): NonNullable<T>
  fail(message: string, options?: LogErrorOptions): never
}

export interface GlobalLog {
  configure(options: Partial<LogRuntimeOptions>): void
  setLevel(level: LogLevel): void
  pause(): void
  resume(): void
  tag(scope: string, context?: LogContext): Logger
  event(name: string, payload?: LogContext): void
  addTransport(transport: LogTransport): void
  tryAddTransport(transport: LogTransport): boolean
  removeTransport(id: string): boolean
  hasTransport(id: string): boolean
  listTransports(): string[]
  flush(): Promise<void>
  dispose(): Promise<void>
}

export interface CallbackTransportOptions {
  id?: string
  enabled?: boolean
  minLevel?: LogLevel
  accepts?: (record: LogRecord) => boolean
  write: (record: LogRecord) => void | Promise<void>
  flush?: () => void | Promise<void>
  dispose?: () => void | Promise<void>
}

export interface MemoryTransport extends LogTransport {
  readonly records: readonly LogRecord[]
  clear(): void
}

export interface MemoryTransportOptions {
  id?: string
  limit?: number
  accepts?: LogTransport['accepts']
  minLevel?: LogLevel
}
