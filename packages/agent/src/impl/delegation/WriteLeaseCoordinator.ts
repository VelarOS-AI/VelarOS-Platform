import { toNullable } from '@velaros-ai/core'

import type { CapabilityWriteLease } from '../../types/delegation.js'

/**
 * 子 Agent 写租约协调器：同一个「资源 + 写范围」上的动作排队执行，互不交错。
 *
 * 并发跑着的多个 worker 可能同时想写同一处，这里按 `资源::范围` 拉一条队列把它们串起来。
 * 协调器不解释资源命名空间也不认识写的是什么，只保证同 key 的先来后到；不同 key 之间完全并行。
 * 派发器持一台，跟着进程活；租约只在内存里，进程内有效。
 */
export interface WriteLeaseCoordinatorApi {
  /**
   * 在「资源 + 范围」的写租约下跑一段动作：先等同 key 的前一个跑完，再占住租约执行 `action`。
   *
   * `resourceId` 或 `scope` 任一缺席即视为没有写范围，直接跑不排队。
   * 无论成功失败都在 `finally` 里释放租约并推进队列，所以 `action` 抛错不会把队列卡死。
   */
  runWithLease<T>(
    resourceId: Nullable<string>,
    scope: Nullable<string>,
    holderTaskId: string,
    action: () => Promise<T>
  ): Promise<T>
  /** 这个「资源 + 范围」此刻的租约持有者（谁、什么时候占的）；没人占或范围不完整时返回 null。供界面展示谁在写。 */
  getLease(resourceId: Nullable<string>, scope: Nullable<string>): Nullable<CapabilityWriteLease>
}

class WriteLeaseCoordinator implements WriteLeaseCoordinatorApi {
  /** leaseKey -> 当前队列尾 Promise。 */
  private readonly queues = new Map<string, Promise<void>>()
  /** leaseKey -> 当前持有者信息。 */
  private readonly leases = new Map<string, CapabilityWriteLease>()

  /** 在能力自己划定的「资源 + 写范围」租约下执行；没有写范围时不排队直接跑。 */
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

export { WriteLeaseCoordinator }
