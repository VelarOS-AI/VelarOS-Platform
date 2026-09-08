import type { ModelMessage } from 'ai'

import { isBlank, isEmpty, isNonEmptyArray, isString, toNullable } from '@velaros-ai/core'

import type {
  AgentRuntimeInputPort,
  AgentRuntimeInputResult,
} from '../agent/RuntimeInputPort'

function hasUserVisibleGuidance(message: ModelMessage): boolean {
  if (message.role !== 'user') return false

  if (isString(message.content)) return !isBlank(message.content.trim())

  return isNonEmptyArray(message.content)
}

type ExecutionGuidanceEnqueueResult =
  | { status: 'accepted' }
  | { status: 'closed'; reason: 'execution-settled' }
  | { status: 'invalid'; reason: 'empty-or-non-user-message' }

type ExecutionGuidanceFinalizationResult =
  | { status: 'sealed' }
  | { status: 'pending'; pendingCount: number }

type ExecutionGuidanceClearResult =
  | { status: 'cleared' }
  | { status: 'retained'; pendingCount: number }

interface ExecutionGuidanceLane {
  messages: ModelMessage[]
  receipts: Array<{ inputId?: string; sourceSessionId?: string; onConsumed?: () => void }>
  inputAcceptedListeners: Set<() => void>
  sealed: boolean
}

class ExecutionGuidanceQueue {
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
export type {
  ExecutionGuidanceClearResult,
  ExecutionGuidanceEnqueueResult,
  ExecutionGuidanceFinalizationResult,
}
