import type { GameRuntimeErrorRecord } from '../core/ports.js'

export interface GameRuntimeErrorInput {
  readonly message: string
  readonly source: GameRuntimeErrorRecord['source']
  readonly file?: string
  readonly line?: number
  readonly stack?: string
  readonly at?: number
}

function normalizeSignature(input: GameRuntimeErrorInput): string {
  return [
    input.source,
    input.message.replace(/\s+/gu, ' ').trim(),
    input.file ?? '',
    input.line ?? '',
  ].join('|')
}

function stringifyConsoleValue(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export class GameRuntimeDiagnostics {
  private readonly records = new Map<string, GameRuntimeErrorRecord>()

  public report(input: GameRuntimeErrorInput): GameRuntimeErrorRecord {
    const signature = normalizeSignature(input)
    const at = input.at ?? Date.now()
    const existing = this.records.get(signature)
    const record: GameRuntimeErrorRecord = {
      signature,
      message: input.message,
      source: input.source,
      ...(input.file ? { file: input.file } : {}),
      ...(input.line === undefined ? {} : { line: input.line }),
      ...(input.stack ? { stack: input.stack } : {}),
      count: (existing?.count ?? 0) + 1,
      firstAt: existing?.firstAt ?? at,
      lastAt: at,
    }
    this.records.set(signature, record)
    return record
  }

  public list(): readonly GameRuntimeErrorRecord[] {
    return [...this.records.values()].sort((left, right) => right.lastAt - left.lastAt)
  }

  public clear(): void {
    this.records.clear()
  }

  public installWindowCapture(): () => void {
    const onError = (event: ErrorEvent) => {
      this.report({
        source: 'runtime',
        message: event.message || 'Unknown window error',
        ...(event.filename ? { file: event.filename } : {}),
        ...(event.lineno > 0 ? { line: event.lineno } : {}),
        ...(event.error instanceof Error && event.error.stack ? { stack: event.error.stack } : {}),
      })
    }
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason
      this.report({
        source: 'runtime',
        message: reason instanceof Error ? reason.message : stringifyConsoleValue(reason),
        ...(reason instanceof Error && reason.stack ? { stack: reason.stack } : {}),
      })
    }
    const originalConsoleError = console.error
    const capturedConsoleError = (...values: unknown[]) => {
      this.report({
        source: 'console',
        message: values.map(stringifyConsoleValue).join(' '),
      })
      originalConsoleError(...values)
    }
    console.error = capturedConsoleError
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onUnhandledRejection)

    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onUnhandledRejection)
      if (console.error === capturedConsoleError) console.error = originalConsoleError
    }
  }
}
