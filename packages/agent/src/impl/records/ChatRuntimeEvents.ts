// 聊天流运行态事件的构造面：每种 runtime kind 的载荷只在这里拼，渲染侧与宿主共用同一份形状。
import type { ErrorCode, ErrorContext } from '@velaros-ai/core/error'

import type { ConfirmationRequestDetail, StreamAbortedPayload, StreamAwaitingConfirmationPayload, StreamAwaitingInputPayload, StreamContextUsageEstimatePayload, StreamDonePayload, StreamErrorPayload, StreamInputAppliedPayload, StreamPhasePayload, StreamReconnectingPayload, StreamRetryingTurnPayload, StreamTurnEndPayload, StreamTurnStartPayload, StreamUsageTelemetryPayload, TeamExecutionPhase, UserActionCard } from '../../types/agent.js'
import { streamAborted, streamAwaitingConfirmation, streamAwaitingInput, streamContextUsageEstimate, streamDone, streamError, streamInputApplied, streamPhase, streamReconnecting, streamRetryingTurn, streamTurnEnd, streamTurnStart, streamUsageTelemetry } from '../../utils/wire/chat-runtime'

/**
 * 聊天流运行态事件的构造面。
 *
 * 每种 runtime kind 的载荷形状是宿主与渲染进程之间的约定，只在这里拼一次；
 * kind 的闭集在 `StreamRuntimeStateKinds`。无状态，进程内共用一份。
 */
export interface ChatRuntimeEventsApi {
  /** 一次用户输入已被本轮采纳（渲染侧据此把输入框清空）。 */
  inputApplied(inputId: string): StreamInputAppliedPayload
  /** 团队执行阶段变化。 */
  phase(teamPhase: TeamExecutionPhase): StreamPhasePayload
  /** 一轮的 token 用量遥测。 */
  usageTelemetry(payload: Omit<StreamUsageTelemetryPayload, 'kind' | 'timestamp'> & {
      timestamp?: number
    }): StreamUsageTelemetryPayload
  /** 当前上下文占用估算（容量条按它刷新）。 */
  contextUsageEstimate(payload: Omit<StreamContextUsageEstimatePayload, 'kind' | 'timestamp'> & {
      timestamp?: number
    }): StreamContextUsageEstimatePayload
  /** 第几轮开始。 */
  turnStart(turn: number): StreamTurnStartPayload
  /** 第几轮结束。 */
  turnEnd(turn: number): StreamTurnEndPayload
  /** 与模型提供方的连接断了，正在重连。 */
  reconnecting(attempt: number, maxAttempts?: LooseOptional<number>, message?: LooseOptional<string>): StreamReconnectingPayload
  /** 本轮失败后正在重试。 */
  retryingTurn(turn: number, attempt: number, maxAttempts?: LooseOptional<number>, message?: LooseOptional<string>): StreamRetryingTurnPayload
  /** 这条流正常收敛（终态）。 */
  done(message?: string, outcome?: Pick<StreamDonePayload, 'verification' | 'goalStatus'>): StreamDonePayload
  /** 这条流被中止（终态）。 */
  aborted(message: string, executionId?: string, code?: ErrorCode): StreamAbortedPayload
  /** 这条流失败（终态）。 */
  error(message: string, code?: ErrorCode, context?: ErrorContext): StreamErrorPayload
  /** 执行停在等待用户确认。 */
  awaitingConfirmation(executionId: string, confirmationMessage: string, userActionCards?: UserActionCard[], confirmationDetail?: ConfirmationRequestDetail, confirmationId?: string): StreamAwaitingConfirmationPayload
  /** 执行停在等待用户补充输入。 */
  awaitingInput(executionId: string, question: string): StreamAwaitingInputPayload
}

/** 方法逐条拼各自的载荷；没有任何状态。 */
class ChatRuntimeEvents implements ChatRuntimeEventsApi {
  public inputApplied(inputId: string): StreamInputAppliedPayload {
    return streamInputApplied(inputId)
  }

  public phase(teamPhase: TeamExecutionPhase): StreamPhasePayload {
    return streamPhase(teamPhase)
  }

  public usageTelemetry(payload: Omit<StreamUsageTelemetryPayload, 'kind' | 'timestamp'> & {
      timestamp?: number
    }): StreamUsageTelemetryPayload {
    return streamUsageTelemetry(payload)
  }

  public contextUsageEstimate(payload: Omit<StreamContextUsageEstimatePayload, 'kind' | 'timestamp'> & {
      timestamp?: number
    }): StreamContextUsageEstimatePayload {
    return streamContextUsageEstimate(payload)
  }

  public turnStart(turn: number): StreamTurnStartPayload {
    return streamTurnStart(turn)
  }

  public turnEnd(turn: number): StreamTurnEndPayload {
    return streamTurnEnd(turn)
  }

  public reconnecting(attempt: number, maxAttempts?: LooseOptional<number>, message?: LooseOptional<string>): StreamReconnectingPayload {
    return streamReconnecting(attempt, maxAttempts, message)
  }

  public retryingTurn(turn: number, attempt: number, maxAttempts?: LooseOptional<number>, message?: LooseOptional<string>): StreamRetryingTurnPayload {
    return streamRetryingTurn(turn, attempt, maxAttempts, message)
  }

  public done(message?: string, outcome: Pick<StreamDonePayload, 'verification' | 'goalStatus'> = {}): StreamDonePayload {
    return streamDone(message, outcome)
  }

  public aborted(message: string, executionId?: string, code?: ErrorCode): StreamAbortedPayload {
    return streamAborted(message, executionId, code)
  }

  public error(message: string, code?: ErrorCode, context?: ErrorContext): StreamErrorPayload {
    return streamError(message, code, context)
  }

  public awaitingConfirmation(executionId: string, confirmationMessage: string, userActionCards?: UserActionCard[], confirmationDetail?: ConfirmationRequestDetail, confirmationId?: string): StreamAwaitingConfirmationPayload {
    return streamAwaitingConfirmation(executionId, confirmationMessage, userActionCards, confirmationDetail, confirmationId)
  }

  public awaitingInput(executionId: string, question: string): StreamAwaitingInputPayload {
    return streamAwaitingInput(executionId, question)
  }
}

/** 聊天流运行态事件的构造面（无状态，进程内共用一份）。 */
export const chatRuntimeEvents: ChatRuntimeEventsApi = new ChatRuntimeEvents()
