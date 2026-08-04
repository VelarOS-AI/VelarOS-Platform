import type { ChatRuntimeEvent } from '@velaros-ai/agent/protocol'
import { ChatRuntimeEvents } from '@velaros-ai/agent/protocol'
import { AppError } from '@velaros-ai/core/error'
import type { ScopedLog } from '@velaros-ai/core/logger'
import { readFirstString } from '@velaros-ai/core/utils/unknownJsonRecord'

interface AgentRuntimeEventBus {
  emitRuntime(event: ChatRuntimeEvent): void
}

/**
 * 智能体循环运行时事件辅助器。
 *
 * 把中断、步数上限和错误映射留在宿主运行时接线之外。
 * 宿主只需要提供带运行时事件发送能力的事件总线。
 */
class AgentRuntimeEvents {
  public handleStreamError(
    error: unknown,
    turn: number,
    abortSignal: AbortSignal,
    events: AgentRuntimeEventBus,
    log: ScopedLog
  ): void {
    const appError = AppError.from(error)
    if (this.isAbortError(error, appError, abortSignal)) {
      const message = this.getAbortMessage(appError, abortSignal)
      log.info('stream aborted', { turn, message })
      this.emitAbort(events, message)
      return
    }

    log.error('stream error', appError)
    events.emitRuntime(ChatRuntimeEvents.error(appError.message, appError.code, appError.context))
  }

  public emitDone(events: AgentRuntimeEventBus): void {
    events.emitRuntime(ChatRuntimeEvents.done())
  }

  public emitAbort(events: AgentRuntimeEventBus, message = '运行被终止'): void {
    events.emitRuntime(ChatRuntimeEvents.aborted(message, undefined, 'EXECUTION_ABORTED'))
  }

  public isAbortError(originalError: unknown, error: AppError, abortSignal: AbortSignal): boolean {
    if (abortSignal.aborted) return true

    if (error.code === 'EXECUTION_ABORTED') return true

    const cause = error.cause
    const originalName = this.readErrorName(originalError)
    const causeName = this.readErrorName(cause)
    if (originalName === 'AbortError' || causeName === 'AbortError') return true

    const normalized = error.message.toLowerCase()
    return (
      normalized.includes('abort') ||
      normalized.includes('cancelled') ||
      normalized.includes('canceled')
    )
  }

  public getAbortMessage(error: AppError, abortSignal: AbortSignal): string {
    return readFirstString(abortSignal.reason, error.message) ?? '运行被终止'
  }

  private readErrorName(error: unknown): Nullable<string> {
    return error instanceof Error ? error.name : null
  }
}

export { AgentRuntimeEvents }
export type { AgentRuntimeEventBus }
