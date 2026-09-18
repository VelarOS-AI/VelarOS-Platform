/** 向量派生索引的包内工作类型。 */

import type { MemoryScopeType } from './memory.js'

/** 向量索引的落盘形状。解析失败 = 当作没建过（派生物不需要抢救）。 */
export interface PersistedVectorIndex {
  /** 落盘时的版本戳字符串。 */
  version: string
  /** 索引里的记录，向量以 base64 编码的 Float32 存放。 */
  records: Array<{
    /** 权威层指针。 */
    id: string
    /** 作用域种类。 */
    scopeType: string
    /** 作用域 id。 */
    scopeId: string
    /** 最后写入时间戳，毫秒。 */
    updatedAt: number
    /** base64 编码的向量。 */
    vector: string
  }>
}

/** 待嵌入的一条索引条目：拿去嵌入之前先拼好文本与作用域。 */
export interface PendingIndexEntry {
  /** 权威层指针。 */
  id: string
  /** 作用域种类。 */
  scopeType: MemoryScopeType
  /** 作用域 id。 */
  scopeId: string
  /** 条目的最后更新时间戳，毫秒。 */
  updatedAt: number
  /** 送去嵌入的正文（标题 + 摘要 + 正文拼接并截断）。 */
  text: string
}
