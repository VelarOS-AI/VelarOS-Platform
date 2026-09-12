import { isPresent, isUndefined } from "@velaros-ai/core";

import type { StoredTransaction } from "../types/transaction.js";

export interface TransactionRepositoryOptions {
  readonly maxTransactions: number;
  readonly maxTerminalTransactions: number;
}

export interface TransactionRepositorySnapshot {
  readonly transactions: ReadonlyMap<string, StoredTransaction>;
  readonly terminalTransactionOrder: readonly string[];
}

/**
 * Project 事务的纯内存仓库。
 *
 * 这里只管理事务身份、保留上限与可回退快照，不决定状态转换，也不执行持久化或文件 IO。
 * `ProjectKernel` 仍负责在正确的 durable/change-feed 提交边界调用这些原语。
 */
export class TransactionRepository {
  private transactions = new Map<string, StoredTransaction>();
  private terminalTransactionOrder: string[] = [];

  public constructor(private readonly options: TransactionRepositoryOptions) {}

  public get size(): number {
    return this.transactions.size;
  }

  public get(transactionId: string): StoredTransaction | undefined {
    return this.transactions.get(transactionId);
  }

  public has(transactionId: string): boolean {
    return this.transactions.has(transactionId);
  }

  public values(): IterableIterator<StoredTransaction> {
    return this.transactions.values();
  }

  /** 新准备的事务进入仓库后，按插入顺序执行全部事务的兜底上限。 */
  public add(transaction: StoredTransaction): readonly string[] {
    this.transactions.set(transaction.transactionId, transaction);
    return this.capTransactions();
  }

  /** 替换一个已存在事务的完整状态；用于失败补偿，不改变保留队列。 */
  public set(transactionId: string, transaction: StoredTransaction): void {
    this.transactions.set(transactionId, transaction);
  }

  public delete(transactionId: string): boolean {
    const deleted = this.transactions.delete(transactionId);
    if (deleted) {
      this.terminalTransactionOrder = this.terminalTransactionOrder.filter(
        (retainedId) => retainedId !== transactionId,
      );
    }
    return deleted;
  }

  /** 从 durable snapshot 装载事务，并按现有状态重建终态保留顺序。 */
  public hydrate(
    transactions: readonly StoredTransaction[],
    isTerminal: (transaction: StoredTransaction) => boolean,
  ): void {
    this.transactions = new Map(
      transactions.map((transaction) => [transaction.transactionId, transaction]),
    );
    this.terminalTransactionOrder = transactions
      .filter(isTerminal)
      .map((transaction) => transaction.transactionId);
  }

  /** 捕获仓库结构快照；事务对象本身保持原引用，适用于新增事务发布失败时恢复 Map。 */
  public snapshot(): TransactionRepositorySnapshot {
    return {
      transactions: new Map(this.transactions),
      terminalTransactionOrder: [...this.terminalTransactionOrder],
    };
  }

  public restore(snapshot: TransactionRepositorySnapshot): void {
    this.transactions = new Map(snapshot.transactions);
    this.terminalTransactionOrder = [...snapshot.terminalTransactionOrder];
  }

  /** 记录已结束事务，并按终态 LRU 上限淘汰最旧事务。 */
  public retainTerminal(transactionId: string): readonly string[] {
    this.terminalTransactionOrder = this.terminalTransactionOrder.filter(
      (retainedId) => retainedId !== transactionId,
    );
    this.terminalTransactionOrder.push(transactionId);
    return this.capTerminalTransactions(transactionId);
  }

  private capTransactions(): string[] {
    const evicted: string[] = [];
    while (this.transactions.size > this.options.maxTransactions) {
      const oldest = this.transactions.keys().next().value;
      if (isUndefined(oldest)) break;
      if (this.delete(oldest)) evicted.push(oldest);
    }
    return evicted;
  }

  private capTerminalTransactions(currentTransactionId?: string): string[] {
    const evicted: string[] = [];
    while (this.terminalTransactionOrder.length > this.options.maxTerminalTransactions) {
      const oldest = this.terminalTransactionOrder.shift();
      if (isPresent(oldest) && oldest !== currentTransactionId) {
        if (this.transactions.delete(oldest)) evicted.push(oldest);
      }
    }
    return evicted;
  }
}
