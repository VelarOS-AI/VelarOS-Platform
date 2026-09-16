import { AppError } from '@velaros-ai/core/error'
import type { ScopedLog } from '@velaros-ai/core/logger'
import { readFirstString } from '@velaros-ai/core/utils/unknownJsonRecord'

import type { AgentRuntimeEventBus } from '../../types/runner.js'
import { ChatRuntimeEvents } from '../wire/chat-runtime.js'

/** 取一个错误对象的 `name`：不是 `Error` 实例（字符串、普通对象、undefined）时返回 null，调用方据此跳过判名。 */
function readErrorName(error: unknown): Nullable<string> {
  return error instanceof Error ? error.name : null
}

/**
 * 判定一次流失败到底是不是"被终止"，而不是真错误。四条任一成立即为真：
 * 终止信号已经拉起；错误码是 `EXECUTION_ABORTED`；原始错误或它的 cause 名字是 `AbortError`；
 * 错误文本里出现 abort / cancelled / canceled。
 * 宁可判宽：把真错误误当成终止只是少报一条 error 事件，反过来会在用户主动停止时弹出一条假报错。
 */
export function isAgentRuntimeAbortError(
  originalError: unknown,
  error: AppError,
  abortSignal: AbortSignal
): boolean {
  if (abortSignal.aborted) return true

  if (error.code === 'EXECUTION_ABORTED') return true

  const cause = error.cause
  const originalName = readErrorName(originalError)
  const causeName = readErrorName(cause)
  if (originalName === 'AbortError' || causeName === 'AbortError') return true

  const normalized = error.message.toLowerCase()
  return (
    normalized.includes('abort') ||
    normalized.includes('cancelled') ||
    normalized.includes('canceled')
  )
}

/** 取这次终止对用户显示的原因：优先用终止信号自带的 `reason`，其次错误自己的 message，两者都不是字符串时回落到默认文案。 */
export function resolveAgentRuntimeAbortMessage(error: AppError, abortSignal: AbortSignal): string {
  return readFirstString(abortSignal.reason, error.message) ?? '运行被终止'
}

/** 往事件总线发一条运行被终止：带 `EXECUTION_ABORTED` 错误码，下游据此把本轮收成"停止"而不是"失败"。 */
export function emitAgentRuntimeAbort(events: AgentRuntimeEventBus, message = '运行被终止'): void {
  events.emitRuntime(ChatRuntimeEvents.aborted(message, undefined, 'EXECUTION_ABORTED'))
}

/** 往事件总线发一条本轮正常收尾。 */
export function emitAgentRuntimeDone(events: AgentRuntimeEventBus): void {
  events.emitRuntime(ChatRuntimeEvents.done())
}

/**
 * 收口一次流失败：先把任意抛出物归一成 `AppError`，是终止就记 info 日志并发 aborted 事件，
 * 是真错误才记 error 日志并把 message / code / context 原样发成 error 事件。
 * 本函数从不抛错，也不决定要不要重试——重试由调用方按发出去的事件决定。
 */
export function handleAgentRuntimeStreamError(
  error: unknown,
  turn: number,
  abortSignal: AbortSignal,
  events: AgentRuntimeEventBus,
  log: ScopedLog
): void {
  const appError = AppError.from(error)
  if (isAgentRuntimeAbortError(error, appError, abortSignal)) {
    const message = resolveAgentRuntimeAbortMessage(appError, abortSignal)
    log.info('stream aborted', { turn, message })
    emitAgentRuntimeAbort(events, message)
    return
  }

  log.error('stream error', appError)
  events.emitRuntime(ChatRuntimeEvents.error(appError.message, appError.code, appError.context))
}
