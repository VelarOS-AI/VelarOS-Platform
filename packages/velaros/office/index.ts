/**
 * 办公文档根入口（`@velaros-ai/velaros/office`），给 Node 宿主：代码面 `velaros:office` 的九个操作、MarkItDown 定位器，
 * 产品面与注入面的接口，以及它们签名里用到的数据。类、工具函数与单元内部数据一律不出单元；
 * 另两个入口是它的子集——`./office/contracts` 只有可移植数据（渲染进程也能加载），`./office/renderer` 只有窄渲染原语（给 Document Renderer）。
 */

// ── 子集入口：常量表与可移植数据 ────────────────────────────────
export * from './contracts.js'

// ── 产品面：类上方的 API 接口 ───────────────────────────────────
export type {
  MarkItDownLocatorApi,
  OfficeDocumentRendererApi,
  OfficeOperationsApi,
} from './contract/provides.js'

// ── 注入面：空间与宿主要塞进来的东西 ────────────────────────────
export type {
  MarkItDownLocatorOptions,
  OfficeOperationContext,
  OfficeResourcePort,
  OfficeSpacePort,
} from './contract/requires.js'

// ── 值：模型面的操作与 MarkItDown 定位器 ────────────────────────
export { officeOperations } from './impl/OfficeOperations.js'
export { createMarkItDownLocator } from './impl/runtime/MarkItDownLocator.js'
