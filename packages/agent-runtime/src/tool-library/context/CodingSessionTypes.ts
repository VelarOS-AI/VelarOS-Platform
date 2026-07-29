import type {
  CapabilityAutoApprovalNotice,
  CapabilityScopeId,
  ChatPromptFeatureId,
  RunProfileSelectionId,
  ToolCategoryId,
  ToolSurfaceProfileId,
} from '@velaros-ai/core/types'

import type { ToolAllocatorRequest } from '../../agent/control-plane'
import type {
  CapabilityValidationRunResult,
  CapabilityValidationStatus,
} from '../../capabilities'
import type {
  CodingSessionSnapshot,
  RuntimeReminderConsumeResult,
  RuntimeReminderInput,
  RuntimeReminderScheduler,
} from '../../reminders'

/** Agent 执行期间的代码会话跟踪 API。 */
export interface ToolCodingSessionApi {
  /** 记录工具结果，用于更新是否写过文件、是否检查过变更等状态。 */
  recordToolResult: (toolName: string, result: any) => void
  /** 记录包含入参的工具结果，可用于发现重复工具调用。 */
  recordToolCallResult: (toolName: string, args: Record<string, any>, result: any) => void
  /** 如果模型重复调用同一工具，返回可直接提示模型的提醒文案。 */
  getRedundantToolCallMessage: (toolName: string, args: Record<string, any>) => Nullable<string>
  /** 记录本会话向用户展示过一张确认卡。 */
  recordConfirmationCard?: () => void
  /** 记住本会话已由用户批准的风险 scope。 */
  grantConfirmedRiskScope?: (scope: string, reason?: string) => string[]
  /** 检查某个风险 scope 是否已在本会话内由用户批准。 */
  hasConfirmedRiskScope?: (scope: string) => boolean
  /** 列出本会话已批准的风险 scope。 */
  getConfirmedRiskScopes?: () => string[]
  /** 运行时提醒调度器（声明式 producer）；调用方应配合 finalizeReminderConsumeResult 同步 tracker 标记。 */
  getReminderScheduler: () => RuntimeReminderScheduler
  /** 组装一次 producer 评估所需的输入。 */
  buildReminderInput: () => RuntimeReminderInput
  /**
   * 在成功 consume 调度器结果后调用：根据 producerId 同步 reminderIssuedForVersion /
   * verificationReminderIssued 等 tracker 旁路状态（与 per-edit-version scope 互补）。
   */
  finalizeReminderConsumeResult: (result: Nullable<RuntimeReminderConsumeResult>) => void
  /** 最近使用过的工具名（最新在前、去重）；供能力扩展过滤相关上下文噪声。 */
  getRecentToolNames?: () => string[]
  /** 获取本 agent run 内所有已记录文件变更（供 get_session_edit_log 工具使用）。 */
  getRecentFileChanges: () => Array<{
    toolName: string
    path: string
    created: boolean
    added: number
    removed: number
    changeId: string
  }>
  /** 标记本轮已经发过验证提醒。 */
  recordVerificationReminderIssued: () => void
  /** 记录验证计划运行结果，更新最新验证状态。 */
  recordVerificationPlanResult: (result: CapabilityValidationRunResult) => void
  /** 手动记录某条命令失败，用于后续提醒。 */
  recordVerificationFailure: (
    command: string,
    status: Extract<CapabilityValidationStatus, 'failed' | 'timed-out'>,
    issues: string[]
  ) => void
  /** 获取当前代码会话状态快照。 */
  getSnapshot: () => CodingSessionSnapshot
  /** 合并子 Agent 完成后的代码会话状态快照。 */
  mergeSnapshot?: (snapshot: CodingSessionSnapshot) => void
  /** 启用一组工具类别，并返回实际新增的类别。 */
  enableToolCategories: (categories: ToolCategoryId[], reason?: string) => ToolCategoryId[]
  /** 标记具体工具名在后续轮次需要注入 schema，并覆盖运行模式预算裁剪。 */
  enableToolNames: (toolNames: string[], reason?: string) => string[]
  /** 移除具体工具名的驻留优先级；下一轮会重新按工具空间预算选择是否暴露。 */
  disableToolNames?: (toolNames: string[], reason?: string) => string[]
  /** 提交下一轮由工具分配器处理的工具租约申请，返回当前待处理申请数。 */
  enqueueToolAllocatorRequest?: (request: ToolAllocatorRequest) => number
  /** Drain 本轮待处理工具分配器申请；agent loop 在每轮模型请求前调用。 */
  drainToolAllocatorRequests?: () => ToolAllocatorRequest[]
  /** 从会话卸载按需工具类别（不可卸载默认类别）。 */
  disableToolCategories: (categories: ToolCategoryId[], reason?: string) => ToolCategoryId[]
  /** 检查当前 session 是否有某个类别的访问权。 */
  hasToolCategoryAccess: (category: ToolCategoryId) => boolean
  /** 检查某个类别是否在本轮应注入模型 schema。 */
  hasActiveToolCategoryAccess: (category: ToolCategoryId) => boolean
  /** 检查某个类别是否属于当前场景允许的工具边界。 */
  isToolCategoryAllowed: (category: ToolCategoryId) => boolean
  /** 读取当前启用的工具类别。 */
  getEnabledToolCategories: () => ToolCategoryId[]
  /** 读取本轮实际注入模型 schema 的工具类别。 */
  getActiveToolCategories: () => ToolCategoryId[]
  /** Read the opaque capability scope selected by the composition root. */
  getActiveCapabilityScope: () => CapabilityScopeId
  /** 当前会话暴露给模型的工具参数复杂度。 */
  getToolSurfaceProfile: () => ToolSurfaceProfileId
  /** 切换当前会话暴露给模型的工具参数复杂度。 */
  setToolSurfaceProfile: (profile: ToolSurfaceProfileId, reason?: string) => ToolSurfaceProfileId
  /** 当前会话的综合运行模式。 */
  getRunProfile: () => RunProfileSelectionId
  /** 临时切换运行模式时应恢复到的目标模式；为空表示当前无需恢复提示。 */
  getRunProfileRestoreTarget?: () => Nullable<RunProfileSelectionId>
  /** 记录或清除临时运行模式恢复目标。 */
  setRunProfileRestoreTarget?: (
    profile: Nullable<RunProfileSelectionId>
  ) => Nullable<RunProfileSelectionId>
  /** 用户显式开启、应覆盖预算裁剪的工具类别。 */
  getBudgetOverrideToolCategories: () => ToolCategoryId[]
  /** 用户显式加载、应覆盖预算裁剪的工具名。 */
  getBudgetOverrideToolNames: () => string[]
  /** 本轮模型输入侧可用窗口（token），由 agent loop 写入；供编辑预算门控读取。 */
  setUsableContextWindowTokens?: (tokens: Nullable<number>) => void
  /** 读取本轮模型输入侧可用窗口（token）；未知时为 null。 */
  getUsableContextWindowTokens?: () => Nullable<number>
  /** 切换当前会话的综合运行模式。 */
  setRunProfile: (profile: RunProfileSelectionId, reason?: string) => RunProfileSelectionId
  /** 授予当前 session 临时类别批准。 */
  grantSessionToolCategoryApproval: (category: ToolCategoryId, reason?: string) => ToolCategoryId[]
  /** 检查某类别是否已被 session 临时批准。 */
  hasSessionToolCategoryApproval: (category: ToolCategoryId) => boolean
  /** 列出 session 临时批准的类别。 */
  getSessionApprovedToolCategories: () => ToolCategoryId[]
  /**
   * 消费某类别的 auto-approve notice（每条只展示一次）。
   * 工具首次执行成功时调用；返回非 null 时附加到工具结果，renderer 据此渲染 UI 卡片。
   */
  consumePendingAutoApprovalNotice: (
    category: ToolCategoryId
  ) => Nullable<CapabilityAutoApprovalNotice>
  /** 启用宿主声明的 prompt feature。 */
  enablePromptFeatures: (features: ChatPromptFeatureId[], reason?: string) => ChatPromptFeatureId[]
  /** 卸载 prompt feature。 */
  disablePromptFeatures: (
    features: ChatPromptFeatureId[],
    reason?: string
  ) => ChatPromptFeatureId[]
  /** 检查 prompt feature 是否可用。 */
  hasPromptFeatureAccess: (feature: ChatPromptFeatureId) => boolean
  /** 列出当前启用的 prompt feature。 */
  getEnabledPromptFeatures: () => ChatPromptFeatureId[]
  /**
   * 会话内各资源的最新 revision（由注入的读取/变更能力结果推进）。
   * 用于发往模型前压缩过期的读文件工具快照。
   */
  getResourceRevisionHints: () => Record<string, string>
  /** 宿主观察器检测到的外部资源变更；与 revision map 一并传给 history sanitize。 */
  getExternallyTouchedResourceIds: () => readonly string[]
  /** 在每轮模型请求开始前Drain的外部触摸路径汇总后进 CodingSession（带去抖内核写入避让）。 */
  notifyExternalFilesystemTouches: (relativePaths: readonly string[]) => void
  /**
   * 为子 Agent 派生一个隔离的会话追踪器：复制配置与审批快照，但重置 editVersion、
   * 去重指纹、验证熔断、提醒版本等易变运行态，避免并发子 Agent 之间及与父之间串味。
   *
   * 生产环境的 CodingSessionTracker 始终实现该方法（见 AgentRunner.query 的隔离逻辑）；
   * 设为可选仅为简化测试替身，不要求每个 stub 都实现。
   */
  forkForSubAgent?: () => ToolCodingSessionApi
}
