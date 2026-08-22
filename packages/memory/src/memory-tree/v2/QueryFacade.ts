import { isEmpty, isPresent, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { MemoryAuthorityDatabaseV2 } from './AuthorityDatabase'
import type { MemoryTreeNodeStructV2 } from './DiffChain'
import type { ContentKeyServiceV2 } from './storage'
import type { MemoryTreeStoreV2 } from './TreeStore'

const DefaultRecallLimitV2 = 3
const MaximumRecallLimitV2 = 12
const MaximumPathNodesV2 = 16
const SensitiveLabelV2 = '敏感记忆'

export type MemoryRecallReasonV2 = 'branch' | 'search' | 'active-path-fallback'

export type MemoryRecallIndexStateV2 = 'ready' | 'missing' | 'stale'

export interface MemoryQueryPathNodeV2 {
  readonly treeNodeId: string
  readonly parentTreeNodeId: Nullable<string>
  readonly nodeType: string
  readonly namespace: string
  readonly subjectType: string
  readonly subjectId: string
  readonly label: Nullable<string>
  readonly sensitive: boolean
  readonly confidence: number
  readonly activation: number
  readonly firstSeenAt: number
  readonly lastActiveAt: number
}

export interface MemoryRecallProjectionV2 {
  readonly treeNodeId: string
  readonly snapshotVersion: number
  readonly denyGeneration: number
  readonly retrievalReason: MemoryRecallReasonV2
  readonly confidence: number
  readonly conceptIds: readonly string[]
  readonly episodeIds: readonly string[]
  readonly claimIds: readonly string[]
  readonly evidenceIds: readonly string[]
  readonly path: readonly MemoryQueryPathNodeV2[]
}

export interface MemoryRecallQueryV2 {
  readonly query: string
  readonly branchTreeNodeId?: string
  readonly limit?: number
  /**
   * 只有宿主已完成当前 surface 的隐私授权判定时才可开启。
   * 默认输出稳定模糊标签，不解密 sensitive 节点。
   */
  readonly revealSensitive?: boolean
}

export interface MemoryRecallQueryResultV2 {
  readonly snapshotVersion: number
  readonly denyGeneration: number
  readonly indexState: MemoryRecallIndexStateV2
  readonly degraded: boolean
  readonly candidateCount: number
  readonly hydratedNodeCount: number
  readonly items: readonly MemoryRecallProjectionV2[]
}

export interface MemoryRecallIndexRefreshReportV2 {
  readonly snapshotVersion: number
  readonly denyGeneration: number
  readonly indexedNodeCount: number
  readonly skippedSensitiveCount: number
  readonly skippedDeniedCount: number
}

export interface MemoryTreeStructureNodeV2 {
  readonly treeNodeId: string
  readonly parentTreeNodeId: Nullable<string>
  readonly nodeType: string
  readonly namespace: string
  readonly subjectType: string
  readonly subjectId: string
  readonly visibilityState: string
}

export interface MemoryTreeStructureProjectionV2 {
  readonly snapshotVersion: number
  readonly denyGeneration: number
  readonly nodes: readonly MemoryTreeStructureNodeV2[]
}

interface SearchIndexEntryV2 {
  readonly treeNodeId: string
  readonly tokens: ReadonlySet<string>
  readonly activation: number
  readonly mainlineScore: number
  readonly lastActiveAt: number
}

interface SearchIndexGenerationV2 {
  readonly snapshotVersion: number
  readonly denyGeneration: number
  readonly entries: readonly SearchIndexEntryV2[]
}

interface PrivacyProjectionV2 {
  readonly sensitiveSubjectKeys: ReadonlySet<string>
}

interface QueryAuthoritySnapshotV2 {
  readonly version: number
  readonly globalMainlineNodeId: Nullable<string>
}

/**
 * v2 已提交树的唯一查询门面。
 *
 * 同步 recall 从不启动模型、网络或全库解密：搜索只读显式后台刷新出的内存 index；
 * index 缺失/陈旧时确定性降级到当前主线路径。每次只解密最终 top-K 路径，且按
 * tree version + privacy generation 双键判断缓存是否仍可消费。
 */
export class MemoryQueryFacadeV2 {
  private searchIndex: Nullable<SearchIndexGenerationV2> = null

  constructor(
    private readonly authority: MemoryAuthorityDatabaseV2,
    private readonly contentKeys: ContentKeyServiceV2,
    private readonly tree: MemoryTreeStoreV2
  ) {}

  /**
   * 显式后台入口。调用方应在 idle/Dream 调度路径执行；同步 recall 永远不会隐式调用。
   * 只在进程内保留规范化 token，不产生明文磁盘索引。
   */
  public refreshSearchIndex(): MemoryRecallIndexRefreshReportV2 {
    const snapshot = this.readSnapshot()
    const denyGeneration = this.readDenyGeneration()
    if (snapshot.version === 0) {
      this.searchIndex = {
        snapshotVersion: 0,
        denyGeneration,
        entries: [],
      }
      return {
        snapshotVersion: 0,
        denyGeneration,
        indexedNodeCount: 0,
        skippedSensitiveCount: 0,
        skippedDeniedCount: 0,
      }
    }
    const nodes = this.tree.current.nodes
    const denied = this.readDeniedSubjects()
    const privacy = this.readPrivacyProjection()
    const entries: SearchIndexEntryV2[] = []
    let skippedSensitiveCount = 0
    let skippedDeniedCount = 0
    for (const node of nodes) {
      if (!isQueryableNodeV2(node) || isDeniedNodeV2(node, denied)) {
        if (node.visibilityState === 'redacted' || isDeniedNodeV2(node, denied)) {
          skippedDeniedCount += 1
        }
        continue
      }
      if (privacy.sensitiveSubjectKeys.has(subjectKeyV2(node))) {
        skippedSensitiveCount += 1
        continue
      }
      if (!node.content.blobRef || !node.content.commitment) continue
      const plaintext = this.contentKeys.openContent(node.content.blobRef, node.content.commitment)
      try {
        const tokens = tokenizeMemoryQueryV2(plaintext.toString('utf8'))
        if (tokens.size === 0) continue
        entries.push({
          treeNodeId: node.stableKey,
          tokens,
          activation: node.activation,
          mainlineScore: node.mainlineScore,
          lastActiveAt: node.lastActiveAt,
        })
      } finally {
        plaintext.fill(0)
      }
    }
    this.searchIndex = {
      snapshotVersion: snapshot.version,
      denyGeneration,
      entries,
    }
    return {
      snapshotVersion: snapshot.version,
      denyGeneration,
      indexedNodeCount: entries.length,
      skippedSensitiveCount,
      skippedDeniedCount,
    }
  }

  public clearSearchIndex(): void {
    this.searchIndex = null
  }

  /**
   * 只暴露稳定结构标识，不解密节点正文。用于宿主维护树选择态，并为 branch recall
   * 提供 treeNodeId；deny-set 中的节点不会出现在投影里。
   */
  public inspectTreeStructure(): MemoryTreeStructureProjectionV2 {
    const snapshot = this.readSnapshot()
    const denyGeneration = this.readDenyGeneration()
    if (snapshot.version === 0) return { snapshotVersion: 0, denyGeneration, nodes: [] }
    const denied = this.readDeniedSubjects()
    return {
      snapshotVersion: snapshot.version,
      denyGeneration,
      nodes: this.tree.current.nodes
        .filter((node) => isQueryableNodeV2(node) && !isDeniedNodeV2(node, denied))
        .map((node) => ({
          treeNodeId: node.stableKey,
          parentTreeNodeId: node.parentKey,
          nodeType: node.nodeType,
          namespace: node.namespace,
          subjectType: node.subjectType,
          subjectId: node.subjectId,
          visibilityState: node.visibilityState,
        })),
    }
  }

  public recall(input: MemoryRecallQueryV2): MemoryRecallQueryResultV2 {
    validateRecallQueryV2(input)
    const snapshot = this.readSnapshot()
    const denyGeneration = this.readDenyGeneration()
    if (snapshot.version === 0) {
      const indexState = this.readIndexState(0, denyGeneration)
      return {
        snapshotVersion: 0,
        denyGeneration,
        indexState,
        degraded: indexState !== 'ready',
        candidateCount: 0,
        hydratedNodeCount: 0,
        items: [],
      }
    }
    const nodes = this.tree.current.nodes
    const byStableKey = new Map(nodes.map((node) => [node.stableKey, node]))
    const denied = this.readDeniedSubjects()
    const privacy = this.readPrivacyProjection()
    const limit = Math.min(input.limit ?? DefaultRecallLimitV2, MaximumRecallLimitV2)
    const indexState = this.readIndexState(snapshot.version, denyGeneration)
    let reason: MemoryRecallReasonV2
    let candidates: MemoryTreeNodeStructV2[]

    if (input.branchTreeNodeId) {
      reason = 'branch'
      const branch = byStableKey.get(input.branchTreeNodeId)
      candidates =
        branch && isQueryableNodeV2(branch) && !isDeniedNodeV2(branch, denied) ? [branch] : []
    } else if (indexState === 'ready') {
      const queryTokens = tokenizeMemoryQueryV2(input.query)
      candidates = this.rankSearchCandidates(queryTokens, byStableKey, denied).slice(0, limit)
      reason = !isEmpty(candidates) ? 'search' : 'active-path-fallback'
      if (isEmpty(candidates)) {
        candidates = resolveFallbackNodesV2(snapshot, nodes, denied)
      }
    } else {
      reason = 'active-path-fallback'
      candidates = resolveFallbackNodesV2(snapshot, nodes, denied)
    }

    const items = candidates.slice(0, limit).map((candidate) =>
      this.hydrateProjection({
        candidate,
        nodesByStableKey: byStableKey,
        denied,
        privacy,
        revealSensitive: Boolean(input.revealSensitive),
        snapshotVersion: snapshot.version,
        denyGeneration,
        reason,
      })
    )
    return {
      snapshotVersion: snapshot.version,
      denyGeneration,
      indexState,
      degraded: indexState !== 'ready' && !input.branchTreeNodeId,
      candidateCount: candidates.length,
      hydratedNodeCount: items.reduce((count, item) => count + item.path.length, 0),
      items,
    }
  }

  private rankSearchCandidates(
    queryTokens: ReadonlySet<string>,
    byStableKey: ReadonlyMap<string, MemoryTreeNodeStructV2>,
    denied: ReadonlySet<string>
  ): MemoryTreeNodeStructV2[] {
    if (!this.searchIndex || queryTokens.size === 0) return []
    return this.searchIndex.entries
      .map((entry) => {
        const overlap = countTokenOverlapV2(queryTokens, entry.tokens)
        return {
          entry,
          score: overlap / queryTokens.size + entry.activation * 0.08 + entry.mainlineScore * 0.04,
          overlap,
        }
      })
      .filter((candidate) => candidate.overlap > 0)
      .sort((left, right) => {
        if (left.score !== right.score) return right.score - left.score
        if (left.entry.lastActiveAt !== right.entry.lastActiveAt)
          return right.entry.lastActiveAt - left.entry.lastActiveAt
        return compareTextV2(left.entry.treeNodeId, right.entry.treeNodeId)
      })
      .flatMap((candidate) => {
        const node = byStableKey.get(candidate.entry.treeNodeId)
        return node && isQueryableNodeV2(node) && !isDeniedNodeV2(node, denied) ? [node] : []
      })
  }

  private hydrateProjection(input: {
    candidate: MemoryTreeNodeStructV2
    nodesByStableKey: ReadonlyMap<string, MemoryTreeNodeStructV2>
    denied: ReadonlySet<string>
    privacy: PrivacyProjectionV2
    revealSensitive: boolean
    snapshotVersion: number
    denyGeneration: number
    reason: MemoryRecallReasonV2
  }): MemoryRecallProjectionV2 {
    const pathNodes = buildPathV2(input.candidate, input.nodesByStableKey).filter(
      (node) => !isDeniedNodeV2(node, input.denied)
    )
    const path = pathNodes.map((node) =>
      this.hydratePathNode(node, input.privacy, input.revealSensitive)
    )
    const entityIds = collectEntityIdsV2(pathNodes)
    return {
      treeNodeId: input.candidate.stableKey,
      snapshotVersion: input.snapshotVersion,
      denyGeneration: input.denyGeneration,
      retrievalReason: input.reason,
      confidence: input.candidate.confidence,
      conceptIds: entityIds.conceptIds,
      episodeIds: entityIds.episodeIds,
      claimIds: entityIds.claimIds,
      evidenceIds: this.readActiveEvidenceIds(pathNodes),
      path,
    }
  }

  private hydratePathNode(
    node: MemoryTreeNodeStructV2,
    privacy: PrivacyProjectionV2,
    revealSensitive: boolean
  ): MemoryQueryPathNodeV2 {
    const sensitive = privacy.sensitiveSubjectKeys.has(subjectKeyV2(node))
    let label: Nullable<string> = null
    if (sensitive && !revealSensitive) {
      label = SensitiveLabelV2
    } else if (
      node.visibilityState !== 'redacted' &&
      node.content.blobRef &&
      node.content.commitment
    ) {
      const plaintext = this.contentKeys.openContent(node.content.blobRef, node.content.commitment)
      try {
        label = plaintext.toString('utf8')
      } finally {
        plaintext.fill(0)
      }
    }
    return {
      treeNodeId: node.stableKey,
      parentTreeNodeId: node.parentKey,
      nodeType: node.nodeType,
      namespace: node.namespace,
      subjectType: node.subjectType,
      subjectId: node.subjectId,
      label,
      sensitive,
      confidence: node.confidence,
      activation: node.activation,
      firstSeenAt: node.firstSeenAt,
      lastActiveAt: node.lastActiveAt,
    }
  }

  private readActiveEvidenceIds(nodes: readonly MemoryTreeNodeStructV2[]): readonly string[] {
    const evidenceIds = new Set<string>()
    const queries: Partial<Record<string, string>> = {
      concept: `SELECT evidence_id FROM memory_concept_evidence WHERE concept_id = ?`,
      episode: `SELECT evidence_id FROM memory_episode_evidence WHERE episode_id = ?`,
      claim: `SELECT evidence_id FROM memory_claim_evidence WHERE claim_id = ?`,
      relation: `SELECT evidence_id FROM memory_relation_evidence WHERE relation_id = ?`,
    }
    for (const node of nodes) {
      const query = queries[node.subjectType]
      if (!query) continue
      const ids = this.authority.database.prepare(query).pluck().all(node.subjectId) as string[]
      for (const evidenceId of ids) evidenceIds.add(evidenceId)
    }
    if (evidenceIds.size === 0) return []
    const eligible = this.authority.database.prepare(
      `SELECT 1 FROM memory_evidence evidence
       WHERE evidence.id = ?
         AND evidence.eligibility_state = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM memory_erasure_targets denied
           WHERE denied.target_type = 'evidence'
             AND denied.target_id = evidence.id
             AND denied.state = 'active'
         )`
    )
    return [...evidenceIds]
      .filter((evidenceId) => Boolean(eligible.get(evidenceId)))
      .sort(compareTextV2)
  }

  private readSnapshot(): QueryAuthoritySnapshotV2 {
    if (this.tree.version === 0) return { version: 0, globalMainlineNodeId: null }
    const row = this.authority.database
      .prepare(
        `SELECT version, global_mainline_node_id
         FROM memory_tree_snapshots
         WHERE version = ?`
      )
      .get(this.tree.version) as { version: number; global_mainline_node_id: string } | undefined
    if (!row) {
      throw new AppError('INVARIANT', '当前树版本缺少 snapshot 权威行。')
    }
    return {
      version: row.version,
      globalMainlineNodeId: row.global_mainline_node_id,
    }
  }

  private readDenyGeneration(): number {
    return this.authority.database
      .prepare(`SELECT integer_value FROM memory_meta WHERE key = 'privacy_generation'`)
      .pluck()
      .get() as number
  }

  private readIndexState(
    snapshotVersion: number,
    denyGeneration: number
  ): MemoryRecallIndexStateV2 {
    if (!this.searchIndex) return 'missing'
    return this.searchIndex.snapshotVersion === snapshotVersion &&
      this.searchIndex.denyGeneration === denyGeneration
      ? 'ready'
      : 'stale'
  }

  private readDeniedSubjects(): ReadonlySet<string> {
    const rows = this.authority.database
      .prepare(
        `SELECT target_type, target_id
         FROM memory_erasure_targets
         WHERE state = 'active'`
      )
      .all() as Array<{ target_type: string; target_id: string }>
    return new Set(rows.map((row) => `${row.target_type}\0${row.target_id}`))
  }

  private readPrivacyProjection(): PrivacyProjectionV2 {
    const sensitive = new Set<string>()
    const conceptRows = this.authority.database
      .prepare(
        `SELECT id FROM memory_concepts
         WHERE privacy_class = 'sensitive'`
      )
      .pluck()
      .all() as string[]
    for (const id of conceptRows) sensitive.add(`concept\0${id}`)
    const claimRows = this.authority.database
      .prepare(
        `SELECT id FROM memory_claims
         WHERE privacy_class = 'sensitive'`
      )
      .pluck()
      .all() as string[]
    for (const id of claimRows) sensitive.add(`claim\0${id}`)
    const episodeRows = this.authority.database
      .prepare(
        `SELECT DISTINCT link.episode_id
         FROM memory_episode_evidence link
         JOIN memory_evidence evidence ON evidence.id = link.evidence_id
         WHERE evidence.privacy_class = 'sensitive'`
      )
      .pluck()
      .all() as string[]
    for (const id of episodeRows) sensitive.add(`episode\0${id}`)
    return { sensitiveSubjectKeys: sensitive }
  }
}

function validateRecallQueryV2(input: MemoryRecallQueryV2): void {
  if (!isString(input.query)) {
    throw new AppError('VALIDATION', 'memory recall query 必须是字符串。')
  }
  if (isPresent(input.branchTreeNodeId) && isEmpty(input.branchTreeNodeId)) {
    throw new AppError('VALIDATION', 'branchTreeNodeId 不得为空。')
  }
  if (isPresent(input.limit) && (!Number.isSafeInteger(input.limit) || input.limit < 1)) {
    throw new AppError('VALIDATION', 'memory recall limit 必须是正安全整数。')
  }
}

function resolveFallbackNodesV2(
  snapshot: QueryAuthoritySnapshotV2,
  nodes: readonly MemoryTreeNodeStructV2[],
  denied: ReadonlySet<string>
): MemoryTreeNodeStructV2[] {
  const mainline = snapshot.globalMainlineNodeId
    ? nodes.find(
        (node) =>
          node.stableKey === snapshot.globalMainlineNodeId &&
          isQueryableNodeV2(node) &&
          !isDeniedNodeV2(node, denied)
      )
    : null
  if (mainline) return [mainline]
  const fallback = [...nodes]
    .filter(
      (node) =>
        isQueryableNodeV2(node) && !isDeniedNodeV2(node, denied) && node.namespace !== 'root'
    )
    .sort((left, right) => {
      if (left.mainlineScore !== right.mainlineScore)
        return right.mainlineScore - left.mainlineScore
      if (left.lastActiveAt !== right.lastActiveAt) return right.lastActiveAt - left.lastActiveAt
      return compareTextV2(left.stableKey, right.stableKey)
    })[0]
  return fallback ? [fallback] : []
}

function buildPathV2(
  anchor: MemoryTreeNodeStructV2,
  byStableKey: ReadonlyMap<string, MemoryTreeNodeStructV2>
): MemoryTreeNodeStructV2[] {
  const reversed: MemoryTreeNodeStructV2[] = []
  const visited = new Set<string>()
  let cursor: MemoryTreeNodeStructV2 | undefined = anchor
  while (cursor && reversed.length < MaximumPathNodesV2) {
    if (visited.has(cursor.stableKey)) {
      throw new AppError('INVARIANT', '记忆树路径出现环。')
    }
    visited.add(cursor.stableKey)
    reversed.push(cursor)
    cursor = cursor.parentKey ? byStableKey.get(cursor.parentKey) : undefined
  }
  return reversed.reverse()
}

function collectEntityIdsV2(nodes: readonly MemoryTreeNodeStructV2[]): {
  conceptIds: readonly string[]
  episodeIds: readonly string[]
  claimIds: readonly string[]
} {
  const conceptIds = new Set<string>()
  const episodeIds = new Set<string>()
  const claimIds = new Set<string>()
  for (const node of nodes) {
    if (node.subjectType === 'concept') conceptIds.add(node.subjectId)
    if (node.subjectType === 'episode') episodeIds.add(node.subjectId)
    if (node.subjectType === 'claim') claimIds.add(node.subjectId)
  }
  return {
    conceptIds: [...conceptIds].sort(compareTextV2),
    episodeIds: [...episodeIds].sort(compareTextV2),
    claimIds: [...claimIds].sort(compareTextV2),
  }
}

function isQueryableNodeV2(node: MemoryTreeNodeStructV2): boolean {
  return node.visibilityState !== 'redacted' && !node.content.redacted
}

function isDeniedNodeV2(node: MemoryTreeNodeStructV2, denied: ReadonlySet<string>): boolean {
  return denied.has(subjectKeyV2(node)) || denied.has(`tree_node\0${node.stableKey}`)
}

function subjectKeyV2(node: MemoryTreeNodeStructV2): string {
  return `${node.subjectType}\0${node.subjectId}`
}

function tokenizeMemoryQueryV2(value: string): ReadonlySet<string> {
  const normalized = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.]+/gu, ' ')
    .trim()
  const tokens = new Set<string>()
  for (const word of normalized.split(/\s+/u)) {
    if (!word) continue
    tokens.add(word)
    const characters = [...word]
    if (characters.some((character) => /\p{Script=Han}/u.test(character))) {
      for (const character of characters) tokens.add(character)
      for (let index = 0; index < characters.length - 1; index += 1) {
        tokens.add(`${characters[index]}${characters[index + 1]}`)
      }
    }
  }
  return tokens
}

function countTokenOverlapV2(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let count = 0
  for (const token of left) {
    if (right.has(token)) count += 1
  }
  return count
}

function compareTextV2(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
