import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'

import { AppError, isEmpty, isNotNull, isPlainObject, isString } from '@velaros-ai/core'

import type { MemorySqliteDatabaseV2 } from '../../types/tree-v2/authority'
import type {
  EvaluateMemoryAuthorityCutoverInputV2,
  LegacyMemoryClaimGovernanceTargetV2,
  LegacyMemoryEvidenceRowV2,
  MemoryAuthorityCutoverDecisionV2,
  MemoryAuthorityCutoverReceiptV2,
  MemoryAuthorityUserSignoffV2,
  MemoryEvidenceEligibilityStateV2,
  MemoryEvidenceParityReportV2,
  MemoryEvidenceTrustLevelV2,
  MemoryGovernanceIdentityKeysV2,
  MemoryPrivacyClassV2,
  NormalizedLegacyEvidenceV2,
  ParsedLegacyMetadataV2,
  ResolvedLegacyGovernanceTargetV2,
  ResolvedLegacyScopeV2,
} from '../../types/tree-v2/evidence'

import { canonicalStringifyV2 } from './diff-chain'
import { isMemoryEvidenceTrustLevelV2, isMemoryPrivacyClassV2 } from './evidence-ingest'
import { canonicalizeWorkspacePathV2, normalizeOriginV2 } from './identity-keys'

/**
 * 旧库证据重灌的纯判据：旧行归一化、旧作用域降级、摘要计算与切权判定。
 * 旧库永远只读，这里的函数一条写语句都没有。
 */

/** 旧库身份的形态：`sha256:` 加 64 位小写 hex。 */
export const SourceDatabaseIdPatternV2 = /^sha256:[0-9a-f]{64}$/

/** 旧来源类型的形态；不合规的一律折成 legacy_import。 */
export const LegacySourceTypePatternV2 = /^[a-z][a-z0-9_-]{0,31}$/

/** 摘要的形态：64 位小写 hex。 */
export const VerificationDigestPatternV2 = /^[0-9a-f]{64}$/

/** 重灌时允许原样保留的可用状态；别的一律折成 excluded。 */
export const ReplayableEligibilityStatesV2 = new Set<MemoryEvidenceEligibilityStateV2>([
  'active',
  'source_deleted',
  'excluded',
  'erased',
])

/** 逐条映射核对结果摘要的域分隔串。 */
export const EvidenceReplayMappingsDomainV2 = 'velaros.memory.evidence-replay-mappings.v2'

/** 治理账本摘要的域分隔串。 */
export const EvidenceReplayGovernanceDomainV2 = 'velaros.memory.evidence-replay-governance.v2'

/** 整份对账报告摘要的域分隔串。 */
export const EvidenceReplayVerificationDomainV2 =
  'velaros.memory.evidence-replay-verification.v2'

/** 旧库身份必须是旧库文件的 SHA-256；不是就拒绝往下走。 */
export function assertSourceDatabaseIdV2(value: string): void {
  if (!SourceDatabaseIdPatternV2.test(value)) {
    throw new AppError('VALIDATION', 'sourceDatabaseId 必须是旧库文件的 SHA-256 身份。')
  }
}

/** 旧库有没有这张表。 */
export function hasLegacyTableV2(database: MemorySqliteDatabaseV2, table: string): boolean {
  return Boolean(
    database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)
  )
}

/** 核对旧库的 memory_evidence 有没有全部必需列；缺列就拒绝猜测迁移来源。 */
export function assertLegacyEvidenceSchemaV2(database: MemorySqliteDatabaseV2): void {
  if (!hasLegacyTableV2(database, 'memory_evidence')) {
    throw new AppError('VALIDATION', '旧数据库缺少 memory_evidence，拒绝猜测迁移来源。')
  }
  const columns = new Set(
    (database.pragma('table_info(memory_evidence)') as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  const required = [
    'id',
    'source_type',
    'trust_level',
    'source_id',
    'session_id',
    'execution_id',
    'workspace_root',
    'scope_type',
    'scope_id',
    'occurred_at',
    'title',
    'content',
    'category',
    'privacy_class',
    'eligibility_state',
    'metadata_json',
    'ingest_sequence',
    'created_at',
  ]
  if (required.some((column) => !columns.has(column))) {
    throw new AppError('VALIDATION', '旧 memory_evidence schema 不受支持。')
  }
}

/** 把旧库一行原始数据映射成强类型的旧证据；列类型不对就是旧库被动过。 */
export function mapLegacyEvidenceRowV2(row: Record<string, unknown>): LegacyMemoryEvidenceRowV2 {
  const text = (key: string): string => {
    const value = row[key]
    if (!isString(value)) {
      throw new AppError('INVARIANT', `旧 Evidence ${key} 不是字符串。`)
    }
    return value
  }
  const integer = (key: string): number => {
    const value = row[key]
    if (!Number.isSafeInteger(value)) {
      throw new AppError('INVARIANT', `旧 Evidence ${key} 不是安全整数。`)
    }
    return value as number
  }
  return {
    id: text('id'),
    sourceType: text('source_type'),
    trustLevel: text('trust_level'),
    sourceId: text('source_id'),
    sessionId: text('session_id'),
    executionId: text('execution_id'),
    workspaceRoot: text('workspace_root'),
    scopeType: text('scope_type'),
    scopeId: text('scope_id'),
    occurredAt: integer('occurred_at'),
    title: text('title'),
    content: text('content'),
    category: text('category'),
    privacyClass: text('privacy_class'),
    eligibilityState: text('eligibility_state'),
    metadataJson: text('metadata_json'),
    ingestSequence: integer('ingest_sequence'),
    createdAt: integer('created_at'),
  }
}

/** 核对旧证据的 id 唯一、采集序号严格递增；不满足就不许重灌。 */
export function validateLegacyEvidenceSequenceV2(
  rows: readonly LegacyMemoryEvidenceRowV2[]
): readonly LegacyMemoryEvidenceRowV2[] {
  const ids = new Set<string>()
  let prior = 0
  for (const row of rows) {
    if (!row.id || ids.has(row.id)) {
      throw new AppError('INVARIANT', '旧 Evidence id 缺失或重复。')
    }
    if (!Number.isSafeInteger(row.ingestSequence) || row.ingestSequence <= prior) {
      throw new AppError('INVARIANT', '旧 Evidence ingest_sequence 必须严格递增。')
    }
    ids.add(row.id)
    prior = row.ingestSequence
  }
  return rows
}

/** 把一条旧证据归一化成新采集入参，并把这一路的降级都记成已知损耗理由码。 */
export function normalizeLegacyEvidenceV2(
  row: LegacyMemoryEvidenceRowV2
): NormalizedLegacyEvidenceV2 {
  const scope = resolveLegacyScopeV2(row)
  const metadata = parseLegacyMetadataV2(row.metadataJson)
  const knownLossReasons = [
    scope.degradedReason,
    metadata.parsed ? null : 'metadata_json_invalid',
    isMemoryEvidenceTrustLevelV2(row.trustLevel)
      ? null
      : 'trust_level_invalid_defaulted_to_external_content',
    isMemoryPrivacyClassV2(row.privacyClass)
      ? null
      : 'privacy_class_invalid_defaulted_to_sensitive',
    LegacySourceTypePatternV2.test(row.sourceType)
      ? null
      : 'source_type_invalid_defaulted_to_legacy_import',
  ].filter((reason): reason is string => isNotNull(reason))
  return {
    input: {
      sourceType: normalizeLegacySourceTypeV2(row.sourceType),
      trustLevel: normalizeLegacyTrustV2(row.trustLevel),
      sourceId: row.id,
      sessionId: row.sessionId || null,
      executionId: row.executionId || null,
      scope: scope.scope,
      occurredAt: row.occurredAt,
      payload: row.content,
      metadata: {
        category: row.category,
        legacyMetadata: metadata.value,
        legacySourceId: row.sourceId,
        legacyScopeId: row.scopeId,
        legacyScopeType: row.scopeType,
        legacyTitle: row.title,
        legacyWorkspaceRoot: row.workspaceRoot,
        metadataParseState: metadata.parsed ? 'parsed' : 'invalid_json',
      },
      privacyClass: normalizeLegacyPrivacyV2(row.privacyClass),
      eligibilityState: normalizeLegacyEligibilityV2(row.eligibilityState) as Exclude<
        MemoryEvidenceEligibilityStateV2,
        'erased'
      >,
      createdAt: row.createdAt,
    },
    knownLossReasons,
  }
}

/** 旧作用域解析成新作用域：路径解不开或站点不是 URL 一律退成 global，并记损耗。 */
export function resolveLegacyScopeV2(row: LegacyMemoryEvidenceRowV2): ResolvedLegacyScopeV2 {
  if (row.workspaceRoot) {
    if (existsSync(row.workspaceRoot)) return { scope: { type: 'workspace', rootPath: row.workspaceRoot }, degradedReason: null }
    return { scope: { type: 'global' }, degradedReason: 'workspace_path_unresolvable' }
  }
  if (row.scopeType === 'site' || row.scopeType === 'origin') {
    try {
      const origin = new URL(row.scopeId).origin
      if (origin !== 'null') return { scope: { type: 'origin', origin }, degradedReason: null }
    } catch {
      // arch-guard:silent-catch-ok 遗留 site scope 不是 URL 时退为 global，并记录已知损耗。
    }
    return { scope: { type: 'global' }, degradedReason: 'site_origin_unresolvable' }
  }
  return {
    scope: { type: 'global' },
    degradedReason: row.scopeType === 'global' ? null : 'legacy_scope_unknown_flattened',
  }
}

/** 旧可用状态不在名单里就折成 excluded。 */
export function normalizeLegacyEligibilityV2(value: string): MemoryEvidenceEligibilityStateV2 {
  return ReplayableEligibilityStatesV2.has(value as MemoryEvidenceEligibilityStateV2)
    ? (value as MemoryEvidenceEligibilityStateV2)
    : 'excluded'
}

/** 旧信任级别不在名单里就折成 external_content（最低信任）。 */
export function normalizeLegacyTrustV2(value: string): MemoryEvidenceTrustLevelV2 {
  return isMemoryEvidenceTrustLevelV2(value) ? value : 'external_content'
}

/** 旧隐私分级不在名单里就折成 sensitive（最保守）。 */
export function normalizeLegacyPrivacyV2(value: string): MemoryPrivacyClassV2 {
  return isMemoryPrivacyClassV2(value) ? value : 'sensitive'
}

/** 旧来源类型形态不合规就折成 legacy_import。 */
export function normalizeLegacySourceTypeV2(value: string): string {
  return LegacySourceTypePatternV2.test(value) ? value : 'legacy_import'
}

/** 旧元数据 JSON 坏了不阻断正文重放，只记一条损耗。 */
export function parseLegacyMetadataV2(raw: string): ParsedLegacyMetadataV2 {
  try {
    const value: unknown = JSON.parse(raw)
    if (isPlainObject(value)) return { value, parsed: true }
  } catch {
    // arch-guard:silent-catch-ok 返回 parsed=false，由调用方记录损耗；坏 metadata 不阻断正文重放。
  }
  return { value: {}, parsed: false }
}

/**
 * 把旧库的治理目标解析成新库的治理匹配键。
 * 身份不全、作用域不支持或解不开、值不是 JSON，都返回 null 匹配键加一个明确的理由码。
 */
export function resolveLegacyGovernanceTargetV2(
  target: Nullable<LegacyMemoryClaimGovernanceTargetV2>,
  identityKeys: MemoryGovernanceIdentityKeysV2
): ResolvedLegacyGovernanceTargetV2 {
  if (!target) return { matchKey: null, reasonCode: 'legacy_governance_target_missing' }
  if (!target.conceptType || !target.conceptName || !target.predicate) return { matchKey: null, reasonCode: 'legacy_governance_identity_incomplete' }
  let scopeType: 'global' | 'workspace' | 'origin'
  let scopeId: string
  try {
    if (target.conceptScopeType === 'global') {
      scopeType = 'global'
      scopeId = 'global'
    } else if (target.conceptScopeType === 'workspace') {
      scopeType = 'workspace'
      scopeId = canonicalizeWorkspacePathV2(target.conceptScopeId)
    } else if (target.conceptScopeType === 'site' || target.conceptScopeType === 'origin') {
      scopeType = 'origin'
      scopeId = normalizeOriginV2(target.conceptScopeId)
    } else {
      return { matchKey: null, reasonCode: 'legacy_governance_scope_unsupported' }
    }
  } catch {
    // arch-guard:silent-catch-ok 遗留 scope 不可解析时返回明确的 reasonCode，继续处理其他证据。
    return { matchKey: null, reasonCode: 'legacy_governance_scope_unresolvable' }
  }
  let value: unknown
  try {
    value = JSON.parse(target.valueJson) as unknown
  } catch {
    // arch-guard:silent-catch-ok 遗留治理值不是 JSON 时返回明确的 reasonCode，继续处理其他证据。
    return { matchKey: null, reasonCode: 'legacy_governance_value_invalid' }
  }
  return {
    matchKey: identityKeys.claimGovernanceMatchKey({
      conceptStableKey: identityKeys.conceptStableKey({
        conceptType: target.conceptType,
        scopeType,
        scopeId,
        discriminator: target.conceptName,
      }),
      predicate: target.predicate,
      content: canonicalStringifyV2(value),
    }),
    reasonCode: null,
  }
}

/** 算整份对账报告的摘要：真机回执与用户签字都签它。 */
export function computeMemoryEvidenceParityDigestV2(
  report: Omit<MemoryEvidenceParityReportV2, 'verificationDigest'>
): string {
  return createHash('sha256')
    .update(
      canonicalStringifyV2({ domain: EvidenceReplayVerificationDomainV2, report }),
      'utf8'
    )
    .digest('hex')
}

/**
 * 判定能不能把权威切到 v2：对账全过、真机回执与用户签字齐备，且两份签名都签的是同一份摘要。
 * 差哪几项都列在 missing 里，不给模糊的"大概可以"。
 */
export function evaluateMemoryAuthorityCutoverV2(
  input: EvaluateMemoryAuthorityCutoverInputV2
): MemoryAuthorityCutoverDecisionV2 {
  const missing: Array<MemoryAuthorityCutoverDecisionV2['missing'][number]> = []
  const { verificationDigest, ...unsignedReport } = input.report
  const reportDigestValid =
    VerificationDigestPatternV2.test(input.report.mappingDigest) &&
    VerificationDigestPatternV2.test(input.report.governanceDigest) &&
    verificationDigest === computeMemoryEvidenceParityDigestV2(unsignedReport)
  if (
    !reportDigestValid ||
    input.report.payloadMismatchCount > 0 ||
    input.report.missingMappingCount > 0 ||
    input.report.orderMismatchCount > 0 ||
    input.report.eligibilityMismatchCount > 0 ||
    input.report.ledgerCount !== input.report.sourceEvidenceCount
  ) {
    missing.push('parity')
  }
  const trueDeviceReceipt = isValidCutoverAttestationV2(input.trueDeviceReceipt)
    ? input.trueDeviceReceipt
    : null
  const userSignoff = isValidCutoverAttestationV2(input.userSignoff) ? input.userSignoff : null
  if (!trueDeviceReceipt) missing.push('true_device_verification')
  if (!userSignoff) missing.push('user_signoff')
  if (
    (trueDeviceReceipt &&
      trueDeviceReceipt.verificationDigest !== input.report.verificationDigest) ||
    (userSignoff && userSignoff.verificationDigest !== input.report.verificationDigest)
  ) {
    missing.push('digest_mismatch')
  }
  return { ready: isEmpty(missing), missing }
}

/** 一份切权凭据要有合法摘要、非负时刻与非空 id 才算数。 */
export function isValidCutoverAttestationV2(
  input: LooseOptional<MemoryAuthorityCutoverReceiptV2 | MemoryAuthorityUserSignoffV2>
): input is MemoryAuthorityCutoverReceiptV2 | MemoryAuthorityUserSignoffV2 {
  if (!input || !VerificationDigestPatternV2.test(input.verificationDigest)) return false
  const timestamp = 'verifiedAt' in input ? input.verifiedAt : input.confirmedAt
  const id = 'receiptId' in input ? input.receiptId : input.signoffId
  return Number.isSafeInteger(timestamp) && timestamp >= 0 && !isEmpty(id)
}
