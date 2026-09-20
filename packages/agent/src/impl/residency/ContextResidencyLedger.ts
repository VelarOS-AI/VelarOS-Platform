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

import type { ContextMigrationEventSink } from '../../contract/requires.js'
import type { ContextAdmissionInput, ContextGovernanceConfig, ContextLedgerAppendResult, ContextLedgerStats, ContextMigrationCause, ContextMigrationOutcome, ContextRecord, ContextRecordClassifier, ContextResidency, ContextResidencyMigrationEvent, ContextResidencyVector, ResidencyLedgerView } from '../../types/residency.js'
import { admitContextRecord } from '../../utils/residency/admission'
import { clampResidencyForRecord, DefaultResidencyCharsPerToken, estimateResidencyTokens, isResidencyDowngrade, residencyRank } from '../../utils/residency/context-record'
import { DefaultContextGovernanceConfig } from '../../utils/residency/governance-config'
import { residentChars } from '../../utils/residency/projection'

/** 建 `ContextResidencyLedger` 时一次性交的几项，全部可省；整个对象都能不传（全走缺省）。 */
export interface ContextResidencyLedgerOptions {
  /** 这本账本用哪套治理配置（准入阈值、fault 恢复参数等），缺省 `DefaultContextGovernanceConfig`；建好之后不再变，换配置要换一本账本。 */
  config?: LooseOptional<ContextGovernanceConfig>
  /** 准入时给记录分类的钩子，决定它初始落在哪一层；不传就只按配置里的机械规则判。 */
  classifier?: LooseOptional<ContextRecordClassifier>
  /** 迁移与 fault 事件往哪儿写；不传就不落事件（账本照常工作，只是没有可观测和可重放的那条流）。 */
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

/**
 * 驻留账本对外这一面：在 `ResidencyLedgerView`（追加、查、迁移、统计）之上，再加只有账本主人用得着的几个口子——
 * 刷量纲、查升温租约与粘滞状态、标待逐出、记缺页。
 *
 * 实现是 `ContextResidencyLedger`，一个治理会话持一本，整本重建时换新的一本（代数 +1）。状态全在内存里。
 * 记录一旦入账永不改写：降级是向量上的迁移事件，fault 后的提升是在尾部追加新副本，两者都不动历史前缀，所以都缓存安全。
 * 传进来的 recordId 不在账本里时一律抛 `AppError('INVARIANT', …)`——那说明调用方拿着另一代的 id。
 */
export interface ContextResidencyLedgerApi extends ResidencyLedgerView {
  /** 刷新记账量纲（字符/token 密度），由会话每轮按实测值喂进来。非法或缺席的值**保持当前值**而不是打回缺省 4：治理链路上「这一次没量出密度」是常态（手动 epoch、空账本轮次），解释成「密度回到 4」会让同一本账的统计在轮次之间跳。 */
  setCharsPerToken(value: LooseOptional<number>): void
  /** 这条记录的升温租约保到第几个 turn（含）；没有租约时返回 null。租约由准入和 fault 退避共同写，查它是为了解释「为什么这条还逐不掉」。 */
  warmUntilTurnOf(recordId: string): Nullable<number>
  /** 这条记录是不是已经因为反复缺页升级成了本代内不再逐出；账本整本重建后自然清零。 */
  isStickyAfterFault(recordId: string): boolean
  /** epoch 排序阶段调用，把一条记录标进待逐出集；幂等，重复标不出错。记录不存在时抛 `INVARIANT`。 */
  markPendingEvict(recordId: string): void
  /** 记一次缺页（`历史检索服务` 命中了非 INLINE 的记录）并返回这条记录累计的缺页次数：落一条 fault 事件、按次数指数延长升温租约（到配置上限封顶）、够次数就转粘滞，并且——只要它还没 EXPIRED——当场升回它的准入驻留态（超长内容只回到 EXCERPT，不会把几十万字正文突然塞回 prompt）。 */
  recordFault(recordId: string, at: number): number
}

export class ContextResidencyLedger implements ContextResidencyLedgerApi {
  /** 没有升温租约时的哨兵轮号：比任何真实轮号都小，所以"当前轮 ≤ 它"恒为假。 */
  private static readonly NoWarmLeaseTurn = -1

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
    return currentTurn <= (this.warmUntilTurn.get(recordId) ?? ContextResidencyLedger.NoWarmLeaseTurn)
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
   * 缺页（fault）记账：`历史检索服务` 命中非 INLINE 记录时调用。
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
    const currentLease = this.warmUntilTurn.get(recordId) ?? ContextResidencyLedger.NoWarmLeaseTurn
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
