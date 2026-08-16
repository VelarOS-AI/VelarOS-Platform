/**
 * `MemoryVectorIndexStore` 的两个实现：纯内存（探针 / headless）与文件（默认持久化）。
 *
 * 文件实现复用 `memory-files` 的 `MemoryFilesIo` 端口——包内只该有**一个**文本 IO 端口；
 * 为向量索引再造一个字段相同的端口，只会让宿主注入两次同一个东西。
 *
 * 落盘形态是**一个 JSON 文件**，向量 base64 编码的 Float32（比 JSON 数字数组小约一个数量级）。
 * 这份文件是纯派生物：格式随时可换（版本戳对不上就整份重建），因此它不需要宽容解析、不需要
 * 迁移器，也不值得为它上一个数据库——权威层的那些硬要求（人可读、可手改、可 diff）在这里
 * **一条都不适用**。
 */

import type { MemoryFilesIo } from '../files/Io'

import type { MemoryVectorIndexRecord, MemoryVectorIndexStore } from './Contract'

export const MemoryVectorIndexFileName = 'vector-index.json'

/** 落盘形状。解析失败 = 当作没建过（派生物不需要抢救）。 */
interface PersistedVectorIndex {
  version: string
  records: Array<{
    id: string
    scopeType: string
    scopeId: string
    updatedAt: number
    vector: string
  }>
}

export interface InMemoryVectorIndexStore extends MemoryVectorIndexStore {
  /** 当前记录数，供探针断言。 */
  size(): number
}

export function createInMemoryVectorIndexStore(): InMemoryVectorIndexStore {
  const records = new Map<string, MemoryVectorIndexRecord>()
  let version: Nullable<string> = null

  return {
    readVersion: () => version,
    writeVersion(next) {
      version = next
    },
    list: () => [...records.values()],
    upsert(next) {
      for (const record of next) records.set(record.id, record)
    },
    remove(ids) {
      let removed = 0
      for (const id of ids) {
        if (records.delete(id)) removed += 1
      }
      return removed
    },
    clear() {
      records.clear()
      version = null
    },
    size: () => records.size,
  }
}

export interface FileVectorIndexStoreOptions {
  readonly io: MemoryFilesIo
  /** 索引目录（宿主注入；派生数据独占一个目录，卸载即整目录可删）。 */
  readonly directory: string
  readonly fileName?: string
}

export function createFileVectorIndexStore(
  options: FileVectorIndexStoreOptions,
): MemoryVectorIndexStore {
  const { io, directory } = options
  const path = io.join(directory, options.fileName ?? MemoryVectorIndexFileName)

  let loaded = false
  let version: Nullable<string> = null
  const records = new Map<string, MemoryVectorIndexRecord>()

  const load = (): void => {
    if (loaded) return
    loaded = true
    const raw = io.readTextFile(path)
    if (raw === null) return
    const parsed = parsePersisted(raw)
    if (!parsed) return
    version = parsed.version
    for (const entry of parsed.records) {
      records.set(entry.id, {
        id: entry.id,
        scopeType: entry.scopeType as MemoryVectorIndexRecord['scopeType'],
        scopeId: entry.scopeId,
        updatedAt: entry.updatedAt,
        vector: decodeVector(entry.vector),
      })
    }
  }

  const flush = (): void => {
    if (version === null && records.size === 0) {
      io.deleteFile(path)
      return
    }
    io.ensureDirectory(directory)
    const payload: PersistedVectorIndex = {
      version: version ?? '',
      records: [...records.values()].map((record) => ({
        id: record.id,
        scopeType: record.scopeType,
        scopeId: record.scopeId,
        updatedAt: record.updatedAt,
        vector: encodeVector(record.vector),
      })),
    }
    io.writeTextFile(path, JSON.stringify(payload))
  }

  return {
    readVersion() {
      load()
      return version
    },
    writeVersion(next) {
      load()
      version = next
      flush()
    },
    list() {
      load()
      return [...records.values()]
    },
    upsert(next) {
      load()
      for (const record of next) records.set(record.id, record)
      flush()
    },
    remove(ids) {
      load()
      let removed = 0
      for (const id of ids) {
        if (records.delete(id)) removed += 1
      }
      if (removed > 0) flush()
      return removed
    },
    clear() {
      load()
      records.clear()
      version = null
      // 卸载语义:派生文件直接消失,不留一个空壳让人以为索引还在。
      io.deleteFile(path)
    },
  }
}

function parsePersisted(raw: string): Nullable<PersistedVectorIndex> {
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedVectorIndex>
    if (typeof parsed?.version !== 'string' || !Array.isArray(parsed.records)) return null
    return { version: parsed.version, records: parsed.records }
  } catch {
    // arch-guard:silent-catch-ok 向量索引是可重建派生物；损坏时返回 null 触发完整重建。
    return null
  }
}

function encodeVector(vector: Float32Array): string {
  const bytes = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodeVector(encoded: string): Float32Array {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
}
