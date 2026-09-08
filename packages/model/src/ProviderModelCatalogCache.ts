import { isUndefined } from '@velaros-ai/core'

import type { ProviderModelCatalog } from './ModelContracts'

interface CatalogEntry {
  controller: AbortController
  promise: Promise<ProviderModelCatalog>
  catalog?: ProviderModelCatalog
  expiresAt: number
  waiters: number
}

/** 目录服务独占的能力快照；键仅驻留内存，不进入日志或 IPC。 */
export class ProviderModelCatalogCache {
  readonly #entries = new Map<string, CatalogEntry>()

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
            current.expiresAt = Date.now() + (catalog.error ? 30_000 : 300_000)
          }
          return catalog
        },
        (error: unknown) => {
          if (this.#entries.get(key) === current) this.#entries.delete(key)
          throw error
        }
      )
      // 保持有界；已交给调用者的请求仍由各自等待者负责取消和回收。
      if (this.#entries.size > 128) {
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
    entry: CatalogEntry,
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
