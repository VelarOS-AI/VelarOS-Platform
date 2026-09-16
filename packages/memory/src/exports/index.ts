import { structureToolDescriptionsForCategory } from '@velaros-ai/agent/tool-contract'

import { memoryTools as rawMemoryTools } from '../impl/MemoryTools'

export type {
  MemoryBackendAwaitable,
  MemoryBackendCaptureBatchOptions,
  MemoryBackendDescriptor,
  MemoryBackendRole,
  MemoryBackendStats,
  MemoryBackendVerb,
  MemoryStoreBackend,
} from '../contract/backend'
export {
  listMissingAuthorityMemoryVerbs,
  RequiredAuthorityMemoryVerbs,
  supportsMemoryBackendVerb,
} from '../contract/backend'
export type {
  MemoryAuthorityEnumeration,
  MemoryDerivedIndexBackend,
  MemoryDerivedIndexRebuildResult,
  MemoryDerivedIndexVersion,
} from '../contract/derived-index'
export {
  formatMemoryDerivedIndexVersion,
  isMemoryDerivedIndexBackend,
  resolveAuthorityEnumeration,
} from '../contract/derived-index'
export type {
  MemoryApi,
  MemoryDatabaseProvider,
  MemorySessionLineageContext,
  MemoryToolContext,
  MemoryTreeRuntimeProviders,
  ToolContext,
  VelaTool,
} from '../contract/requires'
export type {
  LayeredMemoryStoreBackend,
  LayeredMemoryStoreBackendOptions,
  MemoryDerivedIndexFailure,
} from '../impl/backends/LayeredMemoryStore'
export { createLayeredMemoryStoreBackend } from '../impl/backends/LayeredMemoryStore'
export type { MemoryTreeStoreDomain } from '../impl/backends/MemoryTreeStoreBackend'
export { createMemoryTreeStoreBackend, MemoryTreeBackendId } from '../impl/backends/MemoryTreeStoreBackend'
export { MemoryDream } from '../impl/tree/MemoryDream'
export { MemoryTreeDomain as MemoryDomain, MemoryTreeDomain } from '../impl/tree/MemoryTreeDomain'
export { MemoryTreeRecall } from '../impl/tree/MemoryTreeRecall'
export { MemoryTreeRepository } from '../impl/tree/MemoryTreeRepository'
export { createMemoryRuntime, DefaultMemoryRuntime, MemoryRuntime } from '../impl/tree/MemoryTreeRuntime'
export type {
  MemoryCaptureBatchResult,
  MemoryCaptureResult,
  MemoryConceptType,
  MemoryDreamRunOptions,
  MemoryDreamRunResult,
  MemoryEvidenceCategory,
  MemoryEvidenceEligibilityResult,
  MemoryEvidenceEligibilityState,
  MemoryEvidenceInput,
  MemoryEvidenceRecord,
  MemoryEvidenceSourceType,
  MemoryEvidenceTrustLevel,
  MemoryForgetResult,
  MemoryPrivacyClass,
  MemoryRecallItem,
  MemoryRecallOptions,
  MemoryScopeType,
  MemorySourceEligibilityResult,
  MemoryTreeDiagnostics,
  MemoryTreeIntegrityReport,
  MemoryTreeNodeRecord,
  MemoryTreePathNode,
  MemoryTreeSnapshotRecord,
  MemoryTreeState,
} from '../types/memory'
export type {
  MemoryScopeId,
  MemoryScopeSelectorInput,
  MemoryScopeTarget,
  MemoryScopeVisibilityInput,
} from '../utils/scope'
export {
  buildProjectMemoryScope,
  buildSiteMemoryScope,
  GLOBAL_MEMORY_SCOPE,
  isMemoryVisibleInScope,
  resolveMemoryScopeFilterValue,
  resolveMemoryScopeSelector,
  scopeTypeForScopeId,
  SYSTEM_MEMORY_SCOPE,
} from '../utils/scope'
export { applyMemoryTreeSchema, MemoryTreeSchemaSql } from '../utils/tree/schema'

export const memoryTools = structureToolDescriptionsForCategory(rawMemoryTools, 'memory')
