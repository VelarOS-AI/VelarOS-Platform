import { AppError, type ErrorCode } from '../error.js'

import type { LogErrorOptions } from './types.js'

export class LogError extends AppError {
  readonly scope: string

  constructor(
    scope: string,
    message: string,
    options: LogErrorOptions = {},
    fallbackCode: ErrorCode = 'LOG_FAILURE'
  ) {
    // context 由 AppError 持有（`LogContext` 与 `ErrorContext` 同形），此处不再复制第二份。
    super(
      options.code ?? fallbackCode,
      `[${scope}] ${message}`,
      options.cause,
      options.context ?? {}
    )
    this.name = 'LogError'
    this.scope = scope
  }
}

export class LogAssertionError extends LogError {
  constructor(scope: string, message: string, options: LogErrorOptions = {}) {
    super(scope, message, options, 'LOG_ASSERTION')
    this.name = 'LogAssertionError'
  }
}
