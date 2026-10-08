import type { ContextStorage } from '@velaros-ai/context'
import { Log, optionalWhen } from '@velaros-ai/core'

import type { VelarosRuntimeOptions } from '../contract/requires.js'
import type { RuntimeMetric } from '../types/trace.js'

/** 非权威诊断口；保留存储的可选能力与生命周期。 */
export interface RuntimeDiagnosticsApi {
  /** 只包装已注入的存储，不创建数据库或共享对象后端。 */
  readonly storage: ContextStorage
  /** 发送单个无正文采样，观察者失败不改变执行。 */
  record(metric: RuntimeMetric): void
}

/** 将存储耗时与效果阶段交给宿主聚合，不在主链额外写入审计记录。 */
export class RuntimeDiagnostics implements RuntimeDiagnosticsApi {
  public readonly storage: ContextStorage
  public constructor(
    storage: ContextStorage,
    private readonly receive: VelarosRuntimeOptions['onMetric']
  ) {
    this.storage = receive
      ? {
          stores: storage.stores,
          leaseOwner: storage.leaseOwner,
          leaseOwnerActive: storage.leaseOwnerActive?.bind(storage),
          load: (id) => this.measure(id, 'load', () => storage.load(id)),
          selectSnapshot: optionalWhen(
            Boolean(storage.selectSnapshot),
            (...args: Parameters<NonNullable<ContextStorage['selectSnapshot']>>) =>
              this.measure(args[0], 'selectSnapshot', () => storage.selectSnapshot!(...args))
          ),
          loadMetadata: optionalWhen(
            Boolean(storage.loadMetadata),
            (...args: Parameters<NonNullable<ContextStorage['loadMetadata']>>) =>
              this.measure(args[0], 'loadMetadata', () => storage.loadMetadata!(...args))
          ),
          compareAndSwapMetadata: optionalWhen(
            Boolean(storage.compareAndSwapMetadata),
            (...args: Parameters<NonNullable<ContextStorage['compareAndSwapMetadata']>>) =>
              this.measure(args[0], 'compareAndSwapMetadata', () =>
                storage.compareAndSwapMetadata!(...args)
              )
          ),
          compareAndSwap: (id, version, state) =>
            this.measure(id, 'compareAndSwap', () => storage.compareAndSwap(id, version, state)),
          put: (id, body) => this.measure(id, 'put', () => storage.put(id, body)),
          get: (id, objectId) => this.measure(id, 'get', () => storage.get(id, objectId)),
          records: optionalWhen(
            Boolean(storage.records),
            (...args: Parameters<NonNullable<ContextStorage['records']>>) =>
              this.measure(args[0], 'records', () => storage.records!(...args))
          ),
          appendRecord: optionalWhen(
            Boolean(storage.appendRecord),
            (...args: Parameters<NonNullable<ContextStorage['appendRecord']>>) =>
              this.measure(args[0], 'appendRecord', () => storage.appendRecord!(...args))
          ),
          collect: optionalWhen(
            Boolean(storage.collect),
            (...args: Parameters<NonNullable<ContextStorage['collect']>>) =>
              this.measure(args[0], 'collect', () => storage.collect!(...args))
          ),
          close: () => storage.close(),
        }
      : storage
  }
  public record(metric: RuntimeMetric): void {
    if (!this.receive) return
    try {
      void Promise.resolve(this.receive?.(Object.freeze({ ...metric }))).catch(() => {
        Log.tag('ActRuntime').debug('诊断接收器异步拒绝')
      })
    } catch {
      Log.tag('ActRuntime').debug('诊断接收器异常')
    }
  }
  private async measure<T>(
    sessionId: string,
    operation: string,
    run: () => Promise<T>
  ): Promise<T> {
    const start = performance.now()
    let succeeded = false
    try {
      const result = await run()
      succeeded = true
      return result
    } finally {
      this.record({
        sessionId,
        phase: 'storage',
        operation,
        durationMs: performance.now() - start,
        succeeded,
      })
    }
  }
}
