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
    /**
     * warn 也要收。Phaser 报「贴图 key 不存在」「动画 key 不存在」这一整族走的是
     * `console.warn` —— 只补 `console.error` 等于把引擎最常用的那条抱怨通道留在表外，
     * 于是画面上是占位棋盘格、`select:'errors'` 却干干净净。
     */
    // @arch-guard:suspend code-style/forbid-console 理由：本模块**就是** console 拦截器，跑在被服务的
    // 游戏页面里(dist/browser/page.js)而不是主进程,Log 管线不在那儿;改走 Log 会把要拦的东西变成自己。
    const originalConsoleWarn = console.warn
    const capturedConsoleWarn = (...values: unknown[]) => {
      this.report({
        source: 'console',
        message: values.map(stringifyConsoleValue).join(' '),
      })
      originalConsoleWarn(...values)
    }
    // @arch-guard:suspend code-style/forbid-console 理由：同上——安装拦截点，不是在打日志。
    console.error = capturedConsoleError
    // @arch-guard:suspend code-style/forbid-console 理由：同上——安装拦截点，不是在打日志。
    console.warn = capturedConsoleWarn
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onUnhandledRejection)

    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onUnhandledRejection)
      // @arch-guard:suspend code-style/forbid-console 理由：同上——卸载拦截点，还原原始实现。
      if (console.error === capturedConsoleError) console.error = originalConsoleError
      // @arch-guard:suspend code-style/forbid-console 理由：同上——卸载拦截点，还原原始实现。
      if (console.warn === capturedConsoleWarn) console.warn = originalConsoleWarn
    }
  }
}
