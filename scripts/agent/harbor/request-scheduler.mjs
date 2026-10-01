// 有界请求槽：按尝试限制占用，跳过暂时满额的尝试，断开的排队者不会占用供应商资源。
export class RequestScheduler {
  constructor({ maxConcurrency = 1, perAttemptConcurrency = 1, maxQueue = 64 } = {}) {
    for (const [key, value] of Object.entries({ maxConcurrency, perAttemptConcurrency, maxQueue }))
      if (!Number.isInteger(value) || value < 1 || value > 4096) throw new Error(`Invalid ${key}`)
    if (perAttemptConcurrency > maxConcurrency)
      throw new Error('Per-attempt concurrency exceeds global capacity')
    this.maxConcurrency = maxConcurrency
    this.perAttemptConcurrency = perAttemptConcurrency
    this.maxQueue = maxQueue
    this.active = 0
    this.attempts = new Map()
    this.queue = []
  }
  summary(attemptId) {
    return {
      maxConcurrency: this.maxConcurrency,
      perAttemptConcurrency: this.perAttemptConcurrency,
      maxQueue: this.maxQueue,
      active: attemptId ? (this.attempts.get(attemptId) ?? 0) : this.active,
      queued: this.queue.filter((entry) => !attemptId || entry.attemptId === attemptId).length,
    }
  }
  acquire(attemptId, signal) {
    signal?.throwIfAborted()
    if (this.queue.length >= this.maxQueue)
      throw Object.assign(new Error('Gateway request queue is full'), {
        code: 'GATEWAY_QUEUE_FULL',
      })
    return new Promise((resolve, reject) => {
      const entry = { attemptId, resolve, reject, signal }
      entry.abort = () => {
        const index = this.queue.indexOf(entry)
        if (index < 0) return
        this.queue.splice(index, 1)
        reject(signal.reason)
        this.drain()
      }
      this.queue.push(entry)
      signal?.addEventListener('abort', entry.abort, { once: true })
      this.drain()
    })
  }
  drain() {
    while (this.active < this.maxConcurrency) {
      const index = this.queue.findIndex(
        (entry) => (this.attempts.get(entry.attemptId) ?? 0) < this.perAttemptConcurrency
      )
      if (index < 0) return
      const [entry] = this.queue.splice(index, 1)
      entry.signal?.removeEventListener('abort', entry.abort)
      this.active++
      this.attempts.set(entry.attemptId, (this.attempts.get(entry.attemptId) ?? 0) + 1)
      let released = false
      entry.resolve(() => {
        if (released) return
        released = true
        this.active--
        const remaining = this.attempts.get(entry.attemptId) - 1
        if (remaining) this.attempts.set(entry.attemptId, remaining)
        else this.attempts.delete(entry.attemptId)
        this.drain()
      })
    }
  }
}
