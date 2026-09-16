// Platform Kernel 统一持有与宿主无关的远程节点实现。
// 调用侧的终态回放缓存：断线期间产生的结果留在这里等重连来取。
import { isUndefined, toNullable } from '@velaros-ai/core'

import { KernelTuning } from '../../utils/tuning'
import type { RemoteNodeResult } from '../../utils/wire/remote-node'

export class RemoteNodeResultCache {
  private readonly entries = new Map<string, RemoteNodeResult>()

  public constructor(
    private readonly capacity: number = KernelTuning.remoteNodeCompletedCallCapacity,
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
