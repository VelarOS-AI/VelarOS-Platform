/**
 * 桌面控制空间根入口（`@velaros-ai/computer`），给 Node 宿主。
 *
 * 一个宿主只需要这一个入口：五个模型面工具、sidecar 运行时、helper 定位器、内核挂载，
 * 加上注入面与它们用到的数据。`./contracts` 是它的可移植子集，渲染进程也能加载。
 */

// ── 可移植数据与常量表（`./contracts` 的全部内容） ───────────────
export * from './contracts.js'

// ── 产品面 ──────────────────────────────────────────────────────
export type {
  ComputerCapabilityService,
  ComputerHelperLocatorApi,
  ComputerRuntimeApi,
  ComputerToolCollection,
  VelaTool,
} from './contract/provides.js'

// ── 注入面 ──────────────────────────────────────────────────────
export type {
  ComputerHelperLocatorOptions,
  ComputerResourceId,
  ComputerResourcePort,
  ComputerRuntimePort,
  ComputerSidecarManagerOptions,
  ComputerSidecarProcess,
  ComputerSidecarSpawner,
  ComputerToolComputerApi,
  ComputerToolContext,
  ComputerToolContextResolver,
  CreateComputerKernelModuleOptions,
} from './contract/requires.js'

// ── 值：工具集合、运行时、helper 定位器、内核模块 ─────────────────
export { createComputerHelperLocator } from './impl/ComputerHelperLocator.js'
export { createComputerRuntime } from './impl/ComputerSidecarManager.js'
export { ComputerCapability, computerTools, createComputerKernelModule } from './impl/ComputerTools.js'
