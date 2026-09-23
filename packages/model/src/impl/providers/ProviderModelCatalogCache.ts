import { isUndefined } from '@velaros-ai/core'

import type { ProviderModelCatalog } from '../../types/model'
import type { ProviderModelCatalogCacheEntry } from '../../types/providers'
import { ModelTuning } from '../../utils/tuning'

/**
 * 目录服务独占的能力快照缓存。
 *
 * 键里带着密钥，所以它只驻留内存，既不序列化也不进日志或 IPC；
 * 同一个键上的并发请求合成一条，等待者全退出时在飞的请求跟着取消。
 */
export interface ProviderModelCatalogCacheApi {
  /** 取一份目录快照：命中未过期的就直接返回拷贝，否则发起（或搭上）一次请求。 */
  load(
    key: string,
    fetchCatalog: (signal: AbortSignal) => Promise<ProviderModelCatalog>,
    options: { refresh: boolean; signal?: AbortSignal }
  ): Promise<ProviderModelCatalog>
  /** 失效一个键；不给键就整张表清掉。 */
  invalidate(key?: string): void
}

export class ProviderModelCatalogCache implements ProviderModelCatalogCacheApi {
  readonly #entries = new Map<string, ProviderModelCatalogCacheEntry>()

  public async load(
    key: string,
    fetchCatalog: (signal: AbortSignal) => Promise<ProviderModelCatalog>,
    options: { refresh: boolean; signal?: AbortSignal }
  ): Promise<ProviderModelCatalog> {
    options.signal?.throwIfAborted()
    let entry = this.#entries.get(key)
    if (options.refresh || (entry?.catalog && entry.expiresAt <= Date.now())) entry = undefined
    if (!entry) {
      const controller = new AbortController()
      entry = {
        controller,
        promise: Promise.resolve().then(() => fetchCatalog(controller.signal)),
        expiresAt: 0,
        waiters: 0,
      }
      const current = entry
      this.#entries.set(key, current)
      current.promise = current.promise.then(
        (catalog) => {
          if (this.#entries.get(key) === current && !controller.signal.aborted) {
            current.catalog = structuredClone(catalog)
            // 不支持目录的 provider 短期回落，避免每轮重复等待同一个失败端点。
            current.expiresAt =
              Date.now() +
              (catalog.error ? ModelTuning.catalog.errorCacheTtlMs : ModelTuning.catalog.cacheTtlMs)
          }
          return catalog
        },
        (error: unknown) => {
          if (this.#entries.get(key) === current) this.#entries.delete(key)
          throw error
        }
      )
      // 保持有界；已交给调用者的请求仍由各自等待者负责取消和回收。
      if (this.#entries.size > ModelTuning.catalog.cacheEntries) {
        const oldest = this.#entries.keys().next().value
        if (!isUndefined(oldest)) this.#entries.delete(oldest)
      }
    }
    if (entry.catalog) return structuredClone(entry.catalog)
    return this.waitForCatalog(key, entry, options.signal)
  }

  public invalidate(key?: string): void {
    if (isUndefined(key)) this.#entries.clear()
    else this.#entries.delete(key)
  }

  private waitForCatalog(
    key: string,
    entry: ProviderModelCatalogCacheEntry,
    signal?: AbortSignal
  ): Promise<ProviderModelCatalog> {
    entry.waiters += 1
    return new Promise((resolve, reject) => {
      let settled = false
      const cleanup = (): boolean => {
        if (settled) return false
        settled = true
        signal?.removeEventListener('abort', abort)
        entry.waiters -= 1
        return true
      }
      const abort = (): void => {
        if (!cleanup()) return
        reject(signal?.reason)
        if (entry.waiters === 0 && !entry.catalog) {
          if (this.#entries.get(key) === entry) this.#entries.delete(key)
          entry.controller.abort(signal?.reason)
        }
      }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      void entry.promise.then(
        (catalog) => {
          if (cleanup()) resolve(structuredClone(catalog))
        },
        (error: unknown) => {
          if (cleanup()) reject(error)
        }
      )
    })
  }
}
