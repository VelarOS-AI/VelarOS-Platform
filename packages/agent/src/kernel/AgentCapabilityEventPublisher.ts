import { Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import {
  type AgentCapabilityExecutionChannel,
  type AgentCapabilityExecutionDescriptorV1,
  AgentCapabilityExecutionEventType,
  createAgentCapabilityExecutionEventEnvelopeV1,
} from '../protocol/agent-capability'

const log = Log.tag('AgentCapabilityEventPublisher')

export type AgentCapabilityKernelEventDelivery = (
  type: string,
  payload: unknown,
) => Promise<void>

/**
 * 把 Agent 的同步多通道事件总线接到 Kernel 的异步事件发布口。
 *
 * 所有通道共用同一条 Promise 尾链，因而保持跨通道顺序。单次投递失败只记入诊断，不会
 * 截断已接受的后续事件或产生未处理拒绝；关闭后不再接收迟到事件，并等待现有队列排空。
 */
export class AgentCapabilityEventPublisher {
  private tail: Promise<void> = Promise.resolve()
  private accepting = true
  private drainPromise?: Promise<void>

  public constructor(
    private readonly deliver: AgentCapabilityKernelEventDelivery,
    private readonly execution: AgentCapabilityExecutionDescriptorV1,
    private readonly onDeliveryError: (error: unknown) => void,
  ) {}

  public enqueue(channel: AgentCapabilityExecutionChannel, payload: unknown): boolean {
    if (!this.accepting) return false

    const envelope = createAgentCapabilityExecutionEventEnvelopeV1(
      this.execution,
      channel,
      payload,
    )
    this.tail = this.tail
      .then(() => this.deliver(AgentCapabilityExecutionEventType, envelope))
      .catch((error: unknown) => {
        try {
          this.onDeliveryError(error)
        } catch (diagnosticError) {
          // 诊断回调不得破坏能力的结束边界，但自身失败仍进入统一日志管道。
          log.warn('Agent capability delivery diagnostic failed', {
            deliveryError: AppError.getMessage(error),
            diagnosticError: AppError.getMessage(diagnosticError),
          })
        }
      })
    return true
  }

  public closeAndDrain(): Promise<void> {
    this.accepting = false
    this.drainPromise ??= this.tail
    return this.drainPromise
  }
}
