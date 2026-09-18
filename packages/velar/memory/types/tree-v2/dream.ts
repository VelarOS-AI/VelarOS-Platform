import type { MemoryTreeDiffOpV2 } from './diff.js'
import type { MemoryEvidenceEligibilityStateV2 } from './evidence.js'
import type {
  MemoryTreeAuthorityCommitParticipantV2,
  MemoryTreeIdentityChangeV2,
} from './store.js'

/**
 * 记忆树 v2 整理运行（Dream）的数据形状：批次、账本行、验证统计与提交入参。
 * 树 v2 是包内子系统，这些类型不出包。
 */

/** 这次整理用的模型身份；两项都可以为空（比如纯确定性整理）。 */
export interface MemoryDreamModelProfileV2 {
  /** 模型提供方。 */
  readonly provider: Nullable<string>
  /** 模型 id。 */
  readonly model: Nullable<string>
}

/** 批次里一条证据的描述（只带引用与承诺，正文要另外解）。 */
export interface MemoryDreamEvidenceDescriptorV2 {
  /** 证据 id。 */
  readonly id: string
  /** 采集序号。 */
  readonly ingestSequence: number
  /** 可用状态；只有 active 的才进推理。 */
  readonly eligibilityState: MemoryEvidenceEligibilityStateV2
  /** 正文密文引用。 */
  readonly payloadBlobRef: Nullable<string>
  /** 正文承诺。 */
  readonly payloadCommitment: Nullable<string>
  /** 元数据密文引用。 */
  readonly metadataBlobRef: Nullable<string>
  /** 元数据承诺。 */
  readonly metadataCommitment: Nullable<string>
}

/** 开出来的一个整理批次。 */
export interface MemoryDreamStartedRunV2 {
  /** 判别字段：这是一个新开的批次。 */
  readonly kind: 'started'
  /** 这次运行的 id。 */
  readonly runId: string
  /** 这次运行的输入指纹。 */
  readonly inputFingerprint: string
  /** 开始时消化到的证据序号。 */
  readonly frontierBefore: number
  /** 这一批要消化到的证据序号。 */
  readonly frontierAfter: number
  /** 开始时的树版本。 */
  readonly treeVersionBefore: number
  /** 这一批覆盖的全部证据（含不合格的）。 */
  readonly evidence: readonly MemoryDreamEvidenceDescriptorV2[]
  /** 其中可以进推理的那些（eligibilityState 为 active）。 */
  readonly eligibleEvidence: readonly MemoryDreamEvidenceDescriptorV2[]
}

/** 同样输入已经提交过，这一批直接跳过。 */
export interface MemoryDreamSkippedRunV2 {
  /** 判别字段：这一批被跳过。 */
  readonly kind: 'skipped'
  /** 之前那次运行的 id。 */
  readonly runId: string
  /** 这次运行的输入指纹。 */
  readonly inputFingerprint: string
  /** 开始时消化到的证据序号。 */
  readonly frontierBefore: number
  /** 这一批本来要消化到的证据序号。 */
  readonly frontierAfter: number
  /** 开始时的树版本。 */
  readonly treeVersionBefore: number
}

/** 开批次的结果：开出来了、跳过了，或者没有新证据（null）。 */
export type StartMemoryDreamRunResultV2 = Nullable<
  MemoryDreamStartedRunV2 | MemoryDreamSkippedRunV2
>

/** 开一个整理批次的入参。 */
export interface StartMemoryDreamBatchInputV2 {
  /** 触发来源（空闲调度、显式触发…）。 */
  readonly trigger: string
  /** 这一批最多消化多少条证据。 */
  readonly batchSize: number
  /** 这次用的模型身份（进输入指纹）。 */
  readonly modelProfile: MemoryDreamModelProfileV2
  /** 开始时刻（毫秒）；不给用 Date.now。 */
  readonly startedAt?: number
}

/** 一次整理运行的候选统计；接受数加拒绝数必须等于候选数。 */
export interface MemoryDreamValidationStatsV2 {
  /** 用掉的 token 数。 */
  readonly tokenUsage: number
  /** 产生的候选数。 */
  readonly candidateCount: number
  /** 接受的候选数。 */
  readonly acceptedCount: number
  /** 拒绝的候选数。 */
  readonly rejectedCount: number
}

/** 把一次整理运行的结果提交成新树版本的入参。 */
export interface CommitMemoryDreamTreeInputV2 extends MemoryDreamValidationStatsV2 {
  /** 这一步的结构事件。 */
  readonly ops: readonly MemoryTreeDiffOpV2[]
  /** 这一步附带的身份纪元变更。 */
  readonly identityChange?: LooseOptional<MemoryTreeIdentityChangeV2>
  /** 这一版生效的身份纪元 id。 */
  readonly activeIdentityEpochId: string
  /** 全局主线节点的 stableKey。 */
  readonly globalMainlineNodeId: string
  /** 提交时刻（毫秒）；不给用 Date.now。 */
  readonly committedAt?: number
  /** 本包自己的事务参与者。 */
  readonly authorityCommit?: MemoryTreeAuthorityCommitParticipantV2
}

/** 解出来的一条证据正文；调用方用完要清零。 */
export interface MaterializedMemoryDreamEvidenceV2 {
  /** 解密后的正文字节。 */
  readonly payload: Buffer
  /** 解密后的元数据字节；没有就是 null。 */
  readonly metadata: Nullable<Buffer>
}

/** `memory_dream_runs` 的行形状。 */
export interface MemoryDreamRunRowV2 {
  /** 运行 id。 */
  id: string
  /** 运行状态：running / validating / committed / failed / cancelled / skipped。 */
  state: string
  /** 输入指纹。 */
  input_fingerprint: string
  /** 开始时消化到的证据序号。 */
  frontier_before: number
  /** 这一批消化到的证据序号。 */
  frontier_after: number
  /** 开始时的树版本。 */
  tree_version_before: number
  /** 提交后的树版本。 */
  tree_version_after: number
  /** 模型提供方。 */
  model_provider: Nullable<string>
  /** 模型 id。 */
  model: Nullable<string>
  /** 用掉的 token 数。 */
  token_usage: number
  /** 候选数。 */
  candidate_count: number
  /** 接受数。 */
  accepted_count: number
  /** 拒绝数。 */
  rejected_count: number
}

/** 开批次时查证据用的窄行形状。 */
export interface MemoryDreamEvidenceRowV2 {
  /** 证据 id。 */
  id: string
  /** 采集序号。 */
  ingest_sequence: number
  /** 可用状态。 */
  eligibility_state: MemoryEvidenceEligibilityStateV2
  /** 正文密文引用。 */
  payload_blob_ref: Nullable<string>
  /** 正文承诺。 */
  payload_commitment: Nullable<string>
  /** 元数据密文引用。 */
  metadata_blob_ref: Nullable<string>
  /** 元数据承诺。 */
  metadata_commitment: Nullable<string>
}
