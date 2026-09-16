/**
 * 记忆树 v2 的证据与身份键数据形状：采集入参、证据记录、权威行，以及各类稳定键的输入。
 * 树 v2 是包内子系统，这些类型不出包。
 */

/** 盲索引匹配键的用途。与 `utils/tree-v2/identity-keys.ts` 的名单一一对应。 */
export type MemoryMatchKeyPurposeV2 = 'concept-name' | 'concept-alias' | 'scope' | 'source-ref'

/** 一条证据的可用状态；erased 是终态，不得复活。 */
export type MemoryEvidenceEligibilityStateV2 = 'active' | 'source_deleted' | 'excluded' | 'erased'

/** 一条证据的隐私分级。 */
export type MemoryPrivacyClassV2 = 'standard' | 'personal' | 'sensitive'

/** 一条证据的信任级别。 */
export type MemoryEvidenceTrustLevelV2 =
  | 'user_stated'
  | 'system_observed'
  | 'agent_derived'
  | 'external_content'

/** 采集时给的作用域：全局、某个工作区根，或某个站点源。 */
export type MemoryEvidenceScopeInputV2 =
  | { readonly type: 'global' }
  | { readonly type: 'workspace'; readonly rootPath: string }
  | { readonly type: 'origin'; readonly origin: string }

/** 作用域解析后的结果：落库的类型名与盲索引键。 */
export interface MemoryResolvedEvidenceScopeV2 {
  /** 作用域类型：global / workspace / origin。 */
  readonly scopeType: string
  /** 作用域盲索引键；global 没有键。 */
  readonly scopeMatchKey: Nullable<string>
}

/** 采集一条证据的入参。 */
export interface IngestMemoryEvidenceInputV2 {
  /** 来源类型（宿主自定义的短标识）。 */
  readonly sourceType: string
  /** 信任级别。 */
  readonly trustLevel: MemoryEvidenceTrustLevelV2
  /** 来源在宿主那边的 id。 */
  readonly sourceId?: LooseOptional<string>
  /** 来源引用（URL）；给了就派生来源盲索引键。 */
  readonly sourceReference?: LooseOptional<string>
  /** 产生这条证据的会话 id。 */
  readonly sessionId?: LooseOptional<string>
  /** 产生这条证据的执行 id。 */
  readonly executionId?: LooseOptional<string>
  /** 这条证据属于哪个作用域。 */
  readonly scope: MemoryEvidenceScopeInputV2
  /** 事件发生时刻（毫秒）。 */
  readonly occurredAt: number
  /** 语义正文；封成密文后只留引用与承诺。 */
  readonly payload: Buffer | string
  /** 附带的结构化元数据；封成第二个密文 blob。 */
  readonly metadata?: unknown
  /** 隐私分级。 */
  readonly privacyClass: MemoryPrivacyClassV2
  /** 落库时的可用状态；不给按 active。erased 不能从这里进。 */
  readonly eligibilityState?: Exclude<MemoryEvidenceEligibilityStateV2, 'erased'>
  /** 落库时刻（毫秒）；不给用 Date.now。 */
  readonly createdAt?: number
}

/** 一条落库后的证据（只带引用与承诺，不带明文）。 */
export interface MemoryEvidenceRecordV2 {
  /** 证据 id。 */
  readonly id: string
  /** 全局递增的采集序号。 */
  readonly ingestSequence: number
  /** 来源类型。 */
  readonly sourceType: string
  /** 来源在宿主那边的 id。 */
  readonly sourceId: Nullable<string>
  /** 来源引用的盲索引键。 */
  readonly sourceMatchKey: Nullable<string>
  /** 会话 id。 */
  readonly sessionId: Nullable<string>
  /** 执行 id。 */
  readonly executionId: Nullable<string>
  /** 作用域类型。 */
  readonly scopeType: string
  /** 作用域盲索引键。 */
  readonly scopeMatchKey: Nullable<string>
  /** 事件发生时刻（毫秒）。 */
  readonly occurredAt: number
  /** 正文密文引用。 */
  readonly payloadBlobRef: string
  /** 正文承诺。 */
  readonly payloadCommitment: string
  /** 元数据密文引用。 */
  readonly metadataBlobRef: Nullable<string>
  /** 元数据承诺。 */
  readonly metadataCommitment: Nullable<string>
  /** 隐私分级。 */
  readonly privacyClass: MemoryPrivacyClassV2
  /** 可用状态。 */
  readonly eligibilityState: MemoryEvidenceEligibilityStateV2
  /** 落库时刻（毫秒）。 */
  readonly createdAt: number
}

/** 恢复一条证据的结果：原地翻活还是重新采集成新序号。 */
export interface ReactivateMemoryEvidenceResultV2 {
  /** in_place = 原地改状态；reingested = 解密重封成一条新证据。 */
  readonly mode: 'in_place' | 'reingested'
  /** 恢复后的证据记录。 */
  readonly evidence: MemoryEvidenceRecordV2
}

/** `memory_evidence` 的行形状。 */
export interface MemoryEvidenceRowV2 {
  /** 证据 id。 */
  id: string
  /** 采集序号。 */
  ingest_sequence: number
  /** 来源类型。 */
  source_type: string
  /** 来源 id。 */
  source_id: Nullable<string>
  /** 来源盲索引键。 */
  source_match_key: Nullable<string>
  /** 会话 id。 */
  session_id: Nullable<string>
  /** 执行 id。 */
  execution_id: Nullable<string>
  /** 作用域类型。 */
  scope_type: string
  /** 作用域盲索引键。 */
  scope_match_key: Nullable<string>
  /** 事件发生时刻（毫秒）。 */
  occurred_at: number
  /** 正文密文引用。 */
  payload_blob_ref: Nullable<string>
  /** 正文承诺。 */
  payload_commitment: Nullable<string>
  /** 元数据密文引用。 */
  metadata_blob_ref: Nullable<string>
  /** 元数据承诺。 */
  metadata_commitment: Nullable<string>
  /** 隐私分级。 */
  privacy_class: MemoryPrivacyClassV2
  /** 可用状态。 */
  eligibility_state: MemoryEvidenceEligibilityStateV2
  /** 落库时刻（毫秒）。 */
  created_at: number
}

/** 只取 blob id 那一列的行形状。 */
export interface MemoryBlobIdRowV2 {
  /** blob id。 */
  readonly blob_id: string
}

/** 只取信任级别那一列的行形状。 */
export interface MemoryTrustLevelRowV2 {
  /** 信任级别的原始字符串。 */
  readonly trust_level: string
}

/** 整理运行输入指纹的计算材料。 */
export interface MemoryDreamFingerprintInputV2 {
  /** 这次运行开始时消化到的证据序号。 */
  readonly frontierBefore: number
  /** 这次运行要消化的证据 id，按给定顺序。 */
  readonly evidenceIds: readonly string[]
  /** 用了哪个模型（provider 与 model 可为空）。 */
  readonly modelProfile: {
    /** 模型提供方。 */
    readonly provider: Nullable<string>
    /** 模型 id。 */
    readonly model: Nullable<string>
  }
  /** 整理管线的版本号。 */
  readonly pipelineVersion: number
}

/** 概念稳定键的计算材料。 */
export interface MemoryConceptStableKeyInputV2 {
  /** 概念类型。 */
  readonly conceptType: string
  /** 作用域类型。 */
  readonly scopeType: string
  /** 作用域 id。 */
  readonly scopeId: string
  /** 同类同作用域下的区分串（会经身份文本归一化）。 */
  readonly discriminator: string
}

/** 情节稳定键的计算材料。 */
export interface MemoryEpisodeStableKeyInputV2 {
  /** 作用域类型。 */
  readonly scopeType: string
  /** 作用域 id。 */
  readonly scopeId: string
  /** 挂在哪个概念下。 */
  readonly conceptStableKey: string
  /** 这一串情节的根标识。 */
  readonly episodeRoot: string
  /** 情节阶段（会经身份文本归一化）。 */
  readonly phase: string
}

/** 主张稳定键的计算材料。 */
export interface MemoryClaimStableKeyInputV2 {
  /** 挂在哪个概念下。 */
  readonly conceptStableKey: string
  /** 谓词。 */
  readonly predicate: string
  /** 标题（会经身份文本归一化；空串用 untitled）。 */
  readonly title: string
  /** 正文（归一化后取哈希进键）。 */
  readonly content: string
}

/** 主张分组键的计算材料。 */
export interface MemoryClaimGroupKeyInputV2 {
  /** 挂在哪个概念下。 */
  readonly conceptStableKey: string
  /** 谓词。 */
  readonly predicate: string
  /** 标题（会经身份文本归一化；空串用 untitled）。 */
  readonly title: string
}

/** 跨库治理匹配键的计算材料。 */
export interface MemoryClaimGovernanceMatchInputV2 {
  /** 挂在哪个概念下。 */
  readonly conceptStableKey: string
  /** 谓词。 */
  readonly predicate: string
  /** 正文（归一化后取哈希进键）。 */
  readonly content: string
}

/** 旧库一行证据（全部字段都按旧 schema 的明文形态给）。 */
export interface LegacyMemoryEvidenceRowV2 {
  /** 旧库里的证据 id。 */
  readonly id: string
  /** 来源类型。 */
  readonly sourceType: string
  /** 信任级别（旧值，可能不合法）。 */
  readonly trustLevel: string
  /** 来源 id。 */
  readonly sourceId: string
  /** 会话 id。 */
  readonly sessionId: string
  /** 执行 id。 */
  readonly executionId: string
  /** 工作区根路径。 */
  readonly workspaceRoot: string
  /** 作用域类型（旧值）。 */
  readonly scopeType: string
  /** 作用域 id（旧值）。 */
  readonly scopeId: string
  /** 事件发生时刻（毫秒）。 */
  readonly occurredAt: number
  /** 标题明文。 */
  readonly title: string
  /** 正文明文。 */
  readonly content: string
  /** 类别。 */
  readonly category: string
  /** 隐私分级（旧值，可能不合法）。 */
  readonly privacyClass: string
  /** 可用状态（旧值，可能不合法）。 */
  readonly eligibilityState: string
  /** 元数据 JSON（可能坏）。 */
  readonly metadataJson: string
  /** 旧库里的采集序号。 */
  readonly ingestSequence: number
  /** 落库时刻（毫秒）。 */
  readonly createdAt: number
}

/** 旧库里一条主张的治理目标（用来在新库里算治理匹配键）。 */
export interface LegacyMemoryClaimGovernanceTargetV2 {
  /** 判别字段：目前只支持主张。 */
  readonly kind: 'claim'
  /** 主体概念的类型。 */
  readonly conceptType: string
  /** 主体概念的名字。 */
  readonly conceptName: string
  /** 主体概念的作用域类型。 */
  readonly conceptScopeType: string
  /** 主体概念的作用域 id。 */
  readonly conceptScopeId: string
  /** 谓词。 */
  readonly predicate: string
  /** 主张值的 JSON。 */
  readonly valueJson: string
}

/** 旧库里一条治理裁决（遗忘、被取代、已擦除）。 */
export interface LegacyMemoryGovernanceRowV2 {
  /** 治理类型。 */
  readonly governanceType: 'forgotten' | 'superseded' | 'erased'
  /** 被治理对象在旧库里的 id。 */
  readonly legacyTargetId: string
  /** 关联的旧证据 id。 */
  readonly legacyEvidenceId: Nullable<string>
  /** 解析出来的治理目标；解析不了就是 null。 */
  readonly target: Nullable<LegacyMemoryClaimGovernanceTargetV2>
}

/** 旧库读取端口：重灌只经这个面读旧库，永远只读。 */
export interface LegacyMemoryEvidenceReaderV2 {
  /** 旧库文件的 SHA-256 身份 `sha256:<64 hex>`。 */
  readonly sourceDatabaseId: string
  /** 按旧采集序列出全部证据。 */
  listEvidence(): readonly LegacyMemoryEvidenceRowV2[]
  /** 列出旧库里的治理裁决；旧库没有相关表就返回空。 */
  listGovernance(): readonly LegacyMemoryGovernanceRowV2[]
}

/** 一次重灌的读数。 */
export interface MemoryEvidenceReplayReportV2 {
  /** 判别字段：这是执行档。 */
  readonly mode: 'apply'
  /** 旧库身份。 */
  readonly sourceDatabaseId: string
  /** 旧库里一共多少条证据。 */
  readonly sourceEvidenceCount: number
  /** 这次新灌进来多少条。 */
  readonly replayedCount: number
  /** 之前已经灌过、这次跳过多少条。 */
  readonly alreadyReplayedCount: number
  /** 以墓碑形态落下的（旧库里已擦除的）多少条。 */
  readonly tombstoneCount: number
  /** 落成 applied 的治理条数。 */
  readonly governanceAppliedCount: number
  /** 还悬着的治理条数。 */
  readonly governancePendingCount: number
  /** 记为已知损耗的条数。 */
  readonly knownLossCount: number
}

/** 一次对账的读数，连同三个摘要。 */
export interface MemoryEvidenceParityReportV2 {
  /** 判别字段：这是核对档。 */
  readonly mode: 'verify'
  /** 旧库身份。 */
  readonly sourceDatabaseId: string
  /** 旧库里一共多少条证据。 */
  readonly sourceEvidenceCount: number
  /** 重灌账本里有多少条映射。 */
  readonly ledgerCount: number
  /** 正文逐字节对上的条数。 */
  readonly payloadMatchedCount: number
  /** 正文对不上的条数。 */
  readonly payloadMismatchCount: number
  /** 缺映射或映射指向不存在的新证据的条数。 */
  readonly missingMappingCount: number
  /** 顺序对不上或出现孤儿映射的条数。 */
  readonly orderMismatchCount: number
  /** 可用状态对不上的条数。 */
  readonly eligibilityMismatchCount: number
  /** 落成 applied 的治理条数。 */
  readonly governanceAppliedCount: number
  /** 还悬着的治理条数。 */
  readonly governancePendingCount: number
  /** 记为已知损耗的条数。 */
  readonly knownLossCount: number
  /** 逐条映射核对结果的摘要。 */
  readonly mappingDigest: string
  /** 治理账本的摘要。 */
  readonly governanceDigest: string
  /** 整份报告的摘要（切权凭据就签它）。 */
  readonly verificationDigest: string
}

/** 真机验证回执。 */
export interface MemoryAuthorityCutoverReceiptV2 {
  /** 它签的那份报告摘要。 */
  readonly verificationDigest: string
  /** 验证时刻（毫秒）。 */
  readonly verifiedAt: number
  /** 回执 id。 */
  readonly receiptId: string
}

/** 用户签字确认。 */
export interface MemoryAuthorityUserSignoffV2 {
  /** 它签的那份报告摘要。 */
  readonly verificationDigest: string
  /** 确认时刻（毫秒）。 */
  readonly confirmedAt: number
  /** 签字 id。 */
  readonly signoffId: string
}

/** 能不能切权威的裁决。 */
export interface MemoryAuthorityCutoverDecisionV2 {
  /** 三项都齐才为 true。 */
  readonly ready: boolean
  /** 差哪几项。 */
  readonly missing: ReadonlyArray<
    'parity' | 'true_device_verification' | 'user_signoff' | 'digest_mismatch'
  >
}

/** 判定能不能切权威时要看的三份材料。 */
export interface EvaluateMemoryAuthorityCutoverInputV2 {
  /** 最近一次对账报告。 */
  readonly report: MemoryEvidenceParityReportV2
  /** 真机验证回执。 */
  readonly trueDeviceReceipt?: LooseOptional<MemoryAuthorityCutoverReceiptV2>
  /** 用户签字确认。 */
  readonly userSignoff?: LooseOptional<MemoryAuthorityUserSignoffV2>
}

/** 重灌账本的行形状。 */
export interface ReplayLedgerRowV2 {
  /** 旧证据 id。 */
  legacy_evidence_id: string
  /** 旧采集序号。 */
  legacy_ingest_sequence: number
  /** 新证据 id。 */
  evidence_id: string
  /** 这条是正常重灌的还是墓碑。 */
  outcome: 'replayed' | 'tombstone'
}

/** 对账时读新库证据用的窄行形状。 */
export interface V2EvidenceParityRowV2 {
  /** 新证据 id。 */
  id: string
  /** 可用状态。 */
  eligibility_state: MemoryEvidenceEligibilityStateV2
  /** 正文密文引用。 */
  payload_blob_ref: Nullable<string>
  /** 正文承诺。 */
  payload_commitment: Nullable<string>
  /** 新库采集序号。 */
  ingest_sequence: number
}

/** 逐条映射的核对结果（进 mappingDigest）。 */
export interface MemoryEvidenceMappingVerificationV2 {
  /** 旧证据 id。 */
  readonly legacyEvidenceId: string
  /** 旧采集序号。 */
  readonly legacyIngestSequence: number
  /** 新证据 id；缺映射时是空串。 */
  readonly evidenceId: string
  /** 新库采集序号；找不到新证据时为 null。 */
  readonly v2IngestSequence: Nullable<number>
  /** 这条映射的形态：重灌 / 墓碑 / 缺失 / 孤儿。 */
  readonly outcome: ReplayLedgerRowV2['outcome'] | 'missing' | 'orphan'
  /** 正文对上没有。 */
  readonly payloadMatched: boolean
  /** 可用状态对上没有。 */
  readonly eligibilityMatched: boolean
}

/** 记一条治理账本要给的全部字段。 */
export interface RecordMemoryReplayGovernanceInputV2 {
  /** 旧库身份。 */
  readonly sourceDatabaseId: string
  /** 治理类型。 */
  readonly governanceType: 'eligibility' | 'forgotten' | 'superseded' | 'erased' | 'scope_degraded'
  /** 被治理对象在旧库里的 id。 */
  readonly legacyTargetId: string
  /** 关联的旧证据 id。 */
  readonly legacyEvidenceId: Nullable<string>
  /** 对应的新证据 id。 */
  readonly evidenceId: Nullable<string>
  /** 治理目标在新库里的匹配键。 */
  readonly targetMatchKey?: LooseOptional<string>
  /** 这条治理生效的隐私代。 */
  readonly denyGeneration?: LooseOptional<number>
  /** 这条治理落成了什么：生效 / 悬着 / 已知损耗。 */
  readonly disposition: 'applied' | 'pending' | 'known_loss'
  /** 理由码。 */
  readonly reasonCode: string
  /** 记录时刻（毫秒）。 */
  readonly recordedAt: number
}

/** 治理账本按处置分的计数。 */
export interface MemoryReplayGovernanceCountsV2 {
  /** 生效的条数。 */
  readonly applied: number
  /** 悬着的条数。 */
  readonly pending: number
  /** 已知损耗的条数。 */
  readonly knownLoss: number
}

/** 治理账本分组计数的行形状。 */
export interface MemoryReplayGovernanceCountRowV2 {
  /** 处置。 */
  readonly disposition: 'applied' | 'pending' | 'known_loss'
  /** 条数。 */
  readonly count: number
}

/** 旧库治理目标解析成新库匹配键的结果。 */
export interface ResolvedLegacyGovernanceTargetV2 {
  /** 算出来的治理匹配键；解析不了就是 null。 */
  readonly matchKey: Nullable<string>
  /** 解析不了时的理由码。 */
  readonly reasonCode: Nullable<string>
}

/**
 * 解析旧库治理目标要用到的身份键能力面。
 * utils 不许引 impl，所以把它要的两个动作单列成端口，由 `MemoryIdentityKeyServiceV2` 结构上满足。
 */
export interface MemoryGovernanceIdentityKeysV2 {
  /** 算概念稳定键。 */
  conceptStableKey(input: MemoryConceptStableKeyInputV2): string
  /** 算主张的跨库治理匹配键。 */
  claimGovernanceMatchKey(input: MemoryClaimGovernanceMatchInputV2): string
}

/** 一条旧证据归一化成新采集入参的结果，连同这次的已知损耗。 */
export interface NormalizedLegacyEvidenceV2 {
  /** 归一化后的采集入参。 */
  readonly input: IngestMemoryEvidenceInputV2
  /** 这条在归一化过程中损失了什么（理由码）。 */
  readonly knownLossReasons: readonly string[]
}

/** 旧作用域解析结果。 */
export interface ResolvedLegacyScopeV2 {
  /** 解析出来的新作用域。 */
  readonly scope: MemoryEvidenceScopeInputV2
  /** 降级的理由码；没降级就是 null。 */
  readonly degradedReason: Nullable<string>
}

/** 旧元数据 JSON 的解析结果。 */
export interface ParsedLegacyMetadataV2 {
  /** 解析出来的对象；坏了就是空对象。 */
  readonly value: Record<string, unknown>
  /** 是不是真的解析成功了。 */
  readonly parsed: boolean
}

/** 旧库查治理裁决时的原始行形状（各列都可能缺）。 */
export interface LegacyGovernanceQueryRowV2 {
  /** 被治理对象在旧库里的 id。 */
  readonly legacy_target_id: string
  /** 治理类型。 */
  readonly governance_type: 'forgotten' | 'superseded' | 'erased'
  /** 关联的旧证据 id。 */
  readonly legacy_evidence_id: Nullable<string>
  /** 谓词。 */
  readonly predicate: Nullable<string>
  /** 主张值 JSON。 */
  readonly value_json: Nullable<string>
  /** 主体概念类型。 */
  readonly concept_type: Nullable<string>
  /** 主体概念名。 */
  readonly canonical_name: Nullable<string>
  /** 主体概念作用域类型。 */
  readonly scope_type: Nullable<string>
  /** 主体概念作用域 id。 */
  readonly scope_id: Nullable<string>
}
