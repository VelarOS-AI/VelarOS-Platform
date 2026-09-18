import { isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  IngestMemoryEvidenceInputV2,
  MemoryEvidenceEligibilityStateV2,
  MemoryEvidenceRecordV2,
  MemoryEvidenceRowV2,
  MemoryEvidenceTrustLevelV2,
  MemoryPrivacyClassV2,
} from '../../types/tree-v2/evidence.js'

import { assertNonEmptyStringV2, assertNonNegativeSafeIntegerV2 } from './checks.js'

/**
 * 证据采集的入参校验与行映射。都是对数据做的判断，用不着实例状态。
 */

/** 允许的信任级别名单（也是落库时的 CHECK 约束）。 */
export const MemoryEvidenceTrustLevelsV2 = Object.freeze([
  'user_stated',
  'system_observed',
  'agent_derived',
  'external_content',
] as const)

/** 允许的隐私分级名单。 */
export const MemoryPrivacyClassesV2 = Object.freeze([
  'standard',
  'personal',
  'sensitive',
] as const)

/** 采集入口允许落库的可用状态；erased 是擦除 saga 的终态，不从这里进。 */
export const MemoryIngestableEligibilityStatesV2 = Object.freeze([
  'active',
  'source_deleted',
  'excluded',
] as const)

/** 判断一个字符串是不是登记在册的信任级别。 */
export function isMemoryEvidenceTrustLevelV2(
  value: string
): value is MemoryEvidenceTrustLevelV2 {
  return (MemoryEvidenceTrustLevelsV2 as readonly string[]).includes(value)
}

/** 判断一个字符串是不是登记在册的隐私分级。 */
export function isMemoryPrivacyClassV2(value: string): value is MemoryPrivacyClassV2 {
  return (MemoryPrivacyClassesV2 as readonly string[]).includes(value)
}

/** 判断一个可用状态是不是采集入口允许的。 */
export function isIngestableEligibilityStateV2(
  value: MemoryEvidenceEligibilityStateV2
): boolean {
  return (MemoryIngestableEligibilityStatesV2 as readonly string[]).includes(value)
}

/** 校验采集入参：来源、信任级别、时刻、隐私分级与可用状态都要合法。 */
export function validateIngestInputV2(input: IngestMemoryEvidenceInputV2): void {
  assertNonEmptyStringV2(input.sourceType, 'sourceType')
  assertNonEmptyStringV2(input.trustLevel, 'trustLevel')
  if (!isMemoryEvidenceTrustLevelV2(input.trustLevel)) {
    throw new AppError('VALIDATION', 'trustLevel 非法。')
  }
  assertNonNegativeSafeIntegerV2(input.occurredAt, 'occurredAt')
  if (!isMemoryPrivacyClassV2(input.privacyClass)) {
    throw new AppError('VALIDATION', 'privacyClass 非法。')
  }
  if (!isUndefined(input.eligibilityState) && !isIngestableEligibilityStateV2(input.eligibilityState)) {
    throw new AppError('VALIDATION', 'eligibilityState 非法。')
  }
}

/** 把一行证据映射成对外记录；未擦除的行缺 payload blob 就是不变量破坏。 */
export function mapEvidenceRowV2(row: MemoryEvidenceRowV2): MemoryEvidenceRecordV2 {
  if (!row.payload_blob_ref || !row.payload_commitment) {
    throw new AppError('INVARIANT', '未擦除 Evidence 缺少 payload blob。')
  }
  return {
    id: row.id,
    ingestSequence: row.ingest_sequence,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceMatchKey: row.source_match_key,
    sessionId: row.session_id,
    executionId: row.execution_id,
    scopeType: row.scope_type,
    scopeMatchKey: row.scope_match_key,
    occurredAt: row.occurred_at,
    payloadBlobRef: row.payload_blob_ref,
    payloadCommitment: row.payload_commitment,
    metadataBlobRef: row.metadata_blob_ref,
    metadataCommitment: row.metadata_commitment,
    privacyClass: row.privacy_class,
    eligibilityState: row.eligibility_state,
    createdAt: row.created_at,
  }
}
