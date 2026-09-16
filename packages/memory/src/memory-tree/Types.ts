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

export type MemoryEvidenceCategory =
  | 'conversation'
  | 'fact'
  | 'preference'
  | 'feedback'
  | 'procedure'
  | 'project'
  | 'task'
  | 'goal'
  | 'interest'
  | 'entity'
  | 'artifact'

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
  retrievalReason: 'text' | 'scope' | 'mainline' | 'recent' | 'deep'
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
