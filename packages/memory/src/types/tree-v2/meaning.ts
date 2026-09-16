import type { MemoryTreeDiffOpV2, MemoryTreeNodeStructV2 } from './diff'
import type { MemoryPrivacyClassV2 } from './evidence'
import type { MemorySealedContentV2 } from './storage'
import type {
  MemoryTreeAuthorityCommitParticipantV2,
  MemoryTreeIdentityChangeV2,
} from './store'

/**
 * 记忆树 v2 意义整理的数据形状：模型给的候选、裁决结果，以及落库前准备好的实体。
 * 树 v2 是包内子系统，这些类型不出包。
 */

/** 一个意义候选所属的作用域。 */
export type MemoryMeaningScopeV2 =
  | { readonly type: 'global' }
  | { readonly type: 'workspace'; readonly rootPath: string }
  | { readonly type: 'origin'; readonly origin: string }

/** 所有候选共有的两个字段。 */
export interface MemoryMeaningCandidateBaseV2 {
  /** 这一批提案内部的候选键（用来相互引用）。 */
  readonly candidateKey: string
  /** 支撑这个候选的证据 id。 */
  readonly evidenceIds: readonly string[]
}

/** 概念候选。 */
export interface MemoryConceptCandidateV2 extends MemoryMeaningCandidateBaseV2 {
  /** 判别字段。 */
  readonly kind: 'concept'
  /** 概念类型（user、project、task…）。 */
  readonly conceptType: string
  /** 概念名（进身份键与盲索引）。 */
  readonly name: string
  /** 概念描述。 */
  readonly description?: LooseOptional<string>
  /** 这个概念属于哪个作用域。 */
  readonly scope: MemoryMeaningScopeV2
  /** 隐私分级。 */
  readonly privacyClass: MemoryPrivacyClassV2
  /** 生命周期状态。 */
  readonly lifecycleState: string
  /** 首次出现时刻（毫秒）。 */
  readonly firstSeenAt: number
  /** 最近活跃时刻（毫秒）。 */
  readonly lastActiveAt: number
  /** 显著度，[0,1]。 */
  readonly salience: number
  /** 激活度，[0,1]。 */
  readonly activation: number
}

/** 情节候选。 */
export interface MemoryEpisodeCandidateV2 extends MemoryMeaningCandidateBaseV2 {
  /** 判别字段。 */
  readonly kind: 'episode'
  /** 情节类型。 */
  readonly episodeType: string
  /** 情节标题。 */
  readonly title: string
  /** 情节摘要。 */
  readonly summary?: LooseOptional<string>
  /** 情节状态。 */
  readonly state: string
  /** 开始时刻（毫秒）。 */
  readonly startedAt: number
  /** 结束时刻（毫秒）；没结束就不给。 */
  readonly endedAt?: LooseOptional<number>
  /** 这个情节属于哪个作用域。 */
  readonly scope: MemoryMeaningScopeV2
  /** 它挂在哪个概念候选下。 */
  readonly primaryConceptKey: string
  /** 情节阶段（进身份键）。 */
  readonly phase: string
  /** 情节结果。 */
  readonly result?: LooseOptional<string>
  /** 显著度，[0,1]。 */
  readonly salience: number
  /** 激活度，[0,1]。 */
  readonly activation: number
}

/** 主张候选。 */
export interface MemoryClaimCandidateV2 extends MemoryMeaningCandidateBaseV2 {
  /** 判别字段。 */
  readonly kind: 'claim'
  /** 它说的是哪个概念候选。 */
  readonly subjectConceptKey: string
  /** 谓词。 */
  readonly predicate: string
  /** 标题（进身份键的话题段）。 */
  readonly title: string
  /** 主张的值（canonical 序列化后封成密文）。 */
  readonly value: unknown
  /** 主张摘要。 */
  readonly summary?: LooseOptional<string>
  /** 值的存放方式：整存、只留索引，还是只存引用。 */
  readonly storageMode: 'full' | 'index_only' | 'reference'
  /** storageMode 为 reference 时指向的外部引用。 */
  readonly payloadRef?: LooseOptional<string>
  /** 认识状态（用户确认、观察、推导…）。 */
  readonly epistemicStatus: string
  /** 置信度，[0,1]。 */
  readonly confidence: number
  /** 隐私分级。 */
  readonly privacyClass: MemoryPrivacyClassV2
  /** 生命周期状态。 */
  readonly lifecycleState: string
  /** 生效起始时刻（毫秒）。 */
  readonly validFrom: number
  /** 生效结束时刻（毫秒）。 */
  readonly validTo?: LooseOptional<number>
  /** 显著度，[0,1]。 */
  readonly salience: number
  /** 固化强度，[0,1]。 */
  readonly consolidationStrength: number
  /** 激活度，[0,1]。 */
  readonly activation: number
}

/** 关系两端可以是哪三类实体。 */
export type MemoryMeaningEntityKindV2 = 'concept' | 'episode' | 'claim'

/** 关系的一端。 */
export interface MemoryMeaningEndpointV2 {
  /** 端点是哪类实体。 */
  readonly kind: MemoryMeaningEntityKindV2
  /** 端点的候选键。 */
  readonly candidateKey: string
}

/** 关系候选。 */
export interface MemoryRelationCandidateV2 extends MemoryMeaningCandidateBaseV2 {
  /** 判别字段。 */
  readonly kind: 'relation'
  /** 关系起点。 */
  readonly source: MemoryMeaningEndpointV2
  /** 关系终点。 */
  readonly target: MemoryMeaningEndpointV2
  /** 关系类型。 */
  readonly relationType: string
  /** 置信度，[0,1]。 */
  readonly confidence: number
  /** 认识状态。 */
  readonly epistemicStatus: string
  /** 生效起始时刻（毫秒）。 */
  readonly validFrom: number
  /** 生效结束时刻（毫秒）。 */
  readonly validTo?: LooseOptional<number>
  /** 激活度，[0,1]。 */
  readonly activation: number
}

/** 四类意义候选之一。 */
export type MemoryMeaningCandidateV2 =
  | MemoryConceptCandidateV2
  | MemoryEpisodeCandidateV2
  | MemoryClaimCandidateV2
  | MemoryRelationCandidateV2

/** 身份纪元候选：这一轮整理后「我是谁、当前主线是什么」。 */
export interface MemoryIdentityCandidateV2 {
  /** 身份自述。 */
  readonly statement: string
  /** 当前全局主线。 */
  readonly globalMainline: string
  /** 置信度，[0,1]。 */
  readonly confidence: number
  /** 支撑它的证据 id。 */
  readonly evidenceIds: readonly string[]
  /** 支撑它的概念候选键。 */
  readonly supportingConceptKeys: readonly string[]
  /** 支撑它的情节候选键。 */
  readonly supportingEpisodeKeys: readonly string[]
  /** 支撑它的主张候选键。 */
  readonly supportingClaimKeys: readonly string[]
}

/** 模型给出的一整份提案。 */
export interface MemoryMeaningProposalV2 {
  /** 四类候选。 */
  readonly candidates: readonly MemoryMeaningCandidateV2[]
  /** 这一轮是否同时提出新的身份纪元。 */
  readonly identity?: LooseOptional<MemoryIdentityCandidateV2>
}

/** 对一个候选的裁决。 */
export interface MemoryMeaningCandidateDecisionV2 {
  /** 候选键；身份候选固定用 `identity`。 */
  readonly candidateKey: string
  /** 候选种类。 */
  readonly kind: MemoryMeaningCandidateV2['kind'] | 'identity'
  /** 接受、拒绝，还是按信任上限改写后接受。 */
  readonly decision: 'accepted' | 'rejected' | 'revised'
  /** 拒绝或改写的理由码。 */
  readonly reasons: readonly string[]
}

/** 一次意义整理的结果。 */
export interface MemoryMeaningCurationResultV2 {
  /** 提交后的树版本。 */
  readonly treeVersion: number
  /** 接受（含改写后接受）的候选数。 */
  readonly acceptedCount: number
  /** 拒绝的候选数。 */
  readonly rejectedCount: number
  /** 逐候选的裁决。 */
  readonly decisions: readonly MemoryMeaningCandidateDecisionV2[]
}

/** 发起一次意义整理并提交的入参。 */
export interface CurateAndCommitMemoryMeaningInputV2 {
  /** 这次整理运行的 id（必须已经处于 running）。 */
  readonly runId: string
  /** 模型给的提案。 */
  readonly proposal: MemoryMeaningProposalV2
  /** 这次运行用掉的 token 数。 */
  readonly tokenUsage: number
  /** 提交时刻（毫秒）；不给用 Date.now。 */
  readonly committedAt?: number
}

/** 查证据信任级别时用的行形状。 */
export interface EvidenceTrustRowV2 {
  /** 证据 id。 */
  id: string
  /** 信任级别。 */
  trust_level: string
  /** 可用状态。 */
  eligibility_state: string
}

/** 一批证据的信任读数。 */
export interface MemoryEvidenceTrustSummaryV2 {
  /** 逐条证据的信任级别。 */
  readonly levels: string[]
  /** 是不是全都来自外部内容（要按上限压置信度）。 */
  readonly externalOnly: boolean
  /** 读的过程中发现的拒绝理由码。 */
  readonly reasons: string[]
}

/** 外部内容信任上限的处理结果。 */
export interface MemoryExternalContentCapResultV2 {
  /** 压过上限之后的候选；没改就是原来那个。 */
  readonly candidate: MemoryMeaningCandidateV2
  /** 这次有没有真的改写过它。 */
  readonly revised: boolean
}

/** 裁决之后留下来、可以落库的那部分提案。 */
export interface AcceptedMeaningProposalV2 {
  /** 通过的概念候选。 */
  concepts: MemoryConceptCandidateV2[]
  /** 通过的情节候选。 */
  episodes: MemoryEpisodeCandidateV2[]
  /** 通过的主张候选。 */
  claims: MemoryClaimCandidateV2[]
  /** 通过的关系候选。 */
  relations: MemoryRelationCandidateV2[]
  /** 通过的身份候选；没有或被拒就是 null。 */
  identity: Nullable<MemoryIdentityCandidateV2>
  /** 逐候选的裁决。 */
  decisions: MemoryMeaningCandidateDecisionV2[]
  /** 这一批一共有多少个候选（含身份）。 */
  candidateCount: number
}

/** 作用域解析后的结果。 */
export interface ResolvedMeaningScopeV2 {
  /** 作用域类型。 */
  scopeType: string
  /** 作用域 id（进身份键）。 */
  scopeId: string
  /** 作用域盲索引键；global 没有。 */
  scopeMatchKey: Nullable<string>
}

/** 已经封好、但还没登记进权威库的一段正文。 */
export interface PreparedBlobV2 extends MemorySealedContentV2 {
  /** 封之前的明文（准备阶段还要用它算别的键）。 */
  content: string
}

/** 准备好落库的一个概念。 */
export interface PreparedConceptV2 {
  /** 原始候选。 */
  candidate: MemoryConceptCandidateV2
  /** 行 id（已存在就复用）。 */
  id: string
  /** 稳定键。 */
  stableKey: string
  /** 解析后的作用域。 */
  scope: ResolvedMeaningScopeV2
  /** 概念名的盲索引键。 */
  nameMatchKey: string
  /** 封好的概念名。 */
  name: PreparedBlobV2
  /** 封好的描述；没有就是 null。 */
  description: Nullable<PreparedBlobV2>
}

/** 准备好落库的一个情节。 */
export interface PreparedEpisodeV2 {
  /** 原始候选。 */
  candidate: MemoryEpisodeCandidateV2
  /** 行 id。 */
  id: string
  /** 稳定键。 */
  stableKey: string
  /** 解析后的作用域。 */
  scope: ResolvedMeaningScopeV2
  /** 它挂的概念。 */
  primaryConcept: PreparedConceptV2
  /** 封好的标题。 */
  title: PreparedBlobV2
  /** 封好的摘要。 */
  summary: Nullable<PreparedBlobV2>
  /** 封好的结果。 */
  result: Nullable<PreparedBlobV2>
}

/** 准备好落库的一条主张。 */
export interface PreparedClaimV2 {
  /** 原始候选。 */
  candidate: MemoryClaimCandidateV2
  /** 行 id。 */
  id: string
  /** 稳定键。 */
  stableKey: string
  /** 分组键。 */
  groupKey: string
  /** 它说的那个概念。 */
  subjectConcept: PreparedConceptV2
  /** 封好的值。 */
  value: PreparedBlobV2
  /** 封好的摘要。 */
  summary: Nullable<PreparedBlobV2>
}

/** 准备好落库的一条关系。 */
export interface PreparedRelationV2 {
  /** 原始候选。 */
  candidate: MemoryRelationCandidateV2
  /** 行 id。 */
  id: string
  /** 起点实体的行 id。 */
  sourceId: string
  /** 终点实体的行 id。 */
  targetId: string
}

/** 准备好落库的身份纪元。 */
export interface PreparedIdentityV2 {
  /** 原始候选。 */
  candidate: MemoryIdentityCandidateV2
  /** 新纪元 id。 */
  id: string
  /** 纪元序号。 */
  sequence: number
  /** 被接续的纪元 id。 */
  predecessorId: Nullable<string>
  /** 封好的身份自述。 */
  statement: PreparedBlobV2
  /** 封好的全局主线。 */
  globalMainline: PreparedBlobV2
  /** 支撑它的概念行 id。 */
  supportingConceptIds: readonly string[]
  /** 支撑它的情节行 id。 */
  supportingEpisodeIds: readonly string[]
  /** 支撑它的主张行 id。 */
  supportingClaimIds: readonly string[]
}

/** 准备好的一次意义提交：事务参与者、树事件与失败时的收尾。 */
export interface PreparedMeaningCommitV2 {
  /** 提交时在权威事务里跑的参与者。 */
  participant: MemoryTreeAuthorityCommitParticipantV2
  /** 这一步要提交的树事件。 */
  ops: readonly MemoryTreeDiffOpV2[]
  /** 这一步附带的身份纪元变更。 */
  identityChange: Nullable<MemoryTreeIdentityChangeV2>
  /** 提交后生效的身份纪元 id。 */
  activeIdentityEpochId: string
  /** 全局主线节点的 stableKey。 */
  globalMainlineNodeId: string
  /** 提交失败时把已经封好的密文擦掉。 */
  cleanupAfterFailure(): void
}

/** 由准备好的实体推出目标树节点集时要的材料。 */
export interface BuildMeaningTreeNodesInputV2 {
  /** 当前树的节点。 */
  readonly current: readonly MemoryTreeNodeStructV2[]
  /** 准备好的概念。 */
  readonly concepts: readonly PreparedConceptV2[]
  /** 准备好的情节。 */
  readonly episodes: readonly PreparedEpisodeV2[]
  /** 准备好的主张。 */
  readonly claims: readonly PreparedClaimV2[]
  /** 准备好的身份纪元；这一轮不换身份就是 null。 */
  readonly identity: Nullable<PreparedIdentityV2>
  /** 提交后生效的身份纪元 id。 */
  readonly activeIdentityEpochId: string
  /** 全局主线节点的 stableKey。 */
  readonly globalMainlineNodeId: string
  /** 这次提交的时刻（毫秒）。 */
  readonly createdAt: number
}

/** 查当前身份纪元序号时用的窄行形状。 */
export interface ActiveIdentityEpochRowV2 {
  /** 纪元 id。 */
  readonly id: string
  /** 纪元序号。 */
  readonly sequence: number
}

/** 查旧库治理裁决时用的窄行形状。 */
export interface LegacyGovernanceTypeRowV2 {
  /** 治理类型。 */
  readonly governance_type: 'forgotten' | 'superseded' | 'erased'
}
