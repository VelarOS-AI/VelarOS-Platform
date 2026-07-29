export type ErrorCode =
  | 'UNKNOWN'
  | 'NETWORK'
  | 'IPC'
  | 'PERMISSION'
  | 'PLATFORM'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | (string & {})

export interface SerializedError {
  code: ErrorCode
  message: string
  context?: Record<string, unknown>
}

/** Structural result contract accepted from any product adapter. */
export type Result<T> = { ok: true; data: T } | { ok: false; error: SerializedError }
