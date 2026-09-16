import { ExternalAgentBridgePairingBlockMs, ExternalAgentBridgePairingMaxFailures } from './ExternalAgentBridgeCommandQueue'

/**
 * 外部 Agent 桥的配对节流：配对码只有几位，这里数连续输错的次数，错够 `ExternalAgentBridgePairingMaxFailures` 次就封 `ExternalAgentBridgePairingBlockMs` 毫秒，防止对方穷举。
 *
 * 实现是 `ExternalAgentBridgePairingThrottle`，桥的宿主每个待配对通道持一个；配对码本身和它的过期计时仍归产品展示层管，这里只管「还让不让试」。状态只在内存里，进程重启即清零。
 */
export interface ExternalAgentBridgePairingThrottleApi {
  /** 封禁到什么时候：Unix 毫秒时间戳；0 表示从来没封过或已被 `reset` 清掉。给展示层算倒计时用。 */
  readonly blockedUntil: number
  /** 此刻是否还在封禁期内：true 时调用方必须直接拒掉这次配对尝试，连比对配对码都不要做。 */
  readonly isBlocked: boolean
  /** 记一次配对码输错：攒够上限就清零计数并开始新一轮封禁；没到上限只累加，不改 `blockedUntil`。 */
  reject(): void
  /** 配对成功（或通道作废重开）后清空失败计数和封禁期，让下一轮从干净状态重新开始。 */
  reset(): void
}

export class ExternalAgentBridgePairingThrottle implements ExternalAgentBridgePairingThrottleApi {
  private failures = 0
  private blockedUntilValue = 0

  public constructor(private readonly now: () => number = Date.now) {}

  public get blockedUntil(): number {
    return this.blockedUntilValue
  }

  public get isBlocked(): boolean {
    return this.blockedUntilValue > this.now()
  }

  public reject(): void {
    this.failures += 1
    if (this.failures < ExternalAgentBridgePairingMaxFailures) return
    this.failures = 0
    this.blockedUntilValue = this.now() + ExternalAgentBridgePairingBlockMs
  }

  public reset(): void {
    this.failures = 0
    this.blockedUntilValue = 0
  }
}
