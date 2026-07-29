import { isPresent } from '../typeGuards.js'

import { mergeContext, mergeErrorOptions } from './helpers.js'
import type { LogRuntime } from './runtime.js'
import type { LogContext, LogErrorOptions, LogLevel, ScopedLog } from './types.js'

export class Logger implements ScopedLog {
  constructor(
    private readonly runtime: LogRuntime,
    readonly scope: string,
    private readonly context: LogContext = {}
  ) {}

  public child(scope: string, context: LogContext = {}): Logger {
    return new Logger(
      this.runtime,
      this.scope.trim() ? `${this.scope}:${scope}` : scope,
      mergeContext(this.context, context)
    )
  }

  public withContext(context: LogContext): Logger {
    return new Logger(this.runtime, this.scope, mergeContext(this.context, context))
  }

  public trace(message: string, ...args: unknown[]): void {
    this.write('trace', message, args)
  }

  public debug(message: string, ...args: unknown[]): void {
    this.write('debug', message, args)
  }

  public info(message: string, ...args: unknown[]): void {
    this.write('info', message, args)
  }

  public success(message: string, ...args: unknown[]): void {
    this.write('success', message, args)
  }

  public warn(message: string, ...args: unknown[]): void {
    this.write('warn', message, args)
  }

  public error(message: string, ...args: unknown[]): void {
    this.write('error', message, args)
  }

  public fatal(message: string, ...args: unknown[]): void {
    this.write('fatal', message, args)
  }

  public caught(message: string, error: unknown, ...args: unknown[]): void {
    this.runtime.writeMessage({
      level: 'error',
      scope: this.scope,
      message,
      args,
      context: this.context,
      error,
    })
  }

  public event(name: string, payload: LogContext = {}): void {
    this.runtime.writeEvent({
      scope: this.scope,
      name,
      payload,
      context: this.context,
    })
  }

  public check(condition: unknown, message: string, options: LogErrorOptions = {}): void {
    if (condition) return
    throw this.runtime.createAssertionError(
      this.scope,
      message,
      mergeErrorOptions(this.context, options)
    )
  }

  public ensure<T>(value: T, message: string, options: LogErrorOptions = {}): NonNullable<T> {
    if (isPresent(value)) return value

    throw this.runtime.createAssertionError(
      this.scope,
      message,
      mergeErrorOptions(this.context, options)
    )
  }

  public fail(message: string, options: LogErrorOptions = {}): never {
    throw this.runtime.createFailureError(
      this.scope,
      message,
      mergeErrorOptions(this.context, options)
    )
  }

  private write(level: LogLevel, message: string, args: unknown[]): void {
    this.runtime.writeMessage({
      level,
      scope: this.scope,
      message,
      args,
      context: this.context,
    })
  }
}

function createNoopScopedLog(scope: string): ScopedLog {
  const log: ScopedLog = {
    scope,
    child: (childScope) =>
      createNoopScopedLog(scope.trim() ? `${scope}:${childScope}` : childScope),
    withContext: () => log,
    trace: () => {},
    debug: () => {},
    info: () => {},
    success: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    caught: () => {},
    event: () => {},
    check: (condition, message) => {
      if (!condition) throw new Error(message)
    },
    ensure: (value, message) => {
      if (!isPresent(value)) throw new Error(message)
      return value
    },
    fail: (message) => {
      throw new Error(message)
    },
  }

  return log
}

export class Loggable {
  protected readonly log: ScopedLog

  constructor(scope?: string, context: LogContext = {}) {
    const resolvedScope = scope ?? new.target.name
    const globalLog = (globalThis as typeof globalThis & { Log?: { tag: GlobalLogTag } }).Log
    this.log = globalLog?.tag(resolvedScope, context) ?? createNoopScopedLog(resolvedScope)
  }
}

type GlobalLogTag = (scope: string, context?: LogContext) => ScopedLog
