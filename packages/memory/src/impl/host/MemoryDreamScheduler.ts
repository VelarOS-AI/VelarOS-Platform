import { Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { type TimerLease,TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { MemoryHostIdleSignalPort } from '../../contract/requires'
import type { MemoryDreamRunResult } from '../../types/memory'
import { MemoryTuning } from '../../utils/tuning'
import type { MemoryTreeDomainApi as MemoryDomain } from '../tree/MemoryTreeDomain'

/** 一个后台整理调度器要什么。 */
export interface MemoryDreamSchedulerOptions {
  /** 现在允不允许后台整理（自动记忆总开关与后台生长开关的合取）。 */
  isEnabled: () => boolean
  /** 空闲、电池和前台状态端口；具体实现由宿主注入，适配器本体不触碰平台 API。 */
  idleSignal: MemoryHostIdleSignalPort
  /** 电池供电时允不允许继续整理；缺席按不允许。 */
  allowBatteryGrowth?: () => boolean
  /** 巡检间隔，毫秒；缺省取可调参数表。 */
  tickIntervalMs?: number
  /** 系统连续空闲多少秒才动手；缺省取可调参数表。 */
  idleThresholdSeconds?: number
  /** 一次整理处理多少条证据；缺省取可调参数表。 */
  idleBatchSize?: number
  /** 定时器作用域；测试可注入假时钟。 */
  timers?: TimerScope
}

/**
 * 后台整理调度器对外的能力：起停、销毁、立刻跑一次、以及被定时器调用的一次巡检。
 *
 * 即时写入只处理小批量；积压在应用空闲、非前台活跃时续跑。电池供电下只处理较小积压，
 * 手动 `runNow` 与启动恢复不受此门控影响。实例由树治理门面持有，一个门面一份。
 */
export interface MemoryDreamSchedulerApi {
  /** 起定时巡检；已经起过就什么都不做。 */
  start(): void
  /** 停掉定时巡检；停了还能再 `start()`。 */
  stop(): void
  /** 真正的销毁：释放定时器作用域，此后不能再 `start()`。 */
  dispose(): void
  /** 立刻跑一次整理（手动触发，不看空闲与电池门）。 */
  runNow(abortSignal?: AbortSignal): MemoryDreamRunResult
  /** 一次巡检：条件齐了就整理一批，条件不齐直接返回。 */
  tick(): void
}

/** 后台整理调度器实现。 */
export class MemoryDreamScheduler implements MemoryDreamSchedulerApi {
  private readonly log = Log.tag('MemoryDreamScheduler')
  private readonly timers: TimerScope
  private readonly idleSignal: MemoryHostIdleSignalPort
  private readonly tickIntervalMs: number
  private readonly idleThresholdSeconds: number
  private readonly idleBatchSize: number
  private tickLease: Nullable<TimerLease> = null
  private running = false

  constructor(
    private readonly domain: Pick<MemoryDomain, 'runDream'>,
    private readonly options: MemoryDreamSchedulerOptions
  ) {
    this.timers = options.timers ?? new TimerScope({ name: 'MemoryDreamScheduler' })
    this.idleSignal = options.idleSignal
    this.tickIntervalMs = options.tickIntervalMs ?? MemoryTuning.dream.tickIntervalMs
    this.idleThresholdSeconds = options.idleThresholdSeconds ?? MemoryTuning.dream.idleThresholdSeconds
    this.idleBatchSize = options.idleBatchSize ?? MemoryTuning.dream.idleBatchSize
  }

  public start(): void {
    if (this.tickLease) return
    this.tickLease = this.timers.every(
      this.tickIntervalMs,
      () => {
        this.tick()
      },
      { unref: true }
    )
  }

  /**
   * 停掉定时巡检。**只取消租约，不释放定时器作用域**——释放是真正的销毁（`dispose`）才做的事。
   *
   * 从前 `stop()` 直接 `TimerScope.dispose()`，之后 `start()` 里的 `every()` 会抛
   * `INVARIANT`（「已释放」）；`MemoryTreeService.warmup()` 在 `finally` 里调 `start()`，
   * 于是「关掉后台整理再 warmup」就是一次未处理的拒绝。停了还能再起是调度器的基本契约。
   */
  public stop(): void {
    this.tickLease?.cancel()
    this.tickLease = null
  }

  /** 真正的销毁：释放定时器作用域，此后不能再 `start()`。 */
  public dispose(): void {
    this.stop()
    this.timers.dispose()
  }

  public runNow(abortSignal?: AbortSignal): MemoryDreamRunResult {
    return this.domain.runDream({ trigger: 'manual', maxEvidence: this.idleBatchSize, abortSignal })
  }

  public tick(): void {
    if (this.running || !this.options.isEnabled()) return

    const idleSeconds = this.readIdleSeconds()
    const appFocused = this.idleSignal.isAppFocused()
    if (idleSeconds < this.idleThresholdSeconds || appFocused) return

    const onBattery = this.idleSignal.isOnBatteryPower()
    if (onBattery && !this.options.allowBatteryGrowth?.()) return

    this.running = true
    try {
      const result = this.domain.runDream({ trigger: 'idle', maxEvidence: this.idleBatchSize })
      if (result.state === 'committed') {
        this.log.info('idle memory dream committed', {
          acceptedCount: result.acceptedCount,
          treeVersion: result.treeVersionAfter,
        })
      }
    } catch (error) {
      this.log.warn('idle memory dream failed', AppError.from(error))
    } finally {
      this.running = false
    }
  }

  private readIdleSeconds(): number {
    try {
      return this.idleSignal.getIdleSeconds()
    } catch (error) {
      this.log.debug('unable to read system idle time; skip memory dream tick', {
        error: AppError.getMessage(error),
      })
      return 0
    }
  }
}
