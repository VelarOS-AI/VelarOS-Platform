/**
 * 派生索引契约（mod-architecture-blueprint §九 9.2 / 9.4 的机械化）。
 *
 * 「派生索引」不是第二个记忆库，是权威层的一层**可摘的加速器**。这一层把 §九 那几条产品判决
 * 从散文变成可调用的动词，好让「卸载只删索引、权威内容零丢失」成为**类型与探针**能验的事，
 * 而不是实现者的自觉：
 *
 * - **指针不是内容**：索引只持 `{ 指针, 作用域, 向量 }`，不持标题正文的副本。否则「删索引」
 *   就变成了删内容，`orphaned-but-preserved`（§3.7）当场失效；
 * - **重建代替迁移**（§九 9.4）：schema 或嵌入模型变了 → 版本戳对不上 → 全量重建。派生物的
 *   升级就是重建，为派生物写迁移器是白付成本；
 * - **卸载 = `dropIndex()`**：只碰派生数据，签名上就够不着权威层；
 * - **不吃原始证据**：派生索引消费的是权威层 capture **之后**的 `MemoryEvidenceRecord`
 *   （它自带权威层分配的 id = 指针）。因此本接口把窄端口的 `capture` / `captureBatch` 实现成
 *   显式拒收，并且 **descriptor 不声明 `capture`**——「这个后端不吃原始证据」于是
 *   `supportsMemoryBackendVerb(backend, 'capture') === false` 机械可查，不用读文档。
 *
 * 为什么仍然 `extends MemoryStoreBackend`：注册通道要和默认档**同一条**（§九「零轴变更」——
 * 记忆后端是第一个完全用既有轴装出来的能力域）。派生索引因此照旧用
 * `createMemoryStoreKernelModule` 注册、照旧占一个 `velaros.memory.store.<id>` token，
 * 一行机制都不用新造。
 */

import type { MemoryEvidenceRecord, MemoryRecallItem } from '../memory-tree/Types'

import type { MemoryBackendDescriptor, MemoryStoreBackend } from './Contract'

/**
 * 索引版本戳。**变了就重建，不写迁移器**（§九 9.4）。
 *
 * 两段各自独立地让索引作废：`schema` 是本包对记录形状的演进，`embedding` 是嵌入模型身份
 * （换 provider / 换模型 / 换维度）。分两段而不是一个数字，是因为它们由**不同的人**改动
 * ——包作者改 schema，用户换模型——合成一个数字会让其中一方的变更悄悄搭上另一方的便车。
 */
export interface MemoryDerivedIndexVersion {
  readonly schema: number
  /** 嵌入模型身份（如 `openai:text-embedding-3-small:1536`）。 */
  readonly embedding: string
}

/** 版本戳的落盘形式。比较用字符串，避免各实现各写一套字段比较。 */
export function formatMemoryDerivedIndexVersion(version: MemoryDerivedIndexVersion): string {
  return `s${version.schema}|${version.embedding}`
}

/**
 * 权威层全量枚举端口 —— **刻意不进窄端口的六动词面**。
 *
 * 重建需要「把权威层从头读一遍」，但那是**派生层的需求**，不是记忆产品的动词面：给
 * `MemoryStoreBackend` 加一个 `listAll` 会让每个未来后端都被迫实现一个只有索引才用的方法。
 * 因此它是一个独立端口，由权威层**结构上**满足（`memory-files` 提供 `listAll`）或由宿主注入。
 *
 * 与既有惯例一致：`supportsMemoryBackendVerb` 也是靠 `typeof backend.archive === 'function'`
 * 判可选动词的，这里用同一种探测方式，不引入 `instanceof`。
 */
export interface MemoryAuthorityEnumeration {
  /** 权威层全部条目。允许同步/异步可迭代，实现按自己的读盘节奏分批产出。 */
  listAll(): AsyncIterable<MemoryRecallItem> | Iterable<MemoryRecallItem>
}

/** 权威后端是否自带全量枚举；没有则重建不可能，调用方必须显式注入一个源。 */
export function resolveAuthorityEnumeration(
  backend: MemoryStoreBackend,
): MemoryAuthorityEnumeration | undefined {
  const candidate = backend as Partial<MemoryAuthorityEnumeration>
  return typeof candidate.listAll === 'function'
    ? (candidate as MemoryAuthorityEnumeration)
    : undefined
}

export interface MemoryDerivedIndexRebuildResult {
  /** 重建后索引里有多少条指针。 */
  readonly indexedCount: number
  /** 重建前存在、权威层已没有的指针数（孤儿）。 */
  readonly removedOrphanCount: number
  /** 重建后写入的版本戳。 */
  readonly version: string
}

/**
 * 一个派生索引后端。
 *
 * `role` 在类型上就钉死为 `derived-index`——角色是解析期的**安全判据**（权威解析必须跳过
 * 派生索引，见 `resolveMemoryStoreBackend`），可写成 `authority` 的派生索引等于给自己开后门。
 */
export interface MemoryDerivedIndexBackend extends MemoryStoreBackend {
  readonly descriptor: MemoryBackendDescriptor & { readonly role: 'derived-index' }
  readonly indexVersion: MemoryDerivedIndexVersion

  /**
   * 索引是否已过期（落盘版本戳 ≠ 当前版本戳，含「从没建过」）。
   *
   * 过期不等于损坏：过期索引仍可召回（老向量对老内容仍然有效），只是该重建了。把判定与动作
   * 分开，宿主才能自己决定重建时机（开机?空闲?用户点一下?），而不是被后端在召回路径上突然
   * 拖去跑一次全量嵌入。
   */
  isStale(): boolean

  /**
   * 双写的第二写：消费权威层 capture 的**结果**。
   *
   * 吃 `MemoryEvidenceRecord` 而不是 `MemoryEvidenceInput`，因为指针只有权威层能分配
   * （files 档是 `<scopeId>::<相对路径>`）。返回实际写入条数。
   */
  indexEvidence(records: readonly MemoryEvidenceRecord[]): Promise<number>

  /** 从权威层全量重建（先清空后灌入，孤儿因此自然消失）。幂等。 */
  rebuild(source: MemoryAuthorityEnumeration): Promise<MemoryDerivedIndexRebuildResult>

  /** 剔除指定指针（权威层已没有的孤儿；`archive` 的批量形式）。返回实际剔除数。 */
  removePointers(ids: readonly string[]): Promise<number>

  /**
   * 卸载：删光派生数据。
   *
   * 签名上就够不着权威层——这是 §3.7 `orphaned-but-preserved` 在记忆域的机械保证：
   * 「清理索引 mod 的数据」在类型上**不可能**碰到用户的记忆内容。
   */
  dropIndex(): Promise<void>
}

/** 运行时判一个后端是不是派生索引（角色是唯一判据，不做实现探测）。 */
export function isMemoryDerivedIndexBackend(
  backend: MemoryStoreBackend,
): backend is MemoryDerivedIndexBackend {
  return backend.descriptor.role === 'derived-index'
}
