/**
 * 驻留账本（上下文治理 v2 的唯一状态容器）。
 *
 * 会话上下文 = 一本**只追加**的记录账本；发给模型的 prompt = 账本在驻留态向量下的确定性投影。
 * 本类只做三件事，一件不多：
 *  ① 追加记录（走准入钩子定初始驻留）；
 *  ② 维护驻留态向量与 fault 计数——**唯一的变更通道是显式迁移**，每次迁移落一条带因果与
 *     token 差的事件；
 *  ③ 导出可打印、可 diff、可回放的状态（向量 + 统计 + pending 逐出集）。
 *
 * 铁律：`ContextRecord` 一旦入账永不改写。降级是向量上的迁移事件，提升（fault 后重新驻留）
 * 是在**尾部追加新副本**——两者都不动历史前缀，所以都缓存安全。
 *
 * 本类不做治理决策：什么时候降、降谁、降到哪，归 Governor（B1）。这里只提供"能被驱动"的机器。
 */
import { isFiniteNumber, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import {
  admitContextRecord,
  type ContextAdmissionInput,
  type ContextRecordClassifier,
} from './admission'
import {
  clampResidencyForRecord,
  type ContextRecord,
  type ContextResidency,
  type ContextResidencyVector,
  DefaultResidencyCharsPerToken,
  estimateResidencyTokens,
  isResidencyDowngrade,
  residencyRank,
} from './ContextRecord'
import { type ContextGovernanceConfig, DefaultContextGovernanceConfig } from './governanceConfig'
import type {
  ContextMigrationCause,
  ContextMigrationEventSink,
  ContextResidencyMigrationEvent,
} from './migrationLog'
import { residentChars } from './projection'

export interface ContextResidencyLedgerOptions {
  config?: LooseOptional<ContextGovernanceConfig>
  classifier?: LooseOptional<ContextRecordClassifier>
  sink?: LooseOptional<ContextMigrationEventSink>
  /**
   * 本账本的代数：一本账本 = 一代，会话整本重建时递增。
   * 每条迁移/fault 事件都盖这个章，离线重放才能把跨代重名的记录 id（`ctx-r000001`）分开。
   */
  ledgerGeneration?: LooseOptional<number>
  /**
   * 记账量纲：字符/token 密度（缺省 4）。
   *
   * 与治理器、投影用同一个数——账本自己按 4 记、治理器按实测密度记，就会出现
   * 「dashboard 说占了 3 万 token、epoch 报告说 8 万」这种同一本账两个数（§16.5 挂账）。
   */
  charsPerToken?: LooseOptional<number>
}

export interface ContextLedgerAppendResult {
  record: ContextRecord
  event: ContextResidencyMigrationEvent
  /** 被本次追加标为 pending-EVICT 的旧记录 id（只标记，逐出归 epoch）。 */
  supersededIds: string[]
}

export interface ContextLedgerStats {
  recordCount: number
  byResidency: Record<ContextResidency, number>
  pendingEvictCount: number
  pinnedCount: number
  refetchableCount: number
  totalFaults: number
  /** 当前轮仍受准入/缺页升温租约保护的记录数。 */
  warmProtectedCount: number
  /** 因重复缺页而在当前账本代保持驻留的记录数。 */
  stickyFaultCount: number
  /** 当前驻留态下的字符与 token 占用。 */
  residentChars: number
  residentTokens: number
  /** 全部记录以 INLINE 计的字符占用（省下多少的分母）。 */
  fullChars: number
  /** 本次统计用的字符/token 密度（读不出量纲的 token 数没法和别处对账）。 */
  charsPerToken: number
}

/** 迁移被拒的原因（拒绝不抛异常——治理器可能批量试探，返回诊断更好用）。 */
export type ContextMigrationRejection = 'no-op' | 'upgrade-not-allowed' | 'pinned-floor'

export interface ContextMigrationOutcome {
  applied: boolean
  event: Nullable<ContextResidencyMigrationEvent>
  /** 因 pinned 地板被夹住时的实际落点。 */
  residency: ContextResidency
  rejection: Nullable<ContextMigrationRejection>
}

export class ContextResidencyLedger {
  private readonly records: ContextRecord[] = []
  private readonly recordsById = new Map<string, ContextRecord>()
  private readonly residency = new Map<string, ContextResidency>()
  private readonly faults = new Map<string, number>()
  /** 记录 id → 保护到哪个 turn（含）。准入租约与 fault 指数退避共用。 */
  private readonly warmUntilTurn = new Map<string, number>()
  /** 重复缺页达到阈值后，本账本代内不再逐出。重建自然清空。 */
  private readonly stickyFaults = new Set<string>()
  private readonly pendingEvict = new Set<string>()
  private readonly config: ContextGovernanceConfig
  private readonly classifier: Nullable<ContextRecordClassifier>
  private readonly sink: Nullable<ContextMigrationEventSink>
  private readonly ledgerGeneration: number
  private nextSeq = 0
  /** 记账量纲；由会话在每轮治理时按编译期实测值刷新（缺省 4）。 */
  private charsPerToken = DefaultResidencyCharsPerToken

  public constructor(options: ContextResidencyLedgerOptions = {}) {
    this.config = options.config ?? DefaultContextGovernanceConfig
    this.classifier = toNullable(options.classifier)
    this.sink = toNullable(options.sink)
    this.ledgerGeneration = options.ledgerGeneration ?? 0
    this.setCharsPerToken(options.charsPerToken)
  }

  /**
   * 刷新记账量纲。
   *
   * 非法/缺席值一律**保持当前值**而不是打回 4：治理链路上"这一次没量出密度"是常态
   * （手动 epoch、空账本轮次），把它解释成"密度回到 4"会让同一本账本的统计在轮次之间跳来跳去。
   */
  public setCharsPerToken(value: LooseOptional<number>): void {
    if (!isFiniteNumber(value) || value <= 0) return

    this.charsPerToken = value
  }

  /** 追加一条记录：走准入钩子定初始驻留，落准入事件，标失效旧快照。 */
  public append(input: ContextAdmissionInput): ContextLedgerAppendResult {
    const decision = admitContextRecord(input, {
      seq: this.nextSeq,
      config: this.config,
      classifier: this.classifier,
      priorRecords: this.records,
    })
    this.nextSeq += 1

    const record = decision.record
    this.records.push(record)
    this.recordsById.set(record.id, record)
    this.residency.set(record.id, record.admittedResidency)
    if (record.warmLeaseTurns > 0) {
      this.warmUntilTurn.set(record.id, record.turn + record.warmLeaseTurns)
    }
    for (const supersededId of decision.supersededIds) {
      this.pendingEvict.add(supersededId)
    }

    const event: ContextResidencyMigrationEvent = {
      recordId: record.id,
      from: null,
      to: record.admittedResidency,
      cause: decision.cause,
      tokensDelta: estimateResidencyTokens(
        residentChars(record, record.admittedResidency),
        this.charsPerToken
      ),
      at: record.createdAt,
      ledgerGeneration: this.ledgerGeneration,
    }
    this.sink?.recordMigration(event)

    return { record, event, supersededIds: decision.supersededIds }
  }

  public get(recordId: string): Nullable<ContextRecord> {
    return toNullable(this.recordsById.get(recordId))
  }

  /** 账本序（追加序）的全部记录。 */
  public list(): readonly ContextRecord[] {
    return this.records
  }

  public residencyOf(recordId: string): ContextResidency {
    const current = this.residency.get(recordId)
    if (!current) throw new AppError('INVARIANT', `驻留账本没有记录 ${recordId}`)
    return current
  }

  /** 驻留态向量：任何时刻"上下文里有什么"的完整快照，可打印可 diff。 */
  public residencyVector(): ContextResidencyVector {
    return new Map(this.records.map((record) => [record.id, this.residencyOf(record.id)]))
  }

  public faultCountOf(recordId: string): number {
    return this.faults.get(recordId) ?? 0
  }

  /** 记录是否仍在升温租约内，或已因重复缺页升级为本代粘滞驻留。 */
  public isEvictionProtected(recordId: string, currentTurn: number): boolean {
    this.assertKnown(recordId)
    if (this.stickyFaults.has(recordId)) return true
    return currentTurn <= (this.warmUntilTurn.get(recordId) ?? -1)
  }

  public warmUntilTurnOf(recordId: string): Nullable<number> {
    this.assertKnown(recordId)
    return toNullable(this.warmUntilTurn.get(recordId))
  }

  public isStickyAfterFault(recordId: string): boolean {
    this.assertKnown(recordId)
    return this.stickyFaults.has(recordId)
  }

  public pendingEvictions(): string[] {
    return this.records.filter((record) => this.pendingEvict.has(record.id)).map((record) => record.id)
  }

  /** 由 epoch 排序阶段调用：把一条记录标为待逐出（幂等）。 */
  public markPendingEvict(recordId: string): void {
    this.assertKnown(recordId)
    this.pendingEvict.add(recordId)
  }

  /**
   * 显式驻留迁移：只许降级；pinned 记录夹在 EXCERPT 地板上。
   * 拒绝不抛错（治理器会批量试探），返回诊断由调用方决定怎么处理。
   */
  public migrate(
    recordId: string,
    to: ContextResidency,
    cause: ContextMigrationCause,
    at: number
  ): ContextMigrationOutcome {
    const record = this.assertKnown(recordId)
    const from = this.residencyOf(recordId)
    const target = clampResidencyForRecord(record, to)

    if (target === from) return {
        applied: false,
        event: null,
        residency: from,
        rejection: target === to ? 'no-op' : 'pinned-floor',
      }

    if (!isResidencyDowngrade(from, target)) return {
        applied: false,
        event: null,
        residency: from,
        rejection: 'upgrade-not-allowed',
      }

    const beforeTokens = estimateResidencyTokens(residentChars(record, from), this.charsPerToken)
    const afterTokens = estimateResidencyTokens(residentChars(record, target), this.charsPerToken)
    this.residency.set(recordId, target)
    this.pendingEvict.delete(recordId)

    const event: ContextResidencyMigrationEvent = {
      recordId,
      from,
      to: target,
      cause,
      tokensDelta: afterTokens - beforeTokens,
      at,
      ledgerGeneration: this.ledgerGeneration,
    }
    this.sink?.recordMigration(event)

    return {
      applied: true,
      event,
      residency: target,
      rejection: target === to ? null : 'pinned-floor',
    }
  }

  /**
   * 缺页（fault）记账：`context:recall` 命中非 INLINE 记录时调用。
   * fault 率是策略好坏的核心信号，也替代 v1 断链的 outcome 回学。
   */
  public recordFault(recordId: string, at: number): number {
    const record = this.assertKnown(recordId)
    const faultCount = this.faultCountOf(recordId) + 1
    this.faults.set(recordId, faultCount)
    const residencyAtFault = this.residencyOf(recordId)
    this.sink?.recordFault({
      recordId,
      residency: residencyAtFault,
      faultCount,
      ageMs: Math.max(0, at - record.createdAt),
      at,
      ledgerGeneration: this.ledgerGeneration,
    })

    const currentTurn = this.records.reduce((latest, candidate) => Math.max(latest, candidate.turn), 0)
    const recovery = this.config.faultRecovery
    const exponentialLease = recovery.baseWarmLeaseTurns * 2 ** Math.min(20, faultCount - 1)
    const leaseTurns = Math.min(recovery.maxWarmLeaseTurns, exponentialLease)
    const currentLease = this.warmUntilTurn.get(recordId) ?? -1
    this.warmUntilTurn.set(recordId, Math.max(currentLease, currentTurn + leaseTurns))
    if (faultCount >= recovery.stickyAfterFaults) this.stickyFaults.add(recordId)

    // fault 证明这条记录当前仍有用：恢复到它的准入驻留态。超长内容只回到 EXCERPT，不把 300K
    // 正文突然塞回 prompt；普通内容回到 INLINE。迁移是显式事件，缓存只在真实 fault 后失效一次。
    if (residencyAtFault !== 'EXPIRED') this.pageIn(recordId, record.admittedResidency, at)
    return faultCount
  }

  /** 缺页后的显式升温通道；普通治理仍只能调用 migrate 单向降级。 */
  private pageIn(recordId: string, to: ContextResidency, at: number): ContextMigrationOutcome {
    const record = this.assertKnown(recordId)
    const from = this.residencyOf(recordId)
    const target = clampResidencyForRecord(record, to)
    if (residencyRank(target) >= residencyRank(from)) return {
        applied: false,
        event: null,
        residency: from,
        rejection: 'no-op',
      }

    const beforeTokens = estimateResidencyTokens(residentChars(record, from), this.charsPerToken)
    const afterTokens = estimateResidencyTokens(residentChars(record, target), this.charsPerToken)
    this.residency.set(recordId, target)
    this.pendingEvict.delete(recordId)
    const event: ContextResidencyMigrationEvent = {
      recordId,
      from,
      to: target,
      cause: 'fault-page-in',
      tokensDelta: afterTokens - beforeTokens,
      at,
      ledgerGeneration: this.ledgerGeneration,
    }
    this.sink?.recordMigration(event)
    return { applied: true, event, residency: target, rejection: null }
  }

  public stats(): ContextLedgerStats {
    const byResidency: Record<ContextResidency, number> = {
      INLINE: 0,
      EXCERPT: 0,
      SUMMARIZED: 0,
      EVICTED: 0,
      EXPIRED: 0,
    }
    let chars = 0
    let fullChars = 0
    let pinnedCount = 0
    let refetchableCount = 0
    const latestTurn = this.records.reduce((latest, record) => Math.max(latest, record.turn), 0)
    let warmProtectedCount = 0

    for (const record of this.records) {
      const residency = this.residencyOf(record.id)
      byResidency[residency] += 1
      chars += residentChars(record, residency)
      fullChars += record.bytes.full
      if (record.pinned) pinnedCount += 1
      if (record.refetchable) refetchableCount += 1
      if (this.isEvictionProtected(record.id, latestTurn)) warmProtectedCount += 1
    }

    let totalFaults = 0
    for (const count of this.faults.values()) {
      totalFaults += count
    }

    return {
      recordCount: this.records.length,
      byResidency,
      pendingEvictCount: this.pendingEvict.size,
      pinnedCount,
      refetchableCount,
      totalFaults,
      warmProtectedCount,
      stickyFaultCount: this.stickyFaults.size,
      residentChars: chars,
      residentTokens: estimateResidencyTokens(chars, this.charsPerToken),
      fullChars,
      charsPerToken: this.charsPerToken,
    }
  }

  private assertKnown(recordId: string): ContextRecord {
    const record = this.recordsById.get(recordId)
    if (!record) throw new AppError('INVARIANT', `驻留账本没有记录 ${recordId}`)
    return record
  }
}
