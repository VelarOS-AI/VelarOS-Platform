/** 按 transactionId 串行化同一事务的生命周期命令（amend/apply/rollback），不同事务互不阻塞。 */
export class TransactionCoordinator {
  // 队尾 promise 只由 release() 兑现、从不 reject：命令自身的失败只抛给它自己的调用方，
  // 因此排队等待前序命令时无需吞错。
  private readonly tails = new Map<string, Promise<void>>()
  private readonly pending = new Map<string, number>()

  public isBusy(transactionId: string): boolean {
    return (this.pending.get(transactionId) ?? 0) > 0
  }

  public async run<T>(transactionId: string, action: () => Promise<T>): Promise<T> {
    const predecessor = this.tails.get(transactionId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = predecessor.then(() => current)
    this.tails.set(transactionId, tail)
    this.pending.set(transactionId, (this.pending.get(transactionId) ?? 0) + 1)

    await predecessor
    try {
      return await action()
    } finally {
      release()
      const remaining = (this.pending.get(transactionId) ?? 1) - 1
      if (remaining > 0) this.pending.set(transactionId, remaining)
      else this.pending.delete(transactionId)
      if (this.tails.get(transactionId) === tail) this.tails.delete(transactionId)
    }
  }
}
