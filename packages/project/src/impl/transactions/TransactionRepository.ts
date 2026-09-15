/**
 * 事务仓库：`TransactionRepository`。接口 `TransactionRepositoryApi`、构造参数与快照形状在本文件的类上方。
 */

import { isPresent, isUndefined } from '@velaros-ai/core'

import type { StoredTransaction } from '../../types/transaction.js'

/** 事务仓库的构造参数：两道保留上限。 */
export interface TransactionRepositoryOptions {
  /** 全部事务（含准备好还没应用的）最多留多少个，超过从最早加入的淘汰。 */
  readonly maxTransactions: number
  /** 已结束（终态）的事务最多留多少个，超过按最久没用的淘汰。 */
  readonly maxTerminalTransactions: number
}

/** 事务仓库的结构快照，失败补偿时整个换回去。 */
export interface TransactionRepositorySnapshot {
  /** 事务号 → 事务（对象本身是原引用）。 */
  readonly transactions: ReadonlyMap<string, StoredTransaction>
  /** 终态事务的保留顺序，最久没用的在前。 */
  readonly terminalTransactionOrder: readonly string[]
}

/**
 * Project 事务的纯内存仓库：管理事务身份、两道保留上限与可回退快照。
 *
 * 不决定状态转换，也不执行持久化或文件 IO；内核负责在正确的 durable、change-feed 提交边界调用这些原语。
 * 淘汰事务的方法都返回被淘汰的事务号，内核据此删掉对应的投影和字节计划。实例由内核持有，一个内核一份。
 */
export interface TransactionRepositoryApi {
  /** 当前一共有多少个事务。 */
  readonly size: number
  /** 按事务号取事务；没有返回 undefined。 */
  get(transactionId: string): StoredTransaction | undefined
  /** 有没有这个事务。 */
  has(transactionId: string): boolean
  /** 按加入顺序遍历全部事务。 */
  values(): IterableIterator<StoredTransaction>
  /** 加入一个新准备的事务，再按总量上限淘汰最早加入的；返回被淘汰的事务号。 */
  add(transaction: StoredTransaction): readonly string[]
  /** 替换一个已存在事务的完整状态；用于失败补偿，不改变保留顺序。 */
  set(transactionId: string, transaction: StoredTransaction): void
  /** 删掉一个事务（连同终态保留顺序里的记录）；返回原来有没有。 */
  delete(transactionId: string): boolean
  /** 用从落盘状态读回的事务整个替换事务表，并按 isTerminal 重建终态保留顺序。 */
  hydrate(transactions: readonly StoredTransaction[], isTerminal: (transaction: StoredTransaction) => boolean): void
  /** 拷一份结构快照（事务对象保持原引用），新增事务发布失败时交给 restore 换回。 */
  snapshot(): TransactionRepositorySnapshot
  /** 用快照整个换掉当前的事务表与终态保留顺序。 */
  restore(snapshot: TransactionRepositorySnapshot): void
  /** 记下一个刚结束的事务（移到保留顺序最后），再按终态上限淘汰最久没用的（不淘汰它自己）；返回被淘汰的事务号。 */
  retainTerminal(transactionId: string): readonly string[]
}

export class TransactionRepository implements TransactionRepositoryApi {
  private transactions = new Map<string, StoredTransaction>()
  private terminalTransactionOrder: string[] = []

  public constructor(private readonly options: TransactionRepositoryOptions) {}

  public get size(): number {
    return this.transactions.size
  }

  public get(transactionId: string): StoredTransaction | undefined {
    return this.transactions.get(transactionId)
  }

  public has(transactionId: string): boolean {
    return this.transactions.has(transactionId)
  }

  public values(): IterableIterator<StoredTransaction> {
    return this.transactions.values()
  }

  /** 新准备的事务进入仓库后，按插入顺序执行全部事务的兜底上限。 */
  public add(transaction: StoredTransaction): readonly string[] {
    this.transactions.set(transaction.transactionId, transaction)
    return this.capTransactions()
  }

  /** 替换一个已存在事务的完整状态；用于失败补偿，不改变保留队列。 */
  public set(transactionId: string, transaction: StoredTransaction): void {
    this.transactions.set(transactionId, transaction)
  }

  public delete(transactionId: string): boolean {
    const deleted = this.transactions.delete(transactionId)
    if (deleted) {
      this.terminalTransactionOrder = this.terminalTransactionOrder.filter(
        (retainedId) => retainedId !== transactionId,
      )
    }
    return deleted
  }

  /** 从 durable snapshot 装载事务，并按现有状态重建终态保留顺序。 */
  public hydrate(
    transactions: readonly StoredTransaction[],
    isTerminal: (transaction: StoredTransaction) => boolean,
  ): void {
    this.transactions = new Map(
      transactions.map((transaction) => [transaction.transactionId, transaction]),
    )
    this.terminalTransactionOrder = transactions
      .filter(isTerminal)
      .map((transaction) => transaction.transactionId)
  }

  /** 捕获仓库结构快照；事务对象本身保持原引用，适用于新增事务发布失败时恢复 Map。 */
  public snapshot(): TransactionRepositorySnapshot {
    return {
      transactions: new Map(this.transactions),
      terminalTransactionOrder: [...this.terminalTransactionOrder],
    }
  }

  public restore(snapshot: TransactionRepositorySnapshot): void {
    this.transactions = new Map(snapshot.transactions)
    this.terminalTransactionOrder = [...snapshot.terminalTransactionOrder]
  }

  /** 记录已结束事务，并按终态 LRU 上限淘汰最旧事务。 */
  public retainTerminal(transactionId: string): readonly string[] {
    this.terminalTransactionOrder = this.terminalTransactionOrder.filter(
      (retainedId) => retainedId !== transactionId,
    )
    this.terminalTransactionOrder.push(transactionId)
    return this.capTerminalTransactions(transactionId)
  }

  private capTransactions(): string[] {
    const evicted: string[] = []
    while (this.transactions.size > this.options.maxTransactions) {
      const oldest = this.transactions.keys().next().value
      if (isUndefined(oldest)) break
      if (this.delete(oldest)) evicted.push(oldest)
    }
    return evicted
  }

  private capTerminalTransactions(currentTransactionId?: string): string[] {
    const evicted: string[] = []
    while (this.terminalTransactionOrder.length > this.options.maxTerminalTransactions) {
      const oldest = this.terminalTransactionOrder.shift()
      if (isPresent(oldest) && oldest !== currentTransactionId) {
        if (this.transactions.delete(oldest)) evicted.push(oldest)
      }
    }
    return evicted
  }
}
