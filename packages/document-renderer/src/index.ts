/**
 * 文档渲染器根入口（`@velaros-ai/document-renderer`）：一件渲染能力，外加命令协议的约定数据。
 * 只给 Node 用（要读写磁盘、要 Office 渲染原语）；另一个入口 `./contracts` 是它的子集，只有可移植数据。
 */

// ── 子集入口 ────────────────────────────────────────────────────
export * from './contracts.js'

// ── 产品面：一次请求、一次命令行、一次自述 ───────────────────────
export type { DocumentRendererApi } from './impl/DocumentRenderer.js'
export { documentRenderer } from './impl/DocumentRenderer.js'
