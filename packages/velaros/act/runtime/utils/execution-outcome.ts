import {
  isArray,
  isEmpty,
  isFalse,
  isFiniteNumber,
  isPlainObject,
  isString,
  toNullable,
} from '@velaros-ai/core'

import type { ActExecutionFailure, ActExecutionSummary } from '../types/trace.js'

const CancelledCodes = ['CANCELLED', 'ABORTED']

/**
 * 一次执行的落定状态，由它的持久结果和调用回执推出；运行时记任务状态、追踪给宿主摘要都走这里。
 * 没有结果就还在运行；结果或调用回执里有未知效果（或调用没有回执）时是 unknown，要先核对，
 * 这时 failure 只在脚本本身也失败了才有。
 */
export function executionOutcome(
  result: unknown,
  receipts: ReadonlyArray<Optional<{ readonly effect?: string }>>
): Pick<ActExecutionSummary, 'status' | 'failure'> {
  if (!isPlainObject(result)) return { status: 'running', failure: null }
  const failure = executionFailure(result)
  if (
    result.effect === 'unknown' ||
    receipts.some((receipt) => !receipt || receipt.effect === 'unknown')
  )
    return { status: 'unknown', failure }
  if (!failure) return { status: 'succeeded', failure: null }
  // 同批失败后被中止的、宿主取消的、中断时一个调用都还没发出的，都算取消
  const cancelled =
    CancelledCodes.includes(failure.code) || (failure.code === 'INTERRUPTED' && isEmpty(receipts))
  return { status: cancelled ? 'cancelled' : 'failed', failure }
}

/** 结果里的失败原因：没过检查、导入了没授权的模块、脚本抛错、调用没落定、中断或被拒绝。 */
function executionFailure(result: Record<string, unknown>): Nullable<ActExecutionFailure> {
  if (result.code === 'INTERRUPTED')
    return { code: 'INTERRUPTED', message: '运行被中断，脚本没有重跑', line: null }
  if (result.status === 'rejected' || (isString(result.code) && !('checked' in result))) {
    // 没过检查的控制回执带着诊断：第一条比回执的提示更能说明哪里错了
    const diagnostic = firstDiagnostic(result.diagnostics)
    return {
      code: isString(result.code) ? result.code : 'SCRIPT_FAILED',
      message: diagnostic?.message ?? (isString(result.message) ? result.message : '脚本没有运行'),
      line: toNullable(diagnostic?.line),
    }
  }
  if (isFalse(result.checked)) {
    const modules = result.needsModules
    if (isArray(modules))
      return {
        code: 'NEEDS_MODULES',
        message: `导入了没有授权的模块：${modules.join('、')}`,
        line: null,
      }
    const diagnostic = firstDiagnostic(
      (result.check as Optional<{ diagnostics?: unknown }>)?.diagnostics
    )
    return {
      code: 'SCRIPT_CHECK',
      message: diagnostic?.message ?? '脚本没有通过检查',
      line: toNullable(diagnostic?.line),
    }
  }
  const outcome = result.result as Optional<{
    failed?: { code: string; message: string; line?: number }
    unsettled?: readonly string[]
  }>
  if (outcome?.failed)
    return {
      code: outcome.failed.code,
      message: outcome.failed.message,
      line: toNullable(outcome.failed.line),
    }
  if (outcome?.unsettled?.length)
    return {
      code: 'UNSETTLED',
      message: `脚本结束时还有调用没有落定：${outcome.unsettled.join('、')}`,
      line: null,
    }
  return null
}

/** 诊断列表里的第一条；形状不对时当作没有。 */
function firstDiagnostic(diagnostics: unknown): Optional<{ line: number; message: string }> {
  const first = isArray(diagnostics) ? diagnostics[0] : undefined
  return isPlainObject(first) && isString(first.message) && isFiniteNumber(first.line)
    ? { line: first.line, message: first.message }
    : undefined
}
