import type { TaskApprovalStateApi } from '../contract/provides.js'
import type { CapabilityValidationInterpreter, ReminderCapabilityResolver, RuntimePromptFeaturePolicy, RuntimeReminderProducer } from '../contract/requires.js'

import type { CapabilityScopeId, RunProfileSelectionId, StreamToolCallPayload, StreamToolResultPayload, ThinkingDepth, ToolCategoryId, ToolSurfaceProfileId } from './agent.js'
import type { CapabilityValidationRunResult, CapabilityValidationStatus } from './capabilities.js'


export interface CapabilityValidationFailure {
  command: string
  status: 'failed' | 'timed-out'
  issues: string[]
}

/**
 * 「改到这个文件之后要不要再跑一次验证」的判据：由做这次改动的空间声明，Agent 只调用。
 * 收的是会话里记下的改动路径（相对根或绝对都可能）。
 */
export type VerificationRelevantPathPredicate = (path: string) => boolean

export interface CodingSessionSnapshot {
  modifiedPaths: string[]
  /**
   * `modifiedPaths` 里有几条按宿主声明的判据算「值得再跑一次验证」
   * （见 {@link CodingSessionTrackerOptions.isVerificationRelevantPath}）。
   * 缺省（快照不是跟踪器出的）时按「每条都算」读。
   */
  verificationRelevantPathCount?: number
  hasCapabilityMutations: boolean
  hasCapabilityInspection: boolean
  needsChangeInspection: boolean
  needsVerificationCommand: boolean
  reminderIssuedForCurrentEdits: boolean
  verificationReminderIssuedForCurrentEdits?: boolean
  // 与主进程 snapshot 契约保持一致，避免跨包赋值时丢失收敛边界。
  latestVerificationStatus: Nullable<CapabilityValidationStatus>
  activeVerificationFailure: Nullable<CapabilityValidationFailure>
  /**
   * 本会话内连续 verification 失败的次数（成功一次清零）。
   *
   * 用于 failedVerification reminder 在文案上升级——次数到达阈值时由 reminder
   * 改成"建议停下来询问用户 / 拆小步 / 换思路"的提示，避免模型在 edit→verify-fail→edit
   * 的小循环里耗尽 maxSteps。
   */
  consecutiveVerificationFailures?: number
}

/**
 * 运行时提醒触发器。
 *
 * - finishing：模型本轮没有 tool use，准备收尾时；最适合 post-edit / 终态提醒。
 * - post-tool：每次工具结果后；用于紧急通知（验证失败等）。
 * - verification-failed：显式的验证失败事件，便于在专门通道里组装失败提醒。
 *
 * 新增触发器时同步 docs/modules/agent-reminders.md。
 */
export type ReminderTrigger = 'finishing' | 'post-tool' | 'verification-failed'

/**
 * Producer 单次性策略。
 *
 * - one-shot：整个会话只发一次。
 * - per-edit-version：每个新的编辑事务只发一次；新一批编辑会自动重置。
 * - always：每次匹配都允许重新渲染（用于 peek 场景）。
 */
export type ReminderScope = 'one-shot' | 'per-edit-version' | 'always'

/** Producer/Render 输入：把工具上下文、状态快照和工具名解析器一起带进去。 */
export interface RuntimeReminderInput {
  /** 当前 tool context。 */
  toolContext: unknown
  /** 当前 coding session 快照。 */
  snapshot: CodingSessionSnapshot
  /** 当前 run 已开放的工具类别。 */
  enabledToolCategories?: readonly ToolCategoryId[]
  /** 当前编辑事务版本号；同一版本只允许 per-edit-version producer 发一次。 */
  editVersion: number
  /** 当前会话运行策略；低档位用于压制检查/验证类软提醒。 */
  thinkingDepth?: ThinkingDepth
  /** 从 ToolCategory 派生工具名；reminder 文案应优先用它代替硬编码工具名。 */
  capabilityToolNames: ReminderCapabilityResolver
}

export type CodingSessionToolCategoryToolNames = Partial<Record<ToolCategoryId, readonly string[]>>

export interface CodingSessionToolContext {
  listTools(scope?: string): Array<{
    name: string
    categoryId?: LooseOptional<ToolCategoryId>
  }>
}

export interface CapabilityValidationCollectionResult {
  latestVerificationStatus: CapabilityValidationStatus
  activeVerificationFailure: Nullable<CapabilityValidationFailure>
  notes: string[]
}

/** consume 命中 producer 时的元信息，便于调用方同步 CodingSessionTracker 等旁路状态。 */
export interface RuntimeReminderConsumeResult {
  producerId: string
  text: string
}

/**
 * 运行期提醒调度台的最小形状：工具上下文只需要"按触发点取一条提醒"这一面。
 * 类实现在 impl/session/RuntimeReminderScheduler.ts。
 */
export interface RuntimeReminderSchedulerContract {
  /** 登记一个提醒生产者；同 id 重复登记时后来的覆盖先前的。 */
  register(producer: RuntimeReminderProducer): void
  /** 注销一个提醒生产者。 */
  unregister(producerId: string): void
  /** 取一条提醒并把它记成已发（同一轮不重复发）。 */
  consume(trigger: ReminderTrigger, input: RuntimeReminderInput): Nullable<RuntimeReminderConsumeResult>
  /** 只向指定生产者取一条提醒并记成已发。 */
  consumeProducer(producerId: string, input: RuntimeReminderInput): Nullable<string>
  /** 看一眼会发什么，不记成已发。 */
  peek(trigger: ReminderTrigger, input: RuntimeReminderInput): Nullable<string>
  /** 看一眼会发什么并带上生产者身份，不记成已发。 */
  peekWithProducer(trigger: ReminderTrigger, input: RuntimeReminderInput): Nullable<RuntimeReminderConsumeResult>
  /** 清掉某个生产者的"已发"记录，让它下一轮能再发。 */
  resetScope(producerId: string): void
  /** 列出已登记的生产者与它们认领的触发点。 */
  listRegisteredProducers(): Array<{ id: string; triggers: readonly ReminderTrigger[] }>
}

export interface AutoVerificationCodingSession {
  getSnapshot: () => CodingSessionSnapshot
  getReminderScheduler: () => {
    consume: (
      trigger: 'finishing' | 'post-tool' | 'verification-failed',
      input: RuntimeReminderInput
    ) => Nullable<RuntimeReminderConsumeResult>
  }
  buildReminderInput: () => RuntimeReminderInput
  finalizeReminderConsumeResult: (result: Nullable<RuntimeReminderConsumeResult>) => void
  recordVerificationReminderIssued: () => void
  hasToolCategoryAccess: (category: ToolCategoryId) => boolean
  recordVerificationFailure: (
    command: string,
    status: 'failed' | 'timed-out',
    issues: string[]
  ) => void
}

export interface AutoVerificationToolContext {
  codingSession: AutoVerificationCodingSession
  // 父执行的取消信号；verification gate 与本轮执行同生共死。
  abortSignal: AbortSignal
  listTools: (
    scope?: 'all'
  ) => Array<{
    name: string
    categoryId?: LooseOptional<ToolCategoryId>
  }>
}

export interface AutoVerificationEvents {
  emitToolStart: (payload: StreamToolCallPayload) => void
  emitToolDone: (payload: StreamToolResultPayload) => void
}

/**
 * 收尾验证提醒模块说明。
 *
 * 基于编码会话快照，在轮次收尾时决定是否插入一条验证**提醒**（只提醒、绝不代跑）：
 *  - 有相关变更但还没验证过 → 插入验证提醒，引导模型调用注入的验证能力；
 *  - 上一轮验证仍在失败 → 插入失败提醒（顽固失败保护，活跃失败由 CodingSessionTracker 维护）；
 *  - 其余情况不注入。
 *
 * 用 `hasVerificationRelevantModifiedPaths` 过滤掉只改了非代码资产（如 .png、随机文本）的场景——
 * 哪些文件算代码由宿主经 `isVerificationRelevantPath` 声明，本包不持有这张名单；
 * 避免对非验证相关编辑插入噪声 reminder。历史上曾有 quick/standard 模式在收尾时**自动代跑**验证
 * 并把结果续发进下一轮——已按用户要求移除，收尾只提醒、是否验证交回模型决定。
 */
export interface AutoVerificationGateResult {
  followupMessage: Nullable<string>
  result: Nullable<CapabilityValidationRunResult>
}

/**
 * Loop reminder 单一调度入口。
 *
 * 设计意图：让 SoloLoop / QueryLoop 在每个 turn 结尾不需要分别 `if (hasToolUse) buildXxx() else buildYyy()`，
 * 只要把当前 mode + phase 报上来，就能拿到这一刻应该 push 进 history 的全部 user-message。
 *
 * 路由矩阵（行为层面与原先散落写法一致）：
 *
 * | mode      | phase        | 注入                                                |
 * |-----------|--------------|----------------------------------------------------|
 * | solo      | after-tool   | 无（solo 由 auto-verification gate 处理验证失败）     |
 * | solo      | finishing    | finishing reminder（postEdit / verification-remind） |
 * | sub-agent | after-tool   | urgent post-tool reminder（仅验证失败通知）          |
 * | sub-agent | finishing    | finishing reminder（postEdit / verification-remind） |
 *
 * 新增 reminder 类别 → 在 producers 加 trigger，再在这里把 phase 映射到 trigger，
 * 不必再去翻 SoloLoop / QueryLoop 的控制流。
 */
export type LoopReminderMode = 'solo' | 'sub-agent'

export type LoopReminderPhase = 'after-tool' | 'finishing'

export interface TickLoopRemindersArgs {
  mode: LoopReminderMode
  phase: LoopReminderPhase
  toolContext: AutoVerificationToolContext
}

/**
 * 建一台 {@link CodingSessionTracker} 时宿主交给它的全部装配项。
 *
 * 全是可选：产品把自己的工具目录、活动分类、授权与提醒策略灌进来，跟踪器自己不认识任何具体工具名。
 * 构造后除 `taskApprovals`（可由 fork 共享同一份）外都不再变——运行期改这些要新建跟踪器。
 */
export interface CodingSessionTrackerOptions {
  /** 共享的任务授权账本；子 Agent fork 时把父的这份接过来，批准/拒绝对主子立即同时生效。缺省自建一份。 */
  taskApprovals?: TaskApprovalStateApi
  /** 工具类别 → 该类别下的工具名清单（静态目录）。用于把工具名反查成类别，以及没绑 ToolContext 时兜底。 */
  toolCategoryToolNames?: CodingSessionToolCategoryToolNames
  /** 提示能力的归一化与「这个能力要开哪些工具类别」策略，由产品提供；缺省用运行时自带的那份。 */
  promptFeaturePolicy?: RuntimePromptFeaturePolicy
  /** 本会话起始的思考力度；运行期可由 `setThinkingDepth` 改。缺省 `balanced`。 */
  thinkingDepth?: ThinkingDepth
  /** 白名单：给了就只有名单内的类别可被启用，名单外的一律拒绝。缺省不限。 */
  allowedToolCategories?: ToolCategoryId[]
  /** 能力自身写盘后多久内忽略文件系统外部触碰回声（毫秒）；太短会把自己的写入误判成外部修改。 */
  externalTouchCooldownMs?: number
  /** 把宿主给的原始路径归一成会话内统一的资源 id；缺省用跟踪器自带的相对路径归一（拒绝 `..`）。 */
  normalizeResourceId?: LooseOptional<(raw: string) => LooseOptional<string>>
  /** 工具呈现档位的初值（决定工具面怎么铺开）；非法值会被断言拦下。 */
  toolSurfaceProfile?: ToolSurfaceProfileId
  /** 运行档位的初值；非法值会被断言拦下。 */
  runProfile?: RunProfileSelectionId
  /** 起始就处于「激活」的类别（已启用里再挑一层）；缺省等于全部已启用类别。 */
  activeToolCategories?: ToolCategoryId[]
  /** 黑名单：名单内的类别一律不许启用，优先级高于白名单。 */
  deniedToolCategories?: readonly ToolCategoryId[]
  /** 常驻类别：不会被关停、也不会被轮次租约到期换出（但具体工具 schema 仍受预算约束）。 */
  residentToolCategories?: readonly ToolCategoryId[]
  /** 按名换入的工具租约能撑几轮不被用到就到期；至少 1，缺省 64。 */
  toolNameLeaseTurns?: number
  /** 轮次规划快照最多留几份（按最近使用淘汰）；至少 1，缺省 8。 */
  maxTurnPlanningSnapshots?: number
  /** 本次执行当前拥有的互斥能力作用域身份。 */
  activeCapabilityScope?: CapabilityScopeId
  /** 产品提供的验证结果解释器；空表示本产品没有「验证」概念，验证相关提醒全部不触发。 */
  validationInterpreters?: readonly CapabilityValidationInterpreter[]
  /** 产品提供的运行时提醒 producer；构造时一次性注册进调度器。 */
  reminderProducers?: readonly RuntimeReminderProducer[]
  /** 按「这类工具算哪种活动」给工具类别分组，决定一次调用推进编辑版本、算检查还是算验证。 */
  activityCategories?: {
    /** 算「检查改动」的类别（读、列目录、看 diff 之类）；调过就把已检查版本推到当前编辑版本。 */
    inspection?: readonly ToolCategoryId[]
    /** 算「改代码」的类别；成功一次编辑版本 +1，并进入外部触碰冷却。 */
    mutation?: readonly ToolCategoryId[]
    /** 算「跑验证」的类别；调过就把已验证版本推到当前编辑版本，并收集验证结论。 */
    validation?: readonly ToolCategoryId[]
    /** 虽然会改东西、但改的是非代码产物的类别；不推进编辑版本，不触发「改完记得验证」。 */
    nonCodeMutation?: readonly ToolCategoryId[]
  }
  /**
   * 「改到这个文件之后要不要再跑一次验证」的判据，由做这次改动的空间给出（项目里是
   * `@velaros-ai/velar/project` 的 `projectVerificationPolicy.isVerificationRelevantPath`）。
   *
   * Agent 只知道自己收集到了哪些改动路径，不知道哪些文件算代码，所以这条判据不在包内；
   * 不给就把每条改动路径都算成要验证的——看不见哪些改动无关紧要，不等于可以把验证告警吞掉。
   */
  isVerificationRelevantPath?: VerificationRelevantPathPredicate
}
