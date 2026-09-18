/**
 * 产品面：本单元交给外面的能力。类实现的 API 定义在各自的类上方（`impl/` 里，接口紧挨着类），这里登记并转发。
 * 空间要塞进来的东西在 `contract/requires.ts`。这里的每个接口都必须从根入口导出。
 */

// ── 类实现的产品面接口：定义在类上方，这里登记 ────────────────
export type { ComputerHelperLocatorApi } from '../impl/ComputerHelperLocator.js'
export type { ComputerOperationsApi } from '../impl/ComputerOperations.js'
export type { ComputerRuntimeApi } from '../impl/ComputerSidecarManager.js'
