/**
 * 外部语言服务（stdio JSON-RPC）的包内工作类型：在等的请求、在等的诊断、打开着的文档。
 * 带回调，所以不放进可移植数据文件。
 */
import type { TimerLease } from '@velaros-ai/core/utils/TimerScope'

import type { ExternalLanguageDiagnostic } from './development.js'

/** 一条发出去还没回来的 JSON-RPC 请求。 */
export interface ExternalLanguagePendingResponse {
  /** 收到 result 时兑现。 */
  readonly resolve: (value: unknown) => void
  /** 收到 error、进程挂掉或超时时拒绝。 */
  readonly reject: (error: Error) => void
  /** 超时定时器的租约，兑现时要取消。 */
  readonly timer: TimerLease
  /** 摘掉中止监听器；请求收尾时必须调，否则监听器留在信号上。 */
  readonly removeAbort: () => void
}

/** 一个在等 `publishDiagnostics` 的文件。 */
export interface ExternalLanguagePendingDiagnostics {
  /** 收到诊断（或超时、进程挂掉）时兑现。 */
  readonly resolve: (value: readonly ExternalLanguageDiagnostic[]) => void
  /** 等待超时定时器的租约，兑现时要取消。 */
  readonly timer: TimerLease
}

/** 一个文件的诊断结果 + 它是不是「等到超时都没等到」的空结果。 */
export interface ExternalLanguageDiagnosticsOutcome {
  /** 语言服务发回的诊断；超时就是空数组。 */
  readonly diagnostics: readonly ExternalLanguageDiagnostic[]
  /** 真为「等到超时也没收到」：此时空结果不代表这个文件没有问题。 */
  readonly timedOut: boolean
}

/** 已经 `didOpen` 过的文档：后续改动按版本号发 `didChange`。 */
export interface ExternalLanguageOpenDocument {
  /** 打开时用的 LSP languageId。 */
  readonly languageId: string
  /** 文档版本号，每次同步正文加一。 */
  version: number
}
