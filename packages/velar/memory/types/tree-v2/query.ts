import type { MemoryTreeNodeStructV2 } from './diff.js'

/**
 * 记忆树 v2 查询门面的数据形状：召回入参与投影、树结构投影、内存搜索索引与隐私投影。
 * 树 v2 是包内子系统，这些类型不出包。
 */

/** 这条召回结果是怎么来的：指定分支、搜索命中，还是降级到当前主线路径。 */
export type MemoryRecallReasonV2 = 'branch' | 'search' | 'active-path-fallback'

/** 内存搜索索引相对当前树与隐私代的状态。 */
export type MemoryRecallIndexStateV2 = 'ready' | 'missing' | 'stale'

/** 召回路径上的一个节点（正文按隐私判定决定解不解）。 */
export interface MemoryQueryPathNodeV2 {
  /** 节点的稳定标识。 */
  readonly treeNodeId: string
  /** 父节点的稳定标识。 */
  readonly parentTreeNodeId: Nullable<string>
  /** 节点类型。 */
  readonly nodeType: string
  /** 命名空间。 */
  readonly namespace: string
  /** 对应的实体种类。 */
  readonly subjectType: string
  /** 对应的实体 id。 */
  readonly subjectId: string
  /** 节点正文；敏感且未授权时是稳定的模糊标签，redact 过的是 null。 */
  readonly label: Nullable<string>
  /** 这个节点是不是敏感。 */
  readonly sensitive: boolean
  /** 置信度。 */
  readonly confidence: number
  /** 激活度。 */
  readonly activation: number
  /** 首次出现时刻（毫秒）。 */
  readonly firstSeenAt: number
  /** 最近活跃时刻（毫秒）。 */
  readonly lastActiveAt: number
}

/** 一条召回结果：命中节点、它的路径，以及路径上牵连到的实体与证据。 */
export interface MemoryRecallProjectionV2 {
  /** 命中节点的稳定标识。 */
  readonly treeNodeId: string
  /** 这次召回读到的树版本。 */
  readonly snapshotVersion: number
  /** 这次召回读到的隐私代。 */
  readonly denyGeneration: number
  /** 这条结果是怎么来的。 */
  readonly retrievalReason: MemoryRecallReasonV2
  /** 命中节点的置信度。 */
  readonly confidence: number
  /** 路径上的概念 id，按码元序。 */
  readonly conceptIds: readonly string[]
  /** 路径上的情节 id，按码元序。 */
  readonly episodeIds: readonly string[]
  /** 路径上的主张 id，按码元序。 */
  readonly claimIds: readonly string[]
  /** 路径牵连到的、仍然可用的证据 id，按码元序。 */
  readonly evidenceIds: readonly string[]
  /** 从根到命中节点的路径。 */
  readonly path: readonly MemoryQueryPathNodeV2[]
}

/** 一次召回的入参。 */
export interface MemoryRecallQueryV2 {
  /** 查询文本。 */
  readonly query: string
  /** 指定从哪个节点召回；给了就不走搜索。 */
  readonly branchTreeNodeId?: string
  /** 最多返回几条；不给用 MemoryTuning.treeV2.recallDefaultLimit，上限是 recallMaxLimit。 */
  readonly limit?: number
  /**
   * 只有宿主已经完成当前界面的隐私授权判定时才可以开。
   * 缺省输出稳定的模糊标签，不解密敏感节点。
   */
  readonly revealSensitive?: boolean
}

/** 一次召回的结果连同它的降级读数。 */
export interface MemoryRecallQueryResultV2 {
  /** 这次召回读到的树版本。 */
  readonly snapshotVersion: number
  /** 这次召回读到的隐私代。 */
  readonly denyGeneration: number
  /** 内存搜索索引的状态。 */
  readonly indexState: MemoryRecallIndexStateV2
  /** 这次是不是走了降级路径（索引没就绪且不是指定分支）。 */
  readonly degraded: boolean
  /** 筛出来的候选数。 */
  readonly candidateCount: number
  /** 这次一共解了多少个路径节点。 */
  readonly hydratedNodeCount: number
  /** 召回结果。 */
  readonly items: readonly MemoryRecallProjectionV2[]
}

/** 刷新内存搜索索引的一次读数。 */
export interface MemoryRecallIndexRefreshReportV2 {
  /** 这一代索引对应的树版本。 */
  readonly snapshotVersion: number
  /** 这一代索引对应的隐私代。 */
  readonly denyGeneration: number
  /** 进了索引的节点数。 */
  readonly indexedNodeCount: number
  /** 因为敏感被跳过的节点数。 */
  readonly skippedSensitiveCount: number
  /** 因为已 redact 或在擦除名单里被跳过的节点数。 */
  readonly skippedDeniedCount: number
}

/** 树结构投影里的一个节点：只有稳定标识，没有正文。 */
export interface MemoryTreeStructureNodeV2 {
  /** 节点的稳定标识。 */
  readonly treeNodeId: string
  /** 父节点的稳定标识。 */
  readonly parentTreeNodeId: Nullable<string>
  /** 节点类型。 */
  readonly nodeType: string
  /** 命名空间。 */
  readonly namespace: string
  /** 对应的实体种类。 */
  readonly subjectType: string
  /** 对应的实体 id。 */
  readonly subjectId: string
  /** 可见状态。 */
  readonly visibilityState: string
}

/** 不解密的树结构投影，给宿主维护树选择态用。 */
export interface MemoryTreeStructureProjectionV2 {
  /** 这次读到的树版本。 */
  readonly snapshotVersion: number
  /** 这次读到的隐私代。 */
  readonly denyGeneration: number
  /** 可查询且不在擦除名单里的节点。 */
  readonly nodes: readonly MemoryTreeStructureNodeV2[]
}

/** 内存搜索索引里的一条：只留归一化 token，不落盘。 */
export interface SearchIndexEntryV2 {
  /** 节点的稳定标识。 */
  readonly treeNodeId: string
  /** 这个节点正文切出来的 token 集。 */
  readonly tokens: ReadonlySet<string>
  /** 激活度（参与打分）。 */
  readonly activation: number
  /** 主线权重（参与打分）。 */
  readonly mainlineScore: number
  /** 最近活跃时刻（同分时用它排序）。 */
  readonly lastActiveAt: number
}

/** 一代内存搜索索引，连同它对应的树版本与隐私代。 */
export interface SearchIndexGenerationV2 {
  /** 这一代对应的树版本。 */
  readonly snapshotVersion: number
  /** 这一代对应的隐私代。 */
  readonly denyGeneration: number
  /** 索引条目。 */
  readonly entries: readonly SearchIndexEntryV2[]
}

/** 隐私投影：哪些实体是敏感的。 */
export interface PrivacyProjectionV2 {
  /** 敏感实体的键集（`<subjectType>\0<subjectId>`）。 */
  readonly sensitiveSubjectKeys: ReadonlySet<string>
}

/** 查询时用到的权威 snapshot 读数。 */
export interface QueryAuthoritySnapshotV2 {
  /** 当前树版本；空树是 0。 */
  readonly version: number
  /** 这一版的全局主线节点；空树是 null。 */
  readonly globalMainlineNodeId: Nullable<string>
}

/** 查 snapshot 主线节点时用的窄行形状。 */
export interface QueryAuthoritySnapshotRowV2 {
  /** 树版本。 */
  readonly version: number
  /** 全局主线节点的稳定标识。 */
  readonly global_mainline_node_id: string
}

/** 擦除名单的行形状。 */
export interface MemoryErasureTargetRowV2 {
  /** 目标种类。 */
  readonly target_type: string
  /** 目标 id。 */
  readonly target_id: string
}

/** 一次召回里把候选补全成投影所需要的全部材料。 */
export interface HydrateMemoryRecallProjectionInputV2 {
  /** 命中的候选节点。 */
  readonly candidate: MemoryTreeNodeStructV2
  /** 当前树的节点索引。 */
  readonly nodesByStableKey: ReadonlyMap<string, MemoryTreeNodeStructV2>
  /** 擦除名单。 */
  readonly denied: ReadonlySet<string>
  /** 隐私投影。 */
  readonly privacy: PrivacyProjectionV2
  /** 是否允许解密敏感节点。 */
  readonly revealSensitive: boolean
  /** 这次召回读到的树版本。 */
  readonly snapshotVersion: number
  /** 这次召回读到的隐私代。 */
  readonly denyGeneration: number
  /** 这条结果是怎么来的。 */
  readonly reason: MemoryRecallReasonV2
}

/** 路径上牵连到的三类实体 id。 */
export interface MemoryPathEntityIdsV2 {
  /** 概念 id，按码元序。 */
  readonly conceptIds: readonly string[]
  /** 情节 id，按码元序。 */
  readonly episodeIds: readonly string[]
  /** 主张 id，按码元序。 */
  readonly claimIds: readonly string[]
}
