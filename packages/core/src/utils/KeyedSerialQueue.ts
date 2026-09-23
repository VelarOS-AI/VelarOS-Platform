/** 同一资源的操作按准入顺序执行，不同资源互不阻塞。 */
export interface KeyedSerialQueueApi {
  run<T>(key: string, operation: () => T | Promise<T>): Promise<T>
}

class KeyedSerialQueue implements KeyedSerialQueueApi {
  private readonly tails = new Map<string, Promise<void>>()

  public async run<T>(key: string, operation: () => T | Promise<T>): Promise<T> {
    const previous = this.tails.get(key)
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    this.tails.set(key, current)
    // 队列只等待完成信号；业务异常单独返回给该次调用者。
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.tails.get(key) === current) this.tails.delete(key)
    }
  }
}

/** 创建独立串行域；队尾完成后立即回收对应资源。 */
export function createKeyedSerialQueue(): KeyedSerialQueueApi {
  return new KeyedSerialQueue()
}
