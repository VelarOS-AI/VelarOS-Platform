/**
 * 可在浏览器中安全使用的记忆数据传输对象与宿主契约。
 *
 * 本入口只导出类型；存储、`SQLite`、工具和运行时实现仍由包根入口提供。
 */
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
} from './memory-tree/Types.js'
