/**
 * 长期记忆根入口（`@velaros-ai/velaros/memory`），给 Node 宿主：代码面 `velaros:memory` 的三个操作、记忆库的工厂，以及它们用到的接口。
 * 另一个入口 `./contracts` 是它的子集，只有可移植数据。
 */

// ── 子集入口 ────────────────────────────────────────────────────
export * from './contracts.js'

// ── 产品面：velaros:memory 与记忆库 ───────────────────────────────
export type { MemoryOperationsApi, MemoryScopeApi, MemoryStoreApi } from './contract/provides.js'
export { memoryOperations } from './impl/MemoryOperations.js'
export { createMemoryStore } from './impl/MemoryStore.js'

// ── 注入面：宿主要给的东西 ──────────────────────────────────────
export type {
  MemoryOperationContext,
  MemoryScopePort,
  MemoryStoreOptions,
} from './contract/requires.js'
