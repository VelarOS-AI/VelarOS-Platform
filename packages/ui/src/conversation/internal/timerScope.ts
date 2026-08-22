import { isFiniteNumber } from './runtime'

const cancelInterval = globalThis.clearInterval.bind(globalThis)
const cancelTimeout = globalThis.clearTimeout.bind(globalThis)
const scheduleInterval = globalThis.setInterval.bind(globalThis)
const scheduleTimeout = globalThis.setTimeout.bind(globalThis)

function normalizeTimerDelay(value: number): number {
  return Math.max(0, isFiniteNumber(value) ? value : 0)
}

type TimerKind = 'animation-frame' | 'interval' | 'timeout'

interface TimerTaskOptions {
  label?: string
  signal?: AbortSignal
}

export interface TimerLease {
  readonly active: boolean
  readonly kind: TimerKind
  cancel(): boolean
  dispose(): void
}

interface TimerRecord {
  cancelNative: () => void
  kind: TimerKind
}

export class TimerScope {
  private disposed = false
  private readonly records = new Set<TimerRecord>()

  constructor(_options: { name?: string } = {}) {}

  get isDisposed(): boolean {
    return this.disposed
  }

  public after(
    delayMs: number,
    callback: () => void,
    options: TimerTaskOptions = {}
  ): TimerLease {
    this.assertActive()
    const record: TimerRecord = {
      kind: 'timeout',
      cancelNative: () => cancelTimeout(handle),
    }
    const handle = scheduleTimeout(() => {
      if (!this.records.delete(record)) return
      callback()
    }, normalizeTimerDelay(delayMs))
    this.records.add(record)
    const lease = this.createLease(record)
    this.bindAbortSignal(lease, options.signal)
    return lease
  }

  public every(
    intervalMs: number,
    callback: () => void,
    options: TimerTaskOptions = {}
  ): TimerLease {
    this.assertActive()
    const record: TimerRecord = {
      kind: 'interval',
      cancelNative: () => cancelInterval(handle),
    }
    const handle = scheduleInterval(callback, normalizeTimerDelay(intervalMs))
    this.records.add(record)
    const lease = this.createLease(record)
    this.bindAbortSignal(lease, options.signal)
    return lease
  }

  public nextFrame(
    callback: FrameRequestCallback,
    options: TimerTaskOptions = {}
  ): TimerLease {
    this.assertActive()
    const request = globalThis.requestAnimationFrame
    const cancel = globalThis.cancelAnimationFrame
    if (!request || !cancel) throw new Error('requestAnimationFrame is unavailable')

    let handle = 0
    const record: TimerRecord = {
      kind: 'animation-frame',
      cancelNative: () => cancel(handle),
    }
    handle = request((time) => {
      if (!this.records.delete(record)) return
      callback(time)
    })
    this.records.add(record)
    const lease = this.createLease(record)
    this.bindAbortSignal(lease, options.signal)
    return lease
  }

  public cancel(lease?: LooseOptional<TimerLease>): boolean {
    return !!lease?.cancel()
  }

  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const record of this.records) record.cancelNative()
    this.records.clear()
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('TimerScope has been disposed')
  }

  private createLease(record: TimerRecord): TimerLease {
    const scope = this
    const cancel = (): boolean => {
      if (!scope.records.delete(record)) return false
      record.cancelNative()
      return true
    }
    return {
      get active() {
        return scope.records.has(record)
      },
      kind: record.kind,
      cancel,
      dispose: () => {
        cancel()
      },
    }
  }

  private bindAbortSignal(lease: TimerLease, signal?: AbortSignal): void {
    if (!signal) return
    if (signal.aborted) {
      lease.cancel()
      return
    }
    signal.addEventListener('abort', () => lease.cancel(), { once: true })
  }
}
