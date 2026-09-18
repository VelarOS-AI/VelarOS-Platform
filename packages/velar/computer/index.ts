/**
 * 桌面控制根入口（`@velaros-ai/velar/computer`），给 Node 宿主：代码面 `velar:computer` 的五个操作、
 * 管 helper 子进程的运行时与 helper 定位器，外加它们用到的数据与注入面。
 * 另一个入口 `./computer/contracts` 是它的子集，只有可移植数据，渲染进程也能加载。
 */

// ── 子集入口 ────────────────────────────────────────────────────
export * from './contracts.js'

// ── 产品面：velar:computer、运行时、helper 定位器 ────────────────
export type { ComputerHelperLocatorApi, ComputerOperationsApi, ComputerRuntimeApi } from './contract/provides.js'
export { createComputerHelperLocator } from './impl/ComputerHelperLocator.js'
export { computerOperations } from './impl/ComputerOperations.js'
export { createComputerRuntime } from './impl/ComputerSidecarManager.js'

// ── 注入面：空间与宿主要给的东西 ────────────────────────────────
export type {
  ComputerHelperLocatorOptions,
  ComputerOperationContext,
  ComputerResourceId,
  ComputerResourcePort,
  ComputerSidecarManagerOptions,
  ComputerSidecarProcess,
  ComputerSidecarSpawner,
  ComputerSpacePort,
} from './contract/requires.js'
