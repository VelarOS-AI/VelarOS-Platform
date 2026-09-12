import { AsyncLocalStorage } from "node:async_hooks";

import { ProjectError } from "../errors.js";

interface ActiveTransactionCommand {
  active: boolean;
  transactionId: string;
}

/** 按 transactionId 串行化同一事务的生命周期命令（amend/apply/rollback），不同事务互不阻塞。 */
export class TransactionCoordinator {
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
        "INVALID_INPUT",
        `事务命令执行期间不能嵌套发起事务命令：${transactionId}`,
        {
          activeTransactionId: activeCommand.transactionId,
          requestedTransactionId: transactionId,
        },
        "请让当前 hook 返回；如需后续事务，请在外层命令完成后再发起。",
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
