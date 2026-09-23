import { isString } from '@velaros-ai/core'

/** 实例内效果调度；资源身份由宿主声明，缺失范围与所有写操作冲突。 */
export interface EffectSchedulerApi {
  /** 按入队顺序等待冲突操作；成功后调用方在处理器实际结束时释放。 */
  acquire(resources: Optional<readonly string[]>, signal: AbortSignal): Promise<() => void>
}

/** 只让资源集合互斥的操作并行，取消等待者不会提前释放正在执行的操作。 */
export class EffectScheduler implements EffectSchedulerApi {
  private readonly pending = new Map<Promise<void>, Optional<readonly string[]>>()
  public async acquire(
    resources: Optional<readonly string[]>,
    signal: AbortSignal
  ): Promise<() => void> {
    signal.throwIfAborted()
    if (
      resources &&
      (!resources.length || resources.some((resource) => !isString(resource) || !resource.trim()))
    )
      throw new Error('效果范围需要非空的宿主资源身份')
    const scope = resources ? [...new Set(resources)] : undefined
    const predecessors = [...this.pending]
      .filter(([, prior]) => !scope || !prior || scope.some((resource) => prior.includes(resource)))
      .map(([pending]) => pending)
    let resolve = (): void => {}
    const pending = new Promise<void>((done) => {
      resolve = done
    })
    this.pending.set(pending, scope)
    const release = (): void => {
      this.pending.delete(pending)
      resolve()
    }
    let cancel = (): void => {}
    const aborted = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(signal.reason ?? new Error('操作已取消'))
      signal.addEventListener('abort', cancel, { once: true })
    })
    try {
      await Promise.race([Promise.all(predecessors), aborted])
      signal.throwIfAborted()
      return release
    } catch (error) {
      release()
      throw error
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }
}
