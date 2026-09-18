/**
 * 可移植数据入口（`@velaros-ai/velar/memory/contracts`）：约定的常量表、记忆的数据类型、`velar:memory` 的入参与回执，
 * 以及随包发布的模型面（`VelarMemoryModule`：模块名、方法、生成的完整声明），空间挂它时交给代码面的门。
 *
 * 只有可移植数据，浏览器与渲染进程都能加载；存储、SQLite 与运行时实现由根入口提供。
 */
export * from './contract/constants.js'
export { VelarMemoryModule } from './contract/surface.js'
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
} from './types/memory.js'
export type {
  MemoryArchived,
  MemoryFound,
  MemoryIdInput,
  MemoryItem,
  MemoryKind,
  MemorySaved,
  MemorySaveInput,
  MemorySearchInput,
} from './types/memory.js'
