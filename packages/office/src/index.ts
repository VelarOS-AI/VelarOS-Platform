/**
 * office 空间根入口（`@velaros-ai/office`），给 Node 宿主。
 *
 * 一个宿主只需要这一个入口：十个模型面工具、内核挂载、MarkItDown 定位器，加上注入面与它们用到的数据。
 * 另外两个入口是它的子集——`./contracts` 只有可移植数据（渲染进程也能加载），
 * `./renderer` 只有窄渲染原语（给不装 agent 的 Document Renderer）。
 */

// ── 可移植数据与常量表（`./contracts` 的全部内容） ───────────────
export * from './contracts.js'

// ── 产品面 ──────────────────────────────────────────────────────
export type {
  MarkItDownLocatorApi,
  OfficeCapabilityService,
  OfficeDocumentRendererApi,
  OfficeToolCollection,
} from './contract/provides.js'

// ── 注入面 ──────────────────────────────────────────────────────
export type {
  CreateOfficeKernelModuleOptions,
  MarkItDownLocatorOptions,
  OfficeResourcePort,
  OfficeToolContextResolver,
} from './contract/requires.js'

// ── 值：工具集合、内核模块、MarkItDown 定位器 ────────────────────
export { createOfficeKernelModule, OfficeCapability, officeTools } from './impl/OfficeTools.js'
export { createMarkItDownLocator, markItDownBinaryResolver } from './impl/runtime/MarkItDownLocator.js'
