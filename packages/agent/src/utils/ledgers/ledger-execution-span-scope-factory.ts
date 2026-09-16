// LedgerExecutionSpanScopeFactory 用到的纯函数（不碰实例状态）。
import { AppError } from '@velaros-ai/core/error'

import type { SpanLedgerWarn } from '../../types/ledgers.js'

// ── scope 实现（父子指针内部记账，动词内失败隔离） ────────────────────────────────────

/**
 * 生产侧动词的**失败隔离单源**：任一 span 操作抛出都吞成 warn + null。
 *
 * 这是「纯旁路」纪律（见文件头）唯一的落地点——SoloLoop / ToolExecutor 侧才敢直呼不设防。
 * 两个 scope 实现共用同一份，别再各自 try/catch 一遍（改隔离语义要一处改完）。
 */
export function runIsolatedSpanOp<T>(warn: SpanLedgerWarn, fn: () => T, label: string): Nullable<T> {
  try {
    return fn()
  } catch (error) {
    warn(`execution span scope: ${label} failed`, { error: AppError.getMessage(error) })
    return null
  }
}
