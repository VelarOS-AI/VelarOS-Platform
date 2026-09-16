import type { ExecutionSpanStatus, ModelSpan, ToolSpan } from '../../types/agent.js'
import type { ProviderRequestSnapshot } from '../../types/context.js'
import type { CapabilitySpanInput, LedgerTurnSpanScopeDeps, ModelSpanHandle, SpanLedgerWarn, ToolSpanHandle, TurnSpanScope } from '../../types/ledgers.js'

import { type ExecutionSpanRecorder } from './ExecutionSpanRecorder'
import { runIsolatedSpanOp } from './LedgerExecutionSpanScopeFactory'

export class LedgerTurnSpanScope implements TurnSpanScope {
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
