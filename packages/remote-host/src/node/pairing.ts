// 配对闸:一次性人工仪式的节奏控制(六位码 + 有效期 + 失败锁定)。
//
// 单独成文是因为这里的每一条判断都是安全语义,不该淹没在连接状态机里。
import { timingSafeEqual } from 'node:crypto'

import { isPresent, toNullable } from '@velaros-ai/core'
import type { TimerLease, TimerScope } from '@velaros-ai/core/utils/TimerScope'
import {
  RemoteNodePairingLifetimeMs,
  RemoteNodePairingLockoutMs,
  RemoteNodePairingMaxFailures,
} from '@velaros-ai/kernel/contracts/protocol'

import { createPairingCode } from '../shared/crypto'

/** 定长常数时间比较:长度不等直接判否,避免 `timingSafeEqual` 因长度差异抛出。 */
function codesEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length
    && timingSafeEqual(leftBytes, rightBytes)
}

export interface RemoteNodePairingGateOptions {
  readonly timers: TimerScope
  readonly now: () => number
  /** 确定性测试缝;生产环境自生成六位码。 */
  readonly pairingCode?: string
}

export class RemoteNodePairingGate {
  private activeCode?: string
  private activeExpiresAt?: number
  private timer?: TimerLease
  private failures = 0
  private blockedUntil = 0

  public constructor(private readonly options: RemoteNodePairingGateOptions) {}

  public get available(): boolean {
    const now = this.options.now()
    return isPresent(this.activeCode)
      && (this.activeExpiresAt ?? 0) > now
      && this.blockedUntil <= now
  }

  /** 对外可见的码:锁定或过期期间一律不再展示,免得人对着一枚已经不生效的码干瞪眼。 */
  public get code(): Nullable<string> {
    return this.available ? toNullable(this.activeCode) : null
  }

  public get expiresAt(): Nullable<number> {
    return this.available ? toNullable(this.activeExpiresAt) : null
  }

  /**
   * 开一次配对窗口。
   *
   * 刻意**不**清零 failures / blockedUntil:重开窗口不构成重置暴力破解计数的理由,否则只要能
   * 诱导宿主再点一次「配对」,锁定就形同虚设。
   */
  public open(): void {
    this.timer?.cancel()
    this.activeCode = this.options.pairingCode ?? createPairingCode()
    this.activeExpiresAt = this.options.now() + RemoteNodePairingLifetimeMs
    this.timer = this.options.timers.after(RemoteNodePairingLifetimeMs, () => {
      this.activeCode = undefined
      this.activeExpiresAt = undefined
      this.timer = undefined
    }, { label: 'remote-node-pairing-expiry', unref: true })
  }

  public accept(supplied: string): boolean {
    const now = this.options.now()
    // 锁定窗口内直接拒且不再累计:否则持续敲击可以把锁定无限续期,变成一条拒绝服务通道。
    if (this.blockedUntil > now) return false
    const expected = this.activeCode
    if (
      isPresent(expected)
      && (this.activeExpiresAt ?? 0) > now
      && codesEqual(expected, supplied)
    ) {
      return true
    }
    this.failures += 1
    if (this.failures >= RemoteNodePairingMaxFailures) {
      this.failures = 0
      this.blockedUntil = now + RemoteNodePairingLockoutMs
    }
    return false
  }

  /** 配对成功:收窗并清零失败计数。只有**成功**才清零,失败与重开窗口都不清。 */
  public close(): void {
    this.cancel()
    this.failures = 0
  }

  public cancel(): void {
    this.timer?.cancel()
    this.timer = undefined
    this.activeCode = undefined
    this.activeExpiresAt = undefined
  }
}
