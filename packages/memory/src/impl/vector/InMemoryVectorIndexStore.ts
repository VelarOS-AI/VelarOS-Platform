import type { MemoryVectorIndexStore } from '../../contract/requires'
import type { MemoryVectorIndexRecord } from '../../types/memory'

/**
 * 纯内存的向量索引存储：探针与 headless 宿主用，一个文件都不落。
 *
 * 只在包内的探针与测试里直接 new，不出包；进程退出即丢，正合派生物的语义。
 */
export interface InMemoryVectorIndexStoreApi extends MemoryVectorIndexStore {
  /** 当前记录数，供探针断言。 */
  size(): number
}

/** 纯内存的向量索引存储实现。 */
export class InMemoryVectorIndexStore implements InMemoryVectorIndexStoreApi {
  private readonly records = new Map<string, MemoryVectorIndexRecord>()

  private version: Nullable<string> = null

  public readVersion(): Nullable<string> {
    return this.version
  }

  public writeVersion(next: string): void {
    this.version = next
  }

  public list(): readonly MemoryVectorIndexRecord[] {
    return [...this.records.values()]
  }

  public upsert(next: readonly MemoryVectorIndexRecord[]): void {
    for (const record of next) this.records.set(record.id, record)
  }

  public remove(ids: readonly string[]): number {
    let removed = 0
    for (const id of ids) {
      if (this.records.delete(id)) removed += 1
    }
    return removed
  }

  public clear(): void {
    this.records.clear()
    this.version = null
  }

  public size(): number {
    return this.records.size
  }
}
