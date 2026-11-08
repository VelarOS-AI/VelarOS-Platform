/**
 * 办公文档根入口（`@velaros-ai/velaros/office`），给 Node 宿主：代码面 `velaros:office` 的九个操作，
 * 产品面与注入面的接口，以及它们签名里用到的数据。类、工具函数与单元内部数据一律不出单元；
 * 可移植数据在 `./office/contracts`，本机资源定位在 `./office/locator`，独立 Document Renderer 使用 `./office/renderer`。
 */

// ── 子集入口：常量表与可移植数据 ────────────────────────────────
export * from './contracts.js'

// ── 产品面：类上方的 API 接口 ───────────────────────────────────
export type {
  OfficeDocumentRendererApi,
  OfficeOperationsApi,
  OfficeOperationsDocumentsApi,
  OfficeOperationsMarkdownApi,
} from './contract/provides.js'

// ── 注入面：空间与宿主要塞进来的东西 ────────────────────────────
export type { OfficeOperationContext, OfficeSpacePort } from './contract/requires.js'

// ── 值：模型面的文档操作 ────────────────────────────────────────
export { officeOperations } from './impl/OfficeOperations.js'
