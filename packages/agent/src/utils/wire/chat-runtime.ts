/**
 * Stream 终态 runtime kind 注册表。
 * 新增/修改 ChatRuntimeEvent 时须同步：
 * - `packages/core/src/chat-stream/ChatStreamProtocol.ts`
 * - chat stream runtime consumers
 */
import type { ErrorCode, ErrorContext } from '@velaros-ai/core/error'
import { isEmpty } from '@velaros-ai/core/utils/array'
import { toNullable } from '@velaros-ai/core/utils/nullish'
import { optionalWhen } from '@velaros-ai/core/utils/optionalWhen'

import { StreamRuntimeStateKinds } from '../../contract/constants.js'
import type { ConfirmationRequestDetail, StreamAbortedPayload, StreamAwaitingConfirmationPayload, StreamAwaitingInputPayload, StreamContextUsageEstimatePayload, StreamDonePayload, StreamErrorPayload, StreamInputAppliedPayload, StreamPhasePayload, StreamReconnectingPayload, StreamRetryingTurnPayload, StreamStateKind, StreamTurnEndPayload, StreamTurnStartPayload, StreamUsageTelemetryPayload,TeamExecutionPhase, UserActionCard } from '../../types/agent.js'

export const TERMINAL_STREAM_RUNTIME_STATE_KINDS = StreamRuntimeStateKinds.terminal satisfies readonly StreamStateKind[]

/** 表示执行失败/中止、用于抑制重复 error 广播的 runtime kind。 */
export const STREAM_FAILURE_RUNTIME_STATE_KINDS = StreamRuntimeStateKinds.failure satisfies readonly StreamStateKind[]

/** 契约测试与 bridge exhaustive switch 用的完整 kind 列表。 */
export const ALL_STREAM_RUNTIME_STATE_KINDS = StreamRuntimeStateKinds.all satisfies readonly StreamStateKind[]

export const ChatRuntimeEvents = {
  inputApplied(inputId: string): StreamInputAppliedPayload {
    return { kind: 'input-applied', inputId }
  },
  phase(teamPhase: TeamExecutionPhase): StreamPhasePayload {
    return {
      kind: 'phase',
      teamPhase,
    }
  },

  usageTelemetry(
    payload: Omit<StreamUsageTelemetryPayload, 'kind' | 'timestamp'> & {
      timestamp?: number
    }
  ): StreamUsageTelemetryPayload {
    return {
      kind: 'usage-telemetry',
      timestamp: payload.timestamp ?? Date.now(),
      ...payload,
    }
  },

  contextUsageEstimate(
    payload: Omit<StreamContextUsageEstimatePayload, 'kind' | 'timestamp'> & {
      timestamp?: number
    }
  ): StreamContextUsageEstimatePayload {
    return {
      kind: 'context-usage-estimate',
      timestamp: payload.timestamp ?? Date.now(),
      ...payload,
    }
  },

  turnStart(turn: number): StreamTurnStartPayload {
    return {
      kind: 'turn-start',
      turn,
    }
  },

  turnEnd(turn: number): StreamTurnEndPayload {
    return {
      kind: 'turn-end',
      turn,
    }
  },

  reconnecting(
    attempt: number,
    maxAttempts?: LooseOptional<number>,
    message?: LooseOptional<string>
  ): StreamReconnectingPayload {
    return {
      kind: 'reconnecting',
      attempt,
      maxAttempts: (toNullable(maxAttempts)),
      message: (toNullable(message)),
    }
  },

  retryingTurn(
    turn: number,
    attempt: number,
    maxAttempts?: LooseOptional<number>,
    message?: LooseOptional<string>
  ): StreamRetryingTurnPayload {
    return {
      kind: 'retrying-turn',
      turn,
      attempt,
      maxAttempts: (toNullable(maxAttempts)),
      message: (toNullable(message)),
    }
  },

  done(message?: string, outcome: Pick<StreamDonePayload, 'verification' | 'goalStatus'> = {}): StreamDonePayload {
    return {
      kind: 'done',
      ...outcome,
      message,
    }
  },

  aborted(message: string, executionId?: string, code?: ErrorCode): StreamAbortedPayload {
    return {
      kind: 'aborted',
      message,
      executionId,
      code,
    }
  },

  error(message: string, code?: ErrorCode, context?: ErrorContext): StreamErrorPayload {
    return {
      kind: 'error',
      message,
      code,
      context: optionalWhen((!!context && !isEmpty(Object.keys(context))), context),
    }
  },

  awaitingConfirmation(
    executionId: string,
    confirmationMessage: string,
    userActionCards?: UserActionCard[],
    confirmationDetail?: ConfirmationRequestDetail,
    confirmationId?: string
  ): StreamAwaitingConfirmationPayload {
    return {
      kind: 'awaiting-confirmation',
      confirmationId,
      executionId,
      confirmationMessage,
      userActionCards,
      confirmationDetail,
    }
  },

  awaitingInput(executionId: string, question: string): StreamAwaitingInputPayload {
    return {
      kind: 'awaiting-input',
      executionId,
      question,
    }
  },
} as const
