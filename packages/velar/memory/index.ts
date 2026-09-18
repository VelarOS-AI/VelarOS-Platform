/**
 * 长期记忆根入口（`@velaros-ai/velar/memory`），给 Node 宿主：代码面 `velar:memory` 的四个操作、产品面、注入面，以及它们签名里用到的数据。
 *
 * 只写转发语句。入口只有两个——这里与 `./memory/contracts`（可移植数据，任何进程都能加载）；
 * 后端、文件档、向量档、内核适配器的消费方全在宿主主进程，与根入口同一个进程，所以都从这里出。
 * 类与工具函数一律不出单元：要它们的能力走下面的工厂与实例的方法面。
 */

// ── 产品面：类上方接口（contract/provides.ts 登记） ───────────────────────────
export type {
  MemoryAdapterApi,
  MemoryBackendsApi,
  MemoryEvidenceBridgeApi,
  MemoryFilesBackendApi,
  MemoryOperationsApi,
  MemoryScopesApi,
  MemoryStoreCapabilitiesApi,
  MemoryTreeDomainApi,
  MemoryTreeRuntimeApi,
  MemoryTreeServiceApi,
  MemoryTurnContextDeltaSource,
  MemoryTurnRecallCoordinatorApi,
} from './contract/provides.js'

// ── 注入面 ────────────────────────────────────────────────────────────────
export type {
  CreateMemoryStoreKernelModuleOptions,
  MemoryAdapterConfigPort,
  MemoryAdapterHostContextPort,
  MemoryAdapterMountInput,
  MemoryAdapterStorePort,
  MemoryAdapterTreePort,
  MemoryAuthorityEnumeration,
  MemoryDatabaseProvider,
  MemoryDerivedIndexBackend,
  MemoryEmbedder,
  MemoryFilesIo,
  MemoryHostIdleSignalPort,
  MemoryHostScopeResolver,
  MemoryOperationContext,
  MemorySpacePort,
  MemoryStoreBackend,
  MemoryStoreCapabilityRegistry,
  MemoryStoreCapabilityService,
  MemoryTreeRuntimeProviders,
  MemoryVectorIndexStore,
  MountMemoryAdapterInput,
  ResolveMemoryStoreBackendInput,
} from './contract/requires.js'

// ── 常量表（同时随 ./contracts 出包） ──────────────────────────────────────
export * from './contracts.js'

// ── 数据：公开签名用到的类型 ───────────────────────────────────────────────
export type {
  FileVectorIndexStoreOptions,
  LayeredMemoryStoreBackend,
  LayeredMemoryStoreBackendOptions,
  MemoryTreeServiceOptions,
  MemoryVectorBackendOptions,
} from './contract/provides.js'
export type { MemoryTreeStoreDomain, SQLiteDatabase } from './contract/requires.js'
export type { MemoryDerivedIndexFailure } from './types/backends.js'
export type { MemoryFilesBackendOptions } from './types/files.js'
export type {
  MemoryComputerUseObservationInput,
  MemoryExecutionObservationInput,
  MemoryHostScope,
  MemoryHostScopeInput,
  MemoryHostSessionSnapshot,
  MemoryHostTranscriptMessage,
  MemoryHostUserMessage,
  MemoryHostUserMessageEvent,
  MemoryWorkspaceToolObservationInput,
} from './types/host.js'
export type { MemoryTurnRecallInput, MemoryTurnRecallResult } from './types/memory.js'

// ── 出包的值：工厂与实例 ──────────────────────────────────────────────────
export { createLayeredMemoryStoreBackend } from './impl/backends/LayeredMemoryStore.js'
export { memoryBackends } from './impl/backends/MemoryBackends.js'
export { memoryScopes } from './impl/backends/MemoryScopes.js'
export { createMemoryTreeStoreBackend } from './impl/backends/MemoryTreeStoreBackend.js'
export { createMemoryFilesBackend } from './impl/files/MemoryFilesBackend.js'
export { createNodeMemoryFilesIo } from './impl/files/NodeMemoryFilesIo.js'
export { mountMemoryAdapter } from './impl/host/MemoryAdapterRuntime.js'
export { memoryStoreCapabilities } from './impl/host/MemoryStoreCapabilities.js'
export { memoryOperations } from './impl/MemoryOperations.js'
export { createMemoryRuntime } from './impl/tree/MemoryTreeRuntime.js'
export { createFileVectorIndexStore } from './impl/vector/FileVectorIndexStore.js'
export { createMemoryVectorBackend } from './impl/vector/MemoryVectorBackend.js'
