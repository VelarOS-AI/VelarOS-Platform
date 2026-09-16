/**
 * 运行时入口（`@velaros-ai/computer/runtime`）：sidecar 运行时、helper 定位器与内核挂载，只给 Node 宿主。
 * 入口名与导出名在这一轮保持不变，收口那一轮再并进根入口。
 */

// ── 产品面：运行时、helper 定位、内核挂载 ──────────────────────
export { ComputerKernelModuleVersion } from './contract/constants.js'
export type {
  ComputerCapabilityService,
  ComputerHelperLocatorApi,
  ComputerRuntimeApi,
  ComputerRuntimeCapabilityService,
} from './contract/provides.js'
export {
  ComputerHelperLocator,
  ComputerHelperLocator as ComputerHelperResolver,
  computerHelperResolver,
  createComputerHelperLocator,
  resolveBundledComputerRuntimeSourceRoot,
  resolveComputerHelper,
} from './impl/ComputerHelperLocator.js'
export { ComputerSidecarManager, createComputerRuntime } from './impl/ComputerSidecarManager.js'
export { ComputerCapability, createComputerKernelModule } from './impl/ComputerTools.js'

// ── 注入面：宿主要给的东西 ──────────────────────────────────────
export type {
  ComputerHelperLocatorOptions,
  ComputerHelperResolverOptions,
  ComputerResourceId,
  ComputerResourcePort,
  ComputerRuntimePort,
  ComputerSidecarManagerOptions,
  ComputerSidecarProcess,
  ComputerSidecarSpawner,
  ComputerToolContextResolver,
  CreateComputerKernelModuleOptions,
} from './contract/requires.js'

// ── 上面两面用到的数据 ──────────────────────────────────────────
export type {
  ComputerAvailability,
  ComputerAvailabilityReason,
  ComputerClickOptions,
  ComputerClickResult,
  ComputerCoordinateSpace,
  ComputerGlobalClickOptions,
  ComputerHelperLaunchSpec,
  ComputerKeyResult,
  ComputerMoveResult,
  ComputerPermissionStatus,
  ComputerPrimaryDisplayClickOptions,
  ComputerScreenshot,
  ComputerScreenSize,
  ComputerTypeResult,
} from './types/computer.js'
export type {
  ComputerCommand,
  ComputerHelperFailure,
  ComputerHelperRequest,
  ComputerHelperResponse,
  ComputerHelperSuccess,
} from './types/protocol.js'
export {
  decodeComputerResponse,
  drainResponseLines,
  encodeComputerRequest,
} from './utils/protocol.js'
