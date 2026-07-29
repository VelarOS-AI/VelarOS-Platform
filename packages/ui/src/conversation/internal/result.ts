import { isArray, isBoolean, isNumber, isObject, isPresent, isString } from './runtime'

import type { ErrorCode, Result as ResultValue, SerializedError } from '#contracts'

export type Result<T> = ResultValue<T>

export class AppError extends Error {
  readonly code: ErrorCode
  readonly context: Record<string, unknown>

  constructor(
    code: ErrorCode,
    message: string,
    readonly cause?: unknown,
    context: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.context = context
  }

  public static from(error: unknown, code: ErrorCode = 'UNKNOWN'): AppError {
    if (error instanceof AppError) return error
    if (this.isSerialized(error)) return new AppError(error.code, error.message, undefined, error.context)
    return new AppError(code, this.getMessage(error), error)
  }

  public static fromJSON(error: SerializedError): AppError {
    return new AppError(error.code, error.message, undefined, error.context)
  }

  public static getMessage(error: unknown): string {
    const message = this.findMessage(error)
    if (message) return message
    try {
      return isObject(error) ? JSON.stringify(error) : String(error)
    } catch {
      return Object.prototype.toString.call(error)
    }
  }

  public toJSON(): SerializedError {
    return {
      code: this.code,
      message: this.message,
      ...(Object.keys(this.context).length ? { context: this.context } : {}),
    }
  }

  private static findMessage(value: unknown, depth = 0): Nullable<string> {
    if (depth > 5 || !isPresent(value)) return null
    if (isString(value)) return value.trim() || null
    if (isNumber(value) || isBoolean(value)) return String(value)
    if (value instanceof Error) return value.message.trim() || this.findMessage(value.cause, depth + 1)
    if (isArray(value)) {
      for (const entry of value) {
        const message = this.findMessage(entry, depth + 1)
        if (message) return message
      }
      return null
    }
    if (!isObject(value)) return null
    const record = value as Record<string, unknown>
    return (
      this.findMessage(record.message, depth + 1) ??
      this.findMessage(record.error, depth + 1) ??
      this.findMessage(record.cause, depth + 1)
    )
  }

  private static isSerialized(value: unknown): value is SerializedError {
    if (!isObject(value)) return false
    const record = value as Record<string, unknown>
    return isString(record.code) && isString(record.message)
  }
}

export const Result = {
  ok<T>(data: T): Result<T> {
    return { ok: true, data }
  },
  fail<T>(error: unknown): Result<T> {
    return { ok: false, error: AppError.from(error).toJSON() }
  },
  unwrap<T>(result: Result<T>): T {
    if (result.ok) return result.data
    throw AppError.fromJSON(result.error)
  },
  match<T, U>(
    result: Result<T>,
    handlers: { ok: (data: T) => U; fail: (error: AppError) => U }
  ): U {
    return result.ok ? handlers.ok(result.data) : handlers.fail(AppError.fromJSON(result.error))
  },
}
