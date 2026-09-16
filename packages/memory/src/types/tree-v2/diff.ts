/**
 * 记忆树 v2 结构事件链（TreeDiff）的数据形状：节点结构、九种操作、版本段与重放结果。
 * 树 v2 是包内子系统，这些类型不出包。
 */

/**
 * 结构事件的九个操作词。与 `utils/tree-v2/diff-chain.ts` 的词表一一对应；
 * 类型文件不许有值，所以这里直接列字面量。
 */
export type MemoryTreeDiffOpTypeV2 =
  | 'add'
  | 'update'
  | 'move'
  | 'merge'
  | 'split'
  | 'dormant'
  | 'reactivate'
  | 'remove'
  | 'redact'

/** ③ 类语义正文的结构层引用：结构历史永不内嵌明文。 */
export interface MemoryTreeContentRefV2 {
  /** 加密内容 blob 引用；crypto-shred 销毁后为 null（结构位置保留）。 */
  blobRef: Nullable<string>
  /** 随机化承诺（nonce 封装于加密信封内，非明文派生哈希）；redact 后保留但不可验证。 */
  commitment: string
  /** 彻底清除占位标记：true 时渲染 redacted 占位，不声称能验证已删原文。 */
  redacted: boolean
}

/** 节点的可见状态。 */
export type MemoryTreeVisibilityStateV2 = 'active' | 'dormant' | 'pruned' | 'redacted'

/**
 * 结构事件里的节点 payload：只含 ① 纯结构字段 + ③ 类内容引用。
 * 节点身份 = stableKey；父链接用 parentKey（同为 stableKey），使 diff 自包含、
 * 不依赖任何存储层生成的行 id。
 */
export interface MemoryTreeNodeStructV2 {
  /** 节点身份（跨版本稳定）。 */
  stableKey: string
  /** 父节点的 stableKey；根节点为 null。 */
  parentKey: Nullable<string>
  /** 节点类型（概念、情节、主张…）。 */
  nodeType: string
  /** 命名空间（作用域族）。 */
  namespace: string
  /** 这个节点对应的实体种类。 */
  subjectType: string
  /** 这个节点对应的实体 id。 */
  subjectId: string
  /** 语义正文的密文引用。 */
  content: MemoryTreeContentRefV2
  /** 主线权重（量化到 6 位小数）。 */
  mainlineScore: number
  /** 置信度（量化到 6 位小数）。 */
  confidence: number
  /** 激活度（量化到 6 位小数）。 */
  activation: number
  /** 首次出现时刻（毫秒）。 */
  firstSeenAt: number
  /** 最近活跃时刻（毫秒）。 */
  lastActiveAt: number
  /** 可见状态。 */
  visibilityState: MemoryTreeVisibilityStateV2
}

/**
 * 自包含可逆结构事件：before = 事件前受影响节点的完整结构，after = 事件后。
 * 正向 apply：删 before 键、插 after 节点；逆向 apply：对换。
 */
export interface MemoryTreeDiffOpV2 {
  /** 这个事件的语义操作词。 */
  type: MemoryTreeDiffOpTypeV2
  /** 事件前受影响节点的完整结构。 */
  before: readonly MemoryTreeNodeStructV2[]
  /** 事件后受影响节点的完整结构。 */
  after: readonly MemoryTreeNodeStructV2[]
}

/** 一个树版本：从 baseVersion 推进到 version，携带这一步的全部结构事件。 */
export interface MemoryTreeDiffV2 {
  /** 这一步之后的树版本。 */
  version: number
  /** 这一步之前的树版本。 */
  baseVersion: number
  /** 这一步的结构事件，按提交顺序。 */
  ops: readonly MemoryTreeDiffOpV2[]
}

/** 正向应用单个结构事件时的可选项。 */
export interface ApplyTreeDiffOpOptionsV2 {
  /** 是否逐节点核对 before 与现场逐字节一致；缺省 true（重放即自检）。 */
  strict?: boolean
}

/** 链式审计哈希的输入。 */
export interface HashTreeEventInputV2 {
  /** 上一个事件的哈希；创世用全零哨兵。 */
  previousEventHash: string
  /** 这一步之后的树版本。 */
  version: number
  /** 这一步之前的树版本。 */
  baseVersion: number
  /** 这一步的结构事件。 */
  ops: readonly MemoryTreeDiffOpV2[]
  /** 这一步附带的身份变更载荷；缺省恒序列化成 null。 */
  identityChange?: unknown
}

/** 物化基点的链再锚定哈希输入。 */
export interface HashTreeBaseEventInputV2 {
  /** 基点所在的树版本。 */
  baseVersion: number
  /** 基点的状态哈希。 */
  treeHash: string
  /** 基点之前那一段链的事件头哈希。 */
  priorSegmentEventHead: string
  /** 基点清单的哈希。 */
  manifestHash: string
}

/** 一次重放的结果：纯数据，持久化资格另由 `MemoryTreeReplayV2` 的登记表裁决。 */
export interface MemoryTreeReplayResultV2 {
  /** 重放后的全部节点，按 stableKey 的码元序排好。 */
  nodes: MemoryTreeNodeStructV2[]
  /** 这批节点的状态哈希。 */
  stateHash: string
  /** INV-BR 运行时来源标记；持久化只接受 forward。 */
  direction: 'forward' | 'backward'
}

/** 正向重放的可选项。 */
export interface ReplayTreeDiffsForwardOptionsV2 {
  /** 是否逐事件核对现场一致性；缺省 true。 */
  strict?: boolean
  /** 是否对每个事件跑语义自洽校验；逆向重建时传 false。缺省 true。 */
  validateOps?: boolean
  /**
   * 非空 initial 要进入持久化链时，必须同时提交它的原始 forward 结果作来源证明。
   * 省略时仍可做内存重放，但结果过不了 INV-BR 的持久化断言。
   */
  persistenceBase?: MemoryTreeReplayResultV2
}

/** 逆向重建的可选项。 */
export interface ReplayTreeDiffsBackwardOptionsV2 {
  /** 是否逐事件核对现场一致性；缺省 true。 */
  strict?: boolean
}
