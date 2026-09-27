/**
 * 会话之间交活、传话的根入口（`@velaros-ai/velaros/sessions`），给宿主：代码面 `velaros:sessions` 的 list、ask、tell，
 * 以及宿主要给的端口与调用上下文。另一个入口 `./contracts` 是它的子集，只有可移植数据。
 */

// ── 子集入口 ────────────────────────────────────────────────────
export * from './contracts.js'

// ── 产品面：velaros:sessions ──────────────────────────────────────
export type { SessionsOperationsApi } from './contract/provides.js'
export { sessionsOperations } from './impl/SessionsOperations.js'

// ── 注入面：宿主要给的东西 ──────────────────────────────────────
export type { SessionsOperationContext, SessionsSpacePort } from './contract/requires.js'
