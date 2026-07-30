/**
 * 会话级治理器（Governor 的宿主形态）——账本的跨回合家。
 *
 * 账本必须跨回合活着：`ProviderRequestCompiler` 每轮新编译一次，若每轮重建账本，驻留态向量、
 * faultCount、epoch 号全部归零，治理退化成"每轮重新想一遍"。所以状态收在按 sessionId 索引的
 * registry 里（宿主级单实例注入，与它取代的 `ContextAttentionSessionRegistry` 同一注入位）。
 *
 * ## 摄入的唯一难点：历史会被上游改写
 * `sanitizeHistoryForProvider` / 结构自愈每轮都可能重建消息对象，所以"上次摄入过的消息"不能靠
 * 对象身份认。这里按**逐条内容指纹的前缀比对**认：
 *  - 前缀一致 → 只追加新出的尾巴（增量 append，缓存安全）；
 *  - 前缀分叉（历史被截断 / 编辑 / 回滚 / 换会话）→ 整本重建。
 * 重建是正确性兜底，不是常态：分叉意味着上游已经换了一份历史，继续增量只会把两份历史缝起来。
 *
 * ## 治理不发生时必须逐字等价
 * `syncHistory` 之后若未触发 epoch，全部记录都是准入态，投影输出与输入消息**同一批对象、同一
 * 顺序**（B0 已钉"摄入→投影==原历史"）。切换编译器的行为对齐就压在这条上。
 */
import type { ModelMessage } from 'ai'

import { isEmpty, toNullable } from '@velaros-ai/core'

import type { ContextRecordClassifier } from './admission'
import type { ContextRecord } from './ContextRecord'
import { stableFingerprint } from './determinism'
import {
  type ContextGovernanceConfig,
  type ContextGovernanceConfigInput,
  resolveContextGovernanceConfig,
  resolveGovernanceWindowTokens,
} from './governanceConfig'
import { type GovernanceEpochReport, measureProjectedTokens, runGovernanceEpoch } from './GovernanceEpoch'
import { planHistoryIngest } from './ingest'
import type { ContextMigrationEventSink } from './migrationLog'
import { ContextResidencyLedger } from './ResidencyLedger'

/** 模型声明阶段边界的工具名（语义升格为"请求开一次 epoch"，见设计 §5.2）。 */
export const ContextEpochRequestToolName = 'distill_context'

/** 每会话保留的 epoch 报告条数（转交信号只看最近若干次，无限留等于内存泄漏）。 */
const MaxRetainedEpochReports = 32
const DefaultMaxTrackedSessions = 128

/** 转交信号（设计 §4）：连续 2 次 epoch 节省率不足且 post-epoch 占用仍高 → 建议开新会话。 */
export interface ContextHandoffSignal {
  /** 是否建议布防 handoff 卡。 */
  armed: boolean
  /** 最近若干次 epoch 的节省率序列（新→旧）。 */
  recentSavingPercents: number[]
  /** 最近一次 epoch 之后的预算占用百分比；从未跑过 epoch 时为 null。 */
  lastEpochAfterPercent: Nullable<number>
  reason: Nullable<'low-saving-streak'>
}

/** 连续多少次低收益 epoch 触发转交建议。 */
const HandoffLowSavingStreak = 2
/** post-epoch 占用高于该百分比才认为"压不下去了"（设计留作扫参对象）。 */
const HandoffOccupancyPercent = 35

export interface ContextGovernanceSyncInput {
  messages: readonly ModelMessage[]
  at: number
  /**
   * 全保真层引用：toolCallId → payloadRef（PayloadStore 已存的原文）。
   * 准入期把它落进记录，EXCERPT / 墓碑信封的召回引用才能用内容寻址的 payloadRef
   * 而不是只能退回 toolCallId。
   */
  payloadRefsByToolCallId?: LooseOptional<Readonly<Record<string, string>>>
}

export interface ContextGovernanceSyncResult {
  /** 本次同步是否整本重建了账本（历史前缀分叉）。 */
  rebuilt: boolean
  appendedCount: number
}

/** 单会话治理状态。 */
export class ContextGovernanceSession {
  public readonly config: ContextGovernanceConfig
  private ledgerRef: ContextResidencyLedger
  private ingestedFingerprints: string[] = []
  private nextTurn = 0
  private epochSeq = 0
  private readonly reports: GovernanceEpochReport[] = []
  private lastEpochRequestRecordId: Nullable<string> = null
  public updatedAt = 0

  public constructor(
    config: ContextGovernanceConfig,
    private readonly classifier: Nullable<ContextRecordClassifier>,
    private readonly sink: Nullable<ContextMigrationEventSink>
  ) {
    this.config = config
    this.ledgerRef = this.createLedger()
  }

  public get ledger(): ContextResidencyLedger {
    return this.ledgerRef
  }

  public get epoch(): number {
    return this.epochSeq
  }

  public epochReports(): readonly GovernanceEpochReport[] {
    return this.reports
  }

  /** 把本轮的 provider 历史同步进账本：前缀一致则增量追加，分叉则整本重建。 */
  public syncHistory(input: ContextGovernanceSyncInput): ContextGovernanceSyncResult {
    const { messages, at } = input
    const fingerprints = messages.map((message) => stableFingerprint(message))
    const sharedPrefix = resolveSharedPrefixLength(this.ingestedFingerprints, fingerprints)
    const rebuilt = sharedPrefix < this.ingestedFingerprints.length
    if (rebuilt) this.resetLedger()

    const from = rebuilt ? 0 : sharedPrefix
    const tail = messages.slice(from)
    if (!isEmpty(tail)) {
      const plan = planHistoryIngest(tail, {
        baseCreatedAt: at,
        startTurn: this.nextTurn,
        payloadRefsByToolCallId: input.payloadRefsByToolCallId,
      })
      for (const admission of plan.inputs) this.ledgerRef.append(admission)
      this.nextTurn = plan.nextTurn
    }

    this.ingestedFingerprints = fingerprints
    this.updatedAt = at
    return { rebuilt, appendedCount: tail.length }
  }

  /** 当前投影占用（token），与投影共用尾保护规则。 */
  public projectedTokens(budgetTokens: number): number {
    return measureProjectedTokens(this.ledgerRef, this.config, budgetTokens)
  }

  /**
   * 轮边界治理：按需跑一次 epoch。
   *
   * `modelWindowTokens` 缺省时 G 退化为 cap（`resolveGovernanceWindowTokens` 单源）。
   * 返回 null 表示本轮既未触发也未跳过记账（账本为空）。
   */
  public governTurn(input: {
    at: number
    modelWindowTokens?: LooseOptional<number>
  }): Nullable<GovernanceEpochReport> {
    return this.runEpoch(input, this.consumeModelEpochRequest())
  }

  /**
   * 手动开一次 epoch（宿主的 `compact_session` 落点）。
   *
   * 语义与模型调 `distill_context` 完全一致——**请求开一次 epoch**，绕过水位触发线，但反空转、
   * 尾保护、达标即停等器械纪律一条不减。手动不等于强拆：压不下去的出路仍是转交，不是压尾。
   */
  public requestEpoch(input: {
    at: number
    modelWindowTokens?: LooseOptional<number>
  }): Nullable<GovernanceEpochReport> {
    return this.runEpoch(input, true)
  }

  private runEpoch(
    input: { at: number; modelWindowTokens?: LooseOptional<number> },
    modelRequested: boolean
  ): Nullable<GovernanceEpochReport> {
    if (isEmpty(this.ledgerRef.list())) return null

    const budgetTokens = resolveGovernanceWindowTokens(this.config, input.modelWindowTokens)
    const startedAt = Date.now()
    const raw = runGovernanceEpoch({
      ledger: this.ledgerRef,
      config: this.config,
      budgetTokens,
      epoch: this.epochSeq + 1,
      at: input.at,
      modelRequested,
    })
    // 耗时在**跑完之后**测量并回填：epoch 是纯函数（不取时钟），时钟只归调用方。
    const report: GovernanceEpochReport = { ...raw, durationMs: Math.max(0, Date.now() - startedAt) }
    // 只有真正应用了迁移才推进 epoch 号：跳过的 epoch 不是一代，dashboard 上的号必须与
    // "缓存被重建过几次"一一对应，否则模型看到号在涨却没有任何东西变短。
    if (report.applied) this.epochSeq += 1
    this.pushReport(report)
    return report
  }

  /**
   * 缺页记账：`recall_context` 命中账本记录时调用。
   *
   * `ref` 可以是记录 id、payloadRef 或 toolCallId —— 折叠信封给模型的指引就是这三种之一，
   * 这里全认，命中不了直接返回 false（其它折叠机制的引用不该记进本账本的 fault 率）。
   */
  public recordFault(ref: string, at: number): boolean {
    const record = this.findRecordByRef(ref)
    if (!record) return false
    // 缺页的字面意思：**这一页当时不在**。召回一条仍然 INLINE 的记录不是治理失误，
    // 记进 fault 率只会让"降级降错了"的信号被日常召回稀释掉。
    if (this.ledgerRef.residencyOf(record.id) === 'INLINE') return false

    this.ledgerRef.recordFault(record.id, at)
    return true
  }

  /** 转交信号：连续 N 次低收益 epoch 且 post-epoch 占用仍高。 */
  public handoffSignal(): ContextHandoffSignal {
    const applied = this.reports.filter((report) => report.trigger !== null).slice(-HandoffLowSavingStreak)
    const recentSavingPercents = [...applied].reverse().map((report) => report.savingPercent)
    const last = applied.at(-1)
    const lastEpochAfterPercent = toNullable(last?.afterPercent)
    const lowSavingStreak =
      applied.length >= HandoffLowSavingStreak &&
      applied.every((report) => report.savingPercent < this.config.minEpochSavingPercent)
    const armed =
      lowSavingStreak &&
      lastEpochAfterPercent !== null &&
      lastEpochAfterPercent > HandoffOccupancyPercent

    return {
      armed,
      recentSavingPercents,
      lastEpochAfterPercent,
      reason: armed ? 'low-saving-streak' : null,
    }
  }

  /**
   * 模型是否在**最新一轮**调用了 `distill_context`（= 请求开一次 epoch）。
   *
   * 信号从账本结构里读，不从工具 handler 推 —— handler 侧信号需要一条穿过 ToolContext 的
   * 新端口，而这个事实本来就在历史里逐字可查；从账本读还天然可离线重放（B4 的前提）。
   * 每条请求记录只消费一次，避免同一次调用在后续轮次反复触发 epoch。
   */
  private consumeModelEpochRequest(): boolean {
    const records = this.ledgerRef.list()
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index]
      if (record.kind !== 'tool-result' || record.toolName !== ContextEpochRequestToolName) continue
      if (record.id === this.lastEpochRequestRecordId) return false

      this.lastEpochRequestRecordId = record.id
      return true
    }

    return false
  }

  private findRecordByRef(ref: string): Nullable<ContextRecord> {
    const key = ref.trim()
    if (!key) return null

    const direct = this.ledgerRef.get(key)
    if (direct) return direct

    // 折叠信封的 ref 优先用 payloadRef，其次 toolCallId；`tool:<id>` 是 v1 沿用的前缀形态。
    const bare = key.startsWith('tool:') ? key.slice('tool:'.length) : key
    for (const record of this.ledgerRef.list()) {
      if (record.payloadRef === key || record.toolCallId === bare) return record
      if (record.excerpt?.ref === key) return record
    }

    return null
  }

  private pushReport(report: GovernanceEpochReport): void {
    this.reports.push(report)
    if (this.reports.length > MaxRetainedEpochReports) {
      this.reports.splice(0, this.reports.length - MaxRetainedEpochReports)
    }
  }

  private resetLedger(): void {
    this.ledgerRef = this.createLedger()
    this.ingestedFingerprints = []
    this.nextTurn = 0
    this.lastEpochRequestRecordId = null
  }

  private createLedger(): ContextResidencyLedger {
    return new ContextResidencyLedger({
      config: this.config,
      classifier: this.classifier,
      sink: this.sink,
    })
  }
}

export interface ContextGovernanceSessionRegistryOptions {
  /** 宿主注入的治理配置（宽容解析 + 默认值兜底）。 */
  config?: LooseOptional<ContextGovernanceConfigInput>
  /** 领域语义分类器：refetchable / 去重目标 / pinned（能力包注入，agent 包不认工具名单）。 */
  classifier?: LooseOptional<ContextRecordClassifier>
  /** 迁移事件汇工厂；缺省关闭落盘（agent 包 host 无关，写盘是宿主的事）。 */
  sinkFactory?: LooseOptional<(sessionId: string) => Nullable<ContextMigrationEventSink>>
  /** 最大跟踪会话数；超出按 updatedAt 淘汰最旧。 */
  maxTrackedSessions?: LooseOptional<number>
}

/**
 * 治理会话登记处（宿主级单实例）。
 *
 * 取代 `ContextAttentionSessionRegistry` 的注入位：编译器、召回服务与转交信号消费同一份状态。
 */
export class ContextGovernanceSessionRegistry {
  private readonly sessions = new Map<string, ContextGovernanceSession>()
  private config: ContextGovernanceConfig
  private readonly classifier: Nullable<ContextRecordClassifier>
  private readonly sinkFactory: Nullable<(sessionId: string) => Nullable<ContextMigrationEventSink>>
  private readonly maxTrackedSessions: number

  public constructor(options: ContextGovernanceSessionRegistryOptions = {}) {
    this.config = resolveContextGovernanceConfig(options.config)
    this.classifier = toNullable(options.classifier)
    this.sinkFactory = toNullable(options.sinkFactory)
    this.maxTrackedSessions = options.maxTrackedSessions ?? DefaultMaxTrackedSessions
  }

  public governanceConfig(): ContextGovernanceConfig {
    return this.config
  }

  /**
   * 晚绑治理配置（宿主的 `AgentSystemRuntimeConfig.contextGovernance` 在 run 开始时推进来）。
   *
   * registry 是宿主级单实例、比任何一次 run 都长寿，所以配置只能后到。**已存在的会话不改配置**：
   * 半程换水位会让同一本账本的前后半段按两套规则治理，epoch 报告与离线重放当场失去可比性；
   * 新配置从下一个新会话起生效，想立刻生效就 `invalidateSession`。
   */
  public configure(input: LooseOptional<ContextGovernanceConfigInput>): ContextGovernanceConfig {
    this.config = resolveContextGovernanceConfig(input)
    return this.config
  }

  /** 解析（并按需创建）会话治理器；sessionId 为空时返回 null（无身份不建状态）。 */
  public resolve(sessionId: LooseOptional<string>): Nullable<ContextGovernanceSession> {
    const key = sessionId?.trim()
    if (!key) return null

    const existing = this.sessions.get(key)
    if (existing) return existing

    const created = new ContextGovernanceSession(
      this.config,
      this.classifier,
      this.sinkFactory?.(key) ?? null
    )
    this.sessions.set(key, created)
    this.evictOldestSessionsBeyondLimit()
    return created
  }

  /** 已存在才返回，不建新会话（只读查询用）。 */
  public peek(sessionId: LooseOptional<string>): Nullable<ContextGovernanceSession> {
    const key = sessionId?.trim()
    if (!key) return null

    return toNullable(this.sessions.get(key))
  }

  /** fault 记账入口：`recall_context` 每次取回后调用；未命中账本返回 false。 */
  public recordFault(sessionId: LooseOptional<string>, ref: string, at: number = Date.now()): boolean {
    return this.peek(sessionId)?.recordFault(ref, at) ?? false
  }

  /** 转交信号（B1b 的 handoff 布防数据源）。 */
  public handoffSignal(sessionId: LooseOptional<string>): Nullable<ContextHandoffSignal> {
    return this.peek(sessionId)?.handoffSignal() ?? null
  }

  /**
   * 手动开一次 epoch（宿主 hook 的落点）。用 `peek` 而不是 `resolve`：从没编译过的会话没有账本，
   * 为了"压一下"凭空建一本空账本只会产出一份没有信息的报告。
   */
  public requestEpoch(
    sessionId: LooseOptional<string>,
    input: { at?: LooseOptional<number>; modelWindowTokens?: LooseOptional<number> } = {}
  ): Nullable<GovernanceEpochReport> {
    return (
      this.peek(sessionId)?.requestEpoch({
        at: input.at ?? Date.now(),
        modelWindowTokens: input.modelWindowTokens,
      }) ?? null
    )
  }

  /** 最近若干次 epoch 报告（scoreboard / 调试面数据源）。 */
  public epochReports(sessionId: LooseOptional<string>): readonly GovernanceEpochReport[] {
    return this.peek(sessionId)?.epochReports() ?? []
  }

  /** 硬失效通道：会话重置 / handoff / 清空时丢弃全部治理状态。 */
  public invalidateSession(sessionId: LooseOptional<string>): void {
    const key = sessionId?.trim()
    if (key) this.sessions.delete(key)
  }

  private evictOldestSessionsBeyondLimit(): void {
    if (this.sessions.size <= this.maxTrackedSessions) return

    const oldestFirst = [...this.sessions.entries()].sort(
      (left, right) => left[1].updatedAt - right[1].updatedAt
    )
    for (const [sessionId] of oldestFirst.slice(0, this.sessions.size - this.maxTrackedSessions)) {
      this.sessions.delete(sessionId)
    }
  }
}

/** 两串指纹的公共前缀长度。 */
function resolveSharedPrefixLength(left: readonly string[], right: readonly string[]): number {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left[index] === right[index]) index += 1
  return index
}
