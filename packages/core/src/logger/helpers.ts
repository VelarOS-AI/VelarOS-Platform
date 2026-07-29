import { isFunction, isObject, isPresent, isString } from '../typeGuards.js'
import { isEmpty } from '../utils/array.js'

import type {
  LogContext,
  LogEnvironment,
  LogErrorOptions,
  LogLevel,
  LogMessageRecord,
  LogPlatform,
  LogRecord,
  LogTransport,
} from './types.js'

export const LEVEL_TO_NUMERIC: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  success: 2,
  warn: 3,
  error: 4,
  fatal: 5,
}

export const LEVEL_TO_CONSOLE_METHOD: Record<LogLevel, 'log' | 'info' | 'warn' | 'error'> = {
  trace: 'log',
  debug: 'log',
  info: 'info',
  success: 'info',
  warn: 'warn',
  error: 'error',
  fatal: 'error',
}

export const LEVEL_TO_PREFIX: Record<LogLevel, string> = {
  trace: '[TRC]',
  debug: '[DBG]',
  info: '[INF]',
  success: '[SUC]',
  warn: '[WRN]',
  error: '[ERR]',
  fatal: '[FTL]',
}

const ANSI_RESET = '\u001B[0m'
const ANSI_MUTED = '\u001B[90m'

const LEVEL_TO_ANSI_COLOR: Record<LogLevel, string> = {
  trace: ANSI_MUTED,
  debug: '\u001B[36m',
  info: '\u001B[34m',
  success: '\u001B[32m',
  warn: '\u001B[33m',
  error: '\u001B[31m',
  fatal: '\u001B[35m',
}

type ImportMetaEnv = {
  DEV?: boolean
  PROD?: boolean
  MODE?: string
}

export function detectEnvironment(): LogEnvironment {
  const metaEnv = (import.meta as ImportMeta & { env?: ImportMetaEnv }).env
  const mode = isString(metaEnv?.MODE) ? metaEnv.MODE : undefined
  const nodeEnv = getGlobalProcess()?.env?.NODE_ENV

  if (mode === 'test' || nodeEnv === 'test') return 'test'
  if (mode === 'production' || metaEnv?.PROD || nodeEnv === 'production') return 'production'
  return 'development'
}

export function detectPlatform(): LogPlatform {
  const processRef = getGlobalProcess()
  const globalRef = globalThis as {
    window?: unknown
    document?: unknown
    self?: unknown
  }

  if (processRef?.versions?.electron) return processRef.type === 'renderer' ? 'electron-renderer' : 'electron-main'
  if (isPresent(globalRef.window) && isPresent(globalRef.document)) return 'browser'
  if (isPresent(globalRef.self) && !isPresent(globalRef.window)) return 'worker'
  if (processRef?.versions?.node) return 'node'
  return 'unknown'
}

export function detectLevel(environment: LogEnvironment): LogLevel {
  return environment === 'development' ? 'debug' : 'info'
}

export function shouldDispatch(record: LogRecord, transport: LogTransport): boolean {
  if (Object.is(transport.enabled, false)) return false
  if (transport.accepts && !transport.accepts(record)) return false
  if (record.kind === 'message' && transport.minLevel) return LEVEL_TO_NUMERIC[record.level] >= LEVEL_TO_NUMERIC[transport.minLevel]
  return true
}

export function mergeContext(...parts: Array<LogContext | undefined>): LogContext {
  return Object.assign({}, ...filterDefined(parts))
}

export function mergeErrorOptions(
  baseContext: LogContext,
  options: LogErrorOptions
): LogErrorOptions {
  return {
    ...options,
    context: mergeContext(baseContext, options.context),
  }
}

export function buildConsolePayload(record: LogMessageRecord): unknown[] {
  const payload: unknown[] = [record.message]

  if (!isEmpty(record.args)) {
    payload.push(...record.args)
  }

  if (isPresent(record.error)) {
    payload.push(record.error)
  }

  if (!isEmpty(Object.keys(record.context))) {
    payload.push({ context: record.context })
  }

  return payload
}

export function formatTimestamp(date: Date): string {
  return date.toTimeString().slice(0, 8)
}

export function formatConsoleTag(level: LogLevel, timestamp: Date, scope: string): string {
  return [
    colorizeMuted(formatTimestamp(timestamp)),
    colorizeLevel(level, LEVEL_TO_PREFIX[level]),
    colorizeMuted(`[${scope}]`),
  ].join(' ')
}

function colorizeLevel(level: LogLevel, value: string): string {
  return colorize(value, LEVEL_TO_ANSI_COLOR[level])
}

function colorizeMuted(value: string): string {
  return colorize(value, ANSI_MUTED)
}

function colorize(value: string, color: string): string {
  return `${color}${value}${ANSI_RESET}`
}

export function getGlobalProcess(): LooseOptional<{
  env?: Record<string, string>
  versions?: Record<string, string>
  type?: string
}> {
  return (
    globalThis as {
      process?: {
        env?: Record<string, string>
        versions?: Record<string, string>
        type?: string
      }
    }
  ).process
}

export function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return isObject(value) && isFunction((value as PromiseLike<void>).then)
}

export function filterDefined<T>(values: Array<T | undefined>): T[] {
  return values.filter((value): value is T => isPresent(value))
}
