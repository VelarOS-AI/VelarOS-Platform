import type { ErrorCode, ErrorContext } from '../error'
import { isEmpty } from '../utils/array.js'
import type { ContextUsageEstimate } from '../utils/contextUsage'
import { toNullable } from '../utils/nullish.js'
import { optionalWhen } from '../utils/optionalWhen.js'

import type { TeamExecutionPhase } from './team'
import type { UserActionCard } from './tool'

export interface StreamPhasePayload {
  kind: 'phase'
  teamPhase: TeamExecutionPhase
}

export interface StreamContextCompactionPayload {
  kind: 'context-compaction'
  turn: number
  estimatedTokensBefore: number
  estimatedTokensAfter: number
  percentBefore: number
  percentAfter: number
  removedMessages: number
  passes: number
  targetPercent: number
}

export type ChatContextUsageAccountingSource =
  | 'provider'
  | 'provider-count'
  | 'gateway-cost'
  | 'local-estimate'

export type ChatContextUsageAccountingConfidence = 'high' | 'medium' | 'low'

export type ChatContextEvidenceKind =
  | 'file-read'
  | 'file-change'
  | 'command-output'
  | 'verification'
  | 'artifact'
  | 'generic'

export type ChatContextEvidenceImportance = 'pinned' | 'high' | 'medium' | 'low'
export type ChatContextEvidenceFreshness = 'fresh' | 'stale' | 'unknown'
export type ChatContextEvidenceLifecycle =
  | 'active'
  | 'pinned'
  | 'consumed'
  | 'verified'
  | 'demoted'
  | 'stale'
  | 'reread-required'

export interface ChatContextEvidenceRecord {
  id: string
  toolCallId: string
  toolName: string
  kind: ChatContextEvidenceKind
  importance: ChatContextEvidenceImportance
  lifecycle: ChatContextEvidenceLifecycle
  createdAt: number
  summary: string
  path?: LooseOptional<string>
  revision?: LooseOptional<string>
  contentHash?: LooseOptional<string>
  excerpt?: LooseOptional<string>
  fullPayloadRef?: LooseOptional<string>
  freshness?: LooseOptional<ChatContextEvidenceFreshness>
  score?: LooseOptional<number>
  metadata?: Record<string, unknown>
}

export interface StreamUsageTelemetryPayload {
  kind: 'usage-telemetry'
  turn: Nullable<number>
  provider?: LooseOptional<string>
  model: string
  inputTokens: Nullable<number>
  outputTokens: Nullable<number>
  visibleOutputTokens?: LooseOptional<number>
  totalTokens: Nullable<number>
  reasoningTokens: Nullable<number>
  cachedInputTokens?: LooseOptional<number>
  cacheReadInputTokens?: LooseOptional<number>
  cacheWriteInputTokens?: LooseOptional<number>
  costUsd?: LooseOptional<number>
  /** provider finish/finish-step 上报的结束原因(截断/异常关流诊断的唯一持久化出口)。 */
  finishReasons?: LooseOptional<string[]>
  rawFinishReasons?: LooseOptional<string[]>
  source: ChatContextUsageAccountingSource
  confidence: ChatContextUsageAccountingConfidence
  timestamp: number
}

export type StreamContextUsageEstimateSource = 'provider-request-compiler'
export type StreamContextUsagePressureKind =
  | 'none'
  | 'tokens'
  | 'payload'
  | 'tool-schema'
  | 'mixed'

export interface StreamContextUsageZoneDiagnostic {
  zone: string
  usedTokens: number
  effectiveLimitTokens: number
  overBudgetTokens: number
  reclaimOrder: string[]
}

export interface StreamContextUsageLedgerEntry {
  id: string
  zone: string
  chars: number
  estimatedTokens: number
  action: string
  reason: string
  toolCallId?: string
  toolName?: string
  hash?: string
  ref?: string
  zoneReservedTokens?: number
  zoneLimitTokens?: number
  zoneEffectiveLimitTokens?: number
  zoneUsedTokens?: number
  zoneOverBudgetTokens?: number
}

export interface StreamContextAttentionTraceEntry {
  stage: string
  action: 'inline' | 'summarize' | 'handle' | 'drop' | 'skip' | 'estimate' | 'retain'
  target: string
  reason: string
  score?: LooseOptional<number>
  metadata?: Record<string, unknown>
}

export interface StreamContextUsageEstimatePayload extends ContextUsageEstimate {
  kind: 'context-usage-estimate'
  turn: Nullable<number>
  model: string
  source: StreamContextUsageEstimateSource
  pressureKind: StreamContextUsagePressureKind
  ledger: StreamContextUsageLedgerEntry[]
  zoneDiagnostics?: StreamContextUsageZoneDiagnostic[]
  reclaimAttempts?: number
  requestFingerprint?: unknown
  attentionTrace?: StreamContextAttentionTraceEntry[]
  attentionReplayRecord?: unknown
  timestamp: number
}

export interface StreamTurnStartPayload {
  kind: 'turn-start'
  turn: number
}

export interface StreamTurnEndPayload {
  kind: 'turn-end'
  turn: number
}

export interface StreamReconnectingPayload {
  kind: 'reconnecting'
  attempt: number
  maxAttempts?: LooseOptional<number>
  message?: LooseOptional<string>
}

export interface StreamRetryingTurnPayload {
  kind: 'retrying-turn'
  turn: number
  attempt: number
  maxAttempts?: LooseOptional<number>
  message?: LooseOptional<string>
}

export interface StreamDonePayload {
  kind: 'done'
  message?: string
}

export interface StreamAbortedPayload {
  kind: 'aborted'
  message: string
  executionId?: string
  code?: ErrorCode
}

export interface StreamErrorPayload {
  kind: 'error'
  message: string
  code?: ErrorCode
  context?: ErrorContext
}

export interface StreamAwaitingConfirmationPayload {
  kind: 'awaiting-confirmation'
  executionId: string
  confirmationMessage: string
  userActionCards?: UserActionCard[]
}

export interface StreamAwaitingInputPayload {
  kind: 'awaiting-input'
  executionId: string
  question: string
}

export type ChatRuntimeEvent =
  | StreamPhasePayload
  | StreamContextCompactionPayload
  | StreamUsageTelemetryPayload
  | StreamContextUsageEstimatePayload
  | StreamTurnStartPayload
  | StreamTurnEndPayload
  | StreamReconnectingPayload
  | StreamRetryingTurnPayload
  | StreamDonePayload
  | StreamAbortedPayload
  | StreamErrorPayload
  | StreamAwaitingConfirmationPayload
  | StreamAwaitingInputPayload

export type StreamStateKind = ChatRuntimeEvent['kind']
export type StreamStatePayload = ChatRuntimeEvent

/**
 * Stream 终态 runtime kind 注册表。
 * 新增/修改 ChatRuntimeEvent 时须同步：
 * - `packages/core/src/chat-stream/ChatStreamProtocol.ts`
 * - chat stream runtime consumers
 */
export const TERMINAL_STREAM_RUNTIME_STATE_KINDS = [
  'done',
  'aborted',
  'error',
] as const satisfies readonly StreamStateKind[]

export type TerminalStreamRuntimeStateKind = (typeof TERMINAL_STREAM_RUNTIME_STATE_KINDS)[number]

/** 表示执行失败/中止、用于抑制重复 error 广播的 runtime kind。 */
export const STREAM_FAILURE_RUNTIME_STATE_KINDS = [
  'error',
  'aborted',
] as const satisfies readonly StreamStateKind[]

export type StreamFailureRuntimeStateKind = (typeof STREAM_FAILURE_RUNTIME_STATE_KINDS)[number]

/** 契约测试与 bridge exhaustive switch 用的完整 kind 列表。 */
export const ALL_STREAM_RUNTIME_STATE_KINDS = [
  'phase',
  'context-compaction',
  'usage-telemetry',
  'context-usage-estimate',
  'turn-start',
  'turn-end',
  'reconnecting',
  'retrying-turn',
  'done',
  'aborted',
  'error',
  'awaiting-confirmation',
  'awaiting-input',
] as const satisfies readonly StreamStateKind[]

export const ChatRuntimeEvents = {
  phase(teamPhase: TeamExecutionPhase): StreamPhasePayload {
    return {
      kind: 'phase',
      teamPhase,
    }
  },

  contextCompaction(
    payload: Omit<StreamContextCompactionPayload, 'kind'>
  ): StreamContextCompactionPayload {
    return {
      kind: 'context-compaction',
      ...payload,
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

  done(message?: string): StreamDonePayload {
    return {
      kind: 'done',
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
    userActionCards?: UserActionCard[]
  ): StreamAwaitingConfirmationPayload {
    return {
      kind: 'awaiting-confirmation',
      executionId,
      confirmationMessage,
      userActionCards,
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
