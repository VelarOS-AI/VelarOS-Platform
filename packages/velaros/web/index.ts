/**
 * 网上查资料根入口（`@velaros-ai/velaros/web`），给 Node 宿主：代码面 `velaros:web` 的 search 与 read，
 * 以及宿主要给的无头浏览器端口与调用上下文。另一个入口 `./contracts` 是它的子集，只有可移植数据。
 */

// ── 子集入口 ────────────────────────────────────────────────────
export * from './contracts.js'

// ── 产品面：velaros:web ───────────────────────────────────────────
export type { WebOperationsApi } from './contract/provides.js'
export { webOperations } from './impl/WebOperations.js'

// ── 注入面：宿主要给的东西 ──────────────────────────────────────
export type {
  WebEngineBackoff,
  WebOperationContext,
  WebPage,
  WebSpacePort,
} from './contract/requires.js'
