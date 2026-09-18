/**
 * 事务变更投影仓库：`TransactionProjectionRepository`。接口 `TransactionProjectionRepositoryApi`、构造参数与快照形状在本文件的类上方。
 */

import type { ProjectChangeRecordInput } from '../../types/change-feed.js'

/** 投影仓库的构造参数。 */
export interface TransactionProjectionRepositoryOptions {
  /** 最多保存多少条投影；与事务表共用同一容量，超过时只淘汰已经没有对应事务的历史投影。 */
  readonly maxProjections: number
}

/** 投影仓库的结构快照，失败补偿时整个换回去。 */
export interface TransactionProjectionRepositorySnapshot {
  /** 事务号 → 该事务最新的变更投影。 */
  readonly projections: ReadonlyMap<string, ProjectChangeRecordInput>
}

/**
 * 事务 ChangeFeed 投影的纯内存仓库：按事务号保存每个事务最新的变更投影，随事务状态一起落盘，重启后读回。
 *
 * 只保存 durable snapshot 对应的最新投影视图；投影构造、事务状态提交和 ChangeFeed 发布顺序由内核编排，
 * 存储容器不拥有提交策略。实例由内核持有，一个内核一份。
 */
export interface TransactionProjectionRepositoryApi {
  /** 取一个事务最新的投影；没有返回 undefined。 */
  get(transactionId: string): ProjectChangeRecordInput | undefined
  /** 记下（或覆盖）一个事务的投影，按事务号存。 */
  set(projection: ProjectChangeRecordInput): void
  /** 删掉一个事务的投影；返回原来有没有。 */
  delete(transactionId: string): boolean
  /** 按插入顺序遍历全部投影。 */
  values(): IterableIterator<ProjectChangeRecordInput>
  /** 拷一份结构快照（投影对象本身不复制），失败时交给 restore 换回。 */
  snapshot(): TransactionProjectionRepositorySnapshot
  /** 用快照整个换掉当前的投影表。 */
  restore(snapshot: TransactionProjectionRepositorySnapshot): void
  /**
   * 超过容量时按插入顺序淘汰投影，但仍保留的事务（isTransactionRetained 为真）不淘汰：
   * 还能 apply、rollback 的事务要靠投影里的 revision 证据。返回被淘汰的事务号。
   */
  cap(isTransactionRetained: (transactionId: string) => boolean): readonly string[]
  /** 清空后装入从落盘状态读回的投影。 */
  hydrate(projections: readonly ProjectChangeRecordInput[]): void
}

export class TransactionProjectionRepository implements TransactionProjectionRepositoryApi {
  private projections = new Map<string, ProjectChangeRecordInput>()

  public constructor(private readonly options: TransactionProjectionRepositoryOptions) {}

  public get(transactionId: string): ProjectChangeRecordInput | undefined {
    return this.projections.get(transactionId)
  }

  public set(projection: ProjectChangeRecordInput): void {
    this.projections.set(projection.transactionId, projection)
  }

  public delete(transactionId: string): boolean {
    return this.projections.delete(transactionId)
  }

  public values(): IterableIterator<ProjectChangeRecordInput> {
    return this.projections.values()
  }

  public snapshot(): TransactionProjectionRepositorySnapshot {
    return { projections: new Map(this.projections) }
  }

  public restore(snapshot: TransactionProjectionRepositorySnapshot): void {
    this.projections = new Map(snapshot.projections)
  }

  /**
   * durable snapshot 与事务表共享同一容量。超过上限时只淘汰已无对应事务的历史投影，
   * 仍可 apply/rollback 的事务投影必须保留其 revision 证据。
   */
  public cap(isTransactionRetained: (transactionId: string) => boolean): readonly string[] {
    const evicted: string[] = []
    for (const transactionId of this.projections.keys()) {
      if (this.projections.size <= this.options.maxProjections) break
      if (isTransactionRetained(transactionId)) continue
      this.projections.delete(transactionId)
      evicted.push(transactionId)
    }
    return evicted
  }

  public hydrate(projections: readonly ProjectChangeRecordInput[]): void {
    this.projections.clear()
    for (const projection of projections) {
      this.set(projection)
    }
  }
}
