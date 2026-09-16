// Platform Kernel 统一持有与宿主无关的远程节点实现。
// 配对闸:一次性人工仪式的节奏控制(六位码 + 有效期 + 失败锁定)。
//
// 单独成文是因为这里的每一条判断都是安全语义,不该淹没在连接状态机里。
import { isPresent, toNullable } from '@velaros-ai/core'
import type { TimerLease, TimerScope } from '@velaros-ai/core/utils/TimerScope'

import {
  createPairingCode,
  remoteNodeCodesEqual,
} from '../../utils/remote/crypto'
import {
  RemoteNodePairingLifetimeMs,
  RemoteNodePairingLockoutMs,
  RemoteNodePairingMaxFailures,
} from '../../utils/wire/remote-node'

/** 装配一道配对闸要的三样:计时作用域、时钟源,以及可选的固定码。 */
export interface RemoteNodePairingGateOptions {
  /** 计时作用域;配对窗口的过期定时器挂在它名下,随服务端一起释放。 */
  readonly timers: TimerScope
  /** 时钟源;测试里可以推着走,生产里就是 `Date.now`。 */
  readonly now: () => number
  /** 确定性测试缝;生产环境自生成六位码。 */
  readonly pairingCode?: string
}

/**
 * 一次性人工配对仪式的节奏控制。
 *
 * 一个服务端一道闸。里面每一条判断都是安全语义:六位码、有效期、失败锁定,
 * 不该淹没在连接状态机里。
 */
export interface RemoteNodePairingGateApi {
  /** 现在能不能接受配对:有活码、没过期、没在锁定窗口里。 */
  readonly available: boolean
  /** 对外可见的码;锁定或过期期间一律不再展示,返回 `null`。 */
  readonly code: Nullable<string>
  /** 当前码的过期时刻;没有可用码时是 `null`。 */
  readonly expiresAt: Nullable<number>
  /** 开一次配对窗口;刷新码与有效期,但**不**清零失败计数。 */
  open(): void
  /** 核一枚码:对上返回 true,否则累计失败并在超限时进锁定窗口。 */
  accept(supplied: string): boolean
  /** 配对成功:收窗并清零失败计数。 */
  close(): void
  /** 收窗:丢掉当前码与定时器,失败计数原封不动。 */
  cancel(): void
}

export class RemoteNodePairingGate implements RemoteNodePairingGateApi {
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
      && remoteNodeCodesEqual(expected, supplied)
    ) return true
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
