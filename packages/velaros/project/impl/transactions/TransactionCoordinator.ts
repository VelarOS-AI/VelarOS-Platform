/**
 * 事务命令串行器：`TransactionCoordinator`。接口 `TransactionCoordinatorApi` 在本文件的类上方。
 */

import { AsyncLocalStorage } from 'node:async_hooks'

import type { ActiveTransactionCommand } from '../../types/transaction.js'
import { ProjectError } from '../../utils/errors.js'

/**
 * 按 transactionId 串行化同一事务的生命周期命令（amend/apply/rollback），不同事务互不阻塞。
 * 命令里（包括它触发的 hook）不许再嵌套发起事务命令。实例由内核持有，一个内核一份。
 */
export interface TransactionCoordinatorApi {
  /** 这个事务此刻有没有命令在跑或在排队。 */
  isBusy(transactionId: string): boolean
  /**
   * 排在同一事务的前序命令之后执行 action，返回它的结果；action 的失败只抛给本次调用方，不影响后面排队的命令。
   * 在另一条事务命令执行期间调用（嵌套）直接抛 INVALID_INPUT。
   */
  run<T>(transactionId: string, action: () => Promise<T>): Promise<T>
}

export class TransactionCoordinator implements TransactionCoordinatorApi {
  private readonly activeCommand = new AsyncLocalStorage<ActiveTransactionCommand>()
  // 队尾 promise 只由 release() 兑现、从不 reject：命令自身的失败只抛给它自己的调用方，
  // 因此排队等待前序命令时无需吞错。
  private readonly tails = new Map<string, Promise<void>>()
  private readonly pending = new Map<string, number>()

  public isBusy(transactionId: string): boolean {
    return (this.pending.get(transactionId) ?? 0) > 0
  }

  public async run<T>(transactionId: string, action: () => Promise<T>): Promise<T> {
    const activeCommand = this.activeCommand.getStore()
    if (activeCommand?.active) {
      throw new ProjectError(
        'INVALID_INPUT',
        `事务命令执行期间不能嵌套发起事务命令：${transactionId}`,
        {
          activeTransactionId: activeCommand.transactionId,
          requestedTransactionId: transactionId,
        },
        '请让当前 hook 返回；如需后续事务，请在外层命令完成后再发起。'
      )
    }
    const predecessor = this.tails.get(transactionId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = predecessor.then(() => current)
    this.tails.set(transactionId, tail)
    this.pending.set(transactionId, (this.pending.get(transactionId) ?? 0) + 1)

    await predecessor
    const commandContext: ActiveTransactionCommand = { active: true, transactionId }
    try {
      return await this.activeCommand.run(commandContext, action)
    } finally {
      commandContext.active = false
      release()
      const remaining = (this.pending.get(transactionId) ?? 1) - 1
      if (remaining > 0) this.pending.set(transactionId, remaining)
      else this.pending.delete(transactionId)
      if (this.tails.get(transactionId) === tail) this.tails.delete(transactionId)
    }
  }
}
