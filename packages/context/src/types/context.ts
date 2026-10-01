import type { ContextViewForms } from '../contract/constants.js'

/**
 * 上下文原始记录的来源与用途。
 * @AgentView
 * 原文的来源：user 用户输入、assistant 模型回复、tool 能力回执、event 运行事件、note 笔记、checkpoint 检查点、audit 审计记录。
 */
export type ContextRecordKind =
  'user' | 'assistant' | 'tool' | 'event' | 'note' | 'checkpoint' | 'audit'
/**
 * 内容引用在所属会话中解析。
 * @AgentView
 * 原文引用：sessionId 与 id 一起定位一份不可变原文；只能在授权给你的会话范围里读。
 */
export interface ContextRef {
  readonly sessionId: string
  readonly id: string
}
/**
 * 不可变原始记录；正文由对象存储保存。
 * @AgentView
 * 一份原文的元数据：sequence 是它在会话里的序号，chars 是正文字符数，sources 是它引用的原文，createdAt 是 ISO 时间；正文按 ref 另读。
 */
export interface ContextRecord {
  readonly ref: ContextRef
  readonly sequence: number
  readonly kind: ContextRecordKind
  readonly title: string
  readonly objectId: string
  readonly chars: number
  readonly sources: readonly ContextRef[]
  readonly createdAt: string
}
/** 模型可管理工作集的版本与事件游标。 */
export interface WorkingSet {
  readonly revision: number
  readonly cursor: number
  readonly items: readonly ContextRef[]
}
/** 一次持久化提交的完整元数据，正文独立保存。 */
export interface ContextState {
  readonly version: number
  /** 1 表示持久正文均有标准记录引用；旧会话须由原文 owner 补齐引用后才能回收。 */
  readonly objectReferencesVersion?: 1
  readonly records: readonly ContextRecord[]
  readonly workingSet: WorkingSet
  readonly task?: ContextTaskState
  readonly inputSummaries?: ReadonlyArray<{
    readonly input: ContextRef
    readonly summary: ContextRef
    readonly revision: number
  }>
}
/** 不含历史记录目录的状态；版本与完整快照共享同一 CAS 序列。 */
export type ContextMetadata = Omit<ContextState, 'records'>
/**
 * 记录正文与可信的来源元数据。
 * @AgentView
 * 读到的一页原文：text 从第 offset 个字符开始（按 UTF-16 算），totalChars 是整份正文的字符数，没读完就从 offset + text.length 接着读。
 */
export interface ContextContent {
  readonly record: ContextRecord
  readonly text: string
  readonly totalChars: number
  readonly offset: number
}
/** 工作集检查结果；事件游标包括提交期间追加的新事实。 */
export interface ContextSnapshot {
  readonly revision: number
  readonly cursor: number
  readonly items: readonly ContextRef[]
  readonly protected: readonly ContextRef[]
}
/** 一次带乐观锁的工作集替换。 */
export interface WorkingSetChange {
  readonly baseRevision: number
  readonly baseCursor: number
  readonly items: readonly ContextRef[]
}
/** 原子提交的回执。 */
export interface WorkingSetCommit {
  readonly revision: number
  readonly effective: 'next-model-request'
  readonly cursor: number
}
/** 可由模型写入的材料。 */
export interface NoteWrite {
  readonly kind: 'note' | 'checkpoint'
  readonly title: string
  readonly body: string
  readonly sources?: readonly ContextRef[]
}
/** 宿主追加的真实会话事件。 */
export interface ContextAppend {
  readonly kind: ContextRecordKind
  readonly title?: string
  readonly body: string
  readonly sources?: readonly ContextRef[]
}
/** 原文读取范围，单位是 UTF-16 字符。 */
export interface ContextReadRange {
  readonly offset?: number
  readonly limit?: number
}
/** 分页检索条件。 */
export interface ContextQuery {
  readonly query: string
  readonly offset?: number
  readonly limit?: number
}
/** 检索命中的元数据与有界预览。 */
export interface ContextSearchHit {
  readonly ref: ContextRef
  readonly kind: ContextRecordKind
  readonly title: string
  readonly preview: string
}
/** 可继续翻页的检索结果。 */
export interface ContextSearchPage {
  readonly items: readonly ContextSearchHit[]
  readonly nextOffset: Nullable<number>
}
/** 模型请求所用的不可变材料投影。 */
export interface ContextProjection {
  readonly revision: number
  readonly cursor: number
  readonly records: readonly ContextContent[]
  readonly chars: number
}
/** 宿主绑定的任务作用域；模型不能指定调用身份。 */
export interface ContextTaskScope {
  readonly sessionId: string
  readonly revision: number
}
/**
 * 精确选择器由数据源解释，核心不理解文件和 AST。
 * @AgentView
 * 读资源的哪一部分：whole 整份，lines 按行（start、end 从 1 数，含两端），symbol 按名字取一个符号。
 */
export type ContextSelector =
  | { readonly kind: 'whole' }
  | { readonly kind: 'lines'; readonly start: number; readonly end: number }
  | { readonly kind: 'symbol'; readonly name: string }
/**
 * 来源里的一个资源；检索候选与证据都指向它。
 * @AgentView
 * 来源里的一个资源：sourceId 是来源，resourceId 是来源里的资源身份，selector 选读哪一部分，不给就是整份。
 */
export interface ContextResourceTarget {
  readonly kind: 'resource'
  readonly sourceId: string
  readonly resourceId: string
  readonly selector?: ContextSelector
}
/** 资源身份和不可变记录引用采用已有会话命名空间。 */
export type ContextTarget =
  ContextResourceTarget | { readonly kind: 'artifact'; readonly ref: ContextRef }
/** 本次观察的时间要求。 */
export type ContextTime =
  | { readonly kind: 'after-step' }
  | { readonly kind: 'historical' }
  | { readonly kind: 'snapshot'; readonly snapshotId: string }
/**
 * 可由真实源产生的有限表示。
 * @AgentView
 * 能读成的形式：full 全文、excerpt 片段、definition 定义、metadata 元数据、diff 差异。
 */
export type ContextViewForm = (typeof ContextViewForms)[number]
/** 模型请求观察，不直接写入最终消息或授权；上限见 `ViewIntentLimits`。 */
export type ViewIntentInput = {
  readonly purpose?: string
  readonly importance?: 'required' | 'preferred'
  readonly time?: ContextTime
  readonly forms?: readonly ContextViewForm[]
  readonly maxTokensHint?: number
} & (
  | { readonly kind: 'direct'; readonly target: ContextTarget }
  | {
      readonly kind: 'semantic'
      readonly objective: string
      readonly anchors?: readonly ContextTarget[]
    }
)
/** 主机签发的观察身份。 */
export interface RegisteredViewIntent {
  readonly id: string
  readonly scope: ContextTaskScope
  readonly executionId: string
  readonly request: ViewIntentInput
}
/** Source 声明其实际一致性能力。 */
export interface ContextSourceCapabilities {
  readonly snapshot: boolean
  readonly revision: boolean
  readonly conditionalWrite: 'atomic' | 'best-effort' | 'unsupported'
}
/**
 * 资源读取事实，时间不能冒充强版本。
 * @AgentView
 * 读到的是哪个版本：revision 是来源给的版本（没有就是 null），contentHash 是正文指纹，observedAt 是读取时间；
 * consistency 说明能不能核对：snapshot 快照、revision-checkable 可按版本核对、observed-only 只知道读的时候是这样。
 */
export interface ContextReadStamp {
  readonly sourceId: string
  readonly resourceId: string
  readonly revision: Nullable<string>
  readonly contentHash: string
  readonly observedAt: string
  readonly consistency: 'snapshot' | 'revision-checkable' | 'observed-only'
}
/**
 * 适配器返回的正文；complete 明确范围是否完整。
 * @AgentView
 * 从来源读到的正文：complete 为假说明只读了一部分；dependencies 是这份正文依赖的其他资源版本。
 */
export interface ContextSourceRead {
  readonly dependencies?: readonly ContextReadStamp[]
  readonly text: string
  readonly stamp: ContextReadStamp
  readonly form: ContextViewForm
  readonly complete: boolean
  readonly mediaType: string
}
/** 宿主实际装配的证据源发现卡片，不含凭据或路径实现细节。 */
export interface ContextSourceCard {
  readonly id: string
  readonly capabilities: ContextSourceCapabilities
}
/** 经过 Source 当前范围检查的原始检索命中。 */
export interface ContextSourceHit {
  readonly target: ContextTarget
  readonly preview: string
  readonly forms: readonly ContextViewForm[]
}
/** 候选 ID 只能由 Runtime 登记。 */
export interface ContextCandidate extends ContextSourceHit {
  readonly id: string
  readonly intentIds: readonly string[]
}
/** 选择只指向已登记的候选，不携带事实正文。 */
export interface ContextSelection {
  readonly candidateId: string
  readonly intentIds: readonly string[]
  readonly form: ContextViewForm
}
/** 同一任务的共享事实与进度，每次物化的视图都以它为底。 */
export interface ContextTaskFrame {
  readonly goals: readonly ContextContent[]
  readonly capsule: TaskCapsule
  readonly mandatory: readonly ContextFeedback[]
  readonly lastStep?: ContextStepView
}
/** 已校验的物理证据选择。 */
export interface ContextPlan {
  readonly id: string
  readonly scope: ContextTaskScope
  readonly selections: readonly ContextSelection[]
  readonly degraded: readonly string[]
}
/** 缺口必须留在最终视图中。 */
export interface ContextGap {
  readonly intentId: string
  readonly required: boolean
  readonly code: string
  readonly detail: string
}
/** 真实读取产生的证据，恢复引用指向已持久化正文。 */
export interface ContextEvidence {
  readonly id: string
  readonly intentIds: readonly string[]
  readonly target: ContextTarget
  readonly body: string
  readonly hash: string
  readonly form: ContextViewForm
  readonly complete: boolean
  readonly trust: 'source-data' | 'model-derived'
  readonly freshness: 'validated-as-of' | 'observed-at' | 'historical'
  readonly readSet: readonly ContextReadStamp[]
  readonly recovery: ContextRef
}
/**
 * 模型可以更新的显式任务记忆，与真实回执分开；上限见 `TaskCapsuleLimits`。
 * @AgentView
 * 自己维护的任务计划：nextObjective 是下一步目标（最多 2000 个字符）；hypotheses 假设、decisions 已做的决定、openQuestions 待解的问题，各最多 16 条、每条最多 1000 个字符。
 * 计划是你自己的解释，不能代替真实回执。
 */
export interface TaskCapsule {
  readonly nextObjective: string
  readonly hypotheses: readonly string[]
  readonly decisions: readonly string[]
  readonly openQuestions: readonly string[]
}
/** 强制反馈直接源于 Kernel 回执或执行器。 */
export interface ContextFeedback {
  readonly id: string
  readonly executionId: string
  readonly operation: string
  readonly outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown'
  readonly effect: 'none' | 'committed' | 'partial' | 'unknown'
  readonly code?: string
  readonly detail?: string
}
/** 已结算后发布的、自足的下一轮模型视图。 */
/** 当前执行的原文引用始终能召回，下一轮仅内联有界片段。 */
export interface ContextStepRecord {
  readonly source: ContextRef
  readonly result: ContextRef
  readonly attachments?: readonly ContextRef[]
}
/** 脚本变化和输出变化保持各自来源，不能把脚本当作已执行效果。 */
export interface ContextStepView {
  readonly source: ContextContent
  readonly result: ContextContent
  readonly attachments?: ReadonlyArray<{ readonly ref: ContextRef; readonly hash: string }>
}
/** 物化阶段的可聚合计量，不携带正文或参数。 */
export interface ContextViewMetrics {
  readonly sourceReads: number
  readonly sourceBytes: number
  readonly searches: number
  readonly durationMs: number
}
/** 任务累计计量与正文分开存储，供评测和普通 trace 使用。 */
export interface ContextTaskMetrics extends ContextViewMetrics {
  readonly views: number
}
/** 仅描述变化的有界差量；完整证据以本次 view 为准。 */
export interface ContextTextChange {
  readonly from: Nullable<ContextRef>
  readonly to: Nullable<ContextRef>
  readonly changed: boolean
  readonly patch: string
  readonly truncated: boolean
}
/** 原始脚本变化和真实证据变化各自记账，用于定位进展与重复。 */
export interface ContextProgress {
  readonly imagesChanged: boolean
  readonly step: number
  readonly previousViewId: Nullable<string>
  readonly script: ContextTextChange
  readonly result: ContextTextChange
  readonly evidence: ReadonlyArray<{
    readonly target: ContextTarget
    readonly change: 'added' | 'updated' | 'removed'
    readonly patch: string
    readonly truncated: boolean
    readonly before: Nullable<string>
    readonly after: Nullable<string>
  }>
  readonly unchangedEvidence: number
  readonly repeatedSteps: number
  readonly stalled: boolean
}
export interface ModelView extends ContextTaskFrame {
  readonly progress: ContextProgress
  readonly metrics: ContextViewMetrics
  readonly id: string
  readonly scope: ContextTaskScope
  readonly executionId: string
  readonly evidence: readonly ContextEvidence[]
  readonly gaps: readonly ContextGap[]
  readonly coverage: ReadonlyArray<{
    readonly intentId: string
    readonly status: 'satisfied' | 'partial' | 'missing'
  }>
  readonly readSet: readonly ContextReadStamp[]
  readonly degraded: readonly string[]
  readonly builtAt: string
}
/** 可恢复任务阶段；终态只由新的用户运行显式开启。 */
export type ContextTaskStatus =
  | 'ready'
  | 'executing'
  | 'context-pending'
  | 'view-ready'
  | 'context-blocked'
  | 'completed'
  | 'cancelled'
  | 'failed'
/** 主模型与搜索、整理会话的用量统一记账，供应商没有报告时保留 unknown。 */
export interface ContextTaskUsage {
  readonly mainCalls: number
  readonly contextCalls: number
  readonly reservedTokens: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly unmeasuredCalls: number
  /** 用来限每小时用量。 */
  readonly hourly?: ContextHourlyUsage
}
/** 按小时分桶的预留量：当前桶起点、当前桶与上一桶的 token。 */
export interface ContextHourlyUsage {
  readonly start: number
  readonly tokens: number
  readonly previous: number
}
/** 与原始记录同一次 CAS 提交的任务检查点。 */
/** 模型材料携带其引用证据的版本，源失效会沿依赖传播。 */
export interface ContextArtifactProvenance {
  readonly ref: ContextRef
  readonly readSet: readonly ContextReadStamp[]
  readonly complete: boolean
}
export interface ContextTaskState {
  /** 当前逻辑任务使用的持久 store ID；由 Runtime 维护，展示时重新核验权限。 */
  readonly storeRefs?: readonly string[]
  /** 已退出自动展示的授权空间；实际访问会重新激活。 */
  readonly releasedStoreRefs?: readonly string[]
  /** 逻辑任务身份，跨多次 submit 继续使用；旧存储在下次 begin 时补齐。 */
  readonly id?: string
  /** 当前任务的材料边界，原始会话记录仍可按引用归档读取。 */
  readonly startedSequence?: number
  /** 在同一任务存储内记录活动执行及其决策证据，不与模型帧共用单一身份。 */
  readonly activeExecutions?: Readonly<
    Record<string, { readonly view: Nullable<ModelView>; readonly concurrent: boolean }>
  >
  readonly step?: number
  readonly provenance?: readonly ContextArtifactProvenance[]
  readonly metrics?: ContextTaskMetrics
  readonly lastStep?: ContextStepRecord
  readonly revision: number
  readonly status: ContextTaskStatus
  readonly goals: readonly ContextRef[]
  readonly capsule: TaskCapsule
  readonly lease: Nullable<{ readonly id: string; readonly expiresAt: number }>
  readonly executionId: string
  readonly intents: readonly RegisteredViewIntent[]
  readonly mandatory: readonly ContextFeedback[]
  readonly artifacts: readonly ContextRef[]
  readonly view: Nullable<ModelView>
  readonly usage: ContextTaskUsage
  readonly verification: 'unverified' | 'verified'
}
/** 宿主配置的有限预算；模型调用与 token 预算由主模型和搜索、整理会话共用。 */
export interface ContextViewLimits {
  readonly intents: number
  readonly candidates: number
  readonly searchCalls: number
  readonly inspectBytes: number
  readonly evidenceChars: number
  readonly refreshes: number
  readonly modelCalls: number
  readonly modelTokens: number
  /** 滚动一小时的模型 token 上限。 */
  readonly modelTokensPerHour: number
  readonly materializationMs: number
  readonly leaseMs: number
}
/** 用户原始输入附件，由宿主先保存至当前会话。 */
export interface ContextInputFile {
  readonly ref: ContextRef
  readonly name: string
  readonly mediaType: string
  readonly bytes?: number
}
/** 宿主输入；原文与附件保存在唯一对象存储。 */
export interface ContextUserInput {
  readonly text?: string
  readonly files?: readonly ContextInputFile[]
}
/**
 * 模型理解后的输入投影，不改变用户原始事实。
 * @AgentView
 * 一份用户输入的理解摘要：ref 是输入原文，baseRevision 取 snapshot.inputRevisions 里对应条目的 revision；summary 必须保留用户的实际任务、顺序、验收条件与约束，
 * constraints 逐条列出约束（已有摘要时先读它，逐字保留原有约束再追加），unresolved 是没解决的事项。
 */
export interface ContextInputSummary {
  readonly ref: ContextRef
  readonly summary: string
  readonly constraints: readonly string[]
  readonly unresolved: readonly string[]
  readonly baseRevision: number
}

/** 完成验证的后续动作；由事实或领域验收器给出，不自动重跑脚本。 */
export interface ContextCompletionResult {
  /** 任务是否已正式完成。 */
  readonly completed: boolean
  /** 是否经过领域验收。 */
  readonly verified: boolean
  /** 可供下一轮或宿主处理的具体原因。 */
  readonly reason: string
  /** 未完成时应补读修复、刷新、等待输入或处理容量。 */
  readonly recovery?: 'repair' | 'refresh' | 'input' | 'capacity'
}

/** 同一快照内的记录选择；字段取交集，各选择结果取并集。 */
export interface ContextRecordSelection {
  /** 序号下界，不包含此项；与其他筛选取交集。 */
  readonly after?: number
  /** 序号上界，包含此项。 */
  readonly through?: number
  /** 返回匹配记录的前 N 项，最多 recordPage 项，不与 last/latest/latestPerTitle 合用。 */
  readonly first?: number
  /** 精确标题。 */
  readonly title?: string
  /** 按字面匹配的标题前缀。 */
  readonly titlePrefix?: string
  /** 按字面匹配的标题后缀。 */
  readonly titleSuffix?: string
  /** 精确记录序号。 */
  readonly sequence?: number
  /** 每个匹配标题仅返回最新一项，不与 latest/last 合用。 */
  readonly latestPerTitle?: boolean
  /** 返回匹配记录的最后 N 项，最多 recordPage 项，不与 latest 合用。 */
  readonly last?: number
  /** 精确引用身份。 */
  readonly refId?: string
  /** 原始记录类型。 */
  readonly kind?: ContextRecordKind
  /** 仅取本选择中序号最大的记录。 */
  readonly latest?: boolean
}
/** 同一版本的元数据和所选目录；records 不是完整目录，不可用于完整 CAS。 */
export interface ContextRecordSnapshot {
  /** 与所有选中记录来自同一个读快照。 */
  readonly metadata: ContextMetadata
  /** 选择结果按身份去重后，按 sequence 升序返回。 */
  readonly records: readonly ContextRecord[]
}
/** 按索引分页查询原文目录，正文继续通过对象引用读取。 */
export interface ContextRecordQuery {
  /** 序号下界，不包含此项。 */
  readonly after?: number
  /** 每页条数，最多 recordPage 项。 */
  readonly limit?: number
  /** 精确记录标题过滤。 */
  readonly title?: string
  /** 精确原始引用身份过滤。 */
  readonly refId?: string
}
/** 单调序号分页结果。 */
export interface ContextRecordPage {
  /** 本页目录记录。 */
  readonly items: readonly ContextRecord[]
  /** 仍有下一页时使用的序号。 */
  readonly nextAfter: Nullable<number>
}
/** 回收只针对未被目录引用且超过宽限期的孤立对象。 */
export interface ContextObjectCollection {
  /** 宿主确认的会话版本，变化时整体拒绝回收。 */
  readonly expectedVersion: number
  /** 对象最后写入时间的上界，Unix 毫秒；不能进入存储宽限期。 */
  readonly before: number
  /** 默认只报告候选；false 才实际回收。 */
  readonly dryRun?: boolean
}
/** 回收计数，持久记录和已引用正文始终保持。 */
export interface ContextObjectCollectionResult {
  /** 符合孤立及时间条件的对象数。 */
  readonly candidates: number
  /** 本次实际删除对象数。 */
  readonly deleted: number
}
