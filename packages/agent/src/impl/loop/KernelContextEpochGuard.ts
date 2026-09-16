// 域：provider 请求的**上下文纪元（epoch）**——「我拼装时看到的上下文，到真正发出去时还是不是同一份」
// 的乐观并发校验，外加把该纪元记进回合诊断。
//
// ## 为什么需要它
// 拼装一次请求（选历史、选工具、算预算）与真正把它发给 provider 之间隔着若干次 await。这期间用户可能
// 发了新消息、工具页可能换了、上下文可能被压缩过。发一份**基于陈旧上下文**的请求，症状是模型答非所问
// 或引用了已不存在的工具，而且不可复现。`claim()` 在拼装点领一个 (key, revision)，发送前
// `assertCurrent()` 复核；同一 key 再次 claim 会使前一次作废（**后来者赢**——新意图总是压过在途的旧请求）。
//
// ## 关键不变量
//  - **key 由 `scope ?? sessionId` + `phase` 组成**：子 Agent 传自己的 scope（threadId），因此父子并发
//    互不作废。把 scope 去掉会让并发子 Agent 互相踩废对方的请求。
//  - **revision 单调递增、只增不减**，`assertCurrent` 用严格相等而不是「大于等于」：任何一次插队都必须
//    让在途请求失效，不许放行。
//
// ## 纪元指纹的确定性（P7-2）
// `sortedUnique` 用码元序比较（`compareStableStrings`）而非 locale 相关比较，`normalize*` 把所有数值
// 钳到规范形态。判据：同一份上下文在不同机器/不同 locale 下必须算出**同一个纪元**，否则诊断会把
// 环境差异误报成「上下文变了」，而这类误报没有任何办法证伪。
//

import type { KernelContextEpoch, KernelContextEpochClaim, KernelContextEpochGuardLike } from '../../types/loop.js'
import { resolveKernelContextEpochKey } from '../../utils/loop/context-epoch'
import { KernelContextEpochStaleError } from '../errors/KernelContextEpochStaleError'

/**
 * 上下文纪元看门人：管「我拼装请求时看到的上下文，到真正发出去时还是不是同一份」。
 *
 * 谁持有：`TurnRunner` 一个实例，主面与子 Agent 面的每轮都用它（args 没带时回落到这一份），
 * 修订号按 `scope ?? sessionId` + `phase` 分格存在实例里，跨回合累积、不落盘。
 * 一轮里的用法固定两步：`StreamTurn` / `QueryTurn` 编译完请求后 `claim()` 领一张凭据，发给 provider 前
 * `assertCurrent()` 复核；流消费期间每个分片再复核一次。期间有人插队（新消息、换工具页、压缩）就会
 * 重新 claim 让在途凭据作废，复核处抛 `KernelContextEpochStaleError` 把这轮打断——宁可重来，不许发陈旧上下文。
 */
export interface KernelContextEpochGuardApi extends KernelContextEpochGuardLike {
  /** 领一张凭据并把这把键的修订号 +1（同一把键上的前一张立即作废）；在请求编译完、发送前调。 */
  claim(epoch: KernelContextEpoch): KernelContextEpochClaim
  /** 只问不抛：这张凭据是不是仍是最新的。用于把「本轮是否仍当值」写进诊断。 */
  isCurrent(claim: KernelContextEpochClaim): boolean
  /** 复核凭据，过期就抛 `KernelContextEpochStaleError` 打断本轮；发送前与流消费每个分片处各调一次。 */
  assertCurrent(claim: KernelContextEpochClaim): void
}

export class KernelContextEpochGuard implements KernelContextEpochGuardApi {
  private readonly revisions = new Map<string, number>()

  public claim(epoch: KernelContextEpoch): KernelContextEpochClaim {
    const key = resolveKernelContextEpochKey(epoch)
    const revision = (this.revisions.get(key) ?? 0) + 1
    this.revisions.set(key, revision)
    return { key, revision, epoch }
  }

  public isCurrent(claim: KernelContextEpochClaim): boolean {
    return this.revisions.get(claim.key) === claim.revision
  }

  public assertCurrent(claim: KernelContextEpochClaim): void {
    const currentRevision = this.revisions.get(claim.key) ?? 0
    if (currentRevision === claim.revision) return
    throw new KernelContextEpochStaleError(claim, currentRevision)
  }
}

