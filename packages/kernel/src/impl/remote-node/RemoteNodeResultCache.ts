// Platform Kernel 统一持有与宿主无关的远程节点实现。
// 调用侧的终态回放缓存：断线期间产生的结果留在这里等重连来取。
import { isUndefined, toNullable } from '@velaros-ai/core'

import { KernelTuning } from '../../utils/tuning'
import type { RemoteNodeResult } from '../../utils/wire/remote-node'

/**
 * callId → 终态结果的有界 FIFO 缓存。
 *
 * 一个 runner 一份。这是「重连后按同一 callId 重试是安全的」这条承诺的物质基础。
 */
export interface RemoteNodeResultCacheApi {
  /** 取一条已有终态;没有(或已被淘汰)时返回 `null`。 */
  get(callId: string): Nullable<RemoteNodeResult>
  /** 记一条终态;超容量时按最早写入淘汰。 */
  set(callId: string, result: RemoteNodeResult): void
  /** 清空缓存。仅用于解除配对与换配对对象——缓存属于上一段信任关系。 */
  clear(): void
}

export class RemoteNodeResultCache implements RemoteNodeResultCacheApi {
  private readonly entries = new Map<string, RemoteNodeResult>()

  public constructor(
    private readonly capacity: number = KernelTuning.remoteNodeCompletedCallCapacity
  ) {}

  public get(callId: string): Nullable<RemoteNodeResult> {
    return toNullable(this.entries.get(callId))
  }

  public set(callId: string, result: RemoteNodeResult): void {
    this.entries.set(callId, result)
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value
      if (isUndefined(oldest)) break
      this.entries.delete(oldest)
    }
  }

  public clear(): void {
    this.entries.clear()
  }
}
