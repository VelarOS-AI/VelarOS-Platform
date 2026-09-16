import type { ExecutionSpanStatus, ModelSpan, ToolSpan } from '../../types/agent.js'
import type { ProviderRequestSnapshot } from '../../types/context.js'
import type { CapabilitySpanInput, LedgerTurnSpanScopeDeps, ModelSpanHandle, SpanLedgerWarn, ToolSpanHandle, TurnSpanScope } from '../../types/ledgers.js'

import { type ExecutionSpanRecorder } from './ExecutionSpanRecorder'
import { runIsolatedSpanOp } from './LedgerExecutionSpanScopeFactory'

/**
 * 一轮 provider 生成（turn）的 span 作用域：本轮的 model / tool / capability / policy span 都从这里开。
 *
 * 由 run scope 的 `beginTurn` 造，跟着这一轮活；turn span 开不出来时整体降级 no-op（构造时传进来的
 * turnSpan 为 null，所有动词直接返回）。动词内失败一律吞成 warn，绝不冒泡进执行主路。
 */
export interface LedgerTurnSpanScopeApi extends TurnSpanScope {
  /**
   * 开本轮 provider 请求的 model span；返回的 handle 在拿到回包（或失败）时 `end`，token 用量与终止原因那时补。
   *
   * 观测停用或开失败时返回 null，调用方跳过收敛即可。
   */
  beginModelSpan(input: {
    provider: string
    model: string
    requestFingerprint: Nullable<string>
  }): Nullable<ModelSpanHandle>
  /**
   * 开一条挂在本轮下的 tool span；ToolExecutor 只依赖这一个动词，不认 runId / parentSpanId。
   *
   * 返回的 handle 在工具执行结束时 `end`（成功或带 errorCode 的失败）；开不出来时返回 null。
   */
  beginToolSpan(input: {
    toolCallId: string
    toolName: string
    toolCategoryId: Nullable<string>
    toolEffectKind: Nullable<string>
  }): Nullable<ToolSpanHandle>
  /** 记一条 policy 决策的点事件 span（起止同刻）：谁判的、判成什么、为什么，供事后复盘一次执行被哪些策略改过道。 */
  recordPolicySpan(input: {
    name: string
    source: string
    action: string
    reason: string
  }): void
  /** 记一条宿主能力调用的点事件 span；`operationId` 与 `metadata` 由宿主定义，观测侧只原样落盘不解释。 */
  recordCapabilitySpan(input: CapabilitySpanInput): void
  /**
   * 把本轮的**重内容**（系统提示词全文 / promptSegments / capabilityContextAudit / provider 请求快照）
   * 写进 prompt 审计侧信道，靠 `requestFingerprint` 关联回本轮 model span。
   *
   * 未装配侧信道路径时直接 no-op（不落重内容）；**绝不写进会话账本**。
   */
  recordPromptAudit(input: {
    requestFingerprint: Nullable<string>
    systemPrompt: string
    promptSegments: readonly unknown[]
    skippedPromptSegments: readonly unknown[]
    capabilityContextAudit: readonly unknown[]
    providerRequest: Nullable<ProviderRequestSnapshot>
  }): void
  /** 收敛 turn span：本轮收尾时按最终状态调一次，本 scope 之后作废。 */
  end(outcome: { status: ExecutionSpanStatus }): void
}

export class LedgerTurnSpanScope implements LedgerTurnSpanScopeApi {
  constructor(
    private readonly recorder: ExecutionSpanRecorder,
    private readonly run: { runId: string; sessionId: string },
    /** turn span handle；开启失败为 null 时本 scope 整体降级 no-op。 */
    private readonly turnSpan: Nullable<ReturnType<ExecutionSpanRecorder['open']>>,
    private readonly warn: SpanLedgerWarn,
    private readonly deps: LedgerTurnSpanScopeDeps
  ) {}

  public beginModelSpan(input: {
    provider: string
    model: string
    requestFingerprint: Nullable<string>
  }): Nullable<ModelSpanHandle> {
    if (!this.turnSpan) return null
    const parentSpanId = this.turnSpan.spanId
    const open = this.safe(
      () =>
        this.recorder.open({
          category: 'model',
          parentSpanId,
          runId: this.run.runId,
          sessionId: this.run.sessionId,
          name: 'provider-request',
          provider: input.provider,
          model: input.model,
          requestFingerprint: input.requestFingerprint,
          finishReason: null,
          errorCode: null,
          errorMessage: null,
        }),
      'begin model span'
    )
    if (!open) return null
    return {
      end: (outcome) =>
        this.safe(
          () =>
            open.end({
              status: outcome.status,
              metrics: {
                tokensIn: outcome.tokensIn,
                tokensOut: outcome.tokensOut,
                costUsd: outcome.costUsd,
              },
              patch: {
                finishReason: outcome.finishReason,
                requestFingerprint: outcome.requestFingerprint,
                errorCode: outcome.errorCode,
                errorMessage: outcome.errorMessage,
              } satisfies Partial<ModelSpan>,
            }),
          'end model span'
        ),
    }
  }

  public beginToolSpan(input: {
    toolCallId: string
    toolName: string
    toolCategoryId: Nullable<string>
    toolEffectKind: Nullable<string>
  }): Nullable<ToolSpanHandle> {
    if (!this.turnSpan) return null
    const parentSpanId = this.turnSpan.spanId
    const open = this.safe(
      () =>
        this.recorder.open({
          category: 'tool',
          parentSpanId,
          runId: this.run.runId,
          sessionId: this.run.sessionId,
          name: input.toolName,
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          toolCategoryId: input.toolCategoryId,
          toolEffectKind: input.toolEffectKind,
          errorCode: null,
        }),
      'begin tool span'
    )
    if (!open) return null
    return {
      end: (outcome) =>
        this.safe(
          () =>
            open.end({
              status: outcome.status,
              patch: { errorCode: outcome.errorCode } satisfies Partial<ToolSpan>,
            }),
          'end tool span'
        ),
    }
  }

  public recordPolicySpan(input: {
    name: string
    source: string
    action: string
    reason: string
  }): void {
    if (!this.turnSpan) return
    const parentSpanId = this.turnSpan.spanId
    this.safe(
      () =>
        this.recorder.record({
          category: 'policy',
          parentSpanId,
          runId: this.run.runId,
          sessionId: this.run.sessionId,
          name: input.name,
          source: input.source,
          action: input.action,
          reason: input.reason,
        }),
      'record policy span'
    )
  }

  public recordCapabilitySpan(input: CapabilitySpanInput): void {
    if (!this.turnSpan) return
    const parentSpanId = this.turnSpan.spanId
    this.safe(
      () =>
        this.recorder.record(
          {
            category: 'capability',
            parentSpanId,
            runId: this.run.runId,
            sessionId: this.run.sessionId,
            name: input.name,
            capabilityId: input.capabilityId,
            operationId: input.operationId,
            metadata: { ...input.metadata },
          },
        ),
      'record capability span'
    )
  }

  public recordPromptAudit(input: {
    requestFingerprint: Nullable<string>
    systemPrompt: string
    promptSegments: readonly unknown[]
    skippedPromptSegments: readonly unknown[]
    capabilityContextAudit: readonly unknown[]
    providerRequest: Nullable<ProviderRequestSnapshot>
  }): void {
    const append = this.deps.promptAuditAppend
    if (!append) return
    this.safe(
      () =>
        append({
          capturedAt: this.deps.now(),
          sessionId: this.run.sessionId,
          runId: this.run.runId,
          requestFingerprint: input.requestFingerprint,
          turn: this.deps.turnMeta.turn,
          roleId: this.deps.turnMeta.roleId,
          model: this.deps.turnMeta.model,
          systemPrompt: input.systemPrompt,
          promptSegments: input.promptSegments,
          skippedPromptSegments: input.skippedPromptSegments,
          capabilityContextAudit: input.capabilityContextAudit,
          providerRequest: input.providerRequest,
        }),
      'record prompt audit'
    )
  }

  public end(outcome: { status: ExecutionSpanStatus }): void {
    if (!this.turnSpan) return
    const turnSpan = this.turnSpan
    this.safe(() => turnSpan.end({ status: outcome.status }), 'end turn span')
  }

  private safe<T>(fn: () => T, label: string): Nullable<T> {
    return runIsolatedSpanOp(this.warn, fn, label)
  }
}
