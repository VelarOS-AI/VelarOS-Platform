import { AppError, type ErrorCode } from '../error.js'

import type { LogContext, LogErrorOptions } from './types.js'

export class LogError extends AppError {
  readonly scope: string
  readonly context: LogContext

  constructor(
    scope: string,
    message: string,
    options: LogErrorOptions = {},
    fallbackCode: ErrorCode = 'LOG_FAILURE'
  ) {
    super(
      options.code ?? fallbackCode,
      `[${scope}] ${message}`,
      options.cause,
      options.context ?? {}
    )
    this.name = 'LogError'
    this.scope = scope
    this.context = options.context ?? {}
  }
}

export class LogAssertionError extends LogError {
  constructor(scope: string, message: string, options: LogErrorOptions = {}) {
    super(scope, message, options, 'LOG_ASSERTION')
    this.name = 'LogAssertionError'
  }
}
