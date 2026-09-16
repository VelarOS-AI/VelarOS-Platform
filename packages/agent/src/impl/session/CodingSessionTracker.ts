import { isArray, isEmpty, isFiniteNumber, isNumber, isPlainObject, isPositiveNumber, isPresent, isString, isTrue, toNullable } from '@velaros-ai/core'

import type { ReminderCapabilityResolver, RuntimePromptFeaturePolicy } from '../../contract/requires.js'
import type { CapabilityAutoApprovalNotice, CapabilityScopeId, ChatPromptFeatureId, RunProfileSelectionId, TaskApprovalRecord, ThinkingDepth, ToolCategoryId, ToolConfirmationDecisionOptions, ToolLayerTelemetryMetrics, ToolSurfaceProfileId, TurnPlanningTelemetryPayload } from '../../types/agent'
import type { CapabilityValidationRunResult, CapabilityValidationStatus } from '../../types/capabilities.js'
import type { CapabilityValidationFailure, CodingSessionSnapshot, CodingSessionToolCategoryToolNames, CodingSessionToolContext, CodingSessionTrackerOptions, RuntimeReminderConsumeResult, RuntimeReminderInput, VerificationRelevantPathPredicate } from '../../types/session.js'
import type { ToolAllocatorRequest } from '../../types/tools.js'
import { DefaultRunProfileSelectionId, DefaultToolSurfaceProfileId } from '../../utils/runner/runtime-profiles'
import { normalizeResourceIdForTracker } from '../../utils/session/coding-session-tracker'
import { shouldTrackDynamicToolCategoryLease } from '../../utils/session/tool-lease'
import { AgentTuning } from '../../utils/tuning'
import { assertRunProfileSelectionId, assertToolSurfaceProfileId, resolveRunProfileSelectionId, resolveToolSurfaceProfileId } from '../../utils/wire/typed-field-asserts'
import { defaultRuntimePromptFeaturePolicy } from '../tools/DefaultPromptFeaturePolicy'

import { CodingSessionEditResultHelper } from './CodingSessionEditResultHelper'
import { CodingSessionVerificationHelper } from './CodingSessionVerificationHelper'
import { CodingToolCallDeduper } from './CodingToolCallDeduper'
import type { RuntimeReminderSchedulerApi } from './RuntimeReminderScheduler'
import { RuntimeReminderScheduler } from './RuntimeReminderScheduler'
import { SessionTelemetryCounters } from './SessionTelemetryCounters'
import type { TaskApprovalStateApi } from './TaskApprovalState'
import { TaskApprovalState } from './TaskApprovalState'

/**
 * 编码会话跟踪器对外的全部面：一次主 Agent 执行期间，谁都经这一份问「改了什么、查没查、验没验、现在能用哪些工具、
 * 用户批了什么」。
 *
 * 持有者是 AgentRunner（每次执行新建一台），读者遍布提示段拼装、工具注册表、执行策略与自动验证闸。
 * 状态全在内存、跟着这次执行生死；跨 turn 要留住的只有工具类别授权，由外层的 sessionApprovalRegistry 负责存取。
 * 所有 `_reason` 参数只用于人看的说明，不参与判定。
 */
export interface CodingSessionTrackerApi {
  /**
   * 为子 Agent 派生一台跟踪器：编辑、检查、验证、提醒状态各自独立，工具启用面与档位照抄父的当前值。
   *
   * 授权账本**共享同一份**（同一个任务的事实），所以批准、拒绝、收回对主子立即同时生效。
   */
  forkForSubAgent(): CodingSessionTrackerApi
  /**
   * 会话内已知的资源最新 revision（资源 id → revision）。
   *
   * 历史清洗阶段拿它把「读到的是旧版本」的工具结果重写成过期占位，免得模型拿旧 revision 当 baseRevision 去改文件。
   */
  getResourceRevisionHints(): Record<string, string>
  /** 被宿主或外部编辑器改过、但本会话还没重新读过的资源 id；清洗阶段据此把对应的读结果标成过期。 */
  getExternallyTouchedResourceIds(): readonly string[]
  /**
   * 用上一轮结束时推给宿主真值注册表的快照给新建的跟踪器打底（revision 表 + 外部触碰集合）。
   *
   * 每轮执行都会新建一台跟踪器，不打底的话第二轮头一次清洗看不到第一轮已经把文件推进的事实。
   * 语义是**补字典、不清空**：多次调用互相叠加，没有「先 reset 再 seed」这回事；打底只给起点，
   * 之后的推进仍走工具结果与外部触碰通知。
   */
  seedResourceTruth(snapshot: {
    revisionsByResource?: Readonly<Record<string, string>>
    externallyTouchedResourceIds?: readonly string[]
  }): void
  /**
   * 把文件监听收到的外部改动灌进「外部触碰集合」；有新路径时编辑版本 +1 并清掉已有验证结论。
   *
   * 能力自己写盘后的冷却期内一律丢弃（那是自家写入的回声，不是外部修改）；代价是冷却期内真的外部写入会漏掉一轮，
   * 下一轮监听仍会捕获，且能力侧的 revision 校验是硬保底。
   */
  notifyExternalFilesystemTouches(relativePaths: readonly string[]): void
  /** 本会话记录过的文件变更明细（最近 60 条，工具名 / 路径 / 是否新建 / 增删行数 / 变更 id），供「本轮改动」面板与编辑日志读取。 */
  getRecentFileChanges(): Array<{
    toolName: string
    path: string
    created: boolean
    added: number
    removed: number
    changeId: string
  }>
  /** 最近用过的工具名，最新在前、已去重、最多 12 个；能力扩展拿它过滤无关上下文噪声。 */
  getRecentToolNames(): string[]
  /**
   * 记一次工具执行结果，并据此推进整台状态机：热度计数、租约续期、编辑/检查/验证版本、改动路径与验证结论。
   *
   * 结果自称「跳过」或「没变化」的直接不算数；只动了非代码产物的也不推进编辑版本。
   * 每次工具执行落定后由执行链调一次。
   */
  recordToolResult(toolName: string, result: unknown): void
  /**
   * 记一次工具**调用**（带入参）：喂去重指纹，并在这次是「跑通了的验证」时把它的指纹与命令记进当前编辑版本。
   *
   * 与 `recordToolResult` 分两个动词是因为这里要看入参（去重与验证指纹都从入参算），那边只关心结果。
   */
  recordToolCallResult(toolName: string, args: Record<string, unknown>, result: unknown): void
  /**
   * 这次调用要不要被拦下来；要拦则返回给模型看的说明文案，不拦返回 null。
   *
   * 两种拦法：和上一次完全相同的幂等调用，或同一批改动后重复跑一个已经跑通的验证。
   * 入参带 `allowRepeat` 为真时不拦。调用方拿到文案就用它顶替真正执行。
   */
  getRedundantToolCallMessage(toolName: string, args: Record<string, unknown>): Nullable<string>
  /** 提醒发出去之后回调一次，把调度器的已发账与跟踪器这边的旁路标记对齐；传 null 即无事发生。 */
  finalizeReminderConsumeResult(result: LooseOptional<RuntimeReminderConsumeResult>): void
  /**
   * 执行开始时把 ToolContext 绑进来，此后「某个类别下有哪些工具」按运行时真实可见的工具集合算。
   *
   * 不绑也能跑——退回构造时给的静态目录，测试与早期启动阶段因此不必造一整个 ToolContext。
   */
  attachToolContext(toolContext: CodingSessionToolContext): void
  /** 取出提醒调度器本体，供自动验证等外部逻辑复用同一批 producer，而不是各自再拼一套。 */
  getReminderScheduler(): RuntimeReminderSchedulerApi
  /** 把当前快照、编辑版本、思考力度与工具名解析器打包成 producer 需要的输入；每次要问提醒之前现算。 */
  buildReminderInput(): RuntimeReminderInput
  /** 记下「验证提醒已经针对当前这批改动发过了」，同一批改动不再重复提醒；没有任何改动时不记。 */
  recordVerificationReminderIssued(): void
  /** 记一次验证计划的运行结果：把已验证版本推到当前编辑版本，并按结果更新验证结论与连续失败计数。 */
  recordVerificationPlanResult(toolName: string, result: CapabilityValidationRunResult): void
  /**
   * 记一次验证失败（失败或超时）：留下命令、状态与最多 5 条问题摘要，连续失败计数 +1。
   *
   * 连续失败到阈值后提醒文案会升级成「建议停下来问用户」；成功一次即清零。
   */
  recordVerificationFailure(
    command: string,
    status: Extract<CapabilityValidationStatus, 'failed' | 'timed-out'>,
    issues: string[]
  ): void
  /** 汇总当前编辑/检查/验证状态的快照；提示段与自动验证闸都读它，不直接问跟踪器内部字段。 */
  getSnapshot(): CodingSessionSnapshot
  /**
   * 把另一处（通常是子 Agent）的快照并进本跟踪器：路径求并集、状态按「更保守的一方」取。
   *
   * 对方有改动就让本方编辑版本 +1，再按对方是否已检查/已验证把相应版本跟上；连续失败次数取较大值。
   */
  mergeSnapshot(snapshot: CodingSessionSnapshot): void
  /**
   * 启用若干工具类别（同时置为激活），返回启用后的完整类别清单。
   *
   * 黑白名单拦下的直接跳过。`_reason` 只在它表示「模型自己换入」时额外发一张按轮次到期的临时租约；
   * 由运行档位铺开的类别不发租约（见 `shouldTrackDynamicToolCategoryLease`）。
   */
  enableToolCategories(categories: ToolCategoryId[], _reason?: string): ToolCategoryId[]
  /**
   * 关停若干工具类别并撤掉它们的会话授权与预算覆盖，返回剩下的启用清单。
   *
   * 常驻类别不受影响——它们按定义关不掉。
   */
  disableToolCategories(categories: ToolCategoryId[], _reason?: string): ToolCategoryId[]
  /**
   * 按**工具名**换入（给它驻留优先级并续租），返回当前全部被换入的工具名。
   *
   * 顺带给该工具所属类别的租约续期，免得下一轮类别到期反过来把刚换入的工具清掉。
   */
  enableToolNames(toolNames: string[], _reason?: string): string[]
  /** 这个工具名此刻是不是被显式换入过；注册表据此区分「模型点名要的」和「整类默认暴露的」。 */
  hasToolNameAccess(toolName: string): boolean
  /** 按工具名换出（撤掉驻留优先级与缺页上报记录），返回剩下被换入的工具名。 */
  disableToolNames(toolNames: string[], _reason?: string): string[]
  /**
   * 推进到第 `turn` 轮，清掉超过租期没被用过的**工具名**租约，返回本轮到期的工具名。
   *
   * 每轮规划开始时调；到期只是失去驻留优先级，不影响类别授权。
   */
  pruneExpiredToolNameLeases(turn: number): string[]
  /**
   * 推进到第 `turn` 轮，清掉超过租期没被用过的**类别**租约，返回本轮到期的类别。
   *
   * 非常驻类别到期会连同启用与激活一起撤掉，该类别下的工具名租约也一并清除。
   */
  pruneExpiredToolCategoryLeases(turn: number): ToolCategoryId[]
  /** 按签名取一份轮次规划快照并刷新它的最近使用位次（取不到返回 null）；签名相同即可复用上一轮的规划结果。 */
  getTurnPlanningSnapshot<TSnapshot = unknown>(signature: string): Nullable<TSnapshot>
  /** 按签名存一份轮次规划快照；超出上限时从最久没被取过的那份开始丢。空签名不存。 */
  setTurnPlanningSnapshot(signature: string, snapshot: unknown): void
  /** 记一条本轮工具规划的遥测（签名、丢掉多少工具、各类别工具数等）；只留最近 8 条，用于算压力与缓存失效率。 */
  recordTurnPlanningTelemetry(entry: TurnPlanningTelemetryPayload): void
  /** 最近一条轮次规划遥测的深拷贝；没有过返回 null。调试面板与自检读它。 */
  getLastTurnPlanningTelemetry(): Nullable<TurnPlanningTelemetryPayload>
  /**
   * 工具 schema 预算的缩放系数：连续多轮都有工具被挤掉时主动调小，给下一轮留余量。
   *
   * 连续 4 轮压力返回 0.7，连续 2 轮返回 0.85，否则 1（不缩放）。
   */
  getToolSchemaBudgetScale(): number
  /** 排队一条工具分配请求（模型说它下一轮想要什么），返回排队后的总条数。存的是深拷贝，调用方之后改入参不影响它。 */
  enqueueToolAllocatorRequest(request: ToolAllocatorRequest): number
  /** 取走并清空全部排队中的工具分配请求（深拷贝）；下一轮规划开始时调一次。 */
  drainToolAllocatorRequests(): ToolAllocatorRequest[]
  /**
   * 从本轮被预算挤掉的工具名里挑出「这次才新掉的」并标记已上报，返回给上层去提醒模型。
   *
   * 已报过的不重复报；某个工具重新回到驻留集合后记录会被清掉，将来再掉可以再报一次。
   * 不报的话模型只会看到「我换入的工具怎么下一轮没了」而无从解释。
   */
  collectNewlyEvictedPagedInTools(evictedToolNames: readonly string[]): string[]
  /** 这个类别此刻是不是已启用（启用 = 本会话开过，未必在本轮激活）。 */
  hasToolCategoryAccess(category: ToolCategoryId): boolean
  /** 这个类别此刻是不是处于激活（激活 = 已启用里本轮真正参与工具面铺开的那一层）。 */
  hasActiveToolCategoryAccess(category: ToolCategoryId): boolean
  /** 这个类别在黑白名单下允不允许被启用；黑名单优先于白名单，两者都没配就一律允许。 */
  isToolCategoryAllowed(category: ToolCategoryId): boolean
  /** 当前已启用的工具类别清单（拷贝）。 */
  getEnabledToolCategories(): ToolCategoryId[]
  /** 当前处于激活的工具类别清单（拷贝）。 */
  getActiveToolCategories(): ToolCategoryId[]
  /** 本次执行选中的能力作用域身份；具体含义由能力包定义，跟踪器只原样保管不解释。 */
  getActiveCapabilityScope(): CapabilityScopeId
  /** 当前工具呈现档位。 */
  getToolSurfaceProfile(): ToolSurfaceProfileId
  /** 改思考力度并返回改后的值；下一轮拼提示词与建 provider 时生效。 */
  setThinkingDepth(thinkingDepth: ThinkingDepth): ThinkingDepth
  /** 改工具呈现档位并返回改后的值；传非法档位 id 会被断言拦下抛错。 */
  setToolSurfaceProfile(profile: ToolSurfaceProfileId, _reason?: string): ToolSurfaceProfileId
  /** 当前运行档位。 */
  getRunProfile(): RunProfileSelectionId
  /** 临时切档后要回到的档位；没安排回切时为 null。 */
  getRunProfileRestoreTarget(): Nullable<RunProfileSelectionId>
  /** 安排（或用 null 取消）临时切档后要回到的档位并返回设定值；传非法档位 id 会被断言拦下抛错。 */
  setRunProfileRestoreTarget(
    profile: Nullable<RunProfileSelectionId>
  ): Nullable<RunProfileSelectionId>
  /** 当前持有预算覆盖（驻留优先级）的工具类别清单。 */
  getBudgetOverrideToolCategories(): ToolCategoryId[]
  /** 当前持有预算覆盖（驻留优先级）的工具名清单。 */
  getBudgetOverrideToolNames(): string[]
  /** 工具名 → 本会话累计调用次数；换页时据此优先保住用过的热工具、淘汰从没调过的冷工具。 */
  getToolUsageScores(): Record<string, number>
  /** 模型调到当前不可见工具时记一笔遥测；工具名只为可读性，不参与统计。 */
  recordInvisibleToolCall(_toolName: string): void
  /** 向用户出示一张确认卡时记一笔遥测。 */
  recordConfirmationCard(): void
  /** 直接批准一个风险作用域（落一条 approved 记录），返回批准后的全部作用域；空白作用域名直接忽略。 */
  grantConfirmedRiskScope(scope: string, _reason?: string): string[]
  /** 这个风险作用域此刻是不是已批准；空白作用域名一律为否。 */
  hasConfirmedRiskScope(scope: string): boolean
  /** 当前已批准的全部风险作用域。 */
  getConfirmedRiskScopes(): string[]
  /** 本会话的任务审批账本；新一轮或子 Agent 要沿用同一份授权时按它传递。 */
  readonly taskApprovalState: TaskApprovalStateApi
  /** 接过另一台跟踪器的授权账本（共享同一个对象）；新一轮与子 Agent 用它保持授权归属一致，其余状态仍各自独立。 */
  useTaskApprovalStateFrom(source: CodingSessionTrackerApi): void
  /** 全部授权记录（含已拒绝、已收回）的深拷贝，供授权面板渲染。 */
  getTaskApprovalRecords(): TaskApprovalRecord[]
  /** 落一条审批结论（批准或拒绝）；`message` 是拒绝理由。同一个 key 重复落时沿用首次的记录 id。 */
  recordTaskApproval(
    key: string,
    approved: boolean,
    options: ToolConfirmationDecisionOptions,
    message?: LooseOptional<string>
  ): void
  /** 这个 key 被拒了的话给出返回给模型的理由文案；没拒过返回 null。 */
  getTaskApprovalDenial(key: string): Nullable<string>
  /** 按记录 id 收回一条授权；找不到或已收回返回 false。 */
  revokeTaskApproval(id: string): boolean
  /**
   * 汇总本会话的工具层遥测指标（能力启用次数、去重命中、不可见调用、确认卡数、工具块缓存失效率）。
   *
   * `turnsPerCompletedTask` 由调用方给（跟踪器不知道任务何时算完成），非有限数按 null 记。
   */
  getToolLayerTelemetryMetrics(turnsPerCompletedTask?: number): ToolLayerTelemetryMetrics
  /** 每轮解析出模型输入侧真正可用的窗口（token）后写进来；传非正数视为未知（记 null）。 */
  setUsableContextWindowTokens(tokens: Nullable<number>): void
  /** 本轮模型输入侧可用窗口（token）；未知时为 null，编辑预算门控应退回保守默认窗口。 */
  getUsableContextWindowTokens(): Nullable<number>
  /** 切运行档位并返回改后的值；传非法档位 id 会被断言拦下抛错。 */
  setRunProfile(profile: RunProfileSelectionId, _reason?: string): RunProfileSelectionId
  /**
   * 给一个工具类别发会话级授权（顺带落一条 `tool-category:<id>` 的风险作用域批准），返回当前已授权清单。
   *
   * 黑白名单拦下的类别直接不授权。授权跨 turn 由外层注册表负责存取。
   */
  grantSessionToolCategoryApproval(category: ToolCategoryId, _reason?: string): ToolCategoryId[]
  /** 这个类别此刻有没有会话级授权；授权账本里有明确结论时以账本为准（含用户后来撤销的情况）。 */
  hasSessionToolCategoryApproval(category: ToolCategoryId): boolean
  /** 当前仍然有效的会话级已授权类别（已被收回的会被过滤掉）。 */
  getSessionApprovedToolCategories(): ToolCategoryId[]
  /**
   * 取走并清空自动批准提示卡；整会话只发一次，第一次工具调用消费掉。
   *
   * 参数保留只为兼容按类别调用的老签名，实际不参与判断。没有待发的返回 null。
   */
  consumePendingAutoApprovalNotice(
    _category: ToolCategoryId
  ): Nullable<CapabilityAutoApprovalNotice>
  /** 开启若干提示能力（归一化后），顺带把它们要的工具类别加进预算覆盖，返回开启后的完整能力清单。 */
  enablePromptFeatures(features: ChatPromptFeatureId[], _reason?: string): ChatPromptFeatureId[]
  /**
   * 关闭若干提示能力，返回剩下的能力清单。
   *
   * 只有在没有别的能力还需要某个工具类别时才撤掉那个类别的预算覆盖，避免关一个能力误伤另一个。
   */
  disablePromptFeatures(features: ChatPromptFeatureId[], _reason?: string): ChatPromptFeatureId[]
  /** 这个提示能力此刻是不是开着；提示段拼装按它决定要不要渲染对应片段。 */
  hasPromptFeatureAccess(feature: ChatPromptFeatureId): boolean
  /** 当前开启的提示能力清单（拷贝）。 */
  getEnabledPromptFeatures(): ChatPromptFeatureId[]
}

/**
 * 编码会话跟踪器：单次智能体执行内的编辑、检查、验证状态机。
 *
 * 主要职责：
 * 1. 用 `editVersion` 标记“当前这一批改动”：每次成功的注入式变更工具调用加一，
 *    随后检查和验证工具会把对应版本推进到当前版本。
 *    当 `editVersion > lastInspectionVersion / lastVerificationVersion` 时，
 *    说明最新一批改动还没有检查或验证过，由此驱动提醒和验证闸门。
 * 2. 跟踪本会话已启用的工具类别、提示能力和会话级授权，
 *    供执行策略、工具注册表和提示段实时读取。
 * 3. 维护工具调用去重、验证指纹去重和
 *    auto-approval notice 一次性消费机制。
 * 4. 把所有信号汇总成 CodingSessionSnapshot，供 prompt 上下文和自动验证 gate 使用。
 *
 * 该实例与一次主 Agent 执行同生命周期；跨 turn 的工具类别授权由
 * AgentRunner.sessionApprovalRegistry 在外层负责恢复/保存。
 */
class CodingSessionTracker implements CodingSessionTrackerApi {
  /** 新会话默认不开任何提示词特性，由宿主逐条打开。 */
  private static readonly DefaultEnabledPromptFeatures: readonly ChatPromptFeatureId[] = []

  private static readonly DefaultToolNameLeaseTurns = 64
  private static readonly DefaultMaxTurnPlanningSnapshots = 8
  private static readonly MaxRecentToolNames = 12
  private static readonly MaxTurnPlanningTelemetryEntries = 8

  /** 当前 mutation 批次版本号；每次成功的 mutation 工具结果 +1。 */
  private editVersion = 0
  /** 已检查（read/list/diff 等）至的编辑版本；用于判断是否需要 inspection reminder。 */
  private lastInspectionVersion = 0
  /** 已验证（project:run / run_verification_plan）至的编辑版本。 */
  private lastVerificationVersion = 0
  /** 已发过 post-edit reminder 的编辑版本；同版本只发一次。 */
  private reminderIssuedForVersion = 0
  /** 已发过 verification reminder（remind 模式）的编辑版本。 */
  private verificationReminderIssuedForVersion = 0
  /** 本会话内是否调用过任何 inspection 工具；用于 preflight reminder 判断。 */
  private hasCapabilityInspection = false
  private readonly modifiedPaths = new Set<string>()
  /** 「改到这个文件要不要再跑一次验证」的判据，由宿主注入；没注入时每条改动路径都算。 */
  private readonly isVerificationRelevantPath: VerificationRelevantPathPredicate
  private latestVerificationStatus: LooseOptional<CapabilityValidationStatus> = null
  private activeVerificationFailure: LooseOptional<CapabilityValidationFailure> = null
  /**
   * 连续 verification 失败次数。
   *
   * 每次 verification 报错 / 超时 +1，成功一次清零。reminder 文案在到达
   * `CodingVerificationConsecutiveFailureEscalationThreshold` 时升级为"建议停下来问用户"。
   */
  private consecutiveVerificationFailures = 0
  private readonly passedVerificationFingerprintsByVersion = new Map<number, Set<string>>()
  private readonly passedVerificationCommandsByVersion = new Map<number, Set<string>>()
  /**
   * 工具运行时使用计数（冷热感知换页用）：每次工具成功执行 +1。
   * 工具换页在触达分区字节预算时，据此优先保留“工作集”（本会话用过的热工具），
   * 淘汰从未被调用的冷工具——类似操作系统按访问频率/近度做页面置换。
   */
  private readonly toolUsageCounts = new Map<string, number>()
  /** 最近使用过的工具名（最新在前、去重、上限 MaxRecentToolNames），供能力扩展过滤上下文噪声。 */
  private readonly recentToolNames: string[] = []
  private readonly telemetryCounters = new SessionTelemetryCounters()
  /**
   * 本轮模型「输入侧真正可用窗口」（`token`），由 `agent loop` 解析模型上下文窗口后写入
   * （见 `SoloLoop`/`QueryLoop` 的 `ContextOS budget governor` / `resolveContextWindowBudget`）。
   * 供编辑工具做「上下文感知的编辑预算」——单次事务 `diff` 预估 `token` 超过可用窗口某比例时强制按文件/按 `hunk` 分批，
   * 避免一个巨型 `diff` 既撑爆上下文又触发反复。未写入时编辑门控退回保守默认窗口。
   */
  private usableContextWindowTokens: Nullable<number> = null
  private readonly enabledToolCategories: Set<ToolCategoryId>
  private readonly activeToolCategories: Set<ToolCategoryId>
  private readonly budgetOverrideToolCategories = new Set<ToolCategoryId>()
  private readonly budgetOverrideToolCategoryTouchedAtTurn = new Map<ToolCategoryId, number>()
  private readonly budgetOverrideToolNames = new Set<string>()
  private readonly budgetOverrideToolNameTouchedAtTurn = new Map<string, number>()
  private readonly toolNameLeaseTurns: number
  private currentToolLeaseTurn = 0
  private readonly turnPlanningSnapshots = new Map<string, unknown>()
  private readonly maxTurnPlanningSnapshots: number
  private lastTurnPlanningTelemetry: LooseOptional<TurnPlanningTelemetryPayload> = null
  private readonly recentTurnPlanningTelemetry: TurnPlanningTelemetryPayload[] = []
  private readonly pendingToolAllocatorRequests: ToolAllocatorRequest[] = []
  private readonly allowedToolCategories: LooseOptional<Set<ToolCategoryId>>
  private readonly deniedToolCategories: ReadonlySet<ToolCategoryId>
  private readonly residentToolCategories: ReadonlySet<ToolCategoryId>
  private readonly enabledPromptFeatures: Set<ChatPromptFeatureId>
  private readonly sessionApprovedToolCategories = new Set<ToolCategoryId>()
  private approvalState: TaskApprovalStateApi = new TaskApprovalState()
  private readonly toolCategoryToolNames: CodingSessionToolCategoryToolNames
  private readonly inspectionTools: Set<string>
  private readonly verificationTools: Set<string>
  private readonly promptFeaturePolicy: RuntimePromptFeaturePolicy
  private activeToolSurfaceProfile: ToolSurfaceProfileId = DefaultToolSurfaceProfileId
  private activeRunProfile: RunProfileSelectionId = DefaultRunProfileSelectionId
  /**
   * 单次 Agent 执行内的能力作用域身份真值。
   *
   * 具体作用域含义由 capability package 定义；追踪器只保存不透明 id。
   */
  private activeCapabilityScope: CapabilityScopeId
  private runProfileRestoreTarget: Nullable<RunProfileSelectionId> = null
  private thinkingDepth: ThinkingDepth
  private readonly externalTouchCooldownMs: number
  private readonly normalizeResourceId: (raw: string) => LooseOptional<string>
  /** auto-approve 时预置的全局一次性 notice，第一个工具调用消费后清空，整会话只展示一次。 */
  private pendingGlobalAutoApprovalNotice: LooseOptional<CapabilityAutoApprovalNotice> = null
  private readonly toolCallDeduper: CodingToolCallDeduper
  private readonly editResultHelper: CodingSessionEditResultHelper
  private readonly verificationHelper: CodingSessionVerificationHelper
  /**
   * 运行时提醒调度器：声明式管理 post-edit / 失败验证等动态提醒。
   */
  private readonly reminderScheduler: RuntimeReminderSchedulerApi
  /**
   * Tool context 解析器：可选注入，提供后用 ToolRegistry 派生可见工具名；
   * 没注入时回退到静态 ToolCategoryToolNames，避免测试场景必须 mock 完整 ToolContext。
   */
  private capabilityToolNamesResolver: ReminderCapabilityResolver
  /** 已绑定的 ToolContext，用于派生 capability resolver；可在 agent loop 启动时通过 attachToolContext 注入。 */
  private boundToolContext: LooseOptional<CodingSessionToolContext> = null

  constructor(
    initialCategories: ToolCategoryId[] = [],
    initialPromptFeatures?: ChatPromptFeatureId[],
    /** 跨 turn 恢复的已批准工具类别，避免每次发消息都重新询问授权。 */
    initialApprovedCategories: ToolCategoryId[] = [],
    /**
     * 本次新增的自动批准类别（区别于跨 turn 恢复）。
     * 这些类别的首次工具调用需要向前端发出 notice 卡片。
     */
    freshAutoApprovedCategories: ToolCategoryId[] = [],
    options: CodingSessionTrackerOptions = {}
  ) {
    this.toolCategoryToolNames = options.toolCategoryToolNames ?? {}
    this.reminderScheduler = new RuntimeReminderScheduler(options.reminderProducers ?? [])
    this.verificationHelper = new CodingSessionVerificationHelper(options.validationInterpreters)
    this.residentToolCategories = new Set(options.residentToolCategories ?? [])
    this.thinkingDepth = options.thinkingDepth ?? 'balanced'
    this.approvalState = options.taskApprovals ?? this.approvalState
    this.promptFeaturePolicy = options.promptFeaturePolicy ?? defaultRuntimePromptFeaturePolicy
    this.activeToolSurfaceProfile = resolveToolSurfaceProfileId(
      options.toolSurfaceProfile,
      DefaultToolSurfaceProfileId,
      'CodingSessionTracker.toolSurfaceProfile'
    )
    this.activeRunProfile = resolveRunProfileSelectionId(
      options.runProfile,
      DefaultRunProfileSelectionId,
      'CodingSessionTracker.runProfile'
    )
    this.activeCapabilityScope = options.activeCapabilityScope ?? 'default'
    this.toolNameLeaseTurns = Math.max(
      1,
      Math.floor(options.toolNameLeaseTurns ?? CodingSessionTracker.DefaultToolNameLeaseTurns)
    )
    this.maxTurnPlanningSnapshots = Math.max(
      1,
      Math.floor(
        options.maxTurnPlanningSnapshots ??
          CodingSessionTracker.DefaultMaxTurnPlanningSnapshots
      )
    )
    this.allowedToolCategories = options.allowedToolCategories
      ? new Set(options.allowedToolCategories)
      : null
    this.deniedToolCategories = new Set(options.deniedToolCategories ?? [])
    const activityCategories = options.activityCategories ?? {}
    const toolNamesFor = (categories: readonly ToolCategoryId[] = []): string[] =>
      categories.flatMap((categoryId) => this.toolCategoryToolNames[categoryId] ?? [])
    this.inspectionTools = new Set(toolNamesFor(activityCategories.inspection))
    this.verificationTools = new Set(toolNamesFor(activityCategories.validation))
    this.externalTouchCooldownMs =
      options.externalTouchCooldownMs ?? AgentTuning.session.externalTouchCooldownMs
    this.normalizeResourceId =
      options.normalizeResourceId ?? normalizeResourceIdForTracker
    this.isVerificationRelevantPath = options.isVerificationRelevantPath ?? (() => true)
    this.editResultHelper = new CodingSessionEditResultHelper({
      mutationToolNames: toolNamesFor(activityCategories.mutation),
      nonCodeMutationToolNames: toolNamesFor(activityCategories.nonCodeMutation),
      isVerificationRelevantPath: this.isVerificationRelevantPath,
    })
    this.capabilityToolNamesResolver = (category) => [
      ...(this.toolCategoryToolNames[category] ?? []),
    ]
    this.enabledToolCategories = new Set<ToolCategoryId>(
      initialCategories.filter((categoryId) => this.isToolCategoryAllowed(categoryId))
    )
    this.activeToolCategories = new Set<ToolCategoryId>(
      (options.activeToolCategories ?? [...this.enabledToolCategories]).filter(
        (categoryId) =>
          this.isToolCategoryAllowed(categoryId) && this.enabledToolCategories.has(categoryId)
      )
    )
    this.enabledPromptFeatures = new Set<ChatPromptFeatureId>(
      this.promptFeaturePolicy.normalize(
        initialPromptFeatures ?? [...CodingSessionTracker.DefaultEnabledPromptFeatures]
      )
    )
    this.promptFeaturePolicy
      .getCategoriesForFeatures(this.getEnabledPromptFeatures())
      .forEach((category) => {
        if (this.isToolCategoryAllowed(category)) {
          this.budgetOverrideToolCategories.add(category)
        }
      })
    for (const category of initialApprovedCategories) {
      if (this.isToolCategoryAllowed(category)) {
        this.sessionApprovedToolCategories.add(category)
        this.budgetOverrideToolCategories.add(category)
      }
    }
    // 为本次新增的 auto-approve 类别预置唯一 notice；整个会话只展示一次，第一个工具调用消费。
    for (const category of freshAutoApprovedCategories) {
      if (this.isToolCategoryAllowed(category)) {
        this.sessionApprovedToolCategories.add(category)
        this.budgetOverrideToolCategories.add(category)
      }
    }
    if (!isEmpty(freshAutoApprovedCategories)) {
      const approvedAt = Date.now()
      this.pendingGlobalAutoApprovalNotice = {
        id: `session-auto-approval:global:${approvedAt}`,
        categories: freshAutoApprovedCategories,
        promptFeatures: [],
        reason: '会话权限已自动批准',
        message: '当前会话权限模式已允许本次能力请求。',
        approvedAt,
      }
    }
    this.toolCallDeduper = new CodingToolCallDeduper()
  }

  /**
   * 为子 Agent 派生隔离的编辑、验证、提醒和工具启用状态。
   * 授权账本是同一任务的事实，主子共享；批准、拒绝与收回均立即对双方生效。
   * 持久副作用由注入能力服务和 WriteLeaseCoordinator 协调。
   */
  public forkForSubAgent(): CodingSessionTrackerApi {
    const child = new CodingSessionTracker(
      [...this.enabledToolCategories],
      [...this.enabledPromptFeatures],
      [...this.sessionApprovedToolCategories],
      [],
      {
        promptFeaturePolicy: this.promptFeaturePolicy,
        toolCategoryToolNames: this.toolCategoryToolNames,
        thinkingDepth: this.thinkingDepth,
        allowedToolCategories: this.allowedToolCategories
          ? [...this.allowedToolCategories]
          : undefined,
        deniedToolCategories: [...this.deniedToolCategories],
        toolSurfaceProfile: this.activeToolSurfaceProfile,
        runProfile: this.activeRunProfile,
        activeToolCategories: [...this.activeToolCategories],
        activeCapabilityScope: this.activeCapabilityScope,
        externalTouchCooldownMs: this.externalTouchCooldownMs,
        normalizeResourceId: this.normalizeResourceId,
      }
    )
    child.useTaskApprovalStateFrom(this)
    return child
  }

  private readonly recentFileChanges: Array<{
    toolName: string
    path: string
    created: boolean
    added: number
    removed: number
    changeId: string
  }> = []

  /** 本会话内各路径的最新 snapshot.revision（read / apply 结果刷新）。 */
  private readonly resourceRevisionById = new Map<string, string>()
  /** 宿主或外部编辑器触发、等待 sanitize 标记 stale read 的资源路径。 */
  private readonly externallyTouchedPaths = new Set<string>()
  private kernelMutationCooldownUntil = 0

  /** 从工具结果中提取 fileChanges 描述符并追加到 recentFileChanges。 */
  private collectFileChanges(toolName: string, result: unknown): void {
    if (!isPlainObject(result)) return
    const raw = result['fileChanges']
    if (!isArray(raw)) return
    for (const item of raw) {
      if (!isPlainObject(item)) continue
      if (!isString(item['changeId']) || !isString(item['path'])) continue
      this.recentFileChanges.push({
        toolName,
        path: item['path'],
        created: isTrue(item['created']),
        added: isNumber(item['added']) ? item['added'] : 0,
        removed: isNumber(item['removed']) ? item['removed'] : 0,
        changeId: item['changeId'],
      })
    }
    // 只保留最近 60 条，避免长会话无限膨胀
    if (this.recentFileChanges.length > 60) {
      this.recentFileChanges.splice(0, this.recentFileChanges.length - 60)
    }
  }

  /**
   * 合并路径→revision（apply_edit.newRevisions 与 project:read 快照），
   * 供模型历史清洗阶段丢弃过期读结果。
   */
  private mergeResourceRevisionHints(toolName: string, result: unknown): void {
    if (!isPlainObject(result)) return

    const nr = result['newRevisions']
    if (isPlainObject(nr)) {
      for (const [path, rev] of Object.entries(nr)) {
        if (!isString(path) || !isString(rev)) continue
        if (rev === 'deleted') {
          this.resourceRevisionById.delete(path)
          this.externallyTouchedPaths.delete(path)
        } else {
          this.resourceRevisionById.set(path, rev)
          this.externallyTouchedPaths.delete(path)
        }
      }
    }

    const snapSingle = result['snapshot']
    if (isPlainObject(snapSingle)) {
      if (isString(snapSingle.path) && isString(snapSingle.revision)) {
        this.resourceRevisionById.set(snapSingle.path, snapSingle.revision)
        this.externallyTouchedPaths.delete(snapSingle.path)
      }
    }

    const files = result['files']
    if (isArray(files)) {
      for (const item of files) {
        if (!isPlainObject(item)) continue
        const snap = item.snapshot
        if (!isPlainObject(snap)) continue
        if (isString(snap.path) && isString(snap.revision)) {
          this.resourceRevisionById.set(snap.path, snap.revision)
          this.externallyTouchedPaths.delete(snap.path)
        }
      }
    }

  }

  /** 返回会话内已知的最新内核 revision（路径 → revision）。 */
  public getResourceRevisionHints(): Record<string, string> {
    return Object.fromEntries(this.resourceRevisionById)
  }

  public getExternallyTouchedResourceIds(): readonly string[] {
    return [...this.externallyTouchedPaths]
  }

  /**
   * 从上一轮 turn 结束时 push 到宿主资源真值注册表的快照，把
   * revision map / external touch 集合灌进新 tracker。
   *
   * 用途：每次主 Agent 执行都会 new 一个 tracker，导致 turn-2 头部第一次
   * sanitize 时拿不到 turn-1 已经把文件推进的事实——history 里 turn-1 的 read
   * 结果（rev-1）原样进入 model context，模型可能误以为是最新，直接拿 rev-1
   * 当 baseRevision 调 prepare_edit → 在 kernel 那儿撞 BASE_REVISION_MISMATCH
   * 才被动反弹，浪费一整次工具往返。
   *
   * seed 不是真值的最终来源——turn 内任何成功的 read / apply 都会通过
   * `mergeResourceRevisionHints` 继续推进；fs.watch 推过来的 external touch
   * 也仍然走 `notifyExternalFilesystemTouches`。seed 只提供"起点"。
   *
   * 多次调用会以"覆盖且不清空既有"为准——seed 是补字典，不是替换。这一点
   * 与 mergeSnapshot（按字段聚合）有意保持一致：seed 仅在 tracker 完全新建
   * 时调用一次，没有"reset 再 seed"的语义。
   */
  public seedResourceTruth(snapshot: {
    revisionsByResource?: Readonly<Record<string, string>>
    externallyTouchedResourceIds?: readonly string[]
  }): void {
    const { revisionsByResource, externallyTouchedResourceIds } = snapshot
    if (revisionsByResource) {
      for (const [path, revision] of Object.entries(revisionsByResource)) {
        if (!isString(path) || !isString(revision)) continue
        if (!path || !revision) continue
        // seed 期间不动 deduper 的失败记录——tracker 刚建好还没有任何记录，
        // 这里直接写 map 即可，避免无谓 dedupe 副作用。
        this.resourceRevisionById.set(path, revision)
      }
    }
    if (externallyTouchedResourceIds) {
      for (const raw of externallyTouchedResourceIds) {
        const rel = this.normalizeResourceId(raw)
        if (!rel) continue
        // 上轮 turn 结束时挂的外部 touch 仍然有效——模型在 turn-2 看到对应路径
        // 的 read 结果时，sanitize 才能正确重写成 stale 占位。
        this.externallyTouchedPaths.add(rel)
      }
    }
  }

  /**
   * 把 fs.watch 收集到的外部文件系统 touch 灌进会话级"外部触碰集合"，
   * 后续 sanitize 会用它把对应路径的 read 重写成 stale 占位。
   *
   * 边界 case 说明：成功的注入式 editing capability 会触发宿主进程自己的写盘，
   * 资源观察器会把这次写盘当成"外部 touch"回声送进来。为了避免把能力自身
   * 的写入误标为外部修改、进而把刚刚返回 fresh revision 的那条 read 重写成 stale，
   * 这里在 mutation cooldown 期内一律丢弃推入。
   *
   * 已知短板：cooldown 之内的"真·外部写入"（用户在外部编辑器手动改文件，
   * 时间窗刚好跟一次 apply_edit 重合）也会被一并丢弃。这是 best-effort 取舍：
   *  - cooldown 之外、下一轮 sanitize 时会自然捕获到（fs.watch 仍在监听）；
   *  - 模型若紧接着调用变更能力，能力实现的 revision mismatch 校验是硬保底；
   * 因此该缝隙不会破坏数据完整性，只是 stale 提示可能晚一轮才生效。
   */
  public notifyExternalFilesystemTouches(relativePaths: readonly string[]): void {
    if (Date.now() < this.kernelMutationCooldownUntil) return

    let recordedExternalMutation = false
    for (const raw of relativePaths) {
      const rel = this.normalizeResourceId(raw)
      if (!rel) continue
      if (this.externallyTouchedPaths.has(rel)) continue
      this.externallyTouchedPaths.add(rel)
      this.modifiedPaths.add(rel)
      recordedExternalMutation = true
    }

    if (recordedExternalMutation) {
      this.editVersion += 1
      this.resetVerificationStateForEdits()
    }
  }

  /** 返回本会话内所有已记录的文件变更，供 get_session_edit_log 使用。 */
  public getRecentFileChanges() {
    return [...this.recentFileChanges]
  }

  /** 最近使用过的工具名（最新在前、去重），供能力扩展过滤相关上下文噪声。 */
  public getRecentToolNames(): string[] {
    return [...this.recentToolNames]
  }

  private trackRecentToolName(toolName: string): void {
    const existingIndex = this.recentToolNames.indexOf(toolName)
    if (existingIndex >= 0) {
      this.recentToolNames.splice(existingIndex, 1)
    }
    this.recentToolNames.unshift(toolName)
    if (this.recentToolNames.length > CodingSessionTracker.MaxRecentToolNames) {
      this.recentToolNames.length = CodingSessionTracker.MaxRecentToolNames
    }
  }

  public recordToolResult(toolName: string, result: unknown): void {
    // 工作集计数：无论结果是否“有效编辑”，工具被实际调用就记一次热度。
    this.toolUsageCounts.set(toolName, (this.toolUsageCounts.get(toolName) ?? 0) + 1)
    this.trackRecentToolName(toolName)
    if (this.budgetOverrideToolNames.has(toolName)) {
      this.budgetOverrideToolNameTouchedAtTurn.set(toolName, this.currentToolLeaseTurn)
    }
    const toolCategory = this.resolveToolCategoryForToolName(toolName)
    if (toolCategory && this.budgetOverrideToolCategories.has(toolCategory)) {
      this.budgetOverrideToolCategoryTouchedAtTurn.set(toolCategory, this.currentToolLeaseTurn)
    }

    if (this.editResultHelper.isSkippedOrUnchangedResult(result)) return

    if (this.editResultHelper.isNonCodeArtifactMutation(toolName, result)) return

    this.mergeResourceRevisionHints(toolName, result)

    if (this.editResultHelper.isCapabilityMutationTool(toolName)) {
      this.kernelMutationCooldownUntil = Date.now() + this.externalTouchCooldownMs
      this.editVersion += 1
      this.resetVerificationStateForEdits()
      this.collectModifiedPaths(result)
      this.collectFileChanges(toolName, result)
      return
    }

    if (this.inspectionTools.has(toolName)) {
      this.hasCapabilityInspection = true
    }

    if (this.editVersion === 0) return

    if (this.inspectionTools.has(toolName)) {
      this.lastInspectionVersion = this.editVersion
      return
    }

    if (this.verificationTools.has(toolName)) {
      this.lastVerificationVersion = this.editVersion
      this.collectVerificationNotes(toolName, result)
    }
  }

  public recordToolCallResult(
    toolName: string,
    args: Record<string, unknown>,
    result: unknown
  ): void {
    if (toolName === 'tooling:replace') {
      this.telemetryCounters.recordToolReplaceCall()
    }
    this.toolCallDeduper.recordIdempotentToolCall(toolName, args)
    const fingerprint = this.buildVerificationToolFingerprint(toolName, args)
    if (!fingerprint || !this.isPassedVerificationResult(toolName, result)) return

    this.getPassedVerificationFingerprintsForCurrentVersion().add(fingerprint)
    this.recordPassedVerificationCommandForCurrentVersion(toolName, args)
  }

  public getRedundantToolCallMessage(
    toolName: string,
    args: Record<string, unknown>
  ): Nullable<string> {
    const repeatedIdempotentMessage = this.toolCallDeduper.getRepeatedIdempotentToolCallMessage(
      toolName,
      args
    )
    if (repeatedIdempotentMessage) return this.recordDedupeHit(repeatedIdempotentMessage)

    const fingerprint = this.buildVerificationToolFingerprint(toolName, args)
    if (!fingerprint) return null

    if (isTrue(args.allowRepeat)) return null

    if (
      !this.getPassedVerificationFingerprintsForCurrentVersion().has(fingerprint) &&
      !this.hasPassedVerificationCommandForCurrentVersion(args.command)
    ) return null

    return this.recordDedupeHit([
      '已拦截重复验证：同一轮改动后已经成功运行过相同的验证步骤。',
      '不要再次运行同一个验证命令；请改为检查 diff/变更文件，或者直接总结当前结果、验证状态和剩余风险。',
      '只有在新增编辑、验证失败被修复、或用户明确要求重复验证时，才需要重新运行。',
    ].join('\n'))
  }

  private recordDedupeHit(message: string): string {
    this.telemetryCounters.recordDedupeHit()
    return message
  }

  public finalizeReminderConsumeResult(result: LooseOptional<RuntimeReminderConsumeResult>): void {
    if (!result) return

    void result.producerId
  }

  /** 允许 agent loop 启动时把 ToolContext 绑入 tracker，用于派生当前可见工具名。 */
  public attachToolContext(toolContext: CodingSessionToolContext): void {
    this.boundToolContext = toolContext
    this.capabilityToolNamesResolver = (category) => {
      // 优先用 ToolContext.listTools('all') —— 反映本运行时真实可见的工具集合。
      const visible = toolContext
        .listTools('all')
        .filter((tool) => tool.categoryId === category)
        .map((tool) => tool.name)
      if (!isEmpty(visible)) return visible
      // 回退：static catalog；保证测试/早期 boot 阶段也能渲染。
      return [...(this.toolCategoryToolNames[category] ?? [])]
    }
  }

  /** 给外部（如自动验证 helper）直接访问 scheduler 的能力，方便复用 producer。 */
  public getReminderScheduler(): RuntimeReminderSchedulerApi {
    return this.reminderScheduler
  }

  /** 构建调度器输入：把当前 snapshot / editVersion / 工具名解析器打包给 producer。 */
  public buildReminderInput(): RuntimeReminderInput {
    return {
      toolContext: this.boundToolContext,
      snapshot: this.getSnapshot(),
      enabledToolCategories: this.getEnabledToolCategories(),
      editVersion: this.editVersion,
      thinkingDepth: this.thinkingDepth,
      capabilityToolNames: this.capabilityToolNamesResolver,
    }
  }

  public recordVerificationReminderIssued(): void {
    if (this.editVersion > 0) {
      this.verificationReminderIssuedForVersion = this.editVersion
    }
  }

  public recordVerificationPlanResult(
    toolName: string,
    result: CapabilityValidationRunResult
  ): void {
    if (this.editVersion > 0) {
      this.lastVerificationVersion = this.editVersion
    }

    this.collectVerificationNotes(toolName, result)
  }

  public recordVerificationFailure(
    command: string,
    status: Extract<CapabilityValidationStatus, 'failed' | 'timed-out'>,
    issues: string[]
  ): void {
    if (this.editVersion > 0) {
      this.lastVerificationVersion = this.editVersion
    }

    this.latestVerificationStatus = status
    this.activeVerificationFailure = {
      command,
      status,
      issues: issues.slice(0, 5),
    }
    this.consecutiveVerificationFailures += 1
  }

  public getSnapshot(): CodingSessionSnapshot {
    const modifiedPaths = Array.from(this.modifiedPaths)
    return {
      modifiedPaths,
      verificationRelevantPathCount: modifiedPaths.filter((path) => this.isVerificationRelevantPath(path)).length,
      hasCapabilityMutations: this.editVersion > 0,
      hasCapabilityInspection: this.hasCapabilityInspection,
      needsChangeInspection: this.editVersion > this.lastInspectionVersion,
      needsVerificationCommand: this.editVersion > this.lastVerificationVersion,
      reminderIssuedForCurrentEdits: this.reminderIssuedForVersion === this.editVersion,
      verificationReminderIssuedForCurrentEdits:
        this.verificationReminderIssuedForVersion === this.editVersion,
      latestVerificationStatus: toNullable(this.latestVerificationStatus),
      activeVerificationFailure: toNullable(this.activeVerificationFailure),
      consecutiveVerificationFailures: this.consecutiveVerificationFailures,
    }
  }

  public mergeSnapshot(snapshot: CodingSessionSnapshot): void {
    snapshot.modifiedPaths.forEach((path) => {
      this.modifiedPaths.add(path)
    })

    if (snapshot.hasCapabilityInspection) {
      this.hasCapabilityInspection = true
    }

    if (snapshot.hasCapabilityMutations) {
      this.editVersion += 1
      if (!snapshot.needsChangeInspection) {
        this.lastInspectionVersion = this.editVersion
      }
      if (!snapshot.needsVerificationCommand) {
        this.lastVerificationVersion = this.editVersion
      }
      if (snapshot.reminderIssuedForCurrentEdits) {
        this.reminderIssuedForVersion = this.editVersion
      }
      if (snapshot.verificationReminderIssuedForCurrentEdits) {
        this.verificationReminderIssuedForVersion = this.editVersion
      }
    }

    if (snapshot.latestVerificationStatus) {
      this.latestVerificationStatus = snapshot.latestVerificationStatus
    }

    if (snapshot.activeVerificationFailure) {
      this.activeVerificationFailure = {
        command: snapshot.activeVerificationFailure.command,
        status: snapshot.activeVerificationFailure.status,
        issues: [...snapshot.activeVerificationFailure.issues],
      }
    }

    if (
      isNumber(snapshot.consecutiveVerificationFailures) &&
      snapshot.consecutiveVerificationFailures > this.consecutiveVerificationFailures
    ) {
      this.consecutiveVerificationFailures = snapshot.consecutiveVerificationFailures
    }
  }

  public enableToolCategories(categories: ToolCategoryId[], _reason?: string): ToolCategoryId[] {
    const dynamicLease = shouldTrackDynamicToolCategoryLease(_reason)
    categories.forEach((categoryId) => {
      if (!this.isToolCategoryAllowed(categoryId)) return
      this.enabledToolCategories.add(categoryId)
      this.activeToolCategories.add(categoryId)
      // resident 表示类别不能被关停，不表示该类别的全部 schema 永远绕过工具预算驻留。
      // 显式 page-in 仍要创建临时预算覆盖，否则模型刚换入一个默认 resident 类别，下一轮
      // 仍可能看不到任何具体工具。
      if (dynamicLease) {
        this.budgetOverrideToolCategories.add(categoryId)
        this.budgetOverrideToolCategoryTouchedAtTurn.set(
          categoryId,
          this.currentToolLeaseTurn
        )
      }
    })

    return this.getEnabledToolCategories()
  }

  public disableToolCategories(categories: ToolCategoryId[], _reason?: string): ToolCategoryId[] {
    return this.disableToolCategoriesInternal(categories)
  }

  private disableToolCategoriesInternal(
    categories: ToolCategoryId[],
    options: { preserveSessionApprovals?: boolean } = {}
  ): ToolCategoryId[] {
    const protectedIds = this.residentToolCategories
    for (const categoryId of categories) {
      if (protectedIds.has(categoryId)) {
        continue
      }
      this.enabledToolCategories.delete(categoryId)
      this.activeToolCategories.delete(categoryId)
      if (!options.preserveSessionApprovals) {
        this.sessionApprovedToolCategories.delete(categoryId)
      }
      this.budgetOverrideToolCategories.delete(categoryId)
      this.budgetOverrideToolCategoryTouchedAtTurn.delete(categoryId)
      this.toolCategoryToolNames[categoryId]?.forEach((toolName) => {
        this.budgetOverrideToolNames.delete(toolName)
        this.budgetOverrideToolNameTouchedAtTurn.delete(toolName)
      })
    }

    return this.getEnabledToolCategories()
  }

  public enableToolNames(toolNames: string[], _reason?: string): string[] {
    toolNames.forEach((toolName) => {
      const normalized = toolName.trim()
      if (normalized) {
        this.budgetOverrideToolNames.add(normalized)
        this.budgetOverrideToolNameTouchedAtTurn.set(normalized, this.currentToolLeaseTurn)
        // 按名换入同时续租已有的类别准入，避免下一轮类别到期反过来清掉刚刷新的工具租约。
        const categoryId = this.resolveToolCategoryForToolName(normalized)
        if (categoryId && this.budgetOverrideToolCategories.has(categoryId)) {
          this.budgetOverrideToolCategoryTouchedAtTurn.set(categoryId, this.currentToolLeaseTurn)
        }
      }
    })

    return this.getBudgetOverrideToolNames()
  }

  /** 精确工具页租约；供注册表区分显式 page-in 与整类默认暴露。 */
  public hasToolNameAccess(toolName: string): boolean {
    return this.budgetOverrideToolNames.has(toolName.trim())
  }

  public disableToolNames(toolNames: string[], _reason?: string): string[] {
    toolNames.forEach((toolName) => {
      const normalized = toolName.trim()
      if (normalized) {
        this.budgetOverrideToolNames.delete(normalized)
        this.budgetOverrideToolNameTouchedAtTurn.delete(normalized)
        this.reportedEvictedPageInTools.delete(normalized)
      }
    })

    return this.getBudgetOverrideToolNames()
  }

  public pruneExpiredToolNameLeases(turn: number): string[] {
    const normalizedTurn = isFiniteNumber(turn) ? Math.max(0, Math.floor(turn)) : 0
    this.currentToolLeaseTurn = normalizedTurn
    const expired: string[] = []

    for (const toolName of [...this.budgetOverrideToolNames]) {
      const touchedTurn = this.budgetOverrideToolNameTouchedAtTurn.get(toolName)
      if (!isFiniteNumber(touchedTurn)) {
        this.budgetOverrideToolNameTouchedAtTurn.set(toolName, normalizedTurn)
        continue
      }

      if (normalizedTurn - touchedTurn < this.toolNameLeaseTurns) {
        continue
      }

      this.budgetOverrideToolNames.delete(toolName)
      this.budgetOverrideToolNameTouchedAtTurn.delete(toolName)
      this.reportedEvictedPageInTools.delete(toolName)
      expired.push(toolName)
    }

    return expired
  }

  public pruneExpiredToolCategoryLeases(turn: number): ToolCategoryId[] {
    const normalizedTurn = isFiniteNumber(turn) ? Math.max(0, Math.floor(turn)) : 0
    this.currentToolLeaseTurn = normalizedTurn
    const expired: ToolCategoryId[] = []

    for (const categoryId of [...this.budgetOverrideToolCategories]) {
      const touchedTurn = this.budgetOverrideToolCategoryTouchedAtTurn.get(categoryId)
      if (!isFiniteNumber(touchedTurn)) {
        this.budgetOverrideToolCategoryTouchedAtTurn.set(categoryId, normalizedTurn)
        continue
      }

      if (normalizedTurn - touchedTurn < this.toolNameLeaseTurns) continue

      if (!this.residentToolCategories.has(categoryId)) {
        this.enabledToolCategories.delete(categoryId)
        this.activeToolCategories.delete(categoryId)
      }
      this.budgetOverrideToolCategories.delete(categoryId)
      this.budgetOverrideToolCategoryTouchedAtTurn.delete(categoryId)
      this.toolCategoryToolNames[categoryId]?.forEach((toolName) => {
        this.budgetOverrideToolNames.delete(toolName)
        this.budgetOverrideToolNameTouchedAtTurn.delete(toolName)
        this.reportedEvictedPageInTools.delete(toolName)
      })
      expired.push(categoryId)
    }

    return expired
  }

  private resolveToolCategoryForToolName(toolName: string): LooseOptional<ToolCategoryId> {
    const runtimeTool = this.boundToolContext
      ?.listTools('all')
      .find((tool) => tool.name === toolName && isPresent(tool.categoryId))
    if (runtimeTool?.categoryId) return runtimeTool.categoryId

    for (const [categoryId, toolNames] of Object.entries(this.toolCategoryToolNames) as Array<
      [ToolCategoryId, readonly string[]]
    >) {
      if (toolNames.includes(toolName)) return categoryId
    }

    return null
  }

  public getTurnPlanningSnapshot<TSnapshot = unknown>(signature: string): Nullable<TSnapshot> {
    if (!signature) return null
    if (!this.turnPlanningSnapshots.has(signature)) return null
    const snapshot = this.turnPlanningSnapshots.get(signature) as TSnapshot
    this.turnPlanningSnapshots.delete(signature)
    this.turnPlanningSnapshots.set(signature, snapshot)
    return snapshot
  }

  public setTurnPlanningSnapshot(signature: string, snapshot: unknown): void {
    if (!signature) return
    if (this.turnPlanningSnapshots.has(signature)) {
      this.turnPlanningSnapshots.delete(signature)
    }
    this.turnPlanningSnapshots.set(signature, snapshot)
    while (this.turnPlanningSnapshots.size > this.maxTurnPlanningSnapshots) {
      const oldest = this.turnPlanningSnapshots.keys().next().value
      if (!isString(oldest)) break
      this.turnPlanningSnapshots.delete(oldest)
    }
  }

  public recordTurnPlanningTelemetry(entry: TurnPlanningTelemetryPayload): void {
    const snapshot = {
      ...entry,
      expiredToolNameLeases: [...entry.expiredToolNameLeases],
      categorySummary: entry.categorySummary.map((category) => ({
        id: category.id,
        toolCount: category.toolCount,
      })),
    }
    this.lastTurnPlanningTelemetry = snapshot
    this.recentTurnPlanningTelemetry.push(snapshot)
    while (
      this.recentTurnPlanningTelemetry.length >
      CodingSessionTracker.MaxTurnPlanningTelemetryEntries
    ) {
      this.recentTurnPlanningTelemetry.shift()
    }
  }

  public getLastTurnPlanningTelemetry(): Nullable<TurnPlanningTelemetryPayload> {
    return this.lastTurnPlanningTelemetry
      ? {
          ...this.lastTurnPlanningTelemetry,
          expiredToolNameLeases: [...this.lastTurnPlanningTelemetry.expiredToolNameLeases],
          categorySummary: this.lastTurnPlanningTelemetry.categorySummary.map((category) => ({
            id: category.id,
            toolCount: category.toolCount,
          })),
        }
      : null
  }

  public getToolSchemaBudgetScale(): number {
    let consecutivePressureTurns = 0

    for (let index = this.recentTurnPlanningTelemetry.length - 1; index >= 0; index -= 1) {
      const entry = this.recentTurnPlanningTelemetry[index]
      if (!entry || entry.droppedToolCount <= 0) break
      consecutivePressureTurns += 1
    }

    if (consecutivePressureTurns >= 4) return 0.7
    if (consecutivePressureTurns >= 2) return 0.85
    return 1
  }

  public enqueueToolAllocatorRequest(request: ToolAllocatorRequest): number {
    this.pendingToolAllocatorRequests.push({
      ...request,
      operations: [...request.operations],
      targets: request.targets ? [...request.targets] : undefined,
    })
    return this.pendingToolAllocatorRequests.length
  }

  public drainToolAllocatorRequests(): ToolAllocatorRequest[] {
    const drained = this.pendingToolAllocatorRequests.splice(0)
    return drained.map((request) => ({
      ...request,
      operations: [...request.operations],
      targets: request.targets ? [...request.targets] : undefined,
    }))
  }

  /** 已就“缺页（被预算换出）”上报过的 page-in 工具名，避免每轮重复刷屏。 */
  private readonly reportedEvictedPageInTools = new Set<string>()

  /**
   * 计算本轮“新发生缺页”的 page-in 工具并标记已上报。
   *
   * 背景：模型 tooling:replace page-in 的工具进入 budgetOverrideToolNames 获得驻留优先级，
   * 但动态工具空间是硬预算——当驻留集合本身超出 maxToolSchemaChars 时，部分 page-in 工具仍会被换出。
   * 若对模型静默，模型会困惑“为什么换入的工具下一轮不见了”。这里把换出的 page-in 工具回报给上层，
   * 由 agent loop 注入一条 system 提醒。
   *
   * 去重策略：已上报过的不再重复；一旦某工具重新回到驻留集合（不在 evicted 列表里），
   * 清除其记录，使它将来再次被换出时能重新上报。
   */
  public collectNewlyEvictedPagedInTools(evictedToolNames: readonly string[]): string[] {
    const evicted = new Set(evictedToolNames)
    for (const name of [...this.reportedEvictedPageInTools]) {
      if (!evicted.has(name)) {
        this.reportedEvictedPageInTools.delete(name)
      }
    }

    const newly: string[] = []
    for (const name of evictedToolNames) {
      if (!this.reportedEvictedPageInTools.has(name)) {
        this.reportedEvictedPageInTools.add(name)
        newly.push(name)
      }
    }

    return newly
  }

  public hasToolCategoryAccess(category: ToolCategoryId): boolean {
    return this.enabledToolCategories.has(category)
  }

  public hasActiveToolCategoryAccess(category: ToolCategoryId): boolean {
    return this.activeToolCategories.has(category)
  }

  public isToolCategoryAllowed(category: ToolCategoryId): boolean {
    if (this.deniedToolCategories.has(category)) return false
    return !(this.allowedToolCategories && !this.allowedToolCategories.has(category))
  }

  public getEnabledToolCategories(): ToolCategoryId[] {
    return [...this.enabledToolCategories]
  }

  public getActiveToolCategories(): ToolCategoryId[] {
    return [...this.activeToolCategories]
  }

  /** Read the opaque capability scope selected by the composition root. */
  public getActiveCapabilityScope(): CapabilityScopeId {
    return this.activeCapabilityScope
  }

  public getToolSurfaceProfile(): ToolSurfaceProfileId {
    return this.activeToolSurfaceProfile
  }

  public setThinkingDepth(thinkingDepth: ThinkingDepth): ThinkingDepth {
    this.thinkingDepth = thinkingDepth
    return this.thinkingDepth
  }

  public setToolSurfaceProfile(
    profile: ToolSurfaceProfileId,
    _reason?: string
  ): ToolSurfaceProfileId {
    this.activeToolSurfaceProfile = assertToolSurfaceProfileId(
      profile,
      'CodingSessionTracker.toolSurfaceProfile'
    )
    return this.activeToolSurfaceProfile
  }

  public getRunProfile(): RunProfileSelectionId {
    return this.activeRunProfile
  }

  public getRunProfileRestoreTarget(): Nullable<RunProfileSelectionId> {
    return this.runProfileRestoreTarget
  }

  public setRunProfileRestoreTarget(
    profile: Nullable<RunProfileSelectionId>
  ): Nullable<RunProfileSelectionId> {
    this.runProfileRestoreTarget = profile
      ? assertRunProfileSelectionId(profile, 'CodingSessionTracker.runProfileRestoreTarget')
      : null
    return this.runProfileRestoreTarget
  }

  public getBudgetOverrideToolCategories(): ToolCategoryId[] {
    return [...this.budgetOverrideToolCategories]
  }

  public getBudgetOverrideToolNames(): string[] {
    return [...this.budgetOverrideToolNames]
  }

  /** 工具运行时使用计数快照（冷热感知换页用，值为本会话累计调用次数）。 */
  public getToolUsageScores(): Record<string, number> {
    return Object.fromEntries(this.toolUsageCounts)
  }

  public recordInvisibleToolCall(_toolName: string): void {
    this.telemetryCounters.recordInvisibleToolCall()
  }

  public recordConfirmationCard(): void {
    this.telemetryCounters.recordConfirmationCard()
  }

  public grantConfirmedRiskScope(scope: string, _reason?: string): string[] {
    const normalizedScope = scope.trim()
    if (!normalizedScope) return this.getConfirmedRiskScopes()

    this.recordTaskApproval(normalizedScope, true, {
      operation: { key: normalizedScope, label: _reason ?? normalizedScope },
    })
    return this.getConfirmedRiskScopes()
  }

  public hasConfirmedRiskScope(scope: string): boolean {
    const normalizedScope = scope.trim()
    return !!normalizedScope && this.approvalState.has(normalizedScope)
  }

  public get taskApprovalState(): TaskApprovalStateApi {
    return this.approvalState
  }

  public getConfirmedRiskScopes(): string[] {
    return this.approvalState.scopes()
  }

  /** 新一轮和子 Agent 保留同一授权归属；编辑、工具启用与提醒状态仍独立。 */
  public useTaskApprovalStateFrom(source: CodingSessionTrackerApi): void {
    this.approvalState = source.taskApprovalState
  }

  public getTaskApprovalRecords(): TaskApprovalRecord[] {
    return this.approvalState.list()
  }

  public recordTaskApproval(key: string, approved: boolean, options: ToolConfirmationDecisionOptions, message?: LooseOptional<string>): void {
    this.approvalState.record(key, approved, options, message)
  }

  public getTaskApprovalDenial(key: string): Nullable<string> {
    return this.approvalState.denial(key)
  }

  public revokeTaskApproval(id: string): boolean {
    return this.approvalState.revoke(id)
  }

  public getToolLayerTelemetryMetrics(turnsPerCompletedTask?: number): ToolLayerTelemetryMetrics {
    return {
      enableToolsPerSession: this.telemetryCounters.enableToolsPerSession,
      dedupeHitCount: this.telemetryCounters.dedupeHitCount,
      invisibleToolCallCount: this.telemetryCounters.invisibleToolCallCount,
      confirmCardsPerSession: this.telemetryCounters.confirmCardsPerSession,
      toolsBlockCacheInvalidationRate: this.getToolsBlockCacheInvalidationRate(),
      turnsPerCompletedTask: isFiniteNumber(turnsPerCompletedTask)
        ? Math.max(0, Math.floor(turnsPerCompletedTask))
        : null,
    }
  }

  private getToolsBlockCacheInvalidationRate(): Nullable<number> {
    if (this.recentTurnPlanningTelemetry.length < 2) return null

    let transitions = 0
    let changed = 0
    for (let index = 1; index < this.recentTurnPlanningTelemetry.length; index += 1) {
      const previous = this.recentTurnPlanningTelemetry[index - 1]
      const current = this.recentTurnPlanningTelemetry[index]
      if (!previous || !current) continue
      transitions += 1
      if (previous.signature !== current.signature) changed += 1
    }

    if (transitions === 0) return null
    return Math.round((changed / transitions) * 1000) / 1000
  }

  /** agent loop 每轮解析出模型可用窗口（token）后写入，供编辑预算门控读取；传非正数视为未知。 */
  public setUsableContextWindowTokens(tokens: Nullable<number>): void {
    this.usableContextWindowTokens = isPositiveNumber(tokens) ? Math.floor(tokens) : null
  }

  /** 读取本轮模型输入侧可用窗口（token）；未知时为 null，调用方应退回保守默认。 */
  public getUsableContextWindowTokens(): Nullable<number> {
    return this.usableContextWindowTokens
  }

  public setRunProfile(profile: RunProfileSelectionId, _reason?: string): RunProfileSelectionId {
    this.activeRunProfile = assertRunProfileSelectionId(profile, 'CodingSessionTracker.runProfile')
    return this.activeRunProfile
  }

  public grantSessionToolCategoryApproval(
    category: ToolCategoryId,
    _reason?: string
  ): ToolCategoryId[] {
    if (!this.isToolCategoryAllowed(category)) return this.getSessionApprovedToolCategories()
    this.sessionApprovedToolCategories.add(category)
    if (!this.hasConfirmedRiskScope(`tool-category:${category}`)) {
      this.grantConfirmedRiskScope(`tool-category:${category}`, _reason)
    }
    return this.getSessionApprovedToolCategories()
  }

  public hasSessionToolCategoryApproval(category: ToolCategoryId): boolean {
    const status = this.approvalState.status(`tool-category:${category}`)
    return status ? status === 'approved' : this.sessionApprovedToolCategories.has(category)
  }

  public getSessionApprovedToolCategories(): ToolCategoryId[] {
    return [...this.sessionApprovedToolCategories].filter((category) => this.hasSessionToolCategoryApproval(category))
  }

  /**
   * 消费全局 auto-approve notice（忽略 category 参数，兼容现有调用签名）。
   * 整会话只消费一次。
   */
  public consumePendingAutoApprovalNotice(
    _category: ToolCategoryId
  ): Nullable<CapabilityAutoApprovalNotice> {
    const notice = toNullable(this.pendingGlobalAutoApprovalNotice)
    if (notice) {
      this.pendingGlobalAutoApprovalNotice = null
    }
    return notice
  }

  public enablePromptFeatures(
    features: ChatPromptFeatureId[],
    _reason?: string
  ): ChatPromptFeatureId[] {
    const normalizedFeatures = this.promptFeaturePolicy.normalize(features)
    normalizedFeatures.forEach((feature) => {
      this.enabledPromptFeatures.add(feature)
    })
    this.promptFeaturePolicy.getCategoriesForFeatures(normalizedFeatures).forEach((category) => {
      if (this.isToolCategoryAllowed(category)) {
        this.budgetOverrideToolCategories.add(category)
      }
    })

    return this.getEnabledPromptFeatures()
  }

  public disablePromptFeatures(
    features: ChatPromptFeatureId[],
    _reason?: string
  ): ChatPromptFeatureId[] {
    this.promptFeaturePolicy.normalize(features).forEach((feature) => {
      this.enabledPromptFeatures.delete(feature)
      if (feature === 'office') {
        this.sessionApprovedToolCategories.delete('office')
      }
    })
    const remainingPromptFeatureCategories = new Set(
      this.promptFeaturePolicy.getCategoriesForFeatures(this.getEnabledPromptFeatures())
    )
    this.promptFeaturePolicy.getCategoriesForFeatures(features).forEach((category) => {
      if (!remainingPromptFeatureCategories.has(category)) {
        this.budgetOverrideToolCategories.delete(category)
      }
    })

    return this.getEnabledPromptFeatures()
  }

  public hasPromptFeatureAccess(feature: ChatPromptFeatureId): boolean {
    return this.enabledPromptFeatures.has(feature)
  }

  public getEnabledPromptFeatures(): ChatPromptFeatureId[] {
    return [...this.enabledPromptFeatures]
  }

  private resetVerificationStateForEdits(): void {
    this.latestVerificationStatus = null
    this.activeVerificationFailure = null
  }

  private collectModifiedPaths(result: unknown): void {
    this.editResultHelper.extractModifiedPaths(result).forEach((path) => {
      this.modifiedPaths.add(path)
    })
  }

  private collectVerificationNotes(toolName: string, result: unknown): void {
    const verification = this.verificationHelper.collectVerificationToolResult(toolName, result)
    if (!verification) return

    this.applyVerificationCollectionResult(verification)
  }

  /**
   * 把 verification helper 抽出来的结果灌进会话状态——同时维护"连续失败计数"。
   *
   * 命中失败 / timed-out → +1；命中 passed → 清零。其它状态（unknown）保持不变，
   * 避免不明确的状态把计数器误重置。
   */
  private applyVerificationCollectionResult(verification: {
    latestVerificationStatus: LooseOptional<CapabilityValidationStatus>
    activeVerificationFailure: LooseOptional<CapabilityValidationFailure>
  }): void {
    this.latestVerificationStatus = verification.latestVerificationStatus
    this.activeVerificationFailure = verification.activeVerificationFailure
    if (verification.latestVerificationStatus === 'passed') {
      this.consecutiveVerificationFailures = 0
    } else if (
      verification.latestVerificationStatus === 'failed' ||
      verification.latestVerificationStatus === 'timed-out'
    ) {
      this.consecutiveVerificationFailures += 1
    }
  }

  private getPassedVerificationFingerprintsForCurrentVersion(): Set<string> {
    const existing = this.passedVerificationFingerprintsByVersion.get(this.editVersion)
    if (existing) return existing

    // editVersion 持续递增，老 version 上挂的 fingerprint Set 不再被读到（recordToolResult
    // 只会写当前 editVersion）。这里在新建一条桶位时做一次 LRU 清理：只保留最近若干个
    // editVersion 的 fingerprints，防止长时段 session 里 Map 无限膨胀。
    // 上限取一个比较保守的值——verification reminder 只关心"自上次成功 verify 起累积的
    // 失败指纹"，往远历史看意义不大；保留 8 个 editVersion 已经足以覆盖 turn 内回看场景。
    const MaxRetainedEditVersions = 8
    if (this.passedVerificationFingerprintsByVersion.size >= MaxRetainedEditVersions) {
      // Map 的 keys 迭代顺序就是插入顺序，因为 editVersion 单调递增，最早插入的就是最小的。
      // 把多余的"老 version"挨个删掉，直到回到 MaxRetainedEditVersions - 1，再 set 当前版本就刚好达到上限。
      const iter = this.passedVerificationFingerprintsByVersion.keys()
      while (this.passedVerificationFingerprintsByVersion.size >= MaxRetainedEditVersions) {
        const next = iter.next()
        if (next.done) break
        this.passedVerificationFingerprintsByVersion.delete(next.value)
      }
    }

    const fingerprints = new Set<string>()
    this.passedVerificationFingerprintsByVersion.set(this.editVersion, fingerprints)
    return fingerprints
  }

  private getPassedVerificationCommandsForCurrentVersion(): Set<string> {
    const existing = this.passedVerificationCommandsByVersion.get(this.editVersion)
    if (existing) return existing

    const MaxRetainedEditVersions = 8
    if (this.passedVerificationCommandsByVersion.size >= MaxRetainedEditVersions) {
      const iter = this.passedVerificationCommandsByVersion.keys()
      while (this.passedVerificationCommandsByVersion.size >= MaxRetainedEditVersions) {
        const next = iter.next()
        if (next.done) break
        this.passedVerificationCommandsByVersion.delete(next.value)
      }
    }

    const commands = new Set<string>()
    this.passedVerificationCommandsByVersion.set(this.editVersion, commands)
    return commands
  }

  private recordPassedVerificationCommandForCurrentVersion(
    toolName: string,
    args: Record<string, unknown>
  ): void {
    if (toolName !== 'system:run' && toolName !== 'project:run') return
    const command = args.command
    if (!isString(command) || !command.trim()) return

    this.getPassedVerificationCommandsForCurrentVersion().add(command.trim())
  }

  private hasPassedVerificationCommandForCurrentVersion(command: unknown): boolean {
    if (!isString(command) || !command.trim()) return false
    const cited = command.trim()
    return [...this.getPassedVerificationCommandsForCurrentVersion()].some((ran) =>
      this.verificationHelper.evidenceMatches(cited, ran)
    )
  }

  private buildVerificationToolFingerprint(
    toolName: string,
    args: Record<string, unknown>
  ): LooseOptional<string> {
    return this.verificationHelper.buildVerificationToolFingerprint(toolName, args)
  }

  private isPassedVerificationResult(toolName: string, result: unknown): boolean {
    return this.verificationHelper.isPassedVerificationResult(toolName, result)
  }
}

export type { CodingSessionTrackerOptions }
export { CodingSessionTracker }

/** 建一份会话工作态：可见工具类别、提示词特性与本轮改动都记在它身上。 */
export function createCodingSessionTracker(initialCategories: ToolCategoryId[] = [], initialPromptFeatures?: ChatPromptFeatureId[], initialApprovedCategories: ToolCategoryId[] = [], freshAutoApprovedCategories: ToolCategoryId[] = [], options: CodingSessionTrackerOptions = {}): CodingSessionTrackerApi {
  return new CodingSessionTracker(initialCategories, initialPromptFeatures, initialApprovedCategories, freshAutoApprovedCategories, options)
}
