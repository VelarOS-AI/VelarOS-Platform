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
import { Log } from '@velaros-ai/core/logger'

import type { ExecutionSpanScopeFactory } from '../../contract/requires.js'
import type { ExecutionSpan } from '../../types/agent.js'
import type { CapabilitySpanInput, ExecutionCapabilitySpanRecorder, LedgerExecutionSpanScopeFactoryDeps, PromptAuditRecord, RunSpanScope, SpanLedgerWarn, ToolSpanOpener } from '../../types/ledgers.js'

import { ExecutionSpanLedger } from './ExecutionSpanLedger'
import { ExecutionSpanRecorder } from './ExecutionSpanRecorder'
import { LedgerRunSpanScope } from './LedgerRunSpanScope'
import { PromptAuditLedger } from './PromptAuditLedger'

const log = Log.tag('ExecutionSpanScope')

// ── 生产侧端口契约（Ring0 接缝形状） ─────────────────────────────────────────────────

// ── 默认实现：账本落盘 scope 工厂（Ring1，宿主装配） ──────────────────────────────────

/** 无观测时的静默 tool 开启器（生产侧无需分支——始终拿到一个可调用对象或直接 null）。 */
export const NOOP_TOOL_OPENER: ToolSpanOpener = { beginToolSpan: () => null }

/**
 * 账本落盘的 span scope 工厂的完整面：注入端口要的 `beginRun`、宿主级能力观测 `recordCapabilitySpan`，
 * 外加两个生命周期动词。
 *
 * 宿主装配一台、整个进程共用；按会话惰性开账本句柄并缓存（一个会话多次 run 追加同一文件）。
 * 失败隔离是**唯一边界**：每个生产侧动词内吞异常（best-effort warn），故 SoloLoop / ToolExecutor 侧可直呼不设防。
 */
export interface LedgerExecutionSpanScopeFactoryApi
  extends ExecutionSpanScopeFactory,
    ExecutionCapabilitySpanRecorder {
  /**
   * 排空所有已入队的 span 写（不关句柄）。
   *
   * `append` 是 fire-and-forget，写盘在串行队列里异步落定；探针 / 测试在读回账本文件前必须先 await 它，
   * 否则读到的可能少了最后几条。
   */
  drain(): Promise<void>
  /** 排空并关闭全部账本句柄（含 prompt 审计侧信道），同时清空缓存；宿主 dispose 时调一次。 */
  close(): Promise<void>
}

export class LedgerExecutionSpanScopeFactory implements LedgerExecutionSpanScopeFactoryApi {
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
    const ledger = new ExecutionSpanLedger(this.resolveLedgerPath(sessionId), this.warn)
    const opened = ledger.openHandle().then(() => ledger)
    this.ledgers.set(sessionId, opened)
    return opened
  }

  private promptAuditLedgerFor(sessionId: string): Promise<PromptAuditLedger> {
    const existing = this.promptAuditLedgers.get(sessionId)
    if (existing) return existing
    const resolve = this.resolvePromptAuditPath
    if (!resolve) throw new AppError('INVARIANT', '没有配置 prompt 审计账本的路径解析器，无法确定这条审计记录该写到哪个文件：装配本工厂时必须传入 resolvePromptAuditPath。')
    const ledger = new PromptAuditLedger(resolve(sessionId), this.warn)
    const opened = ledger.openHandle().then(() => ledger)
    this.promptAuditLedgers.set(sessionId, opened)
    return opened
  }
}

/** 建一台落盘 span 作用域工厂：每次运行与每个回合各开一个 span。 */
export function createLedgerExecutionSpanScopeFactory(deps: LedgerExecutionSpanScopeFactoryDeps): LedgerExecutionSpanScopeFactoryApi {
  return new LedgerExecutionSpanScopeFactory(deps)
}
