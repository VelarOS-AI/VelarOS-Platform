import { structureToolDescriptionsForCategory } from '@velaros-ai/agent/tool-contract'

import { memoryTools as rawMemoryTools } from './tools/memory/Memory.tool'

export type {
  MemoryBackendAwaitable,
  MemoryBackendCaptureBatchOptions,
  MemoryBackendDescriptor,
  MemoryBackendRole,
  MemoryBackendStats,
  MemoryBackendVerb,
  MemoryStoreBackend,
} from './backend/Contract'
export {
  listMissingAuthorityMemoryVerbs,
  RequiredAuthorityMemoryVerbs,
  supportsMemoryBackendVerb,
} from './backend/Contract'
export type {
  MemoryAuthorityEnumeration,
  MemoryDerivedIndexBackend,
  MemoryDerivedIndexRebuildResult,
  MemoryDerivedIndexVersion,
} from './backend/DerivedIndex'
export {
  formatMemoryDerivedIndexVersion,
  isMemoryDerivedIndexBackend,
  resolveAuthorityEnumeration,
} from './backend/DerivedIndex'
export type {
  LayeredMemoryStoreBackend,
  LayeredMemoryStoreBackendOptions,
  MemoryDerivedIndexFailure,
} from './backend/Layered'
export { createLayeredMemoryStoreBackend } from './backend/Layered'
export type { MemoryTreeStoreDomain } from './backend/TreeStoreBackend'
export { createMemoryTreeStoreBackend, MemoryTreeBackendId } from './backend/TreeStoreBackend'
export { MemoryDream } from './memory-tree/Dream'
export { MemoryTreeRecall } from './memory-tree/Recall'
export { MemoryTreeRepository } from './memory-tree/Repository'
export { applyMemoryTreeSchema, MemoryTreeSchemaSql } from './memory-tree/schema/MemoryTreeSchema'
export { MemoryTreeDomain as MemoryDomain, MemoryTreeDomain } from './memory-tree/Service'
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
} from './memory-tree/Types'
export type {
  MemoryAuthorityMigrationHooksV2,
  MemoryAuthorityOpenReportV2,
  OpenMemoryAuthorityOptionsV2,
  OpenMemoryAuthorityResultV2,
} from './memory-tree/v2/AuthorityDatabase'
export {
  assertMemoryAuthoritySchemaV2,
  MemoryAuthorityDatabaseV2,
  openMemoryAuthorityV2,
} from './memory-tree/v2/AuthorityDatabase'
export {
  applyMemoryAuthorityEvidenceReplayMigrationV2,
  applyMemoryAuthorityMeaningEvidenceMigrationV2,
  applyMemoryAuthoritySchemaV2,
  MemoryAuthorityApplicationIdV2,
  MemoryAuthorityBlindIndexColumnsV2,
  MemoryAuthorityEncryptedContentColumnsV2,
  MemoryAuthorityEvidenceReplayMigrationIdV2,
  MemoryAuthorityEvidenceReplayMigrationSqlV2,
  MemoryAuthorityForbiddenPlaintextColumnsV2,
  MemoryAuthorityMeaningEvidenceMigrationIdV2,
  MemoryAuthorityMeaningEvidenceMigrationSqlV2,
  MemoryAuthorityMigrationIdV2,
  MemoryAuthoritySchemaSqlV2,
  MemoryAuthoritySchemaVersionV2,
} from './memory-tree/v2/AuthoritySchema'
export type {
  MemoryTreeContentRefV2,
  MemoryTreeDiffOpTypeV2,
  MemoryTreeDiffOpV2,
  MemoryTreeDiffV2,
  MemoryTreeNodeStructV2,
  MemoryTreeReplayResultV2,
  MemoryTreeVisibilityStateV2,
} from './memory-tree/v2/DiffChain'
export {
  applyTreeDiffOpV2,
  assertForwardReplayResultForPersistenceV2,
  buildBasicTreeDiffOpsV2,
  buildRedactTreeDiffOpV2,
  canonicalStringifyV2,
  hashTreeBaseEventV2,
  hashTreeEventV2,
  hashTreeStateV2,
  invertTreeDiffOpV2,
  invertTreeDiffV2,
  isMemoryTreeDiffOpV2,
  isMemoryTreeNodeStructV2,
  MemoryTreeDiffOpTypesV2,
  quantizeTreeScoreV2,
  replayTreeDiffsBackwardV2,
  replayTreeDiffsForwardV2,
  TreeDiffGenesisEventHashV2,
  validateTreeDiffOpV2,
} from './memory-tree/v2/DiffChain'
export type {
  CommitMemoryDreamTreeInputV2,
  MaterializedMemoryDreamEvidenceV2,
  MemoryDreamEvidenceDescriptorV2,
  MemoryDreamModelProfileV2,
  MemoryDreamSkippedRunV2,
  MemoryDreamStartedRunV2,
  MemoryDreamValidationStatsV2,
  StartMemoryDreamRunResultV2,
} from './memory-tree/v2/DreamRuns'
export {
  MemoryDreamPipelineVersionV2,
  MemoryDreamRunCoordinatorV2,
} from './memory-tree/v2/DreamRuns'
export type {
  MemoryErasureClosureV2,
  MemoryErasureConfirmedV2,
  MemoryErasurePreviewV2,
  MemoryErasureStatusV2,
  MemoryErasureTargetTypeV2,
  MemoryErasureTargetV2,
} from './memory-tree/v2/ErasureSaga'
export { MemoryErasureServiceV2 } from './memory-tree/v2/ErasureSaga'
export type {
  IngestMemoryEvidenceInputV2,
  MemoryEvidenceEligibilityStateV2,
  MemoryEvidenceRecordV2,
  MemoryEvidenceScopeInputV2,
  MemoryEvidenceTrustLevelV2,
  MemoryPrivacyClassV2,
  ReactivateMemoryEvidenceResultV2,
} from './memory-tree/v2/EvidenceIngest'
export { MemoryEvidenceIngestServiceV2 } from './memory-tree/v2/EvidenceIngest'
export type {
  LegacyMemoryClaimGovernanceTargetV2,
  LegacyMemoryEvidenceReaderV2,
  LegacyMemoryEvidenceRowV2,
  LegacyMemoryGovernanceRowV2,
  MemoryAuthorityCutoverDecisionV2,
  MemoryAuthorityCutoverReceiptV2,
  MemoryAuthorityUserSignoffV2,
  MemoryEvidenceParityReportV2,
  MemoryEvidenceReplayReportV2,
} from './memory-tree/v2/EvidenceReplayMigration'
export {
  computeMemoryEvidenceParityDigestV2,
  evaluateMemoryAuthorityCutoverV2,
  LegacyMemoryEvidenceSqliteReaderV2,
  MemoryEvidenceReplayMigrationV2,
} from './memory-tree/v2/EvidenceReplayMigration'
export type {
  MemoryClaimGovernanceMatchInputV2,
  MemoryClaimStableKeyInputV2,
  MemoryConceptStableKeyInputV2,
  MemoryDreamFingerprintInputV2,
  MemoryEpisodeStableKeyInputV2,
  MemoryMatchKeyPurposeV2,
} from './memory-tree/v2/IdentityKeys'
export {
  canonicalizeWorkspacePathV2,
  computeDreamInputFingerprintV2,
  MemoryIdentityKeyServiceV2,
  MemoryMatchKeyPurposesV2,
  normalizeCanonicalPathV2,
  normalizeIdentityTextV2,
  normalizeOriginV2,
  normalizeSourceReferenceV2,
} from './memory-tree/v2/IdentityKeys'
export type {
  MemoryClaimCandidateV2,
  MemoryConceptCandidateV2,
  MemoryEpisodeCandidateV2,
  MemoryIdentityCandidateV2,
  MemoryMeaningCandidateDecisionV2,
  MemoryMeaningCandidateV2,
  MemoryMeaningCurationResultV2,
  MemoryMeaningEntityKindV2,
  MemoryMeaningProposalV2,
  MemoryMeaningScopeV2,
  MemoryRelationCandidateV2,
} from './memory-tree/v2/MeaningCuration'
export { MemoryMeaningCurationServiceV2 } from './memory-tree/v2/MeaningCuration'
export type {
  MemoryQueryPathNodeV2,
  MemoryRecallIndexRefreshReportV2,
  MemoryRecallIndexStateV2,
  MemoryRecallProjectionV2,
  MemoryRecallQueryResultV2,
  MemoryRecallQueryV2,
  MemoryRecallReasonV2,
  MemoryTreeStructureNodeV2,
  MemoryTreeStructureProjectionV2,
} from './memory-tree/v2/QueryFacade'
export { MemoryQueryFacadeV2 } from './memory-tree/v2/QueryFacade'
export type { StorageStepHooksV2 } from './memory-tree/v2/storage/AtomicFile'
export {
  fsyncDirectoryV2,
  invokeStorageStepV2,
  removeStaleTempFilesV2,
  StorageTempFileSuffixV2,
  writeFileAtomicV2,
} from './memory-tree/v2/storage/AtomicFile'
export {
  assertMemoryBlobIdV2,
  generateMemoryBlobIdV2,
  MemoryBlobIdPatternV2,
  MemoryBlobStoreV2,
} from './memory-tree/v2/storage/BlobStore'
export type {
  MemoryContentKeyServiceOptionsV2,
  MemorySealedContentV2,
} from './memory-tree/v2/storage/ContentKeyService'
export {
  ContentKeyServiceV2,
  createContentCommitmentV2,
} from './memory-tree/v2/storage/ContentKeyService'
export type { MemoryStorageErrorCodeV2 } from './memory-tree/v2/storage/ErrorCodes'
export { MemoryStorageErrorCodesV2 } from './memory-tree/v2/storage/ErrorCodes'
export type { GenerationEntryV2 } from './memory-tree/v2/storage/GenerationPointer'
export {
  commitCurrentGenerationV2,
  CurrentPointerFileNameV2,
  listGenerationEntriesV2,
  readCurrentGenerationV2,
} from './memory-tree/v2/storage/GenerationPointer'
export type {
  MemoryIndexGenerationSealReportV2,
} from './memory-tree/v2/storage/IndexGenerationStore'
export {
  MemoryIndexStoragePolicyV2,
  openCurrentMemoryIndexGenerationV2,
  pruneMemoryIndexGenerationsV2,
  sealMemoryIndexGenerationV2,
} from './memory-tree/v2/storage/IndexGenerationStore'
export type {
  MemoryKeyringOpenReportV2,
  MemoryKeyringStoreOptionsV2,
} from './memory-tree/v2/storage/Keyring'
export { MemoryKeyringStoreV2 } from './memory-tree/v2/storage/Keyring'
export type {
  MemoryPhysicalRootsOpenReportV2,
  MemoryPhysicalRootsV2,
} from './memory-tree/v2/storage/PhysicalRoots'
export {
  BackupSnapshotNamePatternV2,
  formatBackupSnapshotNameV2,
  indexGenerationDirV2,
  openMemoryPhysicalRootsV2,
  resolveMemoryPhysicalRootsV2,
} from './memory-tree/v2/storage/PhysicalRoots'
export type { MemoryWrappingRootV2 } from './memory-tree/v2/storage/WrappingRoot'
export {
  assertMemoryWrappingRootV2,
  assertRawMemoryKeyV2,
  decodeCanonicalBase64V2,
  MemoryWrappingRootIdPatternV2,
  unwrapMemoryKeyV2,
  wrapMemoryKeyV2,
} from './memory-tree/v2/storage/WrappingRoot'
export type {
  MemorySystemRuntimeOpenReportV2,
  OpenMemorySystemRuntimeOptionsV2,
} from './memory-tree/v2/SystemRuntime'
export { MemorySystemRuntimeV2, openMemorySystemRuntimeV2 } from './memory-tree/v2/SystemRuntime'
export type {
  MemoryTreeBaseHashesV2,
  MemoryTreeBaseManifestV2,
  MemoryTreeBaseStateV2,
} from './memory-tree/v2/TreeManifest'
export {
  buildMemoryTreeBaseManifestV2,
  buildMemoryTreeBaseStateV2,
  computeMemoryTreeBaseHashesV2,
  hashMemoryTreeBaseManifestV2,
  MemoryTreeBaseStateFormatV2,
  parseMemoryTreeBaseStateV2,
  validateMemoryTreeBaseStateV2,
} from './memory-tree/v2/TreeManifest'
export type {
  MemoryTreeCheckpointV2,
  MemoryTreeProjectionInspectionV2,
} from './memory-tree/v2/TreeProjectionIndex'
export {
  MemoryTreeCheckpointIntervalV2,
  MemoryTreeProjectionIndexV2,
} from './memory-tree/v2/TreeProjectionIndex'
export type {
  CommitMemoryDreamNoopInputV2,
  CommitMemoryTreeVersionInputV2,
  CommitMemoryTreeVersionResultV2,
  CompactMemoryTreeHeadInputV2,
  CompactMemoryTreeHeadResultV2,
  MemoryDreamRunCommitV2,
  MemoryTreeAuthorityCommitParticipantV2,
  MemoryTreeIdentityChangeV2,
  MemoryTreeStoreOpenReportV2,
} from './memory-tree/v2/TreeStore'
export { MemoryTreeStoreV2 } from './memory-tree/v2/TreeStore'
export type {
  MemoryScopeId,
  MemoryScopeSelectorInput,
  MemoryScopeTarget,
  MemoryScopeVisibilityInput,
} from './MemoryScope'
export {
  buildProjectMemoryScope,
  buildSiteMemoryScope,
  GLOBAL_MEMORY_SCOPE,
  isMemoryVisibleInScope,
  resolveMemoryScopeFilterValue,
  resolveMemoryScopeSelector,
  scopeTypeForScopeId,
  SYSTEM_MEMORY_SCOPE,
} from './MemoryScope'
export { createMemoryRuntime, DefaultMemoryRuntime, MemoryRuntime } from './Runtime'
export type {
  MemoryApi,
  MemoryDatabaseProvider,
  MemorySessionLineageContext,
  MemoryToolContext,
  MemoryTreeRuntimeProviders,
  ToolContext,
  VelaTool,
} from './Types'

export const memoryTools = structureToolDescriptionsForCategory(rawMemoryTools, 'memory')
