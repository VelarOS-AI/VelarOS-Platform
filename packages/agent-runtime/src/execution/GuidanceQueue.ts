import type { ModelMessage } from 'ai'

import { isBlank, isEmpty, isNonEmptyArray, isString } from '@velaros-ai/core'

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

    const lane = this.lane(executionId)
    if (lane.sealed) return { status: 'closed', reason: 'execution-settled' }

    lane.messages.push(message)
    return { status: 'accepted' }
  }

  public consume(executionId: string): Nullable<ModelMessage> {
    const lane = this.lanesByExecutionId.get(executionId)
    if (!lane || isEmpty(lane.messages)) return null

    return lane.messages.shift() ?? null
  }

  public consumeOrSeal(executionId: string): AgentRuntimeInputResult {
    const lane = this.lane(executionId)
    const message = lane.messages.shift()
    if (message) return { status: 'input', message }

    lane.sealed = true
    return { status: 'sealed' }
  }

  public finalize(executionId: string): ExecutionGuidanceFinalizationResult {
    const lane = this.lane(executionId)
    lane.sealed = true
    if (!isEmpty(lane.messages))
      return { status: 'pending', pendingCount: lane.messages.length }
    return { status: 'sealed' }
  }

  public port(executionId: string): AgentRuntimeInputPort {
    return {
      take: () => this.consume(executionId),
      takeOrSeal: () => this.consumeOrSeal(executionId),
    }
  }

  public clear(executionId: string): ExecutionGuidanceClearResult {
    const lane = this.lanesByExecutionId.get(executionId)
    if (lane && !isEmpty(lane.messages))
      return { status: 'retained', pendingCount: lane.messages.length }

    this.lanesByExecutionId.delete(executionId)
    return { status: 'cleared' }
  }

  private lane(executionId: string): ExecutionGuidanceLane {
    const existing = this.lanesByExecutionId.get(executionId)
    if (existing) return existing

    const lane: ExecutionGuidanceLane = { messages: [], sealed: false }
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
