import type { ReminderCapabilityResolver } from '../contract/requires.js'

import type { StreamToolCallPayload, StreamToolResultPayload,ThinkingDepth, ToolCategoryId } from './agent.js'
import type { CapabilityValidationRunResult,CapabilityValidationStatus } from './capabilities.js'

export interface CapabilityValidationFailure {
  command: string
  status: 'failed' | 'timed-out'
  issues: string[]
}

export interface CodingSessionSnapshot {
  modifiedPaths: string[]
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
 * 用 `hasVerificationRelevantModifiedPaths` 过滤掉只改了非代码资产（如 .png、随机文本）的场景，
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
