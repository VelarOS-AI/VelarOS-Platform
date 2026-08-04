import type {
  ThinkingDepth,
  ToolCategoryId,
} from '@velaros-ai/agent/protocol'

import type { CapabilityValidationStatus } from '../capabilities'
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

/** 用于 capabilityToolNames 派生工具名时表达分类。 */
export type ReminderCapabilityResolver = (category: ToolCategoryId) => string[]

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

/** Producer 声明：把"什么时机发什么提醒"沉淀为静态描述，让调度器集中决定是否注入。 */
export interface RuntimeReminderProducer {
  /** 全局唯一 id；同 id 注册时覆盖。 */
  id: string
  /** 触发器集合；调度器仅在匹配触发器时考虑该 producer。 */
  triggers: readonly ReminderTrigger[]
  /** 越小越靠前；同一触发器下，命中多个时按 priority 选最高优。 */
  priority: number
  /** 单次性策略，配合 editVersion 决定是否已发。 */
  scope: ReminderScope
  /** Producer 关注的能力分类；调试展示用，render 内部可自由读取 capabilityToolNames。 */
  capabilities?: readonly ToolCategoryId[]
  /** 激活谓词；返回 false 时调度器跳过。 */
  when: (input: RuntimeReminderInput) => boolean
  /** 渲染提示文本；空文案视为不发送。 */
  render: (input: RuntimeReminderInput) => LooseOptional<string>
}
