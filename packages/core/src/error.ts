/**
 * 统一错误类型
 *
 * 使用方式：
 *   throw new AppError('NETWORK', '请求超时')
 *   throw AppError.from(error, 'IPC')
 */

import { isEmpty } from './utils/array.js'
import { optionalWhen } from './utils/optionalWhen.js'
import { isArray, isBoolean, isNumber, isObject, isPlainObject,isPresent, isString } from './typeGuards'

export type ErrorCode =
  | 'UNKNOWN'
  | 'NETWORK'
  | 'IPC'
  | 'PERMISSION'
  | 'PLATFORM'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'ASSERTION'
  | 'INVARIANT'
  | 'LOG_FAILURE'
  | 'LOG_ASSERTION'
  | (string & {})

export type ErrorContext = Record<string, unknown>

export interface AppErrorOptions {
  code?: ErrorCode
  cause?: unknown
  context?: ErrorContext
}

export class AppError extends Error {
  readonly code: ErrorCode
  readonly cause?: unknown
  readonly context: ErrorContext

  public static [Symbol.hasInstance](value: unknown): boolean {
    if (this !== AppError) return Function.prototype[Symbol.hasInstance].call(this, value)

    const record = value as Error & { code?: unknown; message?: unknown }
    return (
      value instanceof Error &&
      value.name === 'AppError' &&
      isString(record.code) &&
      isString(record.message)
    )
  }

  constructor(code: ErrorCode, message: string, cause?: unknown, context: ErrorContext = {}) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.cause = cause
    this.context = context
  }

  /** 从未知 catch 值构造 AppError */
  public static from(err: unknown, code: ErrorCode = 'UNKNOWN'): AppError {
    if (err instanceof AppError) return err
    if (this.isSerializedError(err)) return new AppError(err.code, err.message, undefined, err.context ?? {})
    const message = this.getMessage(err)
    const resolvedCode = code === 'UNKNOWN' ? (this.getCode(err) ?? code) : code
    return new AppError(resolvedCode, message, err)
  }

  public static getMessage(err: unknown): string {
    if (this.isSerializedError(err)) return err.message

    return this.findMessage(err) ?? this.stringifyUnknown(err)
  }

  /** 序列化为可跨 IPC 传输的纯对象 */
  public toJSON(): SerializedError {
    return {
      code: this.code,
      message: this.message,
      context: optionalWhen(!isEmpty(Object.keys(this.context)), this.context),
    }
  }

  public static fromJSON(obj: SerializedError): AppError {
    return new AppError(obj.code, obj.message, undefined, obj.context ?? {})
  }

  private static findMessage(value: unknown, depth = 0): Nullable<string> {
    if (depth > 5 || !isPresent(value)) return null

    if (isString(value)) return this.normalizeMessage(value)

    if (isNumber(value) || isBoolean(value)) return String(value)

    if (value instanceof Error) return (
        this.normalizeMessage(value.message) ??
        this.findMessage((value as Error & { cause?: unknown }).cause, depth + 1)
      )

    if (isArray(value)) {
      for (const item of value) {
        const message = this.findMessage(item, depth + 1)
        if (message) return message
      }
      return null
    }

    if (isPlainObject(value)) {
      const record = value
      return (
        this.readStringField(record, 'message') ??
        this.findMessage(record.error, depth + 1) ??
        this.findMessage(record.cause, depth + 1) ??
        this.findMessage(record.lastError, depth + 1) ??
        this.findMessage(record.errors, depth + 1)
      )
    }

    return null
  }

  private static getCode(value: unknown, depth = 0): Nullable<ErrorCode> {
    if (depth > 5 || !isPresent(value)) return null

    if (this.isSerializedError(value)) return value.code

    if (value instanceof AppError) return value.code

    if (value instanceof Error) {
      const error = value as Error & { code?: unknown; cause?: unknown }
      return this.normalizeCode(error.code) ?? this.getCode(error.cause, depth + 1)
    }

    if (isArray(value)) {
      for (const item of value) {
        const code = this.getCode(item, depth + 1)
        if (code) return code
      }
      return null
    }

    if (!isPlainObject(value)) return null

    const record = value
    const nestedCode =
      this.getCode(record.error, depth + 1) ??
      this.getCode(record.cause, depth + 1) ??
      this.getCode(record.lastError, depth + 1) ??
      this.getCode(record.errors, depth + 1)

    return nestedCode ?? this.normalizeCode(record.code) ?? this.normalizeCode(record.type)
  }

  private static readStringField(record: Record<string, unknown>, key: string): Nullable<string> {
    const value = record[key]
    return isString(value) ? this.normalizeMessage(value) : null
  }

  private static normalizeMessage(message: string): Nullable<string> {
    const normalized = message.trim()
    if (
      !normalized ||
      normalized === '[object Object]' ||
      normalized === 'undefined' ||
      normalized === 'null'
    ) return null

    return normalized
  }

  private static normalizeCode(code: unknown): Nullable<ErrorCode> {
    if (!isString(code)) return null

    const normalized = code.trim()
    if (!normalized || normalized === 'error') return null

    return normalized
  }

  private static stringifyUnknown(value: unknown): string {
    if (!isPresent(value)) return String(value)

    if (!isObject(value)) return String(value)

    try {
      const seen = new WeakSet<object>()
      const json = JSON.stringify(value, (key, nestedValue) => {
        if (this.isSensitiveErrorField(key)) return '[redacted]'

        if (isObject(nestedValue)) {
          if (seen.has(nestedValue)) return '[circular]'
          seen.add(nestedValue)
        }

        return nestedValue
      })

      return json ? this.truncate(json, 1_000) : Object.prototype.toString.call(value)
    } catch {
      // arch-guard:silent-catch-ok 错误字符串化不能依赖日志器，也不能递归抛错。
      return Object.prototype.toString.call(value)
    }
  }

  private static isSensitiveErrorField(key: string): boolean {
    const normalized = key.toLowerCase()
    return (
      normalized.includes('apikey') ||
      normalized.includes('authorization') ||
      normalized.includes('token') ||
      normalized === 'input' ||
      normalized === 'messages' ||
      normalized === 'requestbodyvalues'
    )
  }

  private static truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) return value

    return `${value.slice(0, maxLength - 1)}…`
  }

  private static isSerializedError(value: unknown): value is SerializedError {
    if (!isPlainObject(value)) return false

    const record = value
    return (
      isString(record.code) &&
      isString(record.message) &&
      (isObject(record.context) || !isPresent(record.context))
    )
  }
}

export interface SerializedError {
  code: ErrorCode
  message: string
  context?: ErrorContext
}
