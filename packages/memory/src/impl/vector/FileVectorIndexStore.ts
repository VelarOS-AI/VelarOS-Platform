import { isNull } from '@velaros-ai/core'

import { MemoryVectorIndexFileName } from '../../contract/constants'
import type { MemoryFilesIo, MemoryVectorIndexStore } from '../../contract/requires'
import type { MemoryVectorIndexRecord } from '../../types/memory'
import type { PersistedVectorIndex } from '../../types/vector'
import { encodeVector, parsePersistedVectorIndex, toVectorIndexRecords } from '../../utils/vector'

/** 一个文件向量索引存储要什么。 */
export interface FileVectorIndexStoreOptions {
  /** 文本读写端口，由宿主注入。 */
  readonly io: MemoryFilesIo
  /** 索引目录（宿主注入；派生数据独占一个目录，卸载即整目录可删）。 */
  readonly directory: string
  /** 索引文件名；缺省用常量表里的 `vector-index.json`。 */
  readonly fileName?: string
}

/**
 * 落在单个 JSON 文件里的向量索引存储（出厂持久化形态）。
 *
 * 复用 `memory-files` 的文件 IO 端口——包内只该有**一个**文本 IO 端口；为向量索引再造一个
 * 字段相同的端口，只会让宿主注入两次同一个东西。实例由 `createFileVectorIndexStore` 造，
 * 一个实例管一个索引目录：首次读盘后常驻内存、写穿落盘。
 */
export class FileVectorIndexStore implements MemoryVectorIndexStore {
  private readonly io: MemoryFilesIo

  private readonly directory: string

  private readonly path: string

  private readonly records = new Map<string, MemoryVectorIndexRecord>()

  private loaded = false

  private version: Nullable<string> = null

  constructor(options: FileVectorIndexStoreOptions) {
    this.io = options.io
    this.directory = options.directory
    this.path = options.io.join(options.directory, options.fileName ?? MemoryVectorIndexFileName)
  }

  public readVersion(): Nullable<string> {
    this.load()
    return this.version
  }

  public writeVersion(next: string): void {
    this.load()
    this.version = next
    this.flush()
  }

  public list(): readonly MemoryVectorIndexRecord[] {
    this.load()
    return [...this.records.values()]
  }

  public upsert(next: readonly MemoryVectorIndexRecord[]): void {
    this.load()
    for (const record of next) this.records.set(record.id, record)
    this.flush()
  }

  public remove(ids: readonly string[]): number {
    this.load()
    let removed = 0
    for (const id of ids) {
      if (this.records.delete(id)) removed += 1
    }
    if (removed > 0) this.flush()
    return removed
  }

  public clear(): void {
    this.load()
    this.records.clear()
    this.version = null
    // 卸载语义：派生文件直接消失，不留一个空壳让人以为索引还在。
    this.io.deleteFile(this.path)
  }

  /** 首次访问时读一次盘；解析失败按「没建过」处理。 */
  private load(): void {
    if (this.loaded) return
    this.loaded = true
    const raw = this.io.readTextFile(this.path)
    if (isNull(raw)) return
    const parsed = parsePersistedVectorIndex(raw)
    if (!parsed) return
    this.version = parsed.version
    for (const entry of toVectorIndexRecords(parsed)) {
      this.records.set(entry.id, {
        ...entry,
        scopeType: entry.scopeType as MemoryVectorIndexRecord['scopeType'],
      })
    }
  }

  /** 把当前内存态写穿到磁盘；空索引直接删文件。 */
  private flush(): void {
    if (isNull(this.version) && this.records.size === 0) {
      this.io.deleteFile(this.path)
      return
    }
    this.io.ensureDirectory(this.directory)
    const payload: PersistedVectorIndex = {
      version: this.version ?? '',
      records: [...this.records.values()].map((record) => ({
        id: record.id,
        scopeType: record.scopeType,
        scopeId: record.scopeId,
        updatedAt: record.updatedAt,
        vector: encodeVector(record.vector),
      })),
    }
    this.io.writeTextFile(this.path, JSON.stringify(payload))
  }
}

/** 造一份落在单个 JSON 文件里的向量索引存储。 */
export function createFileVectorIndexStore(
  options: FileVectorIndexStoreOptions,
): MemoryVectorIndexStore {
  return new FileVectorIndexStore(options)
}
