import type { AppError } from '@velaros-ai/core/error'
import type { ScopedLog } from '@velaros-ai/core/logger'

import type { AgentRuntimeEventBus } from '../../types/runner.js'
import { emitAgentRuntimeAbort, emitAgentRuntimeDone, handleAgentRuntimeStreamError, isAgentRuntimeAbortError, resolveAgentRuntimeAbortMessage } from '../../utils/runner/runtime-events'

/**
 * 智能体循环运行时事件辅助器。
 *
 * 把中断、步数上限和错误映射留在宿主运行时接线之外。
 * 宿主只需要提供带运行时事件发送能力的事件总线。
 *
 * 判定与发事件的规则本身是纯函数（utils/runner/runtime-events.ts），这里只把它们收成一件可注入的东西。
 */
export interface AgentRuntimeEventsApi {
  /**
   * 收口一次流失败：是终止就记 info 并发 aborted 事件，是真错误才记 error 并发 error 事件。
   * 从不抛错；要不要重试由调用方按发出去的事件决定。
   */
  handleStreamError(
    error: unknown,
    turn: number,
    abortSignal: AbortSignal,
    events: AgentRuntimeEventBus,
    log: ScopedLog
  ): void
  /** 本轮正常跑完时发一条 done，宿主据此收掉流。 */
  emitDone(events: AgentRuntimeEventBus): void
  /** 主动停止时发一条 aborted（错误码 `EXECUTION_ABORTED`），下游把本轮收成"停止"而不是"失败"；不给文案就用默认的。 */
  emitAbort(events: AgentRuntimeEventBus, message?: string): void
  /**
   * 判定一次流失败是不是"被终止"：终止信号已拉起、错误码是 `EXECUTION_ABORTED`、
   * 原始错误或其 cause 名为 `AbortError`、或文本里出现 abort / cancelled / canceled，任一成立即为真。
   */
  isAbortError(originalError: unknown, error: AppError, abortSignal: AbortSignal): boolean
  /** 取这次终止显示给用户的原因：优先终止信号的 `reason`，其次错误 message，都不可用时回落到默认文案。 */
  getAbortMessage(error: AppError, abortSignal: AbortSignal): string
}

class AgentRuntimeEvents implements AgentRuntimeEventsApi {
  public handleStreamError(
    error: unknown,
    turn: number,
    abortSignal: AbortSignal,
    events: AgentRuntimeEventBus,
    log: ScopedLog
  ): void {
    handleAgentRuntimeStreamError(error, turn, abortSignal, events, log)
  }

  public emitDone(events: AgentRuntimeEventBus): void {
    emitAgentRuntimeDone(events)
  }

  public emitAbort(events: AgentRuntimeEventBus, message?: string): void {
    emitAgentRuntimeAbort(events, message)
  }

  public isAbortError(originalError: unknown, error: AppError, abortSignal: AbortSignal): boolean {
    return isAgentRuntimeAbortError(originalError, error, abortSignal)
  }

  public getAbortMessage(error: AppError, abortSignal: AbortSignal): string {
    return resolveAgentRuntimeAbortMessage(error, abortSignal)
  }
}

export { AgentRuntimeEvents }
