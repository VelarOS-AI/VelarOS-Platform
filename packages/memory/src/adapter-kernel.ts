export type { MemoryDreamSchedulerOptions } from './contract/provides'
export type { MemoryEvidenceBridgeOptions } from './contract/provides'
export type { MemoryHostScopeResolver } from './contract/requires'
export type { HostIdleSignalPort } from './contract/requires'
export type { MemoryDreamSchedulerApi } from './impl/host/MemoryDreamScheduler'
export { MemoryDreamScheduler } from './impl/host/MemoryDreamScheduler'
export type { MemoryEvidenceBridgeApi } from './impl/host/MemoryEvidenceBridge'
export { MemoryEvidenceBridge } from './impl/host/MemoryEvidenceBridge'
export type {
  ComputerUseObservationInput,
  ExecutionObservationInput,
  WorkspaceToolObservationInput,
} from './types/host'
export type {
  MemoryHostScope,
  MemoryHostScopeInput,
  MemoryHostSessionSnapshot,
  MemoryHostTranscriptMessage,
  MemoryHostUserMessage,
  MemoryHostUserMessageEvent,
} from './types/host'
// 记忆的内核面只有一条：后端经 `velaros.memory.store.<id>` token 注册，宿主经 mountMemoryAdapter
// 接三端口。曾经还有一个 `velaros.memory.default` 只读 kernel 模块（recall/get_claim/diagnostics/
// verify_integrity），全仓零挂载，且它的 get_claim 有一套工具路径没有的跨作用域拦截——两条语义
// 不同的读路径并存，安全评审会读到没在跑的那条。2026-08-05 删除，跨作用域读规则收口到
// `memory:get` 工具这一处（唯一在跑的读路径）。
export {
  DefaultMemoryStoreCapabilityVersion,
  MemoryStoreCapabilityNamespace,
} from './contract/constants'
export type { MemoryAdapterMount } from './contract/provides'
export type { MemoryServiceOptions } from './contract/provides'
export type { MemoryTurnContextDeltaSource } from './contract/provides'
export type {
  MemoryAdapterConfigPort,
  MemoryAdapterHostContextPort,
  MemoryAdapterMountInput,
  MemoryAdapterStorePort,
  MemoryAdapterTreePort,
  MountMemoryAdapterInput,
} from './contract/requires'
export type {
  CreateMemoryStoreKernelModuleOptions,
  MemoryStoreCapabilityRegistry,
  MemoryStoreCapabilityService,
  ResolveMemoryStoreBackendInput,
} from './contract/requires'
export type { MemoryAdapterApi } from './impl/host/MemoryAdapterRuntime'
export { MemoryAdapterRuntime, mountMemoryAdapter } from './impl/host/MemoryAdapterRuntime'
export type { MemoryStoreCapabilitiesApi } from './impl/host/MemoryStoreCapabilities'
export {
  createMemoryStoreCapabilityToken,
  createMemoryStoreKernelModule,
  listRegisteredMemoryStoreBackends,
  memoryStoreCapabilities,
  memoryStoreCapabilityId,
  resolveMemoryDerivedIndexBackends,
  resolveMemoryStoreBackend,
} from './impl/host/MemoryStoreCapabilities'
export type { MemoryTreeServiceApi } from './impl/host/MemoryTreeService'
export { MemoryService } from './impl/host/MemoryTreeService'
export type { MemoryTurnRecallCoordinatorApi } from './impl/host/MemoryTurnRecallCoordinator'
export { MemoryTurnRecallCoordinator } from './impl/host/MemoryTurnRecallCoordinator'
export type { MemoryTurnRecallDeps } from './types/host'
export type { MemoryTurnRecallInput } from './types/memory'
