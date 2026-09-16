/**
 * `@velaros-ai/memory` 根入口，给 Node 宿主：产品面、注入面，以及它们签名里用到的数据。
 *
 * 只写转发语句。入口只有两个——这里与 `./contracts`（可移植数据，任何进程都能加载）；
 * 原来的 `./backend`、`./files`、`./vector`、`./adapter-kernel` 四个子路径的消费方全在
 * 宿主主进程，与根入口同一个进程，按「确有独立消费方的才多开」并进这里。
 * 类与工具函数一律不出包：要它们的能力走下面的工厂与三个实例的方法面。
 */

// ── 产品面：类上方接口（contract/provides.ts 登记） ───────────────────────────
export type {
  MemoryAdapterApi,
  MemoryBackendsApi,
  MemoryEvidenceBridgeApi,
  MemoryFilesBackendApi,
  MemoryScopesApi,
  MemoryStoreCapabilitiesApi,
  MemoryToolCollection,
  MemoryTreeDomainApi,
  MemoryTreeRuntimeApi,
  MemoryTreeServiceApi,
  MemoryTurnContextDeltaSource,
  MemoryTurnRecallCoordinatorApi,
} from './contract/provides'

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
  MemoryStoreBackend,
  MemoryStoreCapabilityRegistry,
  MemoryStoreCapabilityService,
  MemoryToolApi,
  MemoryToolContext,
  MemoryTreeRuntimeProviders,
  MemoryVectorIndexStore,
  MountMemoryAdapterInput,
  ResolveMemoryStoreBackendInput,
  VelaTool,
} from './contract/requires'

// ── 常量表（同时随 ./contracts 出包） ──────────────────────────────────────
export * from './contracts'

// ── 数据：公开签名用到的类型 ───────────────────────────────────────────────
export type {
  FileVectorIndexStoreOptions,
  LayeredMemoryStoreBackend,
  LayeredMemoryStoreBackendOptions,
  MemoryTreeServiceOptions,
  MemoryVectorBackendOptions,
} from './contract/provides'
export type { MemoryTreeStoreDomain, SQLiteDatabase } from './contract/requires'
export type { MemoryDerivedIndexFailure } from './types/backends'
export type { MemoryFilesBackendOptions } from './types/files'
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
} from './types/host'
export type { MemoryTurnRecallInput, MemoryTurnRecallResult } from './types/memory'
export type {
  ForgetMemoryInput,
  GetMemoryInput,
  MemoryToolCategory,
  SaveMemoryInput,
  SearchMemoriesInput,
} from './types/tool'

// ── 出包的值：工厂与实例 ──────────────────────────────────────────────────
export { createLayeredMemoryStoreBackend } from './impl/backends/LayeredMemoryStore'
export { memoryBackends } from './impl/backends/MemoryBackends'
export { memoryScopes } from './impl/backends/MemoryScopes'
export { createMemoryTreeStoreBackend } from './impl/backends/MemoryTreeStoreBackend'
export { createMemoryFilesBackend } from './impl/files/MemoryFilesBackend'
export { createNodeMemoryFilesIo } from './impl/files/NodeMemoryFilesIo'
export { mountMemoryAdapter } from './impl/host/MemoryAdapterRuntime'
export { memoryStoreCapabilities } from './impl/host/MemoryStoreCapabilities'
export { memoryTools } from './impl/MemoryTools'
export { createMemoryRuntime } from './impl/tree/MemoryTreeRuntime'
export { createFileVectorIndexStore } from './impl/vector/FileVectorIndexStore'
export { createMemoryVectorBackend } from './impl/vector/MemoryVectorBackend'
