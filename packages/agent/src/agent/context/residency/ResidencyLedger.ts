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
import { toNullable } from '@velaros-ai/core'
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
  estimateResidencyTokens,
  isResidencyDowngrade,
  residentChars,
} from './ContextRecord'
import { type ContextGovernanceConfig, DefaultContextGovernanceConfig } from './governanceConfig'
import type {
  ContextMigrationCause,
  ContextMigrationEventSink,
  ContextResidencyMigrationEvent,
} from './migrationLog'

export interface ContextResidencyLedgerOptions {
  config?: LooseOptional<ContextGovernanceConfig>
  classifier?: LooseOptional<ContextRecordClassifier>
  sink?: LooseOptional<ContextMigrationEventSink>
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
  /** 当前驻留态下的字符与 token 占用。 */
  residentChars: number
  residentTokens: number
  /** 全部记录以 INLINE 计的字符占用（省下多少的分母）。 */
  fullChars: number
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
  private readonly pendingEvict = new Set<string>()
  private readonly config: ContextGovernanceConfig
  private readonly classifier: Nullable<ContextRecordClassifier>
  private readonly sink: Nullable<ContextMigrationEventSink>
  private nextSeq = 0

  public constructor(options: ContextResidencyLedgerOptions = {}) {
    this.config = options.config ?? DefaultContextGovernanceConfig
    this.classifier = options.classifier ?? null
    this.sink = options.sink ?? null
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
    for (const supersededId of decision.supersededIds) {
      this.pendingEvict.add(supersededId)
    }

    const event: ContextResidencyMigrationEvent = {
      recordId: record.id,
      from: null,
      to: record.admittedResidency,
      cause: decision.cause,
      tokensDelta: estimateResidencyTokens(residentChars(record, record.admittedResidency)),
      at: record.createdAt,
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

    const beforeTokens = estimateResidencyTokens(residentChars(record, from))
    const afterTokens = estimateResidencyTokens(residentChars(record, target))
    this.residency.set(recordId, target)
    this.pendingEvict.delete(recordId)

    const event: ContextResidencyMigrationEvent = {
      recordId,
      from,
      to: target,
      cause,
      tokensDelta: afterTokens - beforeTokens,
      at,
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
    this.sink?.recordFault({
      recordId,
      residency: this.residencyOf(recordId),
      faultCount,
      ageMs: Math.max(0, at - record.createdAt),
      at,
    })
    return faultCount
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

    for (const record of this.records) {
      const residency = this.residencyOf(record.id)
      byResidency[residency] += 1
      chars += residentChars(record, residency)
      fullChars += record.bytes.full
      if (record.pinned) pinnedCount += 1
      if (record.refetchable) refetchableCount += 1
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
      residentChars: chars,
      residentTokens: estimateResidencyTokens(chars),
      fullChars,
    }
  }

  private assertKnown(recordId: string): ContextRecord {
    const record = this.recordsById.get(recordId)
    if (!record) throw new AppError('INVARIANT', `驻留账本没有记录 ${recordId}`)
    return record
  }
}
