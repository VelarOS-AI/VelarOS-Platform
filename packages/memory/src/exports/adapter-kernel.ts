export type { MemoryDreamSchedulerOptions } from '../impl/host/MemoryDreamScheduler'
export { MemoryDreamScheduler } from '../impl/host/MemoryDreamScheduler'
export type {
  ComputerUseObservationInput,
  ExecutionObservationInput,
  MemoryEvidenceBridgeOptions,
  WorkspaceToolObservationInput,
} from '../impl/host/MemoryEvidenceBridge'
export { MemoryEvidenceBridge } from '../impl/host/MemoryEvidenceBridge'
export type {
  MemoryHostScope,
  MemoryHostScopeInput,
  MemoryHostScopeResolver,
  MemoryHostSessionSnapshot,
  MemoryHostTranscriptMessage,
  MemoryHostUserMessage,
  MemoryHostUserMessageEvent,
} from '../types/host'
export type { HostIdleSignalPort } from '../types/host-signals'
// 记忆的内核面只有一条：后端经 `velaros.memory.store.<id>` token 注册，宿主经 mountMemoryAdapter
// 接三端口。曾经还有一个 `velaros.memory.default` 只读 kernel 模块（recall/get_claim/diagnostics/
// verify_integrity），全仓零挂载，且它的 get_claim 有一套工具路径没有的跨作用域拦截——两条语义
// 不同的读路径并存，安全评审会读到没在跑的那条。2026-08-05 删除，跨作用域读规则收口到
// `memory:get` 工具这一处（唯一在跑的读路径）。
export type {
  MemoryAdapterConfigPort,
  MemoryAdapterHostContextPort,
  MemoryAdapterMount,
  MemoryAdapterStorePort,
  MemoryAdapterTreePort,
  MountMemoryAdapterInput,
} from '../impl/host/MemoryAdapterRuntime'
export { MemoryAdapterRuntime, mountMemoryAdapter } from '../impl/host/MemoryAdapterRuntime'
export type {
  CreateMemoryStoreKernelModuleOptions,
  MemoryStoreCapabilityRegistry,
  MemoryStoreCapabilityService,
  ResolveMemoryStoreBackendInput,
} from '../impl/host/MemoryStoreCapabilities'
export {
  createMemoryStoreCapabilityToken,
  createMemoryStoreKernelModule,
  DefaultMemoryStoreCapabilityVersion,
  listRegisteredMemoryStoreBackends,
  memoryStoreCapabilityId,
  MemoryStoreCapabilityNamespace,
  resolveMemoryDerivedIndexBackends,
  resolveMemoryStoreBackend,
} from '../impl/host/MemoryStoreCapabilities'
export type { MemoryServiceOptions } from '../impl/host/MemoryTreeService'
export { MemoryService } from '../impl/host/MemoryTreeService'
export type {
  MemoryTurnContextDeltaSource,
  MemoryTurnRecallDeps,
  MemoryTurnRecallInput,
} from '../impl/host/MemoryTurnRecallCoordinator'
export { MemoryTurnRecallCoordinator } from '../impl/host/MemoryTurnRecallCoordinator'
