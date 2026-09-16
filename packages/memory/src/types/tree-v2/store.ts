import type { MemoryAuthorityOpenReportV2 } from './authority'
import type {
  MemoryTreeDiffOpV2,
  MemoryTreeNodeStructV2,
  MemoryTreeReplayResultV2,
} from './diff'
import type { MemoryWrappingRootV2 } from './storage'

/**
 * 记忆树 v2 的存储与组合根数据形状：物化基点、检查点、投影派生代、提交入参与读数、
 * 权威表的行形状。树 v2 是包内子系统，这些类型不出包。
 */

/** 权威库里几张表共用的「一个整数值」行形状。 */
export interface MemoryMetaIntegerRowV2 {
  /** 这一行的整数值。 */
  readonly integer_value: number
}

/** `SELECT count(*) AS count` 的行形状。 */
export interface MemoryCountRowV2 {
  /** 计数结果。 */
  readonly count: number
}

/** blob 账本里只取状态那一列的行形状。 */
export interface MemoryBlobStateRowV2 {
  /** blob 状态：active 或 erased。 */
  readonly state: string
}

/** 物化基点的清单：节点键、密文引用与 redact 名册，基点哈希对它算。 */
export interface MemoryTreeBaseManifestV2 {
  /** 格式身份，固定 `velaros.memory.tree-base-manifest.v2`。 */
  readonly format: 'velaros.memory.tree-base-manifest.v2'
  /** 这个基点所在的树版本。 */
  readonly baseVersion: number
  /** 全部节点的 stableKey，按码元序。 */
  readonly nodeStableKeys: readonly string[]
  /** 基点引用到的全部 blob id，去重后按码元序。 */
  readonly blobRefs: readonly string[]
  /** 处于 redacted 的节点键，按码元序。 */
  readonly redactedStableKeys: readonly string[]
  /** 节点总数。 */
  readonly nodeCount: number
  /** redacted 节点数。 */
  readonly redactedCount: number
}

/** 物化基点的完整状态 blob（封成密文存进 authority）。 */
export interface MemoryTreeBaseStateV2 {
  /** 格式身份，固定 `velaros.memory.tree-base-state.v2`。 */
  readonly format: 'velaros.memory.tree-base-state.v2'
  /** 这个基点所在的树版本。 */
  readonly baseVersion: number
  /** 基点的全部节点，按 stableKey 的码元序。 */
  readonly nodes: readonly MemoryTreeNodeStructV2[]
  /** 与 nodes 对应的清单。 */
  readonly manifest: MemoryTreeBaseManifestV2
}

/** 物化基点的三个哈希锚点。 */
export interface MemoryTreeBaseHashesV2 {
  /** 基点节点集的状态哈希。 */
  readonly treeHash: string
  /** 清单哈希。 */
  readonly manifestHash: string
  /** 基点事件哈希（链的再锚定点）。 */
  readonly baseEventHash: string
}

/** 内存里的一个检查点：某个版本连同它的正向重放结果。 */
export interface MemoryTreeCheckpointV2 {
  /** 检查点所在的树版本。 */
  readonly version: number
  /** 这个版本的正向重放结果。 */
  readonly replay: MemoryTreeReplayResultV2
}

/** 落进派生代里的检查点（不带重放来源标记）。 */
export interface PersistedMemoryTreeCheckpointV2 {
  /** 检查点所在的树版本。 */
  readonly version: number
  /** 这一版的状态哈希。 */
  readonly treeHash: string
  /** 这一版的全部节点。 */
  readonly nodes: readonly MemoryTreeNodeStructV2[]
}

/** 派生代里封存的树投影产物。 */
export interface MemoryTreeProjectionArtifactV2 {
  /** 格式身份，固定 `velaros.memory.tree-projection-index.v2`。 */
  readonly format: 'velaros.memory.tree-projection-index.v2'
  /** 这份投影对应的树版本。 */
  readonly treeVersion: number
  /** 这份投影的状态哈希。 */
  readonly treeHash: string
  /** 当前树的全部节点。 */
  readonly nodes: readonly MemoryTreeNodeStructV2[]
  /** 随投影一起缓存的检查点，按版本升序。 */
  readonly checkpoints: readonly PersistedMemoryTreeCheckpointV2[]
}

/** 检查派生代与权威链是否一致的读数。 */
export interface MemoryTreeProjectionInspectionV2 {
  /** 当前生效的派生代号。 */
  readonly generation: number
  /** 这一代与权威链的当前版本、状态哈希、节点字节是不是都对得上。 */
  readonly matchesAuthority: boolean
  /** 这一代里缓存了几个检查点。 */
  readonly checkpointCount: number
}

/** `memory_tree_diffs` 的行形状。 */
export interface MemoryTreeDiffRowV2 {
  /** 这一步之后的树版本。 */
  version: number
  /** 这一步之前的树版本。 */
  base_version: number
  /** canonical 序列化的结构事件数组。 */
  ops_json: string
  /** canonical 序列化的身份变更；没有为 null。 */
  identity_change_json: Nullable<string>
  /** 结构事件条数（与 ops_json 互校）。 */
  op_count: number
  /** 上一个事件的哈希。 */
  previous_event_hash: string
  /** 这一步的事件哈希。 */
  event_hash: string
  /** 产生这一步的运行 id。 */
  created_by_run_id: string
  /** 提交时刻（毫秒）。 */
  created_at: number
}

/** `memory_tree_snapshots` 的行形状。 */
export interface MemoryTreeSnapshotRowV2 {
  /** 这一版的树版本。 */
  version: number
  /** 根节点的 stableKey。 */
  root_node_id: string
  /** 这一版生效的身份纪元 id。 */
  active_identity_epoch_id: string
  /** 全局主线节点的 stableKey。 */
  global_mainline_node_id: string
  /** 这一版消化到的证据序号。 */
  frontier_evidence_sequence: number
  /** 产生这一版的运行 id。 */
  created_by_run_id: string
  /** 这一版的状态哈希。 */
  tree_hash: string
  /** 这一版的事件头哈希。 */
  event_head_hash: string
  /** 这一步各类结构事件的计数摘要。 */
  diff_summary_json: string
  /** 提交时刻（毫秒）。 */
  created_at: number
}

/** `memory_tree_bases` 的行形状。 */
export interface MemoryTreeBaseRowV2 {
  /** 基点所在的树版本。 */
  base_version: number
  /** 基点状态 blob 的引用。 */
  state_blob_ref: string
  /** 基点状态 blob 的承诺。 */
  state_commitment: string
  /** 基点的状态哈希。 */
  tree_hash: string
  /** 这次压缩吃掉的起始版本。 */
  compacted_from_version: number
  /** 这次压缩吃掉的结束版本。 */
  compacted_to_version: number
  /** 基点之前那一段链的事件头哈希。 */
  prior_segment_event_head: string
  /** 基点事件哈希。 */
  base_event_hash: string
  /** canonical 序列化规范的版本。 */
  canonical_version: number
  /** 压缩协议的版本。 */
  compaction_version: number
  /** 清单哈希。 */
  manifest_hash: string
  /** 建基点的时刻（毫秒）。 */
  created_at: number
}

/** 一步身份纪元变更。 */
export interface MemoryTreeIdentityChangeV2 {
  /** 新的身份纪元 id。 */
  readonly epochId: string
  /** 纪元序号，正整数。 */
  readonly sequence: number
  /** 上一个纪元 id；首个纪元为 null。 */
  readonly predecessorId: Nullable<string>
}

/** 提交一个树版本时，本包自己的参与者（在树 CAS 后、snapshot/diff 前跑，抛错整事务回滚）。 */
export interface MemoryTreeAuthorityCommitParticipantV2 {
  /** 在树版本 CAS 成功、写 snapshot 之前执行。 */
  apply(): void
  /** 在写完 snapshot、写 diff 之前执行。 */
  applyAfterSnapshot?(): void
}

/** 一次整理运行的提交读数，随树版本一起落库。 */
export interface MemoryDreamRunCommitV2 {
  /** 这次运行的 id。 */
  readonly runId: string
  /** 这次运行输入的指纹 `f2:<64 hex>`。 */
  readonly inputFingerprint: string
  /** 运行开始时消化到的证据序号。 */
  readonly frontierBefore: number
  /** 这次运行用掉的 token 数。 */
  readonly tokenUsage: number
  /** 这次运行产生的候选数。 */
  readonly candidateCount: number
  /** 被接受的候选数。 */
  readonly acceptedCount: number
  /** 被拒绝的候选数（与接受数之和必须等于候选数）。 */
  readonly rejectedCount: number
  /** 结束时刻（毫秒）；不给就用提交时刻。 */
  readonly finishedAt?: number
}

/** 提交一个树版本的入参。 */
export interface CommitMemoryTreeVersionInputV2 {
  /** 提交基线：必须等于当前树版本，否则 CAS 失败。 */
  readonly expectedBaseVersion: number
  /** 这一步的结构事件。 */
  readonly ops: readonly MemoryTreeDiffOpV2[]
  /** 这一步附带的身份纪元变更。 */
  readonly identityChange?: LooseOptional<MemoryTreeIdentityChangeV2>
  /** 这一版生效的身份纪元 id。 */
  readonly activeIdentityEpochId: string
  /** 全局主线节点的 stableKey，必须在提交后的树里。 */
  readonly globalMainlineNodeId: string
  /** 这一版消化到的证据序号，只进不退。 */
  readonly frontierEvidenceSequence: number
  /** 产生这一版的运行 id。 */
  readonly createdByRunId: string
  /** 提交时刻（毫秒）；不给用 Date.now。 */
  readonly createdAt?: number
  /** 随这一版一起落库的整理运行读数。 */
  readonly dreamRunCommit?: MemoryDreamRunCommitV2
  /** 本包自己的事务参与者；在树 CAS 后、snapshot/diff 前运行，抛错即整事务回滚。 */
  readonly authorityCommit?: MemoryTreeAuthorityCommitParticipantV2
  /** Erasure 第一段专用：即使没有投影节点命中，也推进事件版本使并发 Dream 的 CAS 失效。 */
  readonly erasureCommit?: boolean
}

/** 提交一个树版本的结果。 */
export interface CommitMemoryTreeVersionResultV2 {
  /** 新的树版本。 */
  readonly version: number
  /** 新版本的状态哈希。 */
  readonly treeHash: string
  /** 新版本的事件哈希。 */
  readonly eventHash: string
  /** 派生投影有没有跟着刷新成功；false 表示已降级，可稍后重建。 */
  readonly projectionPersisted: boolean
}

/** 一批证据消化完但没产生树事件时的提交入参。 */
export interface CommitMemoryDreamNoopInputV2 {
  /** 期望的当前树版本，CAS 用。 */
  readonly expectedTreeVersion: number
  /** 这一批消化到的证据序号。 */
  readonly frontierEvidenceSequence: number
  /** 这次整理运行的提交读数。 */
  readonly dreamRunCommit: MemoryDreamRunCommitV2
  /** 提交时刻（毫秒）；不给用 Date.now。 */
  readonly committedAt?: number
  /** 本包自己的事务参与者。 */
  readonly authorityCommit?: MemoryTreeAuthorityCommitParticipantV2
}

/** 在当前 head 建物化基点的入参。 */
export interface CompactMemoryTreeHeadInputV2 {
  /** 这次压缩的 id（落进压缩账本）。 */
  readonly compactionId: string
  /** 压缩时刻（毫秒）；不给用 Date.now。 */
  readonly createdAt?: number
}

/** 建物化基点的结果。 */
export interface CompactMemoryTreeHeadResultV2 {
  /** 新基点所在的树版本。 */
  readonly baseVersion: number
  /** 基点事件哈希。 */
  readonly baseEventHash: string
  /** 清单哈希。 */
  readonly manifestHash: string
  /** 这次删掉的 diff 行数。 */
  readonly deletedDiffCount: number
}

/** 打开树存储的一次读数。 */
export interface MemoryTreeStoreOpenReportV2 {
  /** 重建出来的当前树版本；空库是 0。 */
  readonly treeVersion: number
  /** 当前生效的物化基点版本；没有基点是 0。 */
  readonly baseVersion: number
  /** 这次从基点之后重放了多少条 diff。 */
  readonly replayedDiffCount: number
  /** 重放过程中攒下多少个检查点。 */
  readonly checkpointCount: number
  /** 派生投影是不是因为缺失或损坏被重建了。 */
  readonly projectionRebuilt: boolean
}

/** 从权威链重建出来的一棵树（打开时的中间结果）。 */
export interface ReconstructedTreeV2 {
  /** 重建出来的当前树版本。 */
  readonly version: number
  /** 当前生效的物化基点版本。 */
  readonly baseVersion: number
  /** 当前的事件头哈希。 */
  readonly eventHead: string
  /** 当前树的正向重放结果。 */
  readonly current: MemoryTreeReplayResultV2
  /** 重放过程中攒下的检查点。 */
  readonly checkpoints: readonly MemoryTreeCheckpointV2[]
  /** 这次重放了多少条 diff。 */
  readonly replayedDiffCount: number
}

/** 打开包内组合根的入参。 */
export interface OpenMemorySystemRuntimeOptionsV2 {
  /** 宿主注入的数据根（绝对路径）。 */
  readonly dataRoot: string
  /** 宿主注入的 OS 包装根。 */
  readonly wrappingRoot: MemoryWrappingRootV2
  /** 取当前时刻的函数；不给用 Date.now。 */
  readonly now?: () => number
}

/** 打开包内组合根的一次读数。 */
export interface MemorySystemRuntimeOpenReportV2 {
  /** 权威库这一次的打开读数。 */
  readonly authority: MemoryAuthorityOpenReportV2
  /** 树存储这一次的打开读数。 */
  readonly tree: MemoryTreeStoreOpenReportV2
  /** 这次回收了多少个孤儿 blob。 */
  readonly recoveredOrphanBlobCount: number
  /** 这次续跑了多少个未完成的擦除 saga。 */
  readonly resumedErasureCount: number
}
