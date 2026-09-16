import type { ModelMessage } from 'ai'

import { isEmpty, toNullable } from '@velaros-ai/core'

import type { AgentRuntimeInputPort } from '../../contract/requires.js'
import type { ExecutionGuidanceClearResult, ExecutionGuidanceEnqueueResult, ExecutionGuidanceFinalizationResult, ExecutionGuidanceLane } from '../../types/records.js'
import type { AgentRuntimeInputResult } from '../../types/runner.js'
import { hasUserVisibleGuidance } from '../../utils/records/execution-guidance-queue'

/**
 * 运行中补话的队列：一次执行一条 lane，用户在模型跑着的时候补的消息先进队，
 * 由运行时在下一次取输入时消费掉；执行收尾后 lane 会被封口（sealed），之后再补的一律拒收。
 *
 * 队列和回执都只在内存里；正文另有宿主侧副本，这里的回执只带身份（inputId / sourceSessionId）和消费回调。
 * 实现是 `ExecutionGuidanceQueue`，执行服务持一份，并用 `port()` 把它包成运行时要的输入端口。
 */
export interface ExecutionGuidanceQueueApi {
  /** 入队一条补话：不是 user 消息或内容为空时返回 `invalid`；lane 不存在或已封口时返回 `closed`（执行已经收尾了）；入队成功返回 `accepted` 并唤醒正在等输入的运行时。`receipt.onConsumed` 在这条被消费时回调一次。 */
  enqueue(executionId: string, message: ModelMessage, receipt?: { inputId?: string; sourceSessionId?: string; onConsumed?: () => void }): ExecutionGuidanceEnqueueResult
  /** 取走队首那条补话（先进先出）并触发它的 `onConsumed`；lane 不存在或队列空时返回 null。 */
  consume(executionId: string): Nullable<ModelMessage>
  /** 运行时每轮要输入时调它：有补话就返回 `input`；没有就顺手把 lane 封口并返回 `sealed`，本次执行从此不再收补话。 */
  consumeOrSeal(executionId: string): AgentRuntimeInputResult
  /** 执行收尾时封口：返回 `sealed` 表示已经清干净；返回 `pending` 并带上剩余条数，表示还有没被消费的补话，调用方负责交代它们的去向。 */
  finalize(executionId: string): ExecutionGuidanceFinalizationResult
  /** 开一条 lane 并包成运行时要的输入端口。只有执行启动时该调它：迟到的生产者拿不到重新打开的通道。 */
  port(executionId: string): AgentRuntimeInputPort
  /** 丢弃这次执行的 lane：还有没消费的补话时先封口并返回 `retained` 带剩余条数（lane 留着等 `takeRetainedInputIds` 收），否则直接删掉返回 `cleared`。 */
  clear(executionId: string): ExecutionGuidanceClearResult
  /** 收尾后把某个来源会话上那些没被消费的补话的 inputId 交回给宿主（正文宿主自己有），同时删掉对应的 lane。返回交回的 inputId 列表。 */
  takeRetainedInputIds(sourceSessionId: string): string[]
}

class ExecutionGuidanceQueue implements ExecutionGuidanceQueueApi {
  private readonly lanesByExecutionId = new Map<string, ExecutionGuidanceLane>()

  public enqueue(
    executionId: string,
    message: ModelMessage,
    receipt: { inputId?: string; sourceSessionId?: string; onConsumed?: () => void } = {}
  ): ExecutionGuidanceEnqueueResult {
    if (!hasUserVisibleGuidance(message))
      return { status: 'invalid', reason: 'empty-or-non-user-message' }

    const lane = this.lanesByExecutionId.get(executionId)
    if (!lane || lane.sealed) return { status: 'closed', reason: 'execution-settled' }

    lane.messages.push(message)
    lane.receipts.push(receipt)
    for (const listener of [...lane.inputAcceptedListeners]) listener()
    return { status: 'accepted' }
  }

  public consume(executionId: string): Nullable<ModelMessage> {
    const lane = this.lanesByExecutionId.get(executionId)
    if (!lane || isEmpty(lane.messages)) return null

    const message = toNullable(lane.messages.shift())
    lane.receipts.shift()?.onConsumed?.()
    return message
  }

  public consumeOrSeal(executionId: string): AgentRuntimeInputResult {
    const lane = this.lanesByExecutionId.get(executionId)
    if (!lane) return { status: 'sealed' }
    const message = this.consume(executionId)
    if (message) return { status: 'input', message }

    lane.sealed = true
    lane.inputAcceptedListeners.clear()
    return { status: 'sealed' }
  }

  public finalize(executionId: string): ExecutionGuidanceFinalizationResult {
    const lane = this.lanesByExecutionId.get(executionId)
    if (!lane) return { status: 'sealed' }
    lane.sealed = true
    lane.inputAcceptedListeners.clear()
    if (!isEmpty(lane.messages))
      return { status: 'pending', pendingCount: lane.messages.length }
    return { status: 'sealed' }
  }

  public port(executionId: string): AgentRuntimeInputPort {
    // 仅执行启动会创建输入通道；迟到的生产者和保留端口不能重新打开通道。
    this.lane(executionId)
    return {
      take: () => this.consume(executionId),
      takeOrSeal: () => this.consumeOrSeal(executionId),
      onInputAccepted: (listener) => this.onInputAccepted(executionId, listener),
    }
  }

  public clear(executionId: string): ExecutionGuidanceClearResult {
    const lane = this.lanesByExecutionId.get(executionId)
    if (lane) {
      lane.sealed = true
      lane.inputAcceptedListeners.clear()
    }
    if (lane && !isEmpty(lane.messages))
      return { status: 'retained', pendingCount: lane.messages.length }

    this.lanesByExecutionId.delete(executionId)
    return { status: 'cleared' }
  }

  /** 收尾后把未消费输入的身份交回宿主持久消息表，正文已有宿主副本。 */
  public takeRetainedInputIds(sourceSessionId: string): string[] {
    const ids: string[] = []
    for (const [executionId, lane] of this.lanesByExecutionId) {
      if (!lane.sealed || !lane.receipts.some((entry) => entry.sourceSessionId === sourceSessionId)) continue
      for (const entry of lane.receipts) {
        if (entry.sourceSessionId === sourceSessionId && entry.inputId) ids.push(entry.inputId)
      }
      this.lanesByExecutionId.delete(executionId)
    }
    return ids
  }

  private onInputAccepted(executionId: string, listener: () => void): () => void {
    const lane = this.lanesByExecutionId.get(executionId)
    if (!lane) return () => undefined
    if (!isEmpty(lane.messages)) {
      listener()
      return () => undefined
    }
    if (lane.sealed) return () => undefined

    lane.inputAcceptedListeners.add(listener)
    return () => lane.inputAcceptedListeners.delete(listener)
  }

  private lane(executionId: string): ExecutionGuidanceLane {
    const existing = this.lanesByExecutionId.get(executionId)
    if (existing) return existing

    const lane: ExecutionGuidanceLane = {
      messages: [],
      receipts: [],
      inputAcceptedListeners: new Set(),
      sealed: false,
    }
    this.lanesByExecutionId.set(executionId, lane)
    return lane
  }
}

export { ExecutionGuidanceQueue }

/** 建一条执行引导队列：用户插话先进队列，轮边界才并进历史。 */
export function createExecutionGuidanceQueue(): ExecutionGuidanceQueueApi {
  return new ExecutionGuidanceQueue()
}
