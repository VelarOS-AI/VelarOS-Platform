import type { ProjectChangeRecordInput } from "../change-feed.js";

export interface TransactionProjectionRepositoryOptions {
  readonly maxProjections: number;
}

export interface TransactionProjectionRepositorySnapshot {
  readonly projections: ReadonlyMap<string, ProjectChangeRecordInput>;
}

/**
 * 事务 ChangeFeed 投影的纯内存仓库。
 *
 * 这里只保存 durable snapshot 对应的最新投影视图；投影构造、事务状态提交和 ChangeFeed 发布顺序
 * 仍由 ProjectKernel 编排，避免存储容器拥有提交策略。
 */
export class TransactionProjectionRepository {
  private projections = new Map<string, ProjectChangeRecordInput>();

  public constructor(private readonly options: TransactionProjectionRepositoryOptions) {}

  public get(transactionId: string): ProjectChangeRecordInput | undefined {
    return this.projections.get(transactionId);
  }

  public set(projection: ProjectChangeRecordInput): void {
    this.projections.set(projection.transactionId, projection);
  }

  public delete(transactionId: string): boolean {
    return this.projections.delete(transactionId);
  }

  public values(): IterableIterator<ProjectChangeRecordInput> {
    return this.projections.values();
  }

  public snapshot(): TransactionProjectionRepositorySnapshot {
    return { projections: new Map(this.projections) };
  }

  public restore(snapshot: TransactionProjectionRepositorySnapshot): void {
    this.projections = new Map(snapshot.projections);
  }

  /**
   * durable snapshot 与事务表共享同一容量。超过上限时只淘汰已无对应事务的历史投影，
   * 仍可 apply/rollback 的事务投影必须保留其 revision 证据。
   */
  public cap(isTransactionRetained: (transactionId: string) => boolean): readonly string[] {
    const evicted: string[] = [];
    for (const transactionId of this.projections.keys()) {
      if (this.projections.size <= this.options.maxProjections) break;
      if (isTransactionRetained(transactionId)) continue;
      this.projections.delete(transactionId);
      evicted.push(transactionId);
    }
    return evicted;
  }

  public hydrate(projections: readonly ProjectChangeRecordInput[]): void {
    this.projections.clear();
    for (const projection of projections) {
      this.set(projection);
    }
  }
}
