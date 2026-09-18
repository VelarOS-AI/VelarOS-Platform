/**
 * 注入面：`velar:memory` 要宿主塞进来的东西。本单元只从这些口子接收外部能力，别处不留钩子。
 *
 * - 作用域端口 `MemoryScopePort`：三个操作经 `ctx.memory` 调它。宿主不用自己实现，
 *   `createMemoryStore({ root }).scope(作用域)` 交回的就是一份。
 * - 调用上下文 `MemoryOperationContext`：宿主分发每一次调用时装好。
 * - 记忆库的选项 `MemoryStoreOptions`：宿主造记忆库时给根目录。
 *
 * 这里的每个接口都必须从根入口导出。
 */

import type { MemoryEntry, MemoryIdInput, MemoryRemoved, MemorySaved, MemorySaveInput } from '../types/memory.js'

/** 宿主造记忆库（`createMemoryStore`）时给的东西。 */
export interface MemoryStoreOptions {
  /** 记忆的根目录，绝对路径；根下一个作用域一个目录，第一次写入时才建。 */
  root: string
}

/** 一个作用域里的记忆：读写只落在这个作用域的目录里，别的作用域碰不到。入参在这里核对，不合法就一个文件都不写、不删。 */
export interface MemoryScopePort {
  /** 这个作用域的全部记忆，含正文，按更新时间从新到旧。 */
  list: () => Promise<MemoryEntry[]>
  /** 写一条：id 已有就整条覆盖，没有就新建；更新时间由记忆库填。 */
  save: (input: MemorySaveInput) => Promise<MemorySaved>
  /** 删一条：真删；本来就没有时 removed 为假。 */
  remove: (input: MemoryIdInput) => Promise<MemoryRemoved>
}

/** 每次调用 `velar:memory` 时宿主给的上下文。它不是模型能填的入参：宿主分发这次调用时按会话的作用域装好，生成声明时整个丢掉。 */
export interface MemoryOperationContext {
  /** 本次调用的取消信号：取消之后一个文件都不再读写。 */
  abortSignal: AbortSignal
  /** 这次调用落在哪个作用域：`store.scope(这个会话的作用域)`。 */
  memory: MemoryScopePort
}
