import { ExternalAgentBridgePairingBlockMs, ExternalAgentBridgePairingMaxFailures } from './ExternalAgentBridgeCommandQueue'

/** 两个产品共用的配对爆破节流状态机；配对码和 expiry timer 仍由产品展示层拥有。 */
export class ExternalAgentBridgePairingThrottle {
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
