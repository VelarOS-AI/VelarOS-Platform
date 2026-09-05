export type { MemoryDreamSchedulerOptions } from './DreamScheduler'
export { MemoryDreamScheduler } from './DreamScheduler'
export type {
  ComputerUseObservationInput,
  ExecutionObservationInput,
  MemoryEvidenceBridgeOptions,
  WorkspaceToolObservationInput,
} from './EvidenceBridge'
export { MemoryEvidenceBridge } from './EvidenceBridge'
export type {
  MemoryHostScope,
  MemoryHostScopeInput,
  MemoryHostScopeResolver,
  MemoryHostSessionSnapshot,
  MemoryHostTranscriptMessage,
  MemoryHostUserMessage,
  MemoryHostUserMessageEvent,
} from './HostContracts'
export type { HostIdleSignalPort } from './HostSignals'
// 记忆的内核面只有一条：后端经 `velaros.memory.store.<id>` token 注册，宿主经 mountMemoryAdapter
// 接三端口。曾经还有一个 `velaros.memory.default` 只读 kernel 模块（recall/get_claim/diagnostics/
// verify_integrity），全仓零挂载，且它的 get_claim 有一套工具路径没有的跨作用域拦截——两条语义
// 不同的读路径并存，安全评审会读到没在跑的那条。2026-08-05 删除，跨作用域读规则收口到
// `memory:get` 工具这一处（唯一在跑的读路径）。
export {
  createMemoryStoreCapabilityToken,
  createMemoryStoreKernelModule,
  type CreateMemoryStoreKernelModuleOptions,
  DefaultMemoryStoreCapabilityVersion,
  listRegisteredMemoryStoreBackends,
  memoryStoreCapabilityId,
  MemoryStoreCapabilityNamespace,
  type MemoryStoreCapabilityRegistry,
  type MemoryStoreCapabilityService,
  resolveMemoryDerivedIndexBackends,
  resolveMemoryStoreBackend,
  type ResolveMemoryStoreBackendInput,
} from './MemoryStoreCapability'
export {
  type MemoryAdapterConfigPort,
  type MemoryAdapterHostContextPort,
  type MemoryAdapterMount,
  MemoryAdapterRuntime,
  type MemoryAdapterStorePort,
  type MemoryAdapterTreePort,
  mountMemoryAdapter,
  type MountMemoryAdapterInput,
} from './mount'
export type { MemoryServiceOptions } from './Service'
export { MemoryService } from './Service'
export {
  type MemoryTurnContextDeltaSource,
  MemoryTurnRecallCoordinator,
  type MemoryTurnRecallDeps,
  type MemoryTurnRecallInput,
} from './TurnRecallCoordinator'
