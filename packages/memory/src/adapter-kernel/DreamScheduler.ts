import { Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { type TimerLease,TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { MemoryDomain, MemoryDreamRunResult } from '..'

import type { HostIdleSignalPort } from './HostSignals'

const DefaultTickIntervalMs = 60_000
const DefaultIdleThresholdSeconds = 5 * 60
const DefaultIdleBatchSize = 400

interface MemoryDreamSchedulerOptions {
  isEnabled: () => boolean
  /** 空闲/电池/前台读数端口；Electron 实现由 Desktop 胶水注入，适配器本体不触碰 host API。 */
  idleSignal: HostIdleSignalPort
  allowBatteryGrowth?: () => boolean
  tickIntervalMs?: number
  idleThresholdSeconds?: number
  idleBatchSize?: number
  timers?: TimerScope
}

/**
 * MemoryDream 后台维护策略。
 *
 * 即时写入只处理小批量；积压在应用空闲、非前台活跃时续跑。电池供电下只处理较小积压，
 * 手动 runNow 与启动恢复不受此门控影响。
 */
export class MemoryDreamScheduler {
  private readonly log = Log.tag('MemoryDreamScheduler')
  private readonly timers: TimerScope
  private readonly idleSignal: HostIdleSignalPort
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
    this.tickIntervalMs = options.tickIntervalMs ?? DefaultTickIntervalMs
    this.idleThresholdSeconds = options.idleThresholdSeconds ?? DefaultIdleThresholdSeconds
    this.idleBatchSize = options.idleBatchSize ?? DefaultIdleBatchSize
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

  public stop(): void {
    this.timers.dispose()
    this.tickLease = null
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

export type { MemoryDreamSchedulerOptions }
