/**
 * `@velaros-ai/memory` 根入口：产品面、注入面，以及它们签名里用到的数据。
 *
 * 只写转发语句。入口收成两个（`.` 与 `./contracts`）是后面「入口收口」那一轮的事，
 * 这一轮保持现有入口名与导出名不变，只把转发目标换成新的五个目录。
 */

// ── 产品面：类上方接口（contract/provides.ts 登记） ───────────────────────────
export type {
  InMemoryMemoryFilesIoApi,
  InMemoryVectorIndexStoreApi,
  LayeredMemoryStoreBackend,
  MemoryAdapterApi,
  MemoryBackendsApi,
  MemoryDreamSchedulerApi,
  MemoryEvidenceBridgeApi,
  MemoryFilesBackendApi,
  MemoryScopesApi,
  MemoryStoreCapabilitiesApi,
  MemoryToolOperationsApi,
  MemoryTreeDomainApi,
  MemoryTreeServiceApi,
  MemoryTurnContextDeltaSource,
  MemoryTurnRecallCoordinatorApi,
} from '../contract/provides'

// ── 注入面 ────────────────────────────────────────────────────────────────
export type {
  CreateMemoryStoreKernelModuleOptions,
  DefineMemoryToolInput,
  HostIdleSignalPort,
  MemoryAdapterConfigPort,
  MemoryAdapterHostContextPort,
  MemoryAdapterMountInput,
  MemoryAdapterStorePort,
  MemoryAdapterTreePort,
  MemoryApi,
  MemoryAuthorityEnumeration,
  MemoryDatabaseProvider,
  MemoryDerivedIndexBackend,
  MemoryEmbedder,
  MemoryFilesIo,
  MemoryHostScopeResolver,
  MemoryStoreBackend,
  MemoryStoreCapabilityRegistry,
  MemoryStoreCapabilityService,
  MemoryToolApi,
  MemoryToolContext,
  MemoryTreeRuntimeProviders,
  MountMemoryAdapterInput,
  ResolveMemoryStoreBackendInput,
  ToolContext,
  VelaTool,
} from '../contract/requires'

// ── 常量表（同时随 ./contracts 出包） ──────────────────────────────────────
export * from './contracts'

// ── 数据：公开签名用到的类型 ───────────────────────────────────────────────
export type { MemoryToolCollection } from '../contract/provides'
export type { MemoryVectorBackendOptions } from '../contract/provides'
export type { FileVectorIndexStoreOptions } from '../contract/provides'
export type { LayeredMemoryStoreBackendOptions } from '../contract/provides'
export type { MemoryDreamSchedulerOptions } from '../contract/provides'
export type { MemoryEvidenceBridgeOptions } from '../contract/provides'
export type { MemoryServiceOptions } from '../contract/provides'
export type { MemoryAdapterMount } from '../contract/provides'
export type { MemoryVectorIndexStore } from '../contract/requires'
export type { MemoryTreeStoreDomain, SQLiteDatabase } from '../contract/requires'
export type { MemoryDerivedIndexFailure } from '../types/backends'
export type { MemoryFilesBackendOptions } from '../types/files'
export type {
  ComputerUseObservationInput,
  ExecutionObservationInput,
  MemoryHostScope,
  MemoryHostScopeInput,
  MemoryHostSessionSnapshot,
  MemoryHostTranscriptMessage,
  MemoryHostUserMessage,
  MemoryHostUserMessageEvent,
  WorkspaceToolObservationInput,
} from '../types/host'
export type {
  MemoryComputerUseObservationInput,
  MemoryExecutionObservationInput,
  MemoryWorkspaceToolObservationInput,
} from '../types/host'
export type { MemoryTurnRecallDeps } from '../types/host'
export type { MemoryTurnRecallInput, MemoryTurnRecallResult } from '../types/memory'
export type {
  ForgetMemoryInput,
  ForgetMemoryResult,
  GetMemoryInput,
  GetMemoryResult,
  MemoryToolCategory,
  SaveMemoryInput,
  SaveMemoryResult,
  SearchMemoriesInput,
  SearchMemoriesResult,
} from '../types/tool'

// ── 出包的值：实例与工厂 ──────────────────────────────────────────────────
export { createLayeredMemoryStoreBackend } from '../impl/backends/LayeredMemoryStore'
export { memoryBackends } from '../impl/backends/MemoryBackends'
export { memoryScopes } from '../impl/backends/MemoryScopes'
export { createMemoryTreeStoreBackend } from '../impl/backends/MemoryTreeStoreBackend'
export { createInMemoryMemoryFilesIo } from '../impl/files/InMemoryMemoryFilesIo'
export { createMemoryFilesBackend } from '../impl/files/MemoryFilesBackend'
export { createNodeMemoryFilesIo } from '../impl/files/NodeMemoryFilesIo'
export { mountMemoryAdapter } from '../impl/host/MemoryAdapterRuntime'
export { memoryStoreCapabilities } from '../impl/host/MemoryStoreCapabilities'
export { memoryToolOperations } from '../impl/MemoryToolOperations'
export { memoryTools } from '../impl/MemoryTools'
export { createMemoryRuntime } from '../impl/tree/MemoryTreeRuntime'
export { createFileVectorIndexStore } from '../impl/vector/FileVectorIndexStore'
export { createInMemoryVectorIndexStore } from '../impl/vector/InMemoryVectorIndexStore'
export { createMemoryVectorBackend } from '../impl/vector/MemoryVectorBackend'

// ── 入口收口那一轮要删的历史名字（类、utils 函数、散装常量） ─────────────────
export { MemoryDream } from '../impl/tree/MemoryDream'
export { MemoryTreeDomain as MemoryDomain, MemoryTreeDomain } from '../impl/tree/MemoryTreeDomain'
export { MemoryTreeRecall } from '../impl/tree/MemoryTreeRecall'
export { MemoryTreeRepository } from '../impl/tree/MemoryTreeRepository'
export { DefaultMemoryRuntime, MemoryRuntime } from '../impl/tree/MemoryTreeRuntime'
export {
  formatMemoryDerivedIndexVersion,
  isMemoryDerivedIndexBackend,
  listMissingAuthorityMemoryVerbs,
  resolveAuthorityEnumeration,
  supportsMemoryBackendVerb,
} from '../utils/backends'
export {
  buildProjectMemoryScope,
  buildSiteMemoryScope,
  isMemoryVisibleInScope,
  resolveMemoryScopeFilterValue,
  resolveMemoryScopeSelector,
  scopeTypeForScopeId,
} from '../utils/scope'
export { applyMemoryTreeSchema, MemoryTreeSchemaSql } from '../utils/tree/schema'
