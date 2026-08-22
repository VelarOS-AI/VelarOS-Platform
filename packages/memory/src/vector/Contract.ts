/**
 * `memory-vector` 提供两个注入端口，包内不假设模型，也不引入原生模块。
 *
 * 向量索引通过注入的文本输入输出端口持久化；默认每个作用域保存一份 Base64 编码的浮点索引，
 * 检索在内存中执行穷举余弦比较。记忆主干禁止引入 `LanceDB`，而新增 `sqlite-vec` 会让可拆卸派生
 * 索引强制携带原生依赖。个人记忆通常只有数百至数千条，在该量级上穷举检索的复杂度更合适。
 *
 * `MemoryVectorIndexStore` 隔离检索与存储，未来替换近似最近邻实现只需更换这一层，不影响后端契约。
 */

import type { MemoryScopeType } from '../memory-tree/Types'

export const MemoryVectorBackendId = 'vector'

/**
 * 嵌入端口 —— **BYOK 语义**：包内不认识任何 provider、不发一次网络请求、不读一个 API key。
 *
 * `identity` 进版本戳（`MemoryDerivedIndexVersion.embedding`）：换模型 = 索引作废 = 重建。
 * 因此它必须包含真正决定向量语义的一切（provider + 模型 + 维度），而不只是一个模型名。
 */
export interface MemoryEmbedder {
  /** 嵌入模型身份，如 `openai:text-embedding-3-small:1536`。 */
  readonly identity: string
  readonly dimensions: number
  /** 批量嵌入。返回顺序必须与入参一一对应；长度不符视为实现故障。 */
  embed(texts: readonly string[]): Promise<ReadonlyArray<readonly number[]>>
}

/**
 * 索引里的一条记录：**指针 + 作用域 + 向量，没有内容副本**（§九 9.2）。
 *
 * 没有 title / summary / body：一旦索引持了内容副本，「卸载只删索引」就变成了删内容。
 * 召回命中后回权威层 `getItem(id)` 取全文，这是编排层的事。
 */
export interface MemoryVectorIndexRecord {
  /** 权威层指针（`MemoryEvidenceRecord.id` / `MemoryRecallItem.id`）。 */
  readonly id: string
  readonly scopeType: MemoryScopeType
  readonly scopeId: string
  readonly updatedAt: number
  /** **已归一化**的向量：写入时归一，检索时点积即余弦。 */
  readonly vector: Float32Array
}

/**
 * 索引持久化端口。
 *
 * 同步接口是刻意的：检索要把全部向量拿在手里做暴力余弦，实现天然是「首次读盘后常驻内存 +
 * 写穿」。异步签名只会让每个调用点多一个 `await` 而买不到任何东西。
 */
export interface MemoryVectorIndexStore {
  /** 落盘的版本戳；从没建过返回 null。 */
  readVersion(): Nullable<string>
  writeVersion(version: string): void
  /** 全部记录（检索用）。 */
  list(): readonly MemoryVectorIndexRecord[]
  upsert(records: readonly MemoryVectorIndexRecord[]): void
  remove(ids: readonly string[]): number
  /** 清空派生数据（重建的第一步 / 卸载的全部）。 */
  clear(): void
}
