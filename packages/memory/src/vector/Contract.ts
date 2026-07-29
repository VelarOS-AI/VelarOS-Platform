/**
 * `memory-vector` 的两个注入端口 —— **包内零模型假设、零原生模块**。
 *
 * 存储选型裁决（依赖剖面）：向量索引落在**注入的文本 IO** 上（默认实现 = 一个作用域一份
 * base64 Float32 索引文件），检索是内存里的暴力余弦。理由三条：
 *
 * 1. **LanceDB 在这一层是机械禁止的**：`check:memory-boundaries` 明令 Memory 主干不得 import
 *    `@lancedb/lancedb` / `apache-arrow`（那是 knowledge 切片的东西）。为了向量索引去松这道门，
 *    等于把 §九「把向量库请出记忆默认档」反着做一遍；
 * 2. **sqlite-vec 是一个新的原生模块**：派生索引必须**装得起也卸得掉**，为一个可摘的加速器新增
 *    一条平台原生依赖，成本落在所有用户身上而收益只落在装了它的人身上；
 * 3. **量级对得上**：个人记忆是 10²–10³ 条（权威层是一堆 markdown），不是代码库索引。1000 条 ×
 *    1536 维的余弦是几毫秒的事——ANN 在这个量级上买的是复杂度不是速度。
 *
 * 而这三条都不构成锁死：检索与存储被 `MemoryVectorIndexStore` 隔开，换 ANN 库只换这一格实现，
 * 后端与契约一行不动（接口对了实现可换）。
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
