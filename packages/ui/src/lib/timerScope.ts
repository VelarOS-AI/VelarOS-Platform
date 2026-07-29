type TimerKind = 'animation-frame' | 'timeout'

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

  public after(delayMs: number, callback: () => void): TimerLease {
    this.assertActive()
    const record: TimerRecord = {
      kind: 'timeout',
      cancelNative: () => globalThis.clearTimeout(handle),
    }
    const handle = globalThis.setTimeout(() => {
      if (!this.records.delete(record)) return
      callback()
    }, Math.max(0, Number.isFinite(delayMs) ? delayMs : 0))
    this.records.add(record)
    return this.createLease(record)
  }

  public nextFrame(callback: FrameRequestCallback): TimerLease {
    this.assertActive()
    const request = globalThis.requestAnimationFrame
    const cancel = globalThis.cancelAnimationFrame
    if (!request || !cancel) {
      throw new Error('requestAnimationFrame is unavailable')
    }

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
    return this.createLease(record)
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
}
