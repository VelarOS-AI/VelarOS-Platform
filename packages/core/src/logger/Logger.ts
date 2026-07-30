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

