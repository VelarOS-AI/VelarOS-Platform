/**
 * 可在浏览器中安全使用的记忆数据类型与约定的常量表。
 *
 * 本入口只有可移植数据：`types/memory.ts` 的数据类型与 `contract/constants.ts` 的常量表；
 * 存储、`SQLite`、工具和运行时实现仍由包根入口提供。
 */
export * from '../contract/constants.js'
export type {
  MemoryBackendAwaitable,
  MemoryBackendCapabilities,
  MemoryBackendCaptureBatchOptions,
  MemoryBackendDescriptor,
  MemoryBackendRole,
  MemoryBackendStats,
  MemoryCaptureBatchResult,
  MemoryCaptureResult,
  MemoryConceptType,
  MemoryDerivedIndexRebuildResult,
  MemoryDerivedIndexVersion,
  MemoryDreamRunOptions,
  MemoryDreamRunResult,
  MemoryEvidenceCategory,
  MemoryEvidenceEligibilityResult,
  MemoryEvidenceEligibilityState,
  MemoryEvidenceInput,
  MemoryEvidenceRecord,
  MemoryEvidenceSourceType,
  MemoryEvidenceTrustLevel,
  MemoryFilesScopeRoot,
  MemoryForgetResult,
  MemoryPrivacyClass,
  MemoryRecallItem,
  MemoryRecallOptions,
  MemoryScopeId,
  MemoryScopeSelectorInput,
  MemoryScopeTarget,
  MemoryScopeType,
  MemoryScopeVisibilityInput,
  MemorySessionLineageContext,
  MemorySourceEligibilityResult,
  MemoryTreeDiagnostics,
  MemoryTreeIntegrityReport,
  MemoryTreeNodeRecord,
  MemoryTreePathNode,
  MemoryTreeSnapshotRecord,
  MemoryTreeState,
  MemoryVectorIndexRecord,
} from '../types/memory.js'
