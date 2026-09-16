/**
 * office 空间根入口（`@velaros-ai/office`），给 Node 宿主。
 * 只出三样东西：产品面（工具集合、内核挂载、MarkItDown 定位器）、注入面（宿主端口与上下文），
 * 以及它们用到的数据与常量表。另外两个入口 `./contracts`、`./renderer` 是它的子集。
 */
export * from './composition.js'
export type { OfficeDocumentRendererApi, OfficeToolCollection } from './contract/provides.js'
export * from './contracts.js'
export * from './runtime.js'
export * from './tools.js'
