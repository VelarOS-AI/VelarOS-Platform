import { toNullable } from '@velaros-ai/core'

interface CapabilityWriteLease {
  scope: string
  holderTaskId: string
  acquiredAt: number
}

/**
 * Team 写租约协调器。
 *
   * Multiple workers may run concurrently; leases serialize a capability-owned
   * resource/scope pair without interpreting the resource namespace.
 */
class WriteLeaseCoordinator {
  /** leaseKey -> 当前队列尾 Promise。 */
  private readonly queues = new Map<string, Promise<void>>()
  /** leaseKey -> 当前持有者信息。 */
  private readonly leases = new Map<string, CapabilityWriteLease>()

  /** Run under a capability-owned resource/scope write lease. */
  public async runWithLease<T>(
    resourceId: Nullable<string>,
    scope: Nullable<string>,
    holderTaskId: string,
    action: () => Promise<T>
  ): Promise<T> {
    if (!resourceId || !scope) {
      // 没有写范围时不需要串行化。
      return action()
    }

    const leaseKey = `${resourceId}::${scope}`
    const previous = this.queues.get(leaseKey) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const queued = previous.then(() => current)
    this.queues.set(leaseKey, queued)

    // 等待前一个同 key 写操作释放。
    await previous
    this.leases.set(leaseKey, {
      scope,
      holderTaskId,
      acquiredAt: Date.now(),
    })

    try {
      return await action()
    } finally {
      // 无论成功失败都释放租约并推进队列。
      this.leases.delete(leaseKey)
      release()
      if (this.queues.get(leaseKey) === queued) {
        this.queues.delete(leaseKey)
      }
    }
  }

  /** 读取当前租约持有者。 */
  public getLease(resourceId: Nullable<string>, scope: Nullable<string>): Nullable<CapabilityWriteLease> {
    if (!resourceId || !scope) return null

    return toNullable(this.leases.get(`${resourceId}::${scope}`))
  }
}

export type { CapabilityWriteLease }
export { WriteLeaseCoordinator }
