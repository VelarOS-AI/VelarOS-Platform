import type { ErrorCode, ErrorContext } from '@velaros-ai/core/error'
import { isEmpty } from '@velaros-ai/core/utils/array'
import { toNullable } from '@velaros-ai/core/utils/nullish'
import { optionalWhen } from '@velaros-ai/core/utils/optionalWhen'

import type { ContextUsageEstimate } from '../../agent/context/contextUsage'

import type { TeamExecutionPhase } from './team'
import type { UserActionCard } from './tool'

export interface StreamPhasePayload {
  kind: 'phase'
  teamPhase: TeamExecutionPhase
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

/**
 * 上下文治理（v2 驻留账本）逐轮状态：main 进程的治理器是唯一权威，本块是它推给渲染层的**只读**投影。
 *
 * 渲染层因此不需要（也不允许）自己判断"该压了吗/该转交了吗"——v1 把 80% 水位监视放在 React
 * effect 里的那条路已随治理回内核一并下线。转交卡的布防信号就是这里的 `handoffArmed`。
 */
export interface StreamContextGovernanceState {
  /** 已应用过的治理 epoch 代数（= 缓存被重建过几次）。 */
  epoch: number
  /** 本轮治理后的账本投影占用百分比（占治理窗口 G）。 */
  occupancyPercent: Nullable<number>
  /** 本轮是否真的跑了一次 epoch 并应用了迁移。 */
  epochApplied: boolean
  /** 本轮 epoch 的节省率（未跑 epoch 时为 null）。 */
  epochSavingPercent: Nullable<number>
  /** 转交信号：连续低收益 epoch 且压不下去 → 建议开新会话续跑。 */
  handoffArmed: boolean
  /** 最近若干次 epoch 的节省率（新→旧），转交判据的原始证据。 */
  recentSavingPercents: number[]
  /** 最近一次 epoch 之后的占用百分比；从未跑过 epoch 时为 null。 */
  lastEpochAfterPercent: Nullable<number>
  handoffReason: Nullable<string>
  /**
   * I2 蒸馏的逐轮分账。
   *
   * **水位触发的 epoch 不经任何 hook**：`compact_session` 只能透出手动请求的那一次，而手动
   * 那次恰恰是实验里最少见的一类。逐轮流事件是自动 epoch 的唯一出口，所以 RQ3 的因变量必须
   * 在这里也有一份。未跑 epoch 的轮次全为零值/`null`——零不是"没数据"，是"这轮什么都没落地"。
   */
  distill: StreamContextDistillState
}

/**
 * 逐轮 I2 分账（{@link StreamContextGovernanceState} 的一块）。
 *
 * `mode` / `skipReason` 刻意是 `string` 而不是联合类型：档位与跳过原因的权威联合住在
 * `@velaros@velaros-ai/agent` 的治理层，core 是它下游的契约包，复制一份联合等于给同一个枚举做两份
 * 定义，漂移时消费方还以为自己拿到了强类型。这里只承诺"是个可读的标签"。
 */
export interface StreamContextDistillState {
  /** 档位标签：`off` | `aux` | `main` | `adaptive`。 */
  mode: string
  /** 本轮 epoch 应用的产物条数（0 = 本轮没有产物落地）。 */
  appliedProducts: number
  /** 应用产物的器械分布：`distill` = 模型产物过验证，`skeleton` = 拒收后的规则回落。 */
  appliedByInstrument: { distill: number; skeleton: number }
  /** 本轮 epoch 之后是否规划了新的蒸馏。 */
  planned: boolean
  /** 未规划的原因标签（`off` / `no-distiller` / `in-flight` / `target-reached` / `no-segment` / `not-worth` …）。 */
  skipReason: Nullable<string>
  /** 会话累计计数（跨 epoch 单调，采样任意一轮都能看到全貌）。 */
  totals: {
    requested: number
    accepted: number
    rejected: number
    timedOut: number
    failed: number
    staleDropped: number
  }
}

export interface StreamContextUsageEstimatePayload extends ContextUsageEstimate {
  kind: 'context-usage-estimate'
  turn: Nullable<number>
  model: string
  source: StreamContextUsageEstimateSource
  pressureKind: StreamContextUsagePressureKind
  ledger: StreamContextUsageLedgerEntry[]
  zoneDiagnostics?: StreamContextUsageZoneDiagnostic[]
  requestFingerprint?: unknown
  /** 治理状态投影（v2）。编译器未持有治理会话时缺省。 */
  governance?: LooseOptional<StreamContextGovernanceState>
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
