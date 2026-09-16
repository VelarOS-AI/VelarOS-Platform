/** 转交信号（设计 §4）：连续 2 次 epoch 节省率不足且 post-epoch 占用仍高 → 建议开新会话。 */
import type { ModelMessage } from 'ai'

import type { ContextMigrationEventSink } from '../contract/requires.js'

import type { ContextRefRetrieval } from './context.js'

/**
 * 驻留账本的最小形状：蒸馏与 epoch 这两族纯函数真正用到的那几个方法。
 * 类实现在 impl/residency/ContextResidencyLedger.ts；这里只列它们调得到的一面，
 * 免得 utils 为了一个形参把整条实现链拖进来。
 */
export interface ResidencyLedgerView {
  /** 收一条新记录进账本。 */
  append(input: ContextAdmissionInput): ContextLedgerAppendResult
  /** 按 id 取一条记录。 */
  get(recordId: string): Nullable<ContextRecord>
  /** 列出全部记录。 */
  list(): readonly ContextRecord[]
  /** 某条记录当前在哪一层。 */
  residencyOf(recordId: string): ContextResidency
  /** 各层的记录条数向量。 */
  residencyVector(): ContextResidencyVector
  /** 某条记录累计的缺页次数。 */
  faultCountOf(recordId: string): number
  /** 某条记录此刻是否受淘汰保护。 */
  isEvictionProtected(recordId: string, currentTurn: number): boolean
  /** 已排上待淘汰队列的记录 id。 */
  pendingEvictions(): string[]
  /** 把一条记录迁到另一层。 */
  migrate(recordId: string, to: ContextResidency, cause: ContextMigrationCause, at: number): ContextMigrationOutcome
  /** 账本统计（条数、各层占用、缺页率）。 */
  stats(): ContextLedgerStats
}

/**
 * 一个会话的上下文治理面最小形状：同步历史、算窗口、跑 epoch、记缺页。
 * 类实现在 impl/residency/ContextGovernanceSession.ts。
 */
export interface ContextGovernanceSessionApi {
  /** 本会话生效的治理配置。 */
  readonly config: ContextGovernanceConfig
  /** 本会话的驻留账本。 */
  readonly ledger: ResidencyLedgerView
  /** 当前 epoch 号（从 1 起）。 */
  readonly epoch: number
  /** 账本代数（每整本重建一次 +1）。 */
  readonly generation: number
  /** 本代账本内的 epoch 报告（新→旧）。 */
  epochReports(): readonly GovernanceEpochReport[]
  /** 把本轮的 provider 历史同步进账本：前缀一致则增量追加，分叉则整本重建。 */
  syncHistory(input: ContextGovernanceSyncInput): ContextGovernanceSyncResult
  /** 当前投影占用（token），与投影共用尾保护规则。 */
  projectedTokens(budgetTokens: number, charsPerToken?: LooseOptional<number>): number
  /** 当前治理窗口 G 的完整推导。 */
  governanceWindow(): GovernanceWindowDerivation
  /** 轮边界治理：按需跑一次 epoch；返回 null 表示本轮既未触发也未记账。 */
  governTurn(input: GovernanceWindowInput & { at: number; charsPerToken?: LooseOptional<number>; capacityExceeded?: LooseOptional<boolean> }): Nullable<GovernanceEpochReport>
  /** 强制治理入口，供 context overflow 后的自动恢复使用。 */
  requestEpoch(input: GovernanceWindowInput & { at: number; charsPerToken?: LooseOptional<number>; source?: LooseOptional<GovernanceEpochSource> }): Nullable<GovernanceEpochReport>
  /** 等在飞的蒸馏落地（测试与 headless 实验用）。 */
  whenDistillSettled(): Promise<void>
  /** 缺页记账：`context:recall` 命中账本记录时调用。 */
  recordFault(ref: string, at: number): boolean
  /** 转交信号：连续 N 次低收益 epoch 且 post-epoch 占用仍高。 */
  handoffSignal(): ContextHandoffSignal
  /** 最近一次更新时刻。 */
  updatedAt: number
}

/**
 * 治理会话登记处的最小形状：按会话 id 取治理面、配置与 epoch 报告。
 * 类实现在 impl/residency/ContextGovernanceSessionRegistry.ts。
 */
export interface ContextGovernanceSessionRegistryContract {
  /** 当前全局治理配置。 */
  governanceConfig(): ContextGovernanceConfig
  /** 注入/撤销蒸馏器。 */
  setDistiller(distiller: LooseOptional<ContextDistiller>): void
  /** 改写治理配置并返回生效值。 */
  configure(input: LooseOptional<ContextGovernanceConfigInput>): ContextGovernanceConfig
  /** 取（必要时新建）某会话的治理面。 */
  resolve(sessionId: LooseOptional<string>): Nullable<ContextGovernanceSessionApi>
  /** 只看已有的治理面，不新建。 */
  peek(sessionId: LooseOptional<string>): Nullable<ContextGovernanceSessionApi>
  /** 记一次缺页。 */
  recordFault(sessionId: LooseOptional<string>, ref: string, at?: number): boolean
  /** 取转交信号。 */
  handoffSignal(sessionId: LooseOptional<string>): Nullable<ContextHandoffSignal>
  /** 强制跑一次 epoch。 */
  requestEpoch(sessionId: LooseOptional<string>, input?: { at?: LooseOptional<number>; modelWindowTokens?: LooseOptional<number>; charsPerToken?: LooseOptional<number>; source?: LooseOptional<GovernanceEpochSource> }): Nullable<GovernanceEpochReport>
  /** 某会话本代账本内的 epoch 报告。 */
  epochReports(sessionId: LooseOptional<string>): readonly GovernanceEpochReport[]
  /** 丢弃某会话的治理面。 */
  invalidateSession(sessionId: LooseOptional<string>): void
}

/**
 * 治理会话查表面的最小形状：只要"按会话 id 找治理面"这一件事。
 * 降级动作等纯函数收它，不必认识整张登记表。
 */
export interface GovernanceSessionLookup {
  /** 取（必要时新建）某会话的治理面。 */
  resolve(sessionId: LooseOptional<string>): Nullable<ContextGovernanceSessionApi>
}

export interface ContextHandoffSignal {
  /** 是否建议布防 handoff 卡。 */
  armed: boolean
  /** 最近若干次 epoch 的节省率序列（新→旧）。 */
  recentSavingPercents: number[]
  /** 最近一次 epoch 之后的预算占用百分比；从未跑过 epoch 时为 null。 */
  lastEpochAfterPercent: Nullable<number>
  reason: Nullable<'low-saving-streak'>
}

export interface ContextGovernanceSyncInput {
  /** 新摄入消息先全文驻留；不提升已压缩的旧记录。 */
  deferOversizeExcerpt?: boolean
  messages: readonly ModelMessage[]
  at: number
  /**
   * 全保真层引用：toolCallId → payloadRef（PayloadStore 已存的原文）。
   * 准入期把它落进记录，EXCERPT / 墓碑信封的召回引用才能用内容寻址的 payloadRef
   * 而不是只能退回 toolCallId。
   */
  payloadRefsByToolCallId?: LooseOptional<Readonly<Record<string, string>>>
  /** 超长 user 正文的内容哈希 → 持久 payloadRef。 */
  userTextPayloadRefsByHash?: LooseOptional<Readonly<Record<string, string>>>
  /**
   * 本轮编译期实测的字符/token 密度。
   *
   * 摄入期就要拿到它：准入事件的 `tokensDelta` 是账本自己出的账，它按 4 记而治理器按实测记，
   * 同一本账本就有了两个数（§16.5 挂账「stats() 密度」的同一根）。
   */
  charsPerToken?: LooseOptional<number>
}

export interface ContextGovernanceSyncResult {
  /** 本次同步是否整本重建了账本（历史前缀分叉）。 */
  rebuilt: boolean
  appendedCount: number
}

export interface ContextLedgerAppendResult {
  record: ContextRecord
  event: ContextResidencyMigrationEvent
  /** 被本次追加标为 pending-EVICT 的旧记录 id（只标记，逐出归 epoch）。 */
  supersededIds: string[]
}

export interface ContextLedgerStats {
  recordCount: number
  byResidency: Record<ContextResidency, number>
  pendingEvictCount: number
  pinnedCount: number
  refetchableCount: number
  totalFaults: number
  /** 当前轮仍受准入/缺页升温租约保护的记录数。 */
  warmProtectedCount: number
  /** 因重复缺页而在当前账本代保持驻留的记录数。 */
  stickyFaultCount: number
  /** 当前驻留态下的字符与 token 占用。 */
  residentChars: number
  residentTokens: number
  /** 全部记录以 INLINE 计的字符占用（省下多少的分母）。 */
  fullChars: number
  /** 本次统计用的字符/token 密度（读不出量纲的 token 数没法和别处对账）。 */
  charsPerToken: number
}

/** 迁移被拒的原因（拒绝不抛异常——治理器可能批量试探，返回诊断更好用）。 */
export type ContextMigrationRejection = 'no-op' | 'upgrade-not-allowed' | 'pinned-floor'

export interface ContextMigrationOutcome {
  applied: boolean
  event: Nullable<ContextResidencyMigrationEvent>
  /** 因 pinned 地板被夹住时的实际落点。 */
  residency: ContextResidency
  rejection: Nullable<ContextMigrationRejection>
}

/** 迁移因果。准入期只会产生 `admission` / `admission-oversize`；其余归 B1 起的 epoch。 */
export type ContextMigrationCause =
  /** 准入：常规入账。 */
  | 'admission'
  /** 准入：超 `inlineMaxChars`，直接以 EXCERPT 入账。 */
  | 'admission-oversize'
  /** epoch I0：机械逐出。 */
  | 'evict'
  /** epoch I1：规则骨架折叠。 */
  | 'skeleton'
  /** epoch I2：LLM 蒸馏折叠。 */
  | 'distill'
  /** 冷归档 GC：原文不再可取。 */
  | 'expire'
  /** 语义去重：同工具同目标的旧快照被新的取代。 */
  | 'superseded'
  /** 缺页召回：把冷记录重新升温，避免同一内容反复召回。 */
  | 'fault-page-in'
  /** 摘要驻留上限：旧摘要退到隐藏冷层，原始成员继续由检索面提供。 */
  | 'summary-archive'

/**
 * 账本代数：整本重建（用户回滚/编辑历史/结构自愈）一次 +1。
 *
 * 记录 id 是按序号发的（`ctx-r000001`），账本一重建同一个 id 就指向另一条消息。事件流里不带代数，
 * B4 离线重放拿到的是同一 id 跨两段历史的混合流，结论不可信（审计 desktop-wiring 优化 6）。
 */
export interface ContextLedgerGenerationStamp {
  ledgerGeneration: number
}

/** 缺页（fault）事件：`context:recall` 命中非 INLINE 记录。 */
export interface ContextFaultEvent extends ContextLedgerGenerationStamp {
  recordId: string
  residency: ContextResidency
  /** 该记录累计被召回次数（含本次）。 */
  faultCount: number
  /** 记录年龄（毫秒），由调用方的时钟差算出，事件自身不取时钟。 */
  ageMs: number
  at: number
}

export interface ContextResidencyMigrationEvent extends ContextLedgerGenerationStamp {
  recordId: string
  /** null = 准入（此前不存在驻留态）。 */
  from: Nullable<ContextResidency>
  to: ContextResidency
  cause: ContextMigrationCause
  /** 本次迁移的 token 变化量（负值 = 省下）。 */
  tokensDelta: number
  at: number
}

/** JSONL 行写入器端口：宿主注入（文件 / 流 / 内存皆可）。 */
export interface ContextMigrationEventLineWriter {
  write(line: string): void | Promise<void>
}

export interface ContextProjectionBudget {
  /** 尾保护轮数：最近若干轮的记录治理器永不选中（投影落在活动尾）。 */
  tailProtectTurns: number
  /**
   * 尾保护条数：最近若干**条记录**。与轮数取**交集**——两条判据都满足才受保护。
   *
   * 只按对话轮算尾保护有一个致命形态：一次长自主运行（用户发一条指令后 agent 连跑几十轮工具）
   * 整本账本只有 1 个对话轮，于是每条记录都在窗口内，治理器一条候选都收不到、100% 空转（审计
   * V1）。轮是"模型正在聊哪件事"的量纲，条数是"模型手边还需要看多少东西"的量纲，压力来自后者。
   * 缺省视为不限条数（只按轮），0 = 与 `tailProtectTurns: 0` 同义（尾保护关闭）。
   */
  tailProtectMaxRecords?: LooseOptional<number>
  /** 治理窗口 G（token）。给出即产出占用率，缺省则占用率为 null。 */
  budgetTokens?: LooseOptional<number>
  /** token 估算口径，默认 4 字符 1 token。 */
  charsPerToken?: LooseOptional<number>
}

/**
 * 渲染长度的复用缓存，由调用方持有并跨次投影复用（投影本身是纯函数，不留状态）。
 *
 * 键是「记录对象身份 + 驻留态」：记录一旦入账永不改写（P1），所以同一条记录同一驻留态的渲染长度恒定。
 * 不传就每次重新渲染一遍——只影响耗时，不影响结果。
 */
export interface ContextProjectionRenderCache {
  /** 取这条记录在该驻留态下已经量过的字符数；没量过返回 undefined。 */
  get(record: ContextRecord, residency: ContextResidency): Optional<number>
  /** 记下这条记录在该驻留态下的字符数，供后续投影与度量直接取用。 */
  set(record: ContextRecord, residency: ContextResidency, chars: number): void
}

export interface ProjectContextLedgerInput {
  records: readonly ContextRecord[]
  residency: ContextResidencyVector
  budget: ContextProjectionBudget
  /** 稳定前缀：调用方产出并保证逐轮字节不变。 */
  stablePrefix?: readonly ModelMessage[]
  /** 活动尾的外部注入块挂载点（context-dashboard / turn-context delta）。 */
  tailBlocks?: readonly ModelMessage[]
  /** 渲染长度缓存（可选）：由调用方持有，跨轮复用才有意义；不传就每条记录现场渲染。 */
  renderCache?: ContextProjectionRenderCache
}

export interface ContextProjectionStats {
  recordCount: number
  byResidency: Record<ContextResidency, number>
  /** 真正从投影里消失的记录数（被 summary 代表的非工具成员）。 */
  hiddenCount: number
  /** 渲染成墓碑的记录数。 */
  tombstoneCount: number
  excerptCount: number
  /** 落在尾保护窗口、治理器不得选中的记录 id（账本序）。 */
  tailProtectedRecordIds: string[]
  projectedChars: number
  projectedTokens: number
  budgetTokens: Nullable<number>
  occupancyPercent: Nullable<number>
  /** 账本段的内容指纹：前缀是否漂移一眼可判（缓存回归的探针）。 */
  ledgerFingerprint: string
}

export interface ContextProjectionResult {
  messages: ModelMessage[]
  stats: ContextProjectionStats
}

export interface ContextProjectionMeasurement {
  projectedChars: number
  projectedTokens: number
  /** 尾保护窗口内（治理器不得选中）的记录 id。 */
  tailProtectedRecordIds: Set<string>
}

export type RenderedRecord =
  | { kind: 'inline' | 'excerpt' | 'tombstone'; message: ModelMessage }
  | { kind: 'hidden'; message: null }

/** 分类器可见的准入事实（注入方只读，不得改写）。 */
export interface ContextClassificationInput {
  kind: ContextRecordKind
  toolName: Nullable<string>
  toolCallId: Nullable<string>
  /** 工具调用参数（若调用方给了配对的 tool-call）。 */
  toolArgs: unknown
  text: string
  chars: number
  /** 工具错误形态或正文失败信号。 */
  failureEvidence: boolean
}

/**
 * 记录分类器端口：能力包/宿主注入领域语义的唯一入口。
 * 每个方法都可缺省；返回 nullish 表示"我不表态"，回落结构默认。
 * `resolveDedupeTarget` 另有 {@link ContextDedupeVetoTarget} 一态表示"否决去重"。
 */
export interface ContextRecordClassifier {
  isRefetchable?(input: ContextClassificationInput): LooseOptional<boolean>
  resolveDedupeTarget?(input: ContextClassificationInput): LooseOptional<string>
  isPinned?(input: ContextClassificationInput): LooseOptional<boolean>
  /** 在尾保护之外继续保持直接驻留的额外轮数。 */
  resolveWarmLeaseTurns?(input: ContextClassificationInput): LooseOptional<number>
}

export interface ContextAdmissionInput {
  kind: ContextRecordKind
  /** 运行时先保留新消息全文，只有完整请求超容量后才应用已准备的摘录。 */
  deferOversizeExcerpt?: boolean
  message: ModelMessage
  /** 记录创建时刻，由调用方给（准入是纯函数，不取时钟）。 */
  createdAt: number
  turn: number
  /** 配对的工具调用参数：tool-result 记录靠它拿"目标"。 */
  toolArgs?: unknown
  /** 全保真层引用（PayloadStore）。 */
  payloadRef?: LooseOptional<string>
  /**
   * 并行工具结果的全保真层引用：toolCallId → payloadRef。
   *
   * 一条 `role:'tool'` 消息可装 N 份结果，只给第一份填 ref 会让第 2..N 份的墓碑指向别人的
   * payload（审计 V12）。给整张表，per-part 各取各的。
   */
  payloadRefsByToolCallId?: LooseOptional<Readonly<Record<string, string>>>
  /** 显式覆盖：P6 护栏类记录。 */
  pinned?: LooseOptional<boolean>
  /** 显式覆盖：可重取。 */
  refetchable?: LooseOptional<boolean>
  /** 显式覆盖：语义去重的目标定位符。 */
  dedupeTarget?: LooseOptional<string>
  /** 显式覆盖：准入后的额外升温租约。 */
  warmLeaseTurns?: LooseOptional<number>
  /** summary 专用：被折叠的成员记录 id。 */
  memberIds?: readonly string[]
}

export interface ContextAdmissionDecision {
  record: ContextRecord
  /** 准入事件的因果（`admission` / `admission-oversize`）。 */
  cause: ContextMigrationCause
  /** 本次准入令其失效的旧记录 id（只标记，不迁移）。 */
  supersededIds: string[]
}

export interface AdmitContextRecordOptions {
  seq: number
  config?: LooseOptional<ContextGovernanceConfig>
  classifier?: LooseOptional<ContextRecordClassifier>
  /** 账本内既有记录（按账本序），用于语义去重比对。 */
  priorRecords?: readonly ContextRecord[]
}

export interface GovernanceWindowInput {
  /** 模型上下文窗口 W；缺席时按 `estimateContextUsage` 的同一默认值（128K）处理。 */
  modelWindowTokens?: LooseOptional<number>
  /** 输出预留；与送核门同参。 */
  reservedOutputTokens?: LooseOptional<number>
  /** 安全余量百分比；与送核门同参。 */
  safetyMarginPercent?: LooseOptional<number>
  /**
   * 固定开销（token）：系统提示词 + 工具清单/schema + 稳定前缀 + 活动尾。
   *
   * 缺席按 0 处理 —— 那等价于"只有账本正文要发出去"，是宿主没给开销信息时唯一诚实的假设，
   * 此时 G 仍然被门的红线约束住（headroom = sendGate），不会退回旧的 min(W, cap)。
   */
  fixedOverheadTokens?: LooseOptional<number>
}

export interface GovernanceWindowDerivation {
  /** 模型窗口 W（归一后）。 */
  contextWindow: number
  /** 送核门可用窗口：floor(W×(1−safety%)) − 输出预留。 */
  usableContextWindow: number
  /** 送核门红线（token）：估算达到此值即 `okToSend=false`。 */
  sendGateLimitTokens: number
  /** 账本正文之外、但门要算的固定开销（token）。 */
  fixedOverheadTokens: number
  /** 红线之下留给账本正文的额度（可能为负 = 开销本身已撑破门）。 */
  headroomTokens: number
  /** 治理窗口 G（token）——`epochTriggerPercent/epochTargetPercent` 的分母。 */
  windowTokens: number
  /** G 由谁定的：门余量 / cap 上限 / 地板（开销撑破门）。 */
  source: 'send-gate' | 'cap' | 'floor'
}

/** 记录类别（设计稿 §3 七类）。 */
export type ContextRecordKind =
  | 'user'
  | 'assistant'
  | 'tool-call'
  | 'tool-result'
  /** turn-context 注入块。 */
  | 'env-delta'
  /** I1/I2 产物，携 memberIds 作无损指针。 */
  | 'summary'
  /** 权限判决 / 用户纠正 / 安全规则 → 默认 PINNED。 */
  | 'governance'

/**
 * 驻留态（P2 五态）。单向降级：INLINE → EXCERPT → SUMMARIZED → EVICTED → EXPIRED；
 * 提升不是原地改写，而是在尾部**追加新副本**（缓存安全，见 §4C fault 处理）。
 */
export type ContextResidency = 'INLINE' | 'EXCERPT' | 'SUMMARIZED' | 'EVICTED' | 'EXPIRED'

/** 驻留态向量：记录 id → 当前驻留态。投影的第二个入参。 */
export type ContextResidencyVector = ReadonlyMap<string, ContextResidency>

export interface ContextRecordBytes {
  /** 原始全文字符数，保留用于保真元数据。 */
  full: number
  /** 归一化附件后的治理字符数；旧记录缺省时从原消息重算。 */
  budget?: number
  /** 摘录素材的字符数；无摘录时等于 0。**不是** EXCERPT 投影的实际占用（信封与转义另计）。 */
  excerpt: number
}

/** EXCERPT 投影的素材：准入期算好，投影期只做信封拼装。 */
export interface ContextRecordExcerpt {
  text: string
  kind: 'structured' | 'head' | 'facts' | 'code' | 'text' | 'json'
  /** false = 摘录未截断（内容已完整可见，不必召回）。 */
  truncated: boolean
  /** 召回引用，恒等于信封 `retrieval.args.ref`。 */
  ref: string
  refKind: ContextRefRetrieval['args']['refKind']
  reason: string
}

/**
 * 一条 tool-result 记录里**单个** part 的事实。
 *
 * 一轮里模型可以并行发 N 个工具调用，`TurnHistory` 把 N 份结果装进**同一条** `role:'tool'` 消息。
 * 记录仍是一条（不按 part 拆——配对约束靠消息壳成立），但身份与摘录必须落到 part 上：只认第一个
 * 结果会让投影把第一份的信封写进全部 N 个 part，模型看到的 toolName/ref 张冠李戴，被指向错误的
 * payload，消息还反而变大（审计 V5 / V12）。
 */
export interface ContextRecordToolPart {
  toolCallId: string
  toolName: string
  /** 本 part 正文的字符数（信封的 `originalLength`）。 */
  chars: number
  /** 本 part 的摘录素材；正文没超过本 part 预算时为 null（投影按全文渲染）。 */
  excerpt: Nullable<ContextRecordExcerpt>
  payloadRef: Nullable<string>
}

export interface ContextRecord {
  /** 运行时将单条超长摘录推迟到完整请求超容量时，原文始终保留。 */
  readonly deferredSizeAdmission?: boolean
  /** 稳定 id（`ctx-r000001` 形态），跨会话重放不变。 */
  readonly id: string
  /** 单调序号：账本序的唯一权威（不靠 id 字典序）。 */
  readonly seq: number
  readonly kind: ContextRecordKind
  /** 记录创建时刻（元数据携带 —— 投影内禁 `Date.now`）。 */
  readonly createdAt: number
  /** 所属对话轮序，从 0 起。尾保护窗口按它算。 */
  readonly turn: number
  /**
   * P6：护栏类记录。**治理器完全免疫**——不进 epoch 候选、不进蒸馏段；账本层的 EXCERPT 地板
   * （{@link clampResidencyForRecord}）只是拦住绕过候选集的直接迁移的第二道保险，不是"可以变薄"。
   */
  readonly pinned: boolean
  /** 文件读 / 页面快照类：可重取 → I0 优先逐出。 */
  readonly refetchable: boolean
  /**
   * 准入后额外保持直接驻留的轮数。用于失败原因、用户指令与召回结果等短期高价值记录；
   * fault 发生后的动态延长由账本维护，不改写记录。
   */
  readonly warmLeaseTurns: number
  /** 包含失败根因或错误输出；治理器在升温租约内不得将其逐出。 */
  readonly failureEvidence: boolean
  /** 准入判决（不可变）。当前驻留态在账本的向量里。 */
  readonly admittedResidency: ContextResidency
  readonly bytes: ContextRecordBytes
  /** 规则抽取的关键场：路径 / 命令 / 标识符 / 数字（带类别，骨架按类别入栏）。 */
  readonly anchors: readonly ContextAnchor[]
  /** INLINE 投影正文。summary / env-delta / governance 同样以消息形态携带。 */
  readonly message: Nullable<ModelMessage>
  readonly excerpt: Nullable<ContextRecordExcerpt>
  /** 并行工具结果的 per-part 事实（tool-result 记录专用；其余类别恒为空数组）。 */
  readonly toolParts: readonly ContextRecordToolPart[]
  readonly toolName: Nullable<string>
  readonly toolCallId: Nullable<string>
  /**
   * 语义去重键：`工具名::目标定位符`。同键的旧记录在新记录准入时被标 pending-EVICT
   * （相似而过时的内容比无关内容更毒）。无定位符时为 null，永不参与去重。
   */
  readonly dedupeKey: Nullable<string>
  /** summary 专用：被折叠的成员记录 id（无损指针）。其余类别恒为空数组。 */
  readonly memberIds: readonly string[]
  /** 全保真层引用（PayloadStore）。 */
  readonly payloadRef: Nullable<string>
}

/**
 * 蒸馏器端口：宿主注入的一次辅助模型调用。
 *
 * 返回**摘要正文**即可——锚点行与召回行由本模块机械补齐，调用方不必也不该自己拼。
 * 失败一律抛错（调度器会算成拒收并回落骨架），不要返回空串装成功。
 */
export type ContextDistiller = (input: ContextDistillInput) => Promise<string>

export interface ContextDistillInput {
  /** 待蒸馏的成员记录（账本序，最老的在前）。 */
  members: readonly ContextRecord[]
  /** 当前任务目标（目标条件化压缩 [R6]）；账本里没有 user 记录时为 null。 */
  goalHint: Nullable<string>
  /** 期望正文字符上限。 */
  targetChars: number
  /**
   * 整段输入的字符预算（规划期切段用的同一个数）。
   *
   * 宿主按它给成员分配预览额度。写死一个 per-message 常量会让"规划期按 48K 切段"与"实际只喂
   * 2400 字符/条"两套预算互不知情：单条超大记录独占一段时，模型看到的不足全文的 5%，却被要求
   * 逐字保留它没看过的锚点（审计 V14）。
   */
  maxInputChars: number
  /** 必须逐字保留的锚点：提示词里明示，产物按此逐条验证。 */
  requiredAnchors: readonly string[]
  /** 档位（宿主据此选辅助模型还是主模型）。 */
  mode: ContextDistillInstrument
  /** 会话标识（宿主的模型请求遥测上下文）；无身份编译时为 null。 */
  sessionId: Nullable<string>
  /** 超时/中止信号。端口实现应当透传给模型请求。 */
  signal?: LooseOptional<AbortSignal>
}

/** 规划出的一次蒸馏请求（交给异步调度器）。 */
export interface ContextDistillRequest {
  /** 规划它的 epoch 号。 */
  epoch: number
  /**
   * 账本代数。账本一旦整本重建（历史前缀分叉）代数就 +1，跨代产物一律作废——
   * 记录 id 是按序号生成的，重建后同一个 id 会指向**另一条消息**，不设代数护栏就会张冠李戴。
   */
  generation: number
  members: readonly ContextRecord[]
  memberIds: string[]
  requiredAnchors: string[]
  goalHint: Nullable<string>
  targetChars: number
  /** 段落当前占用的字符数（收益估算的分子）。 */
  segmentChars: number
  /** 每次请求省下的 token（经常性收益）。 */
  savingTokensPerRequest: number
  /** 按摊销窗口折算后的总节省 token。 */
  estimatedSavingTokens: number
  /** 一次蒸馏调用的 token 成本（输入 + 输出，一次性）。 */
  estimatedCostTokens: number
}

/** 蒸馏未发生的原因（进 epoch 报告，B3 电池消费）。 */
export type ContextDistillSkipReason =
  /** 档位 off（A0/A1 臂）。 */
  | 'off'
  /** 宿主没注入蒸馏器（headless / 测试 / 模型不可用）。 */
  | 'no-distiller'
  /** 并发上限 1：上一次还没落地。 */
  | 'in-flight'
  /** 待应用产物已达上限。 */
  | 'pending-full'
  /** 机械器械已达标——没到"非花这一跳不可"的地步。 */
  | 'target-reached'
  /** 没有够格的叙事段（全在尾保护 / 全是摘要 / 太短）。 */
  | 'no-segment'
  /** adaptive 判据未过。 */
  | 'not-worth'

/** adaptive 三判据的取值（进报告：RQ3 的机制本体必须可观测）。 */
export interface ContextDistillGateSignals {
  /** ① 机械器械跑完后距目标水位还差几个百分点（占 G）。 */
  shortfallPercent: number
  /** ② 段落叙事字符量。 */
  narrativeChars: number
  /** ② 段落锚点密度（每千字符）。 */
  anchorDensityPerKiloChar: number
  /** ③ 摊销后的预计节省 token / 一次调用的成本 token。 */
  savingToCostRatio: number
  passed: boolean
}

export interface ContextDistillPlan {
  requests: ContextDistillRequest[]
  skipReason: Nullable<ContextDistillSkipReason>
  gate: Nullable<ContextDistillGateSignals>
}

/** 蒸馏产物：已验证（或已回落骨架）的摘要记录素材，等下一个 epoch 边界应用。 */
export interface ContextDistillProduct {
  epoch: number
  generation: number
  memberIds: string[]
  text: string
  /** `distill` = 模型产物过了锚点验证；`skeleton` = 拒收/超时/异常后的规则回落。 */
  instrument: 'distill' | 'skeleton'
  rejection: Nullable<ContextDistillRejection>
}

/** 模型产物被拒的原因。 */
export type ContextDistillRejection =
  /** 产物为空 / 全空白。 */
  | 'empty'
  /** 锚点验证不过：成员记录的关键场没有逐字出现。 */
  | 'missing-anchors'
  /** 产物不比原段落短——摘要不省钱就不叫摘要。 */
  | 'not-smaller'
  /** 超时。 */
  | 'timeout'
  /** 端口抛错。 */
  | 'error'

export interface ContextDistillTotals {
  requested: number
  accepted: number
  rejected: number
  timedOut: number
  failed: number
  /** 跨代作废的产物数（账本重建时丢弃）。 */
  staleDropped: number
}

export interface PlanContextDistillationInput {
  ledger: ResidencyLedgerView
  config: ContextGovernanceConfig
  budgetTokens: number
  /** 机械器械跑完后的投影占用（token）。 */
  projectedTokens: number
  /** 尾保护窗口内的记录 id（治理器永不选中，蒸馏同样不碰）。 */
  tailProtectedRecordIds: ReadonlySet<string>
  epoch: number
  generation: number
  /** 宿主是否注入了蒸馏器。 */
  hasDistiller: boolean
  /** 是否已有在跑/排队的请求（并发 1）。 */
  busy: boolean
  /** 已排队等应用的产物数。 */
  pendingCount: number
  maxPendingProducts: number
}

export interface DistillSegment {
  members: ContextRecord[]
  chars: number
}

/**
 * I2 蒸馏档位 —— 论文 RQ3 的三条实验臂，同一条代码路径，差异只在"什么时刻肯花这一跳"。
 *
 *  - `off`：从不花（A0/A1 臂，纯机械）。
 *  - `aux`（默认）/ `main`：**机械器械没达标就花**（A2-distill-always），差别只是宿主拿辅助模型
 *    还是主模型去跑。
 *  - `adaptive`：在 `aux` 的前提上再过三道判据——缺口够大 / 段落价值密度够高 / 预计节省 ≥ 调用
 *    成本的若干倍（A3，论文主臂，阈值见 {@link ContextDistillAdaptiveConfig}）。
 *
 * 四档都不会在"机械器械已经达标"时花这一跳：那时候段落根本不必折，蒸馏就没有对照物。
 */
export type ContextDistillInstrument = 'off' | 'aux' | 'main' | 'adaptive'

export interface ContextAdmissionConfig {
  /** 工具结果超过该字符数直接以 EXCERPT 准入（沿用 v1 句柄化现值 24K）。 */
  inlineMaxChars: number
  /**
   * 单条 user 正文超过该字符数直接以 EXCERPT 准入（v1 `MaxUserMessageInlineChars` 安全阀，
   * 48K，语义逐字对齐）。与工具结果分开一档：一条用户指令的信息密度远高于一份工具输出，
   * 用同一个 24K 门会把长需求书当日志砍。
   */
  userInlineMaxChars: number
  /**
   * EXCERPT 摘录的字符预算。默认等于 `inlineMaxChars`——**这就是 v1 现行语义**
   * （`tool-output-store` 的 preview 预算 == 句柄化阈值），B0 不动它。
   * 单列成旋钮是为了 B1 能扫参：两者相等时 25K 的结果只省 1K，是个已知的钝角。
   */
  excerptMaxChars: number
}

export interface ContextInstrumentConfig {
  /** I1 规则骨架（免费、保关键场）。 */
  skeleton: boolean
  /** I2 LLM 蒸馏档位。 */
  distill: ContextDistillInstrument
}

/**
 * adaptive 档的三道判据（论文 RQ3 的机制本体）。
 *
 * 三个阈值一个都不写死在逻辑里：它们**就是**"什么时刻值得一次 LLM 调用"这个研究问题的自由度，
 * 写死等于把结论钉在代码里再去测它。全部列为 B4 扫参对象。
 */
export interface ContextDistillAdaptiveConfig {
  /** ① 机械器械（I0+I1）跑完后距目标水位至少还差这么多百分点（占 G），才认为骨架不足以达标。 */
  minShortfallPercent: number
  /** ② 段落价值密度：叙事字符量下限——太短的段落省不出调用成本。 */
  minNarrativeChars: number
  /**
   * ② 段落价值密度：锚点密度上限（每千字符）。
   *
   * 锚点密集的段落规则骨架已经抽得很好，LLM 加不了多少值。**默认值刻意高于 I0 的
   * {@link ContextEvictionConfig.lowAnchorDensityPerKiloChar}（2）**：I2 规划发生在 I0 之后，
   * 密度低于 2 的叙事早被 I0 逐出并折进骨架了，能活到 I2 面前的段落密度必然 ≥ 2。两条阈值取同一
   * 个数，等于把 I2 永久关死——B4 扫参同时动这两个旋钮时，这条关系必须一起维持。
   */
  maxAnchorDensityPerKiloChar: number
  /**
   * ③ 预计（摊销后）节省 token / 预计调用成本 token 的最小倍数。
   *
   * 节省是**每次请求都省**的经常性收益，调用成本是**一次性**支出，两者不同量纲，直接比是错的。
   * 所以先按 {@link amortizationRequests} 把节省摊到若干次请求上，再和成本比。
   */
  minSavingToCostRatio: number
  /**
   * ③ 摊销窗口：预计到下一个 epoch 之前还要发多少次请求。
   *
   * 这是"这次蒸馏能省几遍"的估计值——设成 1 就是要求一次调用当场回本（几乎不可能：输入里本来
   * 就装着整个段落），设得过大则任何段落都值得蒸。B4 扫参对象。
   */
  amortizationRequests: number
}

/** I2 蒸馏的成本护栏与产物规格（档位之外的全部旋钮）。 */
export interface ContextDistillConfig {
  /** prompt 中同时保留的最近摘要数；更老摘要转为隐藏冷记录，原始成员仍可精确检索。 */
  maxResidentSummaries: number
  /** 每个 epoch 最多规划几段蒸馏（并发仍恒为 1，多出来的排队）。 */
  maxSegmentsPerEpoch: number
  /** 单次蒸馏的输入字符上限（沿用 v1 `MaxSummarizerInputChars` 的 48K）。 */
  maxInputChars: number
  /** 产物正文的目标字符数。 */
  targetChars: number
  /** 单次蒸馏超时（毫秒），到点回落 I1 骨架。 */
  timeoutMs: number
  /** 必须逐字保留的锚点条数上限（提示词里明示，产物按此逐条验证）。 */
  maxRequiredAnchors: number
  /** 段落进入蒸馏的最小字符数。 */
  minSegmentChars: number
  adaptive: ContextDistillAdaptiveConfig
}

/**
 * I0 机械逐出的选段阈值（B3 起进配置面，B4 扫参对象）。
 *
 * 这两个数原先是 `GovernanceEpoch.ts` 里的模块常量。搬进来的理由不是"配置越多越好"，而是
 * **它们决定了 I0 从账本里挑走哪些记录**——离线重放要拿同一本账本跑不同的选段策略，写死在
 * 代码里的阈值等于把这一维实验钉死。默认值逐字沿用原常量，行为零变化。
 */
export interface ContextEvictionConfig {
  /**
   * 低锚密度阈值（每千字符锚点数）。低于此值的段落信息密度不足以占住全文位。
   *
   * 与 {@link ContextDistillAdaptiveConfig.maxAnchorDensityPerKiloChar}（默认 6）共同划出 I2
   * 吃的那条带：`(本值, 6]`。把本值调到 ≥ 6 等于让 I0 先把 I2 的口粮全吃掉。
   */
  lowAnchorDensityPerKiloChar: number
  /** 认定"陈旧"的最小轮距：可重取记录至少落后当前轮这么多轮才进 I0 候选。 */
  staleRefetchableTurnDistance: number
  /** 单个用户轮内长自主执行时的记录距离兜底；避免只按 user turn 计算导致永不陈旧。 */
  staleRefetchableRecordDistance: number
  /**
   * 已有内容寻址 payload 的工具结果进入冷驻留候选前至少等待的轮距。
   *
   * 这条路不重新执行工具，只把 prompt 正文换成精确 payload 引用；因此它比“可重取”更可靠，
   * 但仍要给当前任务留出足够的直接使用窗口。
   */
  payloadBackedTurnDistance: number
  /** payload-backed 记录在单轮长执行中的最小记录距离。 */
  payloadBackedRecordDistance: number
}

/** 缺页后的升温与防抖策略。 */
export interface ContextFaultRecoveryConfig {
  /** 第一次缺页后保持重新驻留的轮数。后续缺页按 2 的幂次延长。 */
  baseWarmLeaseTurns: number
  /** 单次升温租约上限。 */
  maxWarmLeaseTurns: number
  /** 同一记录累计缺页达到该次数后，在当前账本代内保持驻留。 */
  stickyAfterFaults: number
}

/**
 * 转交（handoff）布防阈值（B3 起进配置面，B4 扫参对象）。
 *
 * 这两个数原先是 `ContextGovernanceSession.ts` 里的模块常量，与 `ContextEvictionConfig` 同一处境：
 * 设计 §4 明写 35% 那道占用闸"留作扫参对象"，写死在代码里等于每扫一次参就要改代码重编译。
 * 默认值逐字沿用原常量，行为零变化。
 */
export interface ContextHandoffConfig {
  /** 连续多少次低收益 epoch 才认为"压不下去了"。 */
  lowSavingStreak: number
  /** post-epoch 占用高于该百分比（占 G）才布防转交。 */
  occupancyPercent: number
}

export interface ContextGovernanceConfig {
  /** 兼容旧配置的窗口上限字段；当前自动治理不以它缩小真实可用输入容量。 */
  cap: number
  /** 尾保护轮数：最近若干轮对话恒以全文投影。 */
  tailProtectTurns: number
  /**
   * 尾保护条数：最近若干**条记录**。与 {@link tailProtectTurns} 取**交集**（两条都满足才受保护）。
   *
   * 存在理由是量纲：轮数量的是"模型正在聊哪件事"，而压力来自"这一轮里已经堆了多少条工具痕迹"。
   * 一次长自主运行（用户发一条指令、agent 连跑几十轮工具）整本账本只有 1 个对话轮，光按轮算
   * 会让每条记录都落在窗口内、治理器一条候选都收不到——本子系统在它最该发挥作用的形态下 100%
   * 空转（审计 V1）。
   *
   * 默认 16：普通对话一轮约 4-6 条记录，两轮 8-12 条，条数闸基本不咬合（尾保护仍等于轮窗口）；
   * 而在长自主运行里它把保护收敛到最近约 8 个工具步——模型手边真正在用的那一截。
   * 0 = 尾保护关闭（与 `tailProtectTurns: 0` 同义）。
   */
  tailProtectMaxRecords: number
  /** 底层回放的触发参数；运行时自动治理以完整请求是否超过可用输入容量为准。 */
  epochTriggerPercent: number
  /** 已发生容量超限后回收的目标水位；不决定何时自动开始治理。 */
  epochTargetPercent: number
  /** 旧低层回放的收益比例门；真实容量超限与供应方恢复只要求正净收益。 */
  minEpochSavingPercent: number
  admission: ContextAdmissionConfig
  instruments: ContextInstrumentConfig
  /** I0 机械逐出的选段阈值。 */
  eviction: ContextEvictionConfig
  /** 召回缺页后的升温、防抖与粘滞保护。 */
  faultRecovery: ContextFaultRecoveryConfig
  /** 转交布防阈值。 */
  handoff: ContextHandoffConfig
  /** I2 蒸馏的成本护栏与 adaptive 判据（档位在 `instruments.distill`）。 */
  distillation: ContextDistillConfig
  /** 活动尾的 context-dashboard 块（模型本体感知）。 */
  dashboard: boolean
}

export type ContextGovernancePresetName = 'A0-truncation' | 'A1-mechanical' | 'A2-distill-always' | 'A3-adaptive'

export interface ContextGovernanceConfigInput {
  cap?: LooseOptional<number>
  tailProtectTurns?: LooseOptional<number>
  tailProtectMaxRecords?: LooseOptional<number>
  epochTriggerPercent?: LooseOptional<number>
  epochTargetPercent?: LooseOptional<number>
  minEpochSavingPercent?: LooseOptional<number>
  admission?: LooseOptional<{
    inlineMaxChars?: LooseOptional<number>
    userInlineMaxChars?: LooseOptional<number>
    excerptMaxChars?: LooseOptional<number>
  }>
  instruments?: LooseOptional<{
    skeleton?: LooseOptional<boolean>
    distill?: LooseOptional<string>
  }>
  eviction?: LooseOptional<{
    lowAnchorDensityPerKiloChar?: LooseOptional<number>
    staleRefetchableTurnDistance?: LooseOptional<number>
    staleRefetchableRecordDistance?: LooseOptional<number>
    payloadBackedTurnDistance?: LooseOptional<number>
    payloadBackedRecordDistance?: LooseOptional<number>
  }>
  faultRecovery?: LooseOptional<{
    baseWarmLeaseTurns?: LooseOptional<number>
    maxWarmLeaseTurns?: LooseOptional<number>
    stickyAfterFaults?: LooseOptional<number>
  }>
  handoff?: LooseOptional<{
    lowSavingStreak?: LooseOptional<number>
    occupancyPercent?: LooseOptional<number>
  }>
  distillation?: LooseOptional<{
    maxResidentSummaries?: LooseOptional<number>
    maxSegmentsPerEpoch?: LooseOptional<number>
    maxInputChars?: LooseOptional<number>
    targetChars?: LooseOptional<number>
    timeoutMs?: LooseOptional<number>
    maxRequiredAnchors?: LooseOptional<number>
    minSegmentChars?: LooseOptional<number>
    adaptive?: LooseOptional<{
      minShortfallPercent?: LooseOptional<number>
      minNarrativeChars?: LooseOptional<number>
      maxAnchorDensityPerKiloChar?: LooseOptional<number>
      minSavingToCostRatio?: LooseOptional<number>
      amortizationRequests?: LooseOptional<number>
    }>
  }>
  dashboard?: LooseOptional<boolean>
}

/**
 * 锚点类别（抽取顺序即信息密度降序）。
 *
 * 类别在准入期就已知（是哪条正则抽出来的），过去却在记录上退化成无类型字符串，骨架只好用一条更
 * 弱的正则二次分类——`0.24.0` 因此被当成文件路径塞进「文件」栏，把真实路径全顶掉（审计 V13）。
 */
export type ContextAnchorKind = 'path' | 'command' | 'identifier' | 'number'

export interface ContextAnchor {
  /** 归一后的锚点正文（比对与去重都在归一形上做）。 */
  text: string
  kind: ContextAnchorKind
}

export interface ContextDashboardInput {
  epoch: number
  stats: ContextLedgerStats
  records: readonly ContextRecord[]
  residency: ReadonlyMap<string, ContextResidency>
  projectedTokens: number
  budgetTokens: number
  /**
   * 当前账本最近一次治理尝试。
   *
   * `epoch` 只在真正迁移后递增；模型请求被消费但因无候选/收益不足而跳过时仍是 0。把尝试结果
   * 单列，模型才能区分“仍在排队”和“已经执行但无需压缩”。
   */
  lastEpochAttempt?: LooseOptional<
    Pick<
      GovernanceEpochReport,
      'source' | 'applied' | 'skipReason' | 'migrationCount' | 'byInstrument'
    >
  >
}

export interface DashboardHolding {
  id: string
  label: string
  residency: ContextResidency
  chars: number
  toolParts: ReadonlyArray<{ toolCallId: string; toolName: string }>
}

/** epoch 未执行的原因。 */
export type GovernanceEpochSkipReason =
  /** 占用未到触发水位，且模型也没请求。 */
  | 'below-trigger'
  /** 反空转：预计节省低于 `minEpochSavingPercent`。 */
  | 'insufficient-saving'
  /** 无可降级候选（全在尾保护窗口 / 全是治理类 / 已降到底）。 */
  | 'no-candidates'

/**
 * epoch 报告里的 I2 分账。
 *
 * 分成"本 epoch 落地了什么"（epoch 纯函数填）与"本 epoch 规划了什么 + 会话累计"（会话填）两半：
 * 前者是账本事实，后者要问运行态。B3 电池两半都要读——接受率与拒收原因是 RQ3 的因变量。
 */
export interface GovernanceEpochDistillReport {
  mode: ContextDistillInstrument
  /** 本 epoch 应用的产物条数。 */
  appliedProducts: number
  /** 应用产物的器械分布：`distill` = 模型产物过验证，`skeleton` = 拒收后的规则回落。 */
  appliedByInstrument: { distill: number; skeleton: number }
  /** 跨代作废（账本重建后 id 已失效）而丢弃的产物条数。 */
  staleProducts: number
  /** 本 epoch 之后是否规划了新的蒸馏（会话填）。 */
  planned: boolean
  /** 未规划的原因（会话填）。 */
  skipReason: Nullable<ContextDistillSkipReason>
  /** adaptive 三判据取值（会话填；非 adaptive 档恒 passed）。 */
  gate: Nullable<ContextDistillGateSignals>
  /** 会话累计计数（会话填）。 */
  totals: ContextDistillTotals
}

/**
 * 谁请求了这次 epoch。
 *
 * 当前运行时区分容量预判与供应方溢出恢复；旧来源值保留用于解析已有报告和低层回放。
 */
export type GovernanceEpochSource =
  /** 占用越过 `epochTriggerPercent`。 */
  | 'watermark'
  /** 完整请求超过可用输入容量。 */
  | 'capacity'
  /** 历史兼容来源：已有模型治理请求报告。 */
  | 'model-tool'
  /** 历史兼容来源：已有宿主请求报告。 */
  | 'host-request'
  /** 缺页降级阶梯的 `govern-epoch` 级。 */
  | 'overflow-recovery'

/** 每次 epoch 的完整账（P8 测量原生：直接进 scoreboard，也是离线重放的输入）。 */
export interface GovernanceEpochReport {
  epoch: number
  /** 是否真正应用了迁移。 */
  applied: boolean
  skipReason: Nullable<GovernanceEpochSkipReason>
  /** 当前容量触发或内部强制恢复；watermark/model-request 字面量兼容已有报告。 */
  trigger: Nullable<'watermark' | 'capacity' | 'model-request'>
  /**
   * 请求来源（比 `trigger` 细一格）。未触发的轮次也照记——"谁问了但没开"同样是重放输入。
   */
  source: GovernanceEpochSource
  budgetTokens: number
  beforeTokens: number
  afterTokens: number
  savedTokens: number
  /** 相对 epoch 前占用的节省率（百分比，一位小数）。 */
  savingPercent: number
  beforePercent: number
  afterPercent: number
  /** 是否达到 `epochTargetPercent`。 */
  reachedTarget: boolean
  migrationCount: number
  /** 器械分布：各档实际迁移了几条记录。 */
  byInstrument: Record<'evict' | 'skeleton' | 'distill', number>
  /** I2 分账。 */
  distill: GovernanceEpochDistillReport
  /**
   * 本次记账用的字符/token 密度。
   *
   * 同一本账本用不同密度跑出来的 before/after/savingPercent 完全不同；报告里读不出量纲，离线重放
   * 就无法复现，扫参时也分不清"阈值改了"还是"量纲变了"（审计 V9/U11 的记账落点）。
   */
  charsPerToken: number
  /**
   * 本次 G 的推导（送核门口径 → 固定开销 → 余量 → G）。
   *
   * `budgetTokens` 只答"分母是多少"，这里答"分母凭什么是这个数"：离线重放与扫参要靠它把
   * 「阈值动了」和「送核门余量动了」分开。调用方没给推导（纯 epoch 单测）时为 null。
   */
  window: Nullable<GovernanceWindowDerivation>
  /** 本次 epoch 所在的账本代数：账本一重建就换代，跨代报告不可比（审计 U34）。 */
  ledgerGeneration: number
  durationMs: number
  at: number
}

export interface RunGovernanceEpochInput {
  ledger: ResidencyLedgerView
  config: ContextGovernanceConfig
  /** 治理窗口 G（token）：由 `resolveGovernanceWindow` 从送核门口径导出。 */
  budgetTokens: number
  /** G 的推导（记账用，原样进报告）；缺省时报告里为 null。 */
  window?: LooseOptional<GovernanceWindowDerivation>
  /** 本次 epoch 号（从 1 起，由会话维护）。 */
  epoch: number
  /** 时刻（迁移事件的 `at`）。epoch 自身不取时钟。 */
  at: number
  /** 兼容原参数名；内部溢出恢复用它绕过容量预判，低层回放也可显式提供。 */
  modelRequested?: LooseOptional<boolean>
  /** 完整请求容量结论优先于低层历史水位；缺席时维持回放接口的原参数语义。 */
  capacityExceeded?: LooseOptional<boolean>
  /** 请求来源（记账用；缺省按 `modelRequested` 推断）。 */
  source?: LooseOptional<GovernanceEpochSource>
  /** 消息字符/token 的本轮实测密度；缺省保持历史上的 4 字符/token。 */
  charsPerToken?: LooseOptional<number>
  /** 耗时（毫秒）。调用方测量，本函数不取时钟。 */
  durationMs?: LooseOptional<number>
  /** 上一个 epoch 之后异步跑完、等本次边界落地的蒸馏产物（B2 起）。 */
  pendingDistills?: LooseOptional<readonly ContextDistillProduct[]>
  /** 当前账本代数：与产物代数不符即作废（重建后 id 会指向另一条消息）。 */
  ledgerGeneration?: LooseOptional<number>
}

/** 候选来源档（越靠前越机械、越该先降）。 */
export type EpochCandidateTier =
  | 'superseded'
  | 'stale-refetchable'
  | 'payload-backed'
  | 'low-density'
  | 'oversize-excerpt'

export interface EpochCandidate {
  record: ContextRecord
  residency: ContextResidency
  tier: EpochCandidateTier
  /** 准入期已被同工具同目标的新快照取代（迁移因果记 `superseded` 而非 `evict`）。 */
  superseded: boolean
  /** 排序分：越小越先降。 */
  score: number
  /** 当前驻留态下可省的字符数（降到 EVICTED / SUMMARIZED 的净收益）。 */
  reclaimableChars: number
}

export interface AppliedDistillOutcome {
  appliedProducts: number
  appliedByInstrument: { distill: number; skeleton: number }
  archivedSummaries: number
  staleProducts: number
}

export type ContextSkeletonField = 'goal' | 'decisions' | 'files' | 'commands' | 'openIssues' | 'verification'

export interface ContextSkeletonInput {
  /** 被折叠的成员记录（账本序）。 */
  members: readonly ContextRecord[]
  /** 本次 epoch 号（进骨架头，便于在转录里定位是哪一次折叠产生的）。 */
  epoch: number
  /** 锚点行条数上限；缺省取 `distillation.maxRequiredAnchors` 的默认值。 */
  maxAnchors?: LooseOptional<number>
}

export interface ContextSkeletonResult {
  text: string
  /** 逐字并入骨架的锚点（去重，按类别优先序）。 */
  anchors: ContextAnchor[]
  /** 骨架代表的成员记录 id（无损指针的账本侧身份）。 */
  memberIds: string[]
}

export interface ToolCallFact {
  toolCallId: string
  toolName: string
  args: unknown
}

export interface ToolResultFact {
  toolCallId: string
  toolName: string
  /** 结果正文（文本档）；结构化输出为 null。 */
  value: Nullable<string>
  /** 结果正文的保真文本投影：文本档即原文，结构化档退化为稳定 JSON（per-part 摘录的素材）。 */
  text: string
  isError: boolean
}

export interface IngestHistoryOptions {
  /**
   * 记录时刻。历史消息没有时间戳，投影又禁取时钟，所以由调用方给一个**确定的**基准：
   * 缺省 0 = 归档重放（同一份历史两次摄入产出逐字相同的账本）。
   */
  baseCreatedAt?: LooseOptional<number>
  /** 每条消息的时间步进（毫秒），用于让 fault 年龄有单调序。 */
  createdAtStepMs?: LooseOptional<number>
  /** 起始轮序。 */
  startTurn?: LooseOptional<number>
  /**
   * 上一批摄入是否已经见过轮边界（增量摄入的续跑状态）。
   *
   * 轮序自增发生在**第二个及以后**的边界上，这个"见过没有"是跨批状态。不带着它走，一批以 user
   * 消息结尾时下一批就得从 turn+1 起（预支），于是同一份历史逐条增量摄入与一次性整批摄入给出
   * 两套轮序：`[0,1,1,2]` vs `[0,0,1,1]`，尾保护窗口跟着错位，离线重放与在线运行的账本不可比
   * （审计 V8 / U22）。
   */
  turnBoundarySeen?: LooseOptional<boolean>
  /** 全保真层引用：toolCallId → payloadRef（PayloadStore 已存的原文）。 */
  payloadRefsByToolCallId?: LooseOptional<Readonly<Record<string, string>>>
  /** 超长 user 正文的内容哈希 → payloadRef。 */
  userTextPayloadRefsByHash?: LooseOptional<Readonly<Record<string, string>>>
}

export interface HistoryIngestPlan {
  inputs: ContextAdmissionInput[]
  /** 摄入后的下一个轮序（增量摄入用）：**当前轮**，不预支。 */
  nextTurn: number
  /** 本批结束时是否已见过轮边界（下一批的 `turnBoundarySeen` 入参）。 */
  turnBoundarySeen: boolean
}

/**
 * 建 `ContextGovernanceSessionRegistry` 时给的一组宿主注入；全部可省，整个对象也能不传。
 * 除 `distiller` 外都只在建表那一刻读一次，之后新建的会话继承当时的值。
 */
export interface ContextGovernanceSessionRegistryOptions {
  /** 宿主注入的治理配置（宽容解析 + 默认值兜底）。 */
  config?: LooseOptional<ContextGovernanceConfigInput>
  /** 领域语义分类器：refetchable / 去重目标 / pinned（能力包注入，agent 包不认工具名单）。 */
  classifier?: LooseOptional<ContextRecordClassifier>
  /** 迁移事件汇工厂；缺省关闭落盘（agent 包 host 无关，写盘是宿主的事）。 */
  sinkFactory?: LooseOptional<(sessionId: string) => Nullable<ContextMigrationEventSink>>
  /** 最大跟踪会话数；超出按"最近使用"淘汰最旧的那个。 */
  maxTrackedSessions?: LooseOptional<number>
  /**
   * I2 蒸馏器（宿主注入的一次辅助模型调用）。缺省 = 治理退化为纯机械：
   * 档位仍按配置记账，但每次规划都以 `no-distiller` 跳过，不会静默假装蒸馏过。
   */
  distiller?: LooseOptional<ContextDistiller>
}
