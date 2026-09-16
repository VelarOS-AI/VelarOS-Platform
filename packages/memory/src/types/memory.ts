import type { MemoryBackendVerb, MemoryEvidenceCategories } from '../contract/constants.js'

export type MemoryEvidenceSourceType =
  | 'chat_message'
  | 'agent_tool'
  | 'execution_event'
  | 'workspace_event'
  | 'computer_use'
  | 'user_correction'
  | 'import'

export type MemoryEvidenceTrustLevel =
  | 'user_stated'
  | 'system_observed'
  | 'agent_derived'
  | 'external_content'

export type MemoryPrivacyClass = 'standard' | 'personal' | 'sensitive'

export type MemoryEvidenceCategory = (typeof MemoryEvidenceCategories)[number]

export type MemoryConceptType =
  | 'user'
  | 'project'
  | 'task'
  | 'goal'
  | 'interest'
  | 'procedure'
  | 'entity'
  | 'artifact'
  | 'conversation'

export type MemoryScopeType = 'global' | 'workspace' | 'site' | 'system' | 'session' | 'execution'

export type MemoryEvidenceEligibilityState = 'active' | 'source_deleted' | 'excluded'

export interface MemoryEvidenceInput {
  sourceType: MemoryEvidenceSourceType
  trustLevel: MemoryEvidenceTrustLevel
  sourceId?: string
  sessionId?: string
  executionId?: string
  workspaceRoot?: string
  occurredAt?: number
  title?: string
  content: string
  category?: MemoryEvidenceCategory
  privacyClass?: MemoryPrivacyClass
  scopeType?: MemoryScopeType
  scopeId?: string
  metadata?: Record<string, unknown>
}

export interface MemoryEvidenceRecord {
  id: string
  sourceType: MemoryEvidenceSourceType
  trustLevel: MemoryEvidenceTrustLevel
  sourceId: string
  sessionId: string
  executionId: string
  workspaceRoot: string
  scopeType: MemoryScopeType
  scopeId: string
  occurredAt: number
  title: string
  content: string
  category: MemoryEvidenceCategory
  privacyClass: MemoryPrivacyClass
  eligibilityState: MemoryEvidenceEligibilityState
  metadata: Record<string, unknown>
  ingestSequence: number
  createdAt: number
}

export interface MemoryCaptureResult {
  evidence: MemoryEvidenceRecord
  inserted: boolean
}

export interface MemoryCaptureBatchResult {
  evidence: MemoryEvidenceRecord[]
  insertedCount: number
  treeVersion: number
}

export interface MemoryDreamRunOptions {
  trigger: 'immediate' | 'manual' | 'idle' | 'startup'
  maxEvidence?: number
  abortSignal?: AbortSignal
}

export interface MemoryDreamRunResult {
  runId: string
  state: 'committed' | 'skipped' | 'failed' | 'cancelled'
  frontierBefore: number
  frontierAfter: number
  candidateCount: number
  acceptedCount: number
  rejectedCount: number
  treeVersionBefore: number
  treeVersionAfter: number
}

export interface MemoryTreePathNode {
  id: string
  nodeType: 'root' | 'trunk' | 'experience_branch' | 'task_branch' | 'stage' | 'leaf'
  title: string
  subjectType: string
  subjectId: string
}

export interface MemoryRecallOptions {
  limit?: number
  workspaceRoot?: string
  scopeId?: string
  /**
   * 作用域查询是否同时放行真正的 global Claim。默认保持通用召回的既有行为；
   * 需要严格实体隔离的入口（例如工作区建议卡）应显式传 false。
   */
  includeGlobal?: boolean
  /** 自动回合召回使用：避免把本轮刚写入的会话文本再次当作历史上下文注入。 */
  excludeSessionId?: string
  /** 自动回合召回使用：Evidence 保留，但不把纯 assistant 会话复述再次喂回模型。 */
  excludeAgentConversationEchoes?: boolean
  /** 自动回合召回使用：原始会话观察不注入，已整理成偏好、事实或流程的长期 Claim 不受影响。 */
  excludeConversationObservations?: boolean
  /**
   * 排除仅由这些来源支持的 Claim。混合来源 Claim 只要仍有一个未排除的有效 Evidence 就保留。
   * 典型用途是让自动回合召回跳过运行轨迹，同时保留手动查询与审计能力。
   */
  excludeSourceTypes?: MemoryEvidenceSourceType[]
  categories?: MemoryEvidenceCategory[]
  includeDormant?: boolean
  deep?: boolean
}

export interface MemoryRecallItem {
  id: string
  claimId: string
  conceptId: string
  conceptType: MemoryConceptType
  predicate: string
  title: string
  summary: string
  value: unknown
  scopeType: MemoryScopeType
  scopeId: string
  confidence: number
  salience: number
  activation: number
  updatedAt: number
  snapshotVersion: number
  /** `semantic` = 派生语义索引命中（内容仍逐字来自权威层）；`deep` = 把归档条目一并翻出来的深层召回。 */
  retrievalReason: 'text' | 'scope' | 'mainline' | 'recent' | 'deep' | 'semantic'
  evidenceIds: string[]
  /** 当前有效 Evidence 的来源类型；旧索引或外部后端无法提供来源时允许缺席。 */
  sourceTypes?: MemoryEvidenceSourceType[]
  path: MemoryTreePathNode[]
}

export interface MemoryTreeNodeRecord {
  id: string
  stableKey: string
  parentId: Nullable<string>
  nodeType: MemoryTreePathNode['nodeType']
  namespace: string
  title: string
  summary: string
  subjectType: string
  subjectId: string
  mainlineScore: number
  confidence: number
  firstSeenAt: number
  lastActiveAt: number
  projectionVersion: number
  activation: number
  visibilityState: 'active' | 'dormant' | 'pruned' | 'redacted'
}

export interface MemoryTreeSnapshotRecord {
  version: number
  rootNodeId: string
  activeIdentityEpochId: string
  globalMainlineNodeId: string
  frontierEvidenceSequence: number
  treeHash: string
  eventHeadHash: string
  createdAt: number
}

export interface MemoryTreeState {
  snapshot: Nullable<MemoryTreeSnapshotRecord>
  nodes: MemoryTreeNodeRecord[]
}

export interface MemoryTreeDiagnostics {
  evidenceCount: number
  conceptCount: number
  episodeCount: number
  claimCount: number
  relationCount: number
  treeNodeCount: number
  dreamRunCount: number
  ingestFrontier: number
  dreamFrontier: number
  treeVersion: number
  pendingEvidenceCount: number
  stalledDreamRunCount: number
}

export interface MemoryForgetResult {
  claimId: string
  affectedEvidenceIds: string[]
  treeVersion: number
}

export interface MemoryEvidenceEligibilityResult {
  evidenceId: string
  state: MemoryEvidenceEligibilityState
  affectedClaimIds: string[]
  treeVersion: number
}

export interface MemorySourceEligibilityResult {
  sourceScope: 'session'
  sourceId: string
  state: MemoryEvidenceEligibilityState
  affectedEvidenceIds: string[]
  affectedClaimIds: string[]
  treeVersion: number
}

export interface MemoryTreeIntegrityReport {
  valid: boolean
  checkedThroughVersion: number
  errors: string[]
}

/** 端口内部的同步/异步兼容包装；不从内核 ABI 借类型，保持契约层零 kernel 依赖。 */
export type MemoryBackendAwaitable<T> = T | Promise<T>

/**
 * 后端在叠加语义里的角色。
 *
 * - `authority`：权威层，记忆内容的唯一真相住在这里（出厂默认是 `memory-files`，宿主可显式选择 `memory-tree`）。
 * - `derived-index`：派生索引，丢了能重建，不是权威内容（`memory-vector`）。
 *
 * 角色不只是标签，是**解析期的安全判据**：权威解析一律跳过 `derived-index`——派生索引不持内容，
 * 被当成权威层用等于静默丢数据。
 */
export type MemoryBackendRole = 'authority' | 'derived-index'

/** 后端自述。宿主诊断面与后端选择器只读它，不做 `instanceof` 之类的实现探测。 */
export interface MemoryBackendDescriptor {
  /** 后端短 id（`files` / `tree` / `vector`）；能力令牌由它派生。 */
  readonly id: string
  /** 权威层还是派生索引。 */
  readonly role: MemoryBackendRole
  /** 设置页「跑在哪个后端上」直接显示的名字。 */
  readonly displayName: string
  /** 本后端实现了哪些动词；未列出的可选动词在实现上必须缺席（而不是抛未实现）。 */
  readonly verbs: readonly MemoryBackendVerb[]
}

/**
 * 后端无关的健康读数。
 *
 * 刻意不复用 `MemoryTreeDiagnostics`：那是树后端的 schema，窄端口一旦返回它就等于把树形态钉进契约。
 * 树后端把自己的诊断投影到这里，文件后端填自己能诚实回答的三项。
 */
export interface MemoryBackendStats {
  /** 是哪个后端答的。 */
  readonly backendId: string
  /** 该后端当前持有的记忆条目数（树后端 = claim 数，文件后端 = 索引条目数）。 */
  readonly itemCount: number
  /** 还没被整理/索引的待处理量；无此概念的后端返回 0。 */
  readonly pendingCount: number
  /** 后端自有的单调版本号；无版本概念的后端返回 0。 */
  readonly version: number
  /** 后端私有读数，仅供诊断展示，禁止参与任何判定逻辑。 */
  readonly details?: Readonly<Record<string, number | string>>
}

/** 批量写入的选项。 */
export interface MemoryBackendCaptureBatchOptions {
  /** 是否在本次写入后立即整理。无整理管线的后端忽略该项（写入即最终态）。 */
  readonly consolidate?: boolean
}

/**
 * 派生索引的版本戳。**变了就重建，不写迁移器**。
 *
 * 两段各自独立地让索引作废：`schema` 是本包对记录形状的演进，`embedding` 是嵌入模型身份
 * （换 provider / 换模型 / 换维度）。分两段而不是一个数字，是因为它们由**不同的人**改动。
 */
export interface MemoryDerivedIndexVersion {
  /** 记录形状的版本号，由本包演进。 */
  readonly schema: number
  /** 嵌入模型身份（如 `openai:text-embedding-3-small:1536`）。 */
  readonly embedding: string
}

/** 一次全量重建的回执。 */
export interface MemoryDerivedIndexRebuildResult {
  /** 重建后索引里有多少条指针。 */
  readonly indexedCount: number
  /** 重建前存在、权威层已没有的指针数（孤儿）。 */
  readonly removedOrphanCount: number
  /** 重建后写入的版本戳。 */
  readonly version: string
}

/**
 * 向量索引里的一条记录：**指针 + 作用域 + 向量，没有内容副本**。
 *
 * 没有 title / summary / body：一旦索引持了内容副本，「卸载只删索引」就变成了删内容。
 * 召回命中后回权威层按 id 取全文，那是编排层的事。
 */
export interface MemoryVectorIndexRecord {
  /** 权威层指针（`MemoryRecallItem.id`）。 */
  readonly id: string
  /** 这条记忆属于哪一种作用域。 */
  readonly scopeType: MemoryScopeType
  /** 这条记忆的作用域 id。 */
  readonly scopeId: string
  /** 最后一次写入索引的时间戳，毫秒。 */
  readonly updatedAt: number
  /** **已归一化**的向量：写入时归一，检索时点积即余弦。 */
  readonly vector: Float32Array
}

/** 序列化的作用域身份：`global` / `system` / `project:<根>` / `site:<源>`。 */
export type MemoryScopeId = string

/**
 * 作用域的**两根轴**：会话身份轴与工作区根轴。
 *
 * - 轴一 `scopeId` = 会话身份（空间实体）派生出的作用域。宿主每次调用都算得出它，因此它**在场即权威**。
 * - 轴二 `workspaceRoot` = 当前工作区根。它不是第二个候选作用域，而是轴一缺席时**把项目作用域物化出来**的那个参数。
 *
 * 两轴正交但不并列：同时给两根轴时按轴一裁决。
 */
export interface MemoryScopeSelectorInput {
  /** 会话身份派生出的作用域 id；在场即权威。 */
  scopeId?: LooseOptional<string>
  /** 当前工作区根；只在 scopeId 缺席时用来物化项目作用域。 */
  workspaceRoot?: LooseOptional<string>
}

/** 可见性判定的目标读数：后端记录、文件根与召回条目共用这一格。 */
export interface MemoryScopeTarget {
  /** 目标所属的作用域种类；没有 scopeId 时才作为回落判据。 */
  scopeType?: LooseOptional<string>
  /** 目标所属的作用域 id；在场即权威。 */
  scopeId?: LooseOptional<string>
}

/** 可见性判定的入参：两轴，外加要不要并入真正的 global 记忆。 */
export interface MemoryScopeVisibilityInput extends MemoryScopeSelectorInput {
  /**
   * 是否并入真正的 global 记忆。默认并入（通用召回的既有行为）；需要严格实体隔离的入口
   * 显式传 false。
   */
  includeGlobal?: LooseOptional<boolean>
}

/**
 * 工具面看得见的后端自述。
 *
 * 工具契约必须后端无关，但**返回值**可以按能力分档：装了整理管线才说「稍后整理」，
 * 有版本概念才回版本号。没有这一格，工具只能对所有后端说树档的话，或者只说最小公倍数。
 */
export interface MemoryBackendCapabilities {
  /** 当前后端的短 id。 */
  id: string
  /** 当前后端声明并实现了哪些动词。 */
  verbs: readonly MemoryBackendVerb[]
}

/** 宿主在记忆工具边界上归一好的会话谱系：分支与被排除的消息由宿主裁决，记忆只如实记录。 */
export interface MemorySessionLineageContext {
  /** 当前会话 id。 */
  sessionId: string
  /** 当前活动分支 id。 */
  activeBranchId?: LooseOptional<string>
  /** 这一轮可见的分支 id 列表。 */
  visibleBranchIds?: string[]
  /** 被用户排除、不该进入记忆的消息 id 列表。 */
  excludedMessageIds?: string[]
}

/**
 * 一个作用域的磁盘落点。
 *
 * `directory` 由宿主注入：全局 = `<userData>/memory`，项目 = `<仓根>/.velaros/memory`。
 */
export interface MemoryFilesScopeRoot {
  /** 这个根属于哪一种作用域。 */
  readonly scopeType: MemoryScopeType
  /** 这个根对应的作用域 id。 */
  readonly scopeId: MemoryScopeId
  /** 根目录的绝对路径。 */
  readonly directory: string
  /** 只读根（如别人 clone 来的共享记忆）不接受写入；缺省可写。 */
  readonly readOnly?: boolean
}

/** 一次回合召回的入参。 */
export interface MemoryTurnRecallInput {
  /** 当前会话 id。 */
  sessionId: string
  /** 用户本轮输入的原始文本（不含冻结的环境块）。 */
  query: string
  /** 当前工作区根。 */
  workspaceRoot?: LooseOptional<string>
  /** 宿主上下文身份。 */
  contextId?: LooseOptional<string>
}

/** 供外部引擎 prompt 前缀消费的只读召回结果；空数组表示关闭、跳过、失败或超时。 */
export interface MemoryTurnRecallResult {
  /** 可直接拼进提示词的中文摘要。 */
  summaries: string[]
  /** 每条摘要对应的来源标注。 */
  sources?: Array<{ sourceId: string, label: string }>
}

