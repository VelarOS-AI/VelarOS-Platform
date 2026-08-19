// 域：执行观测 span 的**生产侧端口**（宪章 §11 span 模型的产 span 接缝；D6 端口纪律）。
//
// 这是注入执行三件套与 runner 的可选 `spanRecorder` 端口的类型契约与默认实现。设计铁律（对齐任务
// D6 与 §10 UX 铁律）：
//   - **纯旁路**：产 span 是执行主路的旁支——端口缺省即整链 no-op（web 桥零观测零付费，pi 判据），
//     任一 span 操作失败**绝不**冒泡进执行主路（默认实现在每个动词内隔离并吞掉异常）。
//   - **调用方零 spanId 记账**：run→turn→{model,tool,capability,policy} 的父子指针由 scope 内部管理，
//     生产侧（SoloLoop / ToolExecutor）只声明「开一个什么 span」，拿回一个非抛出 handle 供收敛。
//   - **只落已完成 span**：进行中 span 驻 recorder 内存，收敛才 emit + 校验 + 落账本（读侧无半态）。
import { toNullable, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import type { ProviderRequestSnapshot } from '../../agent/context/ProviderRequestSnapshot'
import type {
  ExecutionSpan,
  ExecutionSpanStatus,
  ModelSpan,
  ToolSpan,
} from '../../protocol'

import { ExecutionSpanLedger, type SpanLedgerWarn } from './ExecutionSpanLedger'
import { ExecutionSpanRecorder } from './ExecutionSpanRecorder'
import { PromptAuditLedger, type PromptAuditRecord } from './prompt-audit'

const log = logRuntime.tag('ExecutionSpanScope')

/** 宿主能力的会话级观测输入；领域字段全部收进不透明 metadata。 */
export interface CapabilitySpanInput {
  name: string
  capabilityId: string
  operationId: string
  metadata?: Readonly<Record<string, unknown>>
}

/** 非 run 作用域的通用能力观测端口，由宿主按需注入。 */
export interface ExecutionCapabilitySpanRecorder {
  recordCapabilitySpan(
    sessionId: string,
    input: CapabilitySpanInput
  ): void
}

// ── 生产侧端口契约（Ring0 接缝形状） ─────────────────────────────────────────────────

/** 一条 tool span 的收敛产出。`errorCode` 成功用 null。 */
export interface ToolSpanOutcome {
  status: ExecutionSpanStatus
  errorCode: Nullable<string>
}

/** 一条进行中 tool span 的 handle。`end` 契约上**绝不抛出**（默认实现内部隔离）。 */
export interface ToolSpanHandle {
  end(outcome: ToolSpanOutcome): void
}

/**
 * tool span 开启器——注入执行三件套（ToolExecutor）的**窄端口**。
 *
 * ToolExecutor 只依赖这一个动词：不认 runId / parentSpanId（那些由绑定本开启器的 turn scope 内部持有），
 * 令执行器与观测账本的树形记账解耦。缺省（`undefined`）= 该执行器不产 tool span。
 */
export interface ToolSpanOpener {
  /** 开一条挂在当前 turn 下的 tool span；观测停用或开启失败返回 null（执行器据此跳过收敛）。 */
  beginToolSpan(input: {
    toolCallId: string
    toolName: string
    toolCategoryId: Nullable<string>
    toolEffectKind: Nullable<string>
  }): Nullable<ToolSpanHandle>
}

/** 一条 model span 的收敛产出（D5：usage 挂在此确定 turn 的 model span 上，无 null turn）。 */
export interface ModelSpanOutcome {
  status: ExecutionSpanStatus
  finishReason: Nullable<string>
  errorCode: Nullable<string>
  errorMessage: Nullable<string>
  tokensIn: Nullable<number>
  tokensOut: Nullable<number>
  costUsd: Nullable<number>
  /**
   * 请求指纹（Ring0 `ProviderRequestFingerprint.id`，与 context-replays 对齐）。仅在回合收敛后才可知
   * （拼装期计算），故 open 时置 null、收敛时 patch 补上。缺席用 null。
   */
  requestFingerprint: Nullable<string>
}

/** 一条进行中 model span 的 handle。`end` 契约上绝不抛出。 */
export interface ModelSpanHandle {
  end(outcome: ModelSpanOutcome): void
}

/**
 * turn 级 scope：一次 provider 生成回合内 model / tool / capability / policy span 的来源。
 *
 * 继承 {@link ToolSpanOpener} 令其可直接注入 ToolExecutor 作 tool span 开启器。
 */
export interface TurnSpanScope extends ToolSpanOpener {
  /** 开本轮 provider 请求的 model span（挂本确定 turn；usage 在 end 时补上）。 */
  beginModelSpan(input: {
    provider: string
    model: string
    requestFingerprint: Nullable<string>
  }): Nullable<ModelSpanHandle>
  /** 记一条 policy 点事件 span（收编 control-plane ledger 决策）。 */
  recordPolicySpan(input: { name: string; source: string; action: string; reason: string }): void
  /** 记一条宿主注入能力的点事件 span；Kernel 不解释 operationId/metadata。 */
  recordCapabilitySpan(input: CapabilitySpanInput): void
  /**
   * D3：把本回合的**重内容**（系统提示词全文 / promptSegments / capabilityContextAudit）写进 prompt 审计侧信道
   * （独立文件，靠 `requestFingerprint` 关联回本回合 model span）。span 侧只留指标 + 指纹保持轻/高频；
   * 无 sidecar 装配（`resolvePromptAuditPath` 缺席）时 no-op。**绝不进会话账本**。
   */
  recordPromptAudit(input: {
    requestFingerprint: Nullable<string>
    systemPrompt: string
    promptSegments: readonly unknown[]
    skippedPromptSegments: readonly unknown[]
    capabilityContextAudit: readonly unknown[]
    providerRequest: Nullable<ProviderRequestSnapshot>
  }): void
  /** 收敛本 turn span。 */
  end(outcome: { status: ExecutionSpanStatus }): void
}

/** run 级 scope：一次完整 agent 执行的根，派生 turn scope。 */
export interface RunSpanScope {
  beginTurn(input: {
    turn: number
    roleId: Nullable<string>
    model: Nullable<string>
  }): TurnSpanScope
  end(outcome: { status: ExecutionSpanStatus }): void
}

/**
 * 注入 runner 的可选 span 端口（`spanRecorder?`）。缺省 = 无观测（零付费）。
 *
 * runner（SoloLoop）每次执行 `beginRun` 得到一个 run scope；其余生产侧只经 scope 派生，不碰账本/recorder。
 */
export interface ExecutionSpanScopeFactory {
  beginRun(input: {
    runId: string
    sessionId: string
    rootInputId: Nullable<string>
    /** 子 Agent 身份/角色名（主 Agent 根 run 用 null）——令独立顶层 run 在同会话多 run 树里可辨识。 */
    agentName: Nullable<string>
    /** 派发来源（子 Agent 的父角色/派发链；主 Agent 根 run 用 null）。 */
    dispatchSource: Nullable<string>
  }): RunSpanScope
}

// ── 默认实现：账本落盘 scope 工厂（Ring1，宿主装配） ──────────────────────────────────

/** 无观测时的静默 tool 开启器（生产侧无需分支——始终拿到一个可调用对象或直接 null）。 */
const NOOP_TOOL_OPENER: ToolSpanOpener = { beginToolSpan: () => null }

/** {@link LedgerExecutionSpanScopeFactory} 装配依赖。 */
export interface LedgerExecutionSpanScopeFactoryDeps {
  /** 每会话执行账本文件路径（数据根下与 session ledger 平行目录）。 */
  resolveLedgerPath: (sessionId: string) => string
  /**
   * D3：每会话 prompt 审计侧信道文件路径（与 span 账本物理平行，如 `execution-spans/<id>.prompts.jsonl`）。
   * 缺省关闭——`recordPromptAudit` 降级 no-op（不装配 sidecar = 不落重内容）。
   */
  resolvePromptAuditPath?: (sessionId: string) => string
  /** 非致命恢复事件回落（尾行修复等）；缺省进 warn 日志。 */
  warn?: SpanLedgerWarn
  now?: () => number
  nextSpanId?: () => string
}

/**
 * 账本落盘的 span scope 工厂——把生产侧 scope 动词桥到 {@link ExecutionSpanRecorder} +
 * {@link ExecutionSpanLedger}（旁账本，每会话一文件 append-only）。
 *
 * 失败隔离是**唯一边界**：每个生产侧动词内 try/catch 吞异常（best-effort warn），故 SoloLoop /
 * ToolExecutor 侧可直呼不设防（对齐「code like one author，不散落 try/catch」）。账本按会话缓存句柄、
 * 每条 span fsync 落盘；`drain` / `close` 供宿主 dispose 与探针读回前排空。
 */
export class LedgerExecutionSpanScopeFactory
  implements ExecutionSpanScopeFactory, ExecutionCapabilitySpanRecorder
{
  private readonly resolveLedgerPath: (sessionId: string) => string
  private readonly resolvePromptAuditPath: Nullable<(sessionId: string) => string>
  private readonly warn: SpanLedgerWarn
  private readonly now: () => number
  private readonly nextSpanId: Nullable<() => string>
  /** 每会话账本句柄（懒开，缓存复用；一个会话多次 run 追加同一文件）。 */
  private readonly ledgers = new Map<string, Promise<ExecutionSpanLedger>>()
  /** 每会话 prompt 审计侧信道句柄（D3；懒开，缓存复用）。 */
  private readonly promptAuditLedgers = new Map<string, Promise<PromptAuditLedger>>()

  constructor(deps: LedgerExecutionSpanScopeFactoryDeps) {
    this.resolveLedgerPath = deps.resolveLedgerPath
    this.resolvePromptAuditPath = toNullable(deps.resolvePromptAuditPath)
    this.warn = deps.warn ?? ((message, detail) => log.debug(message, detail))
    this.now = deps.now ?? (() => Date.now())
    this.nextSpanId = toNullable(deps.nextSpanId)
  }

  public beginRun(input: {
    runId: string
    sessionId: string
    rootInputId: Nullable<string>
    agentName: Nullable<string>
    dispatchSource: Nullable<string>
  }): RunSpanScope {
    const append = this.appendToLedger(input.sessionId, 'execution span append failed')
    const recorder = this.createRecorder(append)
    // D3：prompt 审计写路径（同 fire-and-forget 纪律）；未装配 sidecar 时为 null → recordPromptAudit no-op。
    const promptAuditAppend = this.resolvePromptAuditPath
      ? (record: PromptAuditRecord): void => {
          const ledger = this.promptAuditLedgerFor(input.sessionId)
          void ledger
            .then((handle) => handle.append(record))
            .catch((error) => this.warn('prompt audit append failed', { error: AppError.getMessage(error) }))
        }
      : null
    return new LedgerRunSpanScope(recorder, input, this.warn, this.now, promptAuditAppend)
  }

  /** 记录一条不隶属具体 run 的宿主能力观测；失败隔离，不影响主执行链。 */
  public recordCapabilitySpan(
    sessionId: string,
    input: CapabilitySpanInput
  ): void {
    try {
      const append = this.appendToLedger(sessionId, 'capability span append failed')
      const recorder = this.createRecorder(append)
      recorder.record(
        {
          category: 'capability',
          parentSpanId: null,
          runId: null,
          sessionId,
          name: input.name,
          capabilityId: input.capabilityId,
          operationId: input.operationId,
          metadata: { ...input.metadata },
        }
      )
    } catch (error) {
      this.warn('capability span failed', { error: AppError.getMessage(error) })
    }
  }

  /** 排空所有已入队写（供探针在读回前调用）。 */
  public async drain(): Promise<void> {
    await Promise.all([
      ...[...this.ledgers.values()].map(async (ledger) => (await ledger).drain()),
      ...[...this.promptAuditLedgers.values()].map(async (ledger) => (await ledger).drain()),
    ])
  }

  /** 排空并关闭所有账本句柄（供宿主 dispose）。 */
  public async close(): Promise<void> {
    const pending = [...this.ledgers.values()]
    const pendingPrompt = [...this.promptAuditLedgers.values()]
    this.ledgers.clear()
    this.promptAuditLedgers.clear()
    await Promise.all([
      ...pending.map(async (ledger) => (await ledger).close()),
      ...pendingPrompt.map(async (ledger) => (await ledger).close()),
    ])
  }

  /** 装配一台录制器（时钟与 id 工厂来自注入端口；缺省交由录制器自己回落系统实现）。 */
  private createRecorder(emit: (span: ExecutionSpan) => void): ExecutionSpanRecorder {
    return new ExecutionSpanRecorder({
      emit,
      now: this.now,
      // 内部持 Nullable、对外端口收可选：null↔undefined 只在这一处归一（§1.5）。
      nextSpanId: toOptional(this.nextSpanId),
    })
  }

  /** 账本 append 为 fire-and-forget（sink 友好，产 span 侧零 await）；失败吞掉不冒泡。 */
  private appendToLedger(sessionId: string, label: string): (span: ExecutionSpan) => void {
    return (span) => {
      void this.ledgerFor(sessionId)
        .then((handle) => handle.append(span))
        .catch((error) => this.warn(label, { error: AppError.getMessage(error) }))
    }
  }

  private ledgerFor(sessionId: string): Promise<ExecutionSpanLedger> {
    const existing = this.ledgers.get(sessionId)
    if (existing) return existing
    const opened = ExecutionSpanLedger.open(this.resolveLedgerPath(sessionId), this.warn)
    this.ledgers.set(sessionId, opened)
    return opened
  }

  private promptAuditLedgerFor(sessionId: string): Promise<PromptAuditLedger> {
    const existing = this.promptAuditLedgers.get(sessionId)
    if (existing) return existing
    const resolve = this.resolvePromptAuditPath
    if (!resolve) throw new AppError('INVARIANT', 'prompt audit path resolver not configured')
    const opened = PromptAuditLedger.open(resolve(sessionId), this.warn)
    this.promptAuditLedgers.set(sessionId, opened)
    return opened
  }
}

// ── scope 实现（父子指针内部记账，动词内失败隔离） ────────────────────────────────────

/**
 * 生产侧动词的**失败隔离单源**：任一 span 操作抛出都吞成 warn + null。
 *
 * 这是「纯旁路」纪律（见文件头）唯一的落地点——SoloLoop / ToolExecutor 侧才敢直呼不设防。
 * 两个 scope 实现共用同一份，别再各自 try/catch 一遍（改隔离语义要一处改完）。
 */
function runIsolatedSpanOp<T>(warn: SpanLedgerWarn, fn: () => T, label: string): Nullable<T> {
  try {
    return fn()
  } catch (error) {
    warn(`execution span scope: ${label} failed`, { error: AppError.getMessage(error) })
    return null
  }
}

class LedgerRunSpanScope implements RunSpanScope {
  private readonly runSpan: ReturnType<ExecutionSpanRecorder['open']>

  constructor(
    private readonly recorder: ExecutionSpanRecorder,
    private readonly run: {
      runId: string
      sessionId: string
      rootInputId: Nullable<string>
      agentName: Nullable<string>
      dispatchSource: Nullable<string>
    },
    private readonly warn: SpanLedgerWarn,
    private readonly now: () => number,
    /** D3：prompt 审计侧信道写入器（fire-and-forget）；缺省 null → recordPromptAudit no-op。 */
    private readonly promptAuditAppend: Nullable<(record: PromptAuditRecord) => void>
  ) {
    this.runSpan = this.recorder.open({
      category: 'run',
      parentSpanId: null,
      runId: run.runId,
      sessionId: run.sessionId,
      name: 'agent-run',
      rootInputId: run.rootInputId,
      agentName: run.agentName,
      dispatchSource: run.dispatchSource,
    })
  }

  public beginTurn(input: {
    turn: number
    roleId: Nullable<string>
    model: Nullable<string>
  }): TurnSpanScope {
    const turnSpan = this.safe(
      () =>
        this.recorder.open({
          category: 'turn',
          parentSpanId: this.runSpan.spanId,
          runId: this.run.runId,
          sessionId: this.run.sessionId,
          name: `turn-${input.turn}`,
          turn: input.turn,
          roleId: input.roleId,
          model: input.model,
        }),
      'begin turn span'
    )
    return new LedgerTurnSpanScope(this.recorder, this.run, turnSpan, this.warn, {
      turnMeta: { turn: input.turn, roleId: input.roleId, model: input.model },
      now: this.now,
      promptAuditAppend: this.promptAuditAppend,
    })
  }

  public end(outcome: { status: ExecutionSpanStatus }): void {
    this.safe(() => this.runSpan.end({ status: outcome.status }), 'end run span')
  }

  private safe<T>(fn: () => T, label: string): Nullable<T> {
    return runIsolatedSpanOp(this.warn, fn, label)
  }
}

interface LedgerTurnSpanScopeDeps {
  /** 本 turn 的元数据，供 D3 prompt 审计记录带上（span 侧已单独记，此处审计侧信道复用）。 */
  turnMeta: { turn: number; roleId: Nullable<string>; model: Nullable<string> }
  now: () => number
  /** D3：prompt 审计写入器（fire-and-forget）；null → recordPromptAudit no-op。 */
  promptAuditAppend: Nullable<(record: PromptAuditRecord) => void>
}

class LedgerTurnSpanScope implements TurnSpanScope {
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

export { NOOP_TOOL_OPENER }
