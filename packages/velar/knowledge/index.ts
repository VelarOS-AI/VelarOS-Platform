/**
 * 知识检索根入口（`@velaros-ai/velar/knowledge`）：代码面 `velar:knowledge` 的三个操作，外加它们用到的数据与注入面。
 * 知识库本身在 `@velaros-ai/knowledge`，宿主拿它实现空间端口。另一个入口 `./knowledge/contracts` 是它的子集，只有可移植数据。
 */

// ── 子集入口 ────────────────────────────────────────────────────
export * from './contracts.js'

// ── 产品面：velar:knowledge ─────────────────────────────────────
export type { KnowledgeOperationsApi } from './contract/provides.js'
export { knowledgeOperations } from './impl/KnowledgeOperations.js'

// ── 注入面：空间要给的东西 ──────────────────────────────────────
export type { KnowledgeOperationContext, KnowledgeSpacePort } from './contract/requires.js'
