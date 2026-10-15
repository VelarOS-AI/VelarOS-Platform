import assert from 'node:assert/strict'

// 前瞻长程评测：只证明日志计算一致；真实工作与原始源码、进程回执仍须独立审计。
export class ProductivityLedger {
  #elapsed = 0
  #accountedThrough = 0
  #productiveMs = 0
  #workIntervals = 0
  #idleMs = 0
  #progress = new Map()

  add(event) {
    if (event.type === 'start') return
    assert(
      Number.isSafeInteger(event.elapsedMs) && event.elapsedMs >= this.#elapsed,
      'Monotonic integer milliseconds required'
    )
    this.#elapsed = event.elapsedMs
    if (['ack', 'verified', 'fault'].includes(event.type))
      this.#progress.set(event.type, event.elapsedMs)
    if (!['work', 'idle'].includes(event.type)) return
    assert(
      Number.isSafeInteger(event.startMs) && Number.isSafeInteger(event.endMs),
      'Interval bounds must be integer milliseconds'
    )
    assert(
      event.startMs >= this.#accountedThrough && event.endMs >= event.startMs,
      'Intervals must be ordered and nonoverlapping'
    )
    assert(event.endMs <= event.elapsedMs, 'An interval cannot extend past its retained event')
    this.#accountedThrough = event.endMs
    if (event.type === 'idle') {
      this.#idleMs += event.endMs - event.startMs
      this.#progress.clear()
      return
    }
    const witnesses = {
      transaction: ['ack'],
      verification: ['verified'],
      fault: ['fault', 'verified'],
    }[event.kind]
    assert(
      typeof event.kind === 'string' && Array.isArray(witnesses),
      'Unknown productive work kind'
    )
    for (const type of witnesses) {
      const at = this.#progress.get(type)
      assert(
        at !== undefined && at >= event.startMs && at <= event.endMs,
        'Work interval requires matching observed progress'
      )
    }
    this.#productiveMs += event.endMs - event.startMs
    assert(Number.isSafeInteger(this.#productiveMs), 'Productive total overflow')
    this.#workIntervals++
    this.#progress.clear()
  }

  finish(claimedMs = this.#productiveMs) {
    assert(
      this.#workIntervals > 0 && this.#productiveMs > 0,
      'Actual productive intervals required'
    )
    assert.equal(
      claimedMs,
      this.#productiveMs,
      'Productive time must equal the sum of actual work intervals, excluding idle gaps'
    )
    return {
      productiveMs: this.#productiveMs,
      workIntervals: this.#workIntervals,
      excludedExplicitIdleMs: this.#idleMs,
      segmentElapsedMs: this.#elapsed,
      structuralTimeVerified: true,
      actualWorkVerified: false,
    }
  }
}
