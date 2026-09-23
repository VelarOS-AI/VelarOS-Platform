/**
 * 变更记录的公共部分：`BaseProjectChangeFeed`（抽象类），实现注入面的 `ProjectChangeFeedWriter`。
 * 内存里按事务号保存每个事务的最新一条记录、按序号排序、通知订阅者；落不落盘由子类的 persist 决定。
 */

import { AppError } from '@velaros-ai/core/error'

import { ProjectTransactionLimits } from '../../contract/constants.js'
import type { ProjectChangeFeedWriter } from '../../contract/requires.js'
import type {
  ProjectChangeListener,
  ProjectChangeListOptions,
  ProjectChangeRecord,
  ProjectChangeRecordInput,
} from '../../types/change-feed.js'
import { cloneChange } from '../../utils/transactions/change-records.js'

export abstract class BaseProjectChangeFeed implements ProjectChangeFeedWriter {
  private readonly changes = new Map<string, ProjectChangeRecord>()
  private readonly listeners = new Set<ProjectChangeListener>()
  private lastSequence = 0

  /** 收下一条已经落好的记录：序号必须严格递增，同一事务只留最新一条。 */
  protected hydrate(change: ProjectChangeRecord): void {
    if (change.sequence <= this.lastSequence) {
      throw new AppError('VALIDATION', '变更记录的序号必须严格递增。')
    }
    this.lastSequence = change.sequence
    this.changes.set(change.transactionId, cloneChange(change))
  }

  /** 把一条新记录落到持久层；落盘的子类实现它，只在内存里的子类不实现。 */
  protected persist?(change: ProjectChangeRecord): void

  public record(input: ProjectChangeRecordInput): ProjectChangeRecord {
    const change: ProjectChangeRecord = cloneChange({
      ...input,
      sequence: this.lastSequence + 1,
      updatedAt: Date.now(),
    })
    this.persist?.(change)
    this.hydrate(change)
    const published = cloneChange(change)
    for (const listener of this.listeners) listener(cloneChange(published))
    return published
  }

  public list(options: ProjectChangeListOptions = {}): readonly ProjectChangeRecord[] {
    const before = options.beforeSequence ?? Number.POSITIVE_INFINITY
    const limit = Math.max(
      1,
      Math.min(
        ProjectTransactionLimits.listMax,
        Math.floor(options.limit ?? ProjectTransactionLimits.listDefault)
      )
    )
    return [...this.changes.values()]
      .filter((change) => change.sequence < before)
      .sort((left, right) => right.sequence - left.sequence)
      .slice(0, limit)
      .map(cloneChange)
  }

  public get(transactionId: string): ProjectChangeRecord | undefined {
    const change = this.changes.get(transactionId)
    return change ? cloneChange(change) : undefined
  }

  public subscribe(listener: ProjectChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
