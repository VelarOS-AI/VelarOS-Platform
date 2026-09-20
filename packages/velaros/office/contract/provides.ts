/**
 * 产品面：本单元交给外面的整件能力。类实现的 API 定义在各自的类上方（`impl/` 里，接口紧挨着类），这里只做登记与转发；
 * 这里登记的每个接口都从根入口导出。空间要塞进来的东西在 `contract/requires.ts`。
 */

// ── 模型面：velaros:office 的九个操作 ─────────────────────────────
export type { OfficeOperationsApi } from '../impl/OfficeOperations.js'

// ── 运行时：MarkItDown 定位与给 Document Renderer 的窄渲染面 ──────
export type { MarkItDownLocatorApi } from '../impl/runtime/MarkItDownLocator.js'
export type { OfficeDocumentRendererApi } from '../impl/runtime/OfficeDocumentRenderer.js'
