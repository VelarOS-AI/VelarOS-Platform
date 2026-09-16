import { AppError } from '@velaros-ai/core/error'

import type {
  MemoryDreamEvidenceDescriptorV2,
  MemoryDreamEvidenceRowV2,
  MemoryDreamValidationStatsV2,
} from '../../types/tree-v2/dream'

import { assertNonNegativeSafeIntegerV2 } from './checks'

/**
 * 整理运行账本的纯判据：行映射与候选统计自检。
 */

/** 把一行证据映射成批次里的描述（不解密，只搬引用）。 */
export function mapDreamEvidenceV2(
  row: MemoryDreamEvidenceRowV2
): MemoryDreamEvidenceDescriptorV2 {
  return {
    id: row.id,
    ingestSequence: row.ingest_sequence,
    eligibilityState: row.eligibility_state,
    payloadBlobRef: row.payload_blob_ref,
    payloadCommitment: row.payload_commitment,
    metadataBlobRef: row.metadata_blob_ref,
    metadataCommitment: row.metadata_commitment,
  }
}

/** 校验候选统计：四个数都是非负安全整数，且接受数加拒绝数等于候选数。 */
export function validateDreamStatsV2(stats: MemoryDreamValidationStatsV2): void {
  assertNonNegativeSafeIntegerV2(stats.tokenUsage, 'tokenUsage')
  assertNonNegativeSafeIntegerV2(stats.candidateCount, 'candidateCount')
  assertNonNegativeSafeIntegerV2(stats.acceptedCount, 'acceptedCount')
  assertNonNegativeSafeIntegerV2(stats.rejectedCount, 'rejectedCount')
  if (stats.acceptedCount + stats.rejectedCount !== stats.candidateCount) {
    throw new AppError('VALIDATION', 'candidate 统计不守恒。')
  }
}
