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
  inputAcceptedListeners: Set<() => void>
  sealed: boolean
}

class ExecutionGuidanceQueue {
  private readonly lanesByExecutionId = new Map<string, ExecutionGuidanceLane>()

  public enqueue(
    executionId: string,
    message: ModelMessage
  ): ExecutionGuidanceEnqueueResult {
    if (!hasUserVisibleGuidance(message))
      return { status: 'invalid', reason: 'empty-or-non-user-message' }

    const lane = this.lanesByExecutionId.get(executionId)
    if (!lane || lane.sealed) return { status: 'closed', reason: 'execution-settled' }

    lane.messages.push(message)
    for (const listener of [...lane.inputAcceptedListeners]) listener()
    return { status: 'accepted' }
  }

  public consume(executionId: string): Nullable<ModelMessage> {
    const lane = this.lanesByExecutionId.get(executionId)
    if (!lane || isEmpty(lane.messages)) return null

    return toNullable(lane.messages.shift())
  }

  public consumeOrSeal(executionId: string): AgentRuntimeInputResult {
    const lane = this.lanesByExecutionId.get(executionId)
    if (!lane) return { status: 'sealed' }
    const message = lane.messages.shift()
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
