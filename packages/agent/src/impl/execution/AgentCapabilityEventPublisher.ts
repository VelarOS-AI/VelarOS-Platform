import { Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { AgentCapabilityExecutionChannel, AgentCapabilityExecutionDescriptorV1 } from '../../types/agent.js'
import type { AgentCapabilityKernelEventDelivery } from '../../types/execution.js'
import { AgentCapabilityExecutionEventType, createAgentCapabilityExecutionEventEnvelopeV1 } from '../../utils/wire/agent-capability'

const log = Log.tag('AgentCapabilityEventPublisher')

/**
 * 把 Agent 的同步多通道事件总线接到 Kernel 的异步事件发布口。
 *
 * 所有通道共用同一条 Promise 尾链，因而保持跨通道顺序。单次投递失败只记入诊断，不会
 * 截断已接受的后续事件或产生未处理拒绝；关闭后不再接收迟到事件，并等待现有队列排空。
 */
export interface AgentCapabilityEventPublisherApi {
  /**
   * 接一条事件进队：返回 `true` 表示已接受并排进尾链（**不代表已投递成功**），`false` 表示已经关闭、这条被丢弃。
   * 投递失败只走诊断回调与日志，不会中断尾链，也不会向调用方抛错。
   */
  enqueue(channel: AgentCapabilityExecutionChannel, payload: unknown): boolean
  /** 关闭准入并等待队列排空；之后的 `enqueue` 一律返回 false。重复调用返回同一个 Promise，多处收尾可以各等各的。 */
  closeAndDrain(): Promise<void>
}

export class AgentCapabilityEventPublisher implements AgentCapabilityEventPublisherApi {
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

/** 建一台 Agent 能力事件发布器：把执行事件按信封发到内核事件总线。 */
export function createAgentCapabilityEventPublisher(deliver: AgentCapabilityKernelEventDelivery, execution: AgentCapabilityExecutionDescriptorV1, onDeliveryError: (error: unknown) => void): AgentCapabilityEventPublisherApi {
  return new AgentCapabilityEventPublisher(deliver, execution, onDeliveryError)
}
