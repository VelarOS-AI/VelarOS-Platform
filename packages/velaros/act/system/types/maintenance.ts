import type {
  ContextInputSummary,
  ContextRecord,
  ContextRef,
  TaskCapsule,
} from '@velaros-ai/context'
import type { ScriptOutputEdit, ScriptOutputManifest } from '@velaros-ai/script'

import type { VolumeNarrative } from './history.js'
import type { MemoryOrganizeIntent } from './memory.js'

/** 整理支线看到的只读快照说明；正文按本快照授权的引用读取。 */
export interface ContextMaintenanceSnapshot {
  /** 当前有效状态与尚待按最新用户输入核对的状态；历史摘要独立保留。 */
  readonly active?: ActiveContextState
  /** 本轮主线工作意图与保留要求。 */
  readonly intent?: MemoryOrganizeIntent
  /** 发起请求的稳定身份，自动整理为空。 */
  readonly requestId?: string
  /** 当前任务使用的空间引用；释放只改变自动展示。 */
  readonly storeRefs?: readonly string[]
  readonly baseRevision: string
  readonly targetChars: number
  readonly through: number
  readonly totalRecords: number
  readonly goals: readonly ContextRef[]
  readonly capsule: TaskCapsule
  readonly observationRef: Nullable<string>
  /** 最新观察结果及可管理的源码规则，不复制结果正文。 */
  readonly observation?: {
    readonly resultRef: Nullable<string>
    readonly manifest: ScriptOutputManifest
    readonly blocks: ReadonlyArray<{
      readonly key: string
      readonly contentHash: string
      readonly chars: number
    }>
  }
  /** 最近封成的一卷：补丁的 volume 给它写叙事；本任务还没有卷时缺省。 */
  readonly volume?: {
    readonly ref: ContextRef
    readonly from: number
    readonly through: number
    readonly skeleton: string
  }
  /**
   * 已有的长期单：negativeAttempts 是各卷叙事累积下来试过没用的做法（最新的在前），unresolved 来自当前状态仍开放的事项；
   * 省略旧事项不会关闭它，解决时用 active 按 id 附真实证据逐项变更。
   */
  readonly ledgers: {
    readonly negativeAttempts: readonly string[]
    readonly unresolved: readonly string[]
  }
  /** 用户目标代次，用于使旧摘要失效。 */
  readonly taskRevision: string
  readonly protectedRefs: readonly ContextRef[]
  /** 输入摘要版本及当前摘要原文引用；既有约束从该引用读取后保留。 */
  readonly inputRevisions: ReadonlyArray<{
    readonly ref: ContextRef
    readonly revision: number
    readonly summaryRef?: ContextRef
  }>
}

/**
 * 模型只提交元数据变更，最终发布由 Runtime 完成。
 * @AgentView
 * 整理补丁：只改父会话的展示，不改原文。最小的有效补丁只有 baseRevision（照抄 snapshot.baseRevision）、summary（有证据支持的整理说明，1 到 3000 个字符）与 unresolved（未解决事项，最多 32 条、每条最多 1000 个字符）；
 * 其余字段只在确实需要、而且已经查明时才给，不要为了填满而改所有分区。notes、inputs、releaseResults、releaseStoreRefs 各最多 64 项，整份不超过 60000 个字符。
 * 所有引用都用父快照里的真实引用，不能用本整理会话的输出引用；遵循 snapshot.intent 的 focus 与 preserve。
 */
export interface ContextPatch {
  readonly baseRevision: string
  readonly summary: string
  readonly unresolved: readonly string[]
  /** 逐项更新当前约束/未解事项；只改变模型解释，原始最新用户输入始终优先。 */
  readonly active?: ActiveContextPatch
  /** 笔记的派生展示；主模型的笔记、计划与结论归主模型维护，这里只改展示。 */
  readonly notes?: readonly ContextNotePresentation[]
  /** 输入摘要：只有完整原文已经进入本支线请求才可替换；只看到引用、片段或元数据时省略，并在 unresolved 里报告缺口。 */
  readonly inputs?: readonly ContextInputSummary[]
  /** 最近一卷（snapshot.volume）的叙事；快照里没有卷、或还没读清楚那一段时省略。 */
  readonly volume?: VolumeNarrative
  /** 退出自动展示的空间引用，只能选 snapshot.storeRefs 里的；不删除对象、不取消订阅、不撤回权限。 */
  readonly releaseStoreRefs?: readonly string[]
  /** 退出自动展示的执行结果引用；明确要求保留、或还有未决操作依赖的不能释放。 */
  readonly releaseResults?: readonly string[]
  /**
   * 观察的展示调整：sourceRef 照抄 snapshot.observationRef；按 snapshot.observation.manifest 里的静态 key 改 view，Runtime 写回观察源码并对已采集的结果重新展示，不重跑脚本。
   * summaries 的 key、resultRef、contentHash 必须与 snapshot.observation.blocks 对上，text 1 到 12000 个字符；view 用 summary 模式时必须有对得上的摘要。不能改采集表达式、key、purpose、priority 或权限。
   */
  readonly observation?: ScriptOutputEdit & {
    readonly sourceRef: string
    readonly summaries?: ReadonlyArray<{
      readonly key: string
      readonly resultRef: string
      readonly contentHash: string
      readonly text: string
    }>
  }
}

/** 当前状态的一项模型解释；sources 始终指向不可变原文。 */
export interface ActiveContextItem {
  readonly id: string
  readonly kind: 'constraint' | 'question'
  readonly text: string
  readonly sources: readonly ContextRef[]
  readonly origin: 'model-interpretation'
}

/** 当前任务有效状态的版本；pendingInputs 表示这些原始输入尚未完成逐项核对。 */
export interface ActiveContextState {
  readonly revision: number
  readonly status: 'reviewed' | 'pending-review'
  readonly items: readonly ActiveContextItem[]
  readonly pendingInputs: readonly ContextRef[]
  /** 容量满时尚未导入的历史摘要；关闭已有项后继续导入，不静默丢弃。 */
  readonly pendingSources: readonly ContextRef[]
}

/** @AgentView 一段直接证据：ref 指原文；offset 为 UTF-16 起点；quote 为该位置逐字引文，最多 4000 字符。 */
export interface ActiveContextEvidence {
  readonly ref: ContextRef
  readonly offset: number
  readonly quote: string
}

/**
 * @AgentView
 * 当前状态核对：baseRevision 照抄 snapshot.active.revision；reviewedInput 必须是 snapshot.goals 的最新原始输入，而且全文已进入本整理会话。
 * changes 最多 64 项，逐条按现有 id 操作；约束只允许用比其原始输入更晚的用户输入作为撤销/取代依据，不能用模型笔记撤销用户约束。
 * superseded 需要 replacement（1 到 1000 字符）；retracted 仅用于约束；resolved 仅用于未解事项。每项 evidence 至少一段、最多 8 段真实引文。
 * 这是带来源的模型解释，不是原始用户授权；引文存在也不保证解释正确。仍成立的项不提交变更，未解项省略时继续保留。
 * additions 用于明确核对后的补充或重开；与 changes 合计最多 64 项。text 为 1 到 1000 字符，每项 evidence 为 1 到 8 段；约束证据必须是全文已读的用户原文。
 */
export interface ActiveContextPatch {
  readonly baseRevision: number
  readonly reviewedInput: ContextRef
  readonly additions?: ReadonlyArray<{
    readonly kind: 'constraint' | 'question'
    readonly text: string
    readonly evidence: readonly ActiveContextEvidence[]
  }>
  readonly changes: ReadonlyArray<{
    readonly id: string
    readonly status: 'superseded' | 'retracted' | 'resolved'
    readonly replacement?: string
    readonly evidence: readonly ActiveContextEvidence[]
  }>
}

/** @AgentView 补丁通过校验后受理；原生调用成功后宿主完成交付，文本协议继续声明完成。宿主在父会话的下一次请求前重新核验版本再发布。 */
export interface ContextPatchReceipt {
  readonly accepted: true
  readonly baseRevision: string
}

/** 持续应用到后续新帧的呈现预算，原始数据和源码保持原有归属。 */
export interface ContextProjectionPolicy {
  /** 与不可变笔记版本绑定的派生展示，不写回主模型笔记。 */
  readonly notes?: readonly ContextNotePresentation[]
  /** 改造前的压力整理只在一轮内生效；现在的策略都保留到下一份策略或任务切换。 */
  readonly expiresAfterTurn?: number
  readonly origin: 'model-interpretation'
  /** 整理时的目标容量，只作记录；每帧的容量由剩余轮数规划。 */
  readonly maxChars: number
  readonly summary: string
  readonly unresolved: readonly string[]
  readonly report: ContextRef
}

/**
 * 整理材料目录只给出原始元数据。
 * @AgentView
 * 快照目录的一页：只有元数据，正文按 ref 用 read 读；nextAfter 不是 null 就把它当 after 接着翻。
 */
export interface ContextMaintenancePage {
  readonly items: readonly ContextRecord[]
  readonly nextAfter: Nullable<number>
}

/** @AgentView 翻快照目录：after 是上一页的 nextAfter，从头翻不给；limit 每页最多 64 项。 */
export interface ContextMaterialsQuery {
  readonly after?: number
  readonly limit?: number
}

/** @AgentView 按快照里的引用读一页父会话原文：offset、limit 按 UTF-16 字符算，一页最多 32000 个字符，还受本次整理剩下的读取额度限制。 */
export interface ContextMaterialsReadInput {
  readonly ref: ContextRef
  readonly offset?: number
  readonly limit?: number
}

/**
 * 整理模型只能改变某一原始版本的展示。
 * @AgentView
 * 一份笔记的派生展示：ref 必须是这份笔记当前版本的引用；summary（1 到 12000 个字符）与 resident 至少给一个；明确要求保留的笔记不能移出自动展示。
 */
export interface ContextNotePresentation {
  /** 精确不可变笔记引用；主模型更新后自动失效。 */
  readonly ref: ContextRef
  /** 可选派生摘要，保持解释来源。 */
  readonly summary?: string
  /** false 只退出自动展示，原文仍可召回。 */
  readonly resident?: boolean
}
