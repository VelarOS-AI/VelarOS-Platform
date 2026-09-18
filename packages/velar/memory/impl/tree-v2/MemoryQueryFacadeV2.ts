import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { MemoryTreeNodeStructV2 } from '../../types/tree-v2/diff.js'
import type {
  HydrateMemoryRecallProjectionInputV2,
  MemoryErasureTargetRowV2,
  MemoryQueryPathNodeV2,
  MemoryRecallIndexRefreshReportV2,
  MemoryRecallIndexStateV2,
  MemoryRecallProjectionV2,
  MemoryRecallQueryResultV2,
  MemoryRecallQueryV2,
  MemoryRecallReasonV2,
  MemoryTreeStructureProjectionV2,
  PrivacyProjectionV2,
  QueryAuthoritySnapshotRowV2,
  QueryAuthoritySnapshotV2,
  SearchIndexEntryV2,
  SearchIndexGenerationV2,
} from '../../types/tree-v2/query.js'
import { compareCodeUnitV2 } from '../../utils/tree-v2/checks.js'
import {
  buildPathV2,
  collectEntityIdsV2,
  countTokenOverlapV2,
  isDeniedNodeV2,
  isQueryableNodeV2,
  resolveFallbackNodesV2,
  SensitiveLabelV2,
  subjectKeyV2,
  tokenizeMemoryQueryV2,
  validateRecallQueryV2,
} from '../../utils/tree-v2/query.js'
import { MemoryTuning } from '../../utils/tuning.js'

import type { ContentKeyServiceV2Api } from './storage/ContentKeyServiceV2.js'
import type { MemoryAuthorityDatabaseV2Api } from './MemoryAuthorityDatabaseV2.js'
import type { MemoryTreeStoreV2Api } from './MemoryTreeStoreV2.js'

/**
 * 已提交树的唯一查询门面：召回、树结构投影与内存搜索索引的持有者。
 *
 * 同步召回从不启动模型、网络或全库解密：搜索只读显式后台刷新出来的内存索引；
 * 索引缺失或陈旧时确定性降级到当前主线路径。每次只解密最终 top-K 路径，
 * 并按「树版本 + 隐私代」双键判断缓存还能不能用。
 * 实例归 `MemorySystemRuntimeV2`（或探针）所有，索引随实例存活。
 */
export interface MemoryQueryFacadeV2Api {
  /**
   * 显式后台入口：按当前树重建内存搜索索引，返回这一代的读数。
   * 调用方应该放在空闲或整理调度路径上；同步召回永远不会隐式调它。
   * 只在进程内留归一化 token，不产生明文磁盘索引。
   */
  refreshSearchIndex(): MemoryRecallIndexRefreshReportV2
  /** 丢掉内存搜索索引（关闭前调用，避免 token 留在进程里）。 */
  clearSearchIndex(): void
  /**
   * 只给稳定结构标识、不解密正文的树投影，给宿主维护树选择态、并为分支召回提供节点 id。
   * 在擦除名单里的节点不会出现在投影里。
   */
  inspectTreeStructure(): MemoryTreeStructureProjectionV2
  /**
   * 召回：指定分支就只取那个节点，否则按内存索引打分；索引没就绪时降级到主线路径。
   * 入参不合法抛 VALIDATION；当前树版本缺 snapshot 权威行抛 INVARIANT。
   */
  recall(input: MemoryRecallQueryV2): MemoryRecallQueryResultV2
}

export class MemoryQueryFacadeV2 implements MemoryQueryFacadeV2Api {
  /** 打分里激活度的权重（相对 token 覆盖率）。 */
  private static readonly ActivationWeight = 0.08

  /** 打分里主线权重的权重（相对 token 覆盖率）。 */
  private static readonly MainlineWeight = 0.04

  private searchIndex: Nullable<SearchIndexGenerationV2> = null

  constructor(
    private readonly authority: MemoryAuthorityDatabaseV2Api,
    private readonly contentKeys: ContentKeyServiceV2Api,
    private readonly tree: MemoryTreeStoreV2Api
  ) {}

  public refreshSearchIndex(): MemoryRecallIndexRefreshReportV2 {
    const snapshot = this.readSnapshot()
    const denyGeneration = this.readDenyGeneration()
    if (snapshot.version === 0) {
      this.searchIndex = { snapshotVersion: 0, denyGeneration, entries: [] }
      return {
        snapshotVersion: 0,
        denyGeneration,
        indexedNodeCount: 0,
        skippedSensitiveCount: 0,
        skippedDeniedCount: 0,
      }
    }
    const denied = this.readDeniedSubjects()
    const privacy = this.readPrivacyProjection()
    const entries: SearchIndexEntryV2[] = []
    let skippedSensitiveCount = 0
    let skippedDeniedCount = 0
    for (const node of this.tree.current.nodes) {
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
    this.searchIndex = { snapshotVersion: snapshot.version, denyGeneration, entries }
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
    const limit = Math.min(
      input.limit ?? MemoryTuning.treeV2.recallDefaultLimit,
      MemoryTuning.treeV2.recallMaxLimit
    )
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

  /** 按 token 覆盖率加激活度、主线权重打分排序，再映射回当前树上还能查的节点。 */
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
          score:
            overlap / queryTokens.size +
            entry.activation * MemoryQueryFacadeV2.ActivationWeight +
            entry.mainlineScore * MemoryQueryFacadeV2.MainlineWeight,
          overlap,
        }
      })
      .filter((candidate) => candidate.overlap > 0)
      .sort((left, right) => {
        if (left.score !== right.score) return right.score - left.score
        if (left.entry.lastActiveAt !== right.entry.lastActiveAt) return right.entry.lastActiveAt - left.entry.lastActiveAt
        return compareCodeUnitV2(left.entry.treeNodeId, right.entry.treeNodeId)
      })
      .flatMap((candidate) => {
        const node = byStableKey.get(candidate.entry.treeNodeId)
        return node && isQueryableNodeV2(node) && !isDeniedNodeV2(node, denied) ? [node] : []
      })
  }

  /** 把一个候选补全成召回结果：解路径、收实体 id、查还可用的证据。 */
  private hydrateProjection(
    input: HydrateMemoryRecallProjectionInputV2
  ): MemoryRecallProjectionV2 {
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

  /** 解一个路径节点的正文：敏感且未授权给模糊标签，redact 过的给 null。 */
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

  /** 收路径上各实体牵连的证据 id，并滤掉不再可用或已进擦除名单的。 */
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
      .sort(compareCodeUnitV2)
  }

  /** 读当前树版本对应的 snapshot 权威行；空树返回零值，缺行抛 INVARIANT。 */
  private readSnapshot(): QueryAuthoritySnapshotV2 {
    if (this.tree.version === 0) return { version: 0, globalMainlineNodeId: null }
    const row = this.authority.database
      .prepare(
        `SELECT version, global_mainline_node_id
         FROM memory_tree_snapshots
         WHERE version = ?`
      )
      .get(this.tree.version) as QueryAuthoritySnapshotRowV2 | undefined
    if (!row) {
      throw new AppError('INVARIANT', '当前树版本缺少 snapshot 权威行。')
    }
    return {
      version: row.version,
      globalMainlineNodeId: row.global_mainline_node_id,
    }
  }

  /** 读隐私代：擦除与隐私分级每变一次它就推进一格，用来判断缓存还能不能用。 */
  private readDenyGeneration(): number {
    return this.authority.database
      .prepare(`SELECT integer_value FROM memory_meta WHERE key = 'privacy_generation'`)
      .pluck()
      .get() as number
  }

  /** 判断内存索引相对当前树版本与隐私代是就绪、缺失还是陈旧。 */
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

  /** 读当前生效的擦除名单，拼成 `<type>\0<id>` 的键集。 */
  private readDeniedSubjects(): ReadonlySet<string> {
    const rows = this.authority.database
      .prepare(
        `SELECT target_type, target_id
         FROM memory_erasure_targets
         WHERE state = 'active'`
      )
      .all() as MemoryErasureTargetRowV2[]
    return new Set(rows.map((row) => `${row.target_type}\0${row.target_id}`))
  }

  /** 读敏感实体投影：概念与主张看自己的隐私分级，情节看它挂的证据。 */
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
