import type {
  StreamToolCallPayload,
  StreamToolResultPayload,
  ToolCategoryId,
} from '@velaros-ai/agent/protocol'

import type {
  CapabilityValidationRunResult,
} from '../capabilities'
import type {
  CodingSessionSnapshot,
  ReminderCapabilityResolver,
  RuntimeReminderConsumeResult,
  RuntimeReminderInput,
} from '../reminders'

import { hasVerificationRelevantModifiedPaths } from './paths'

interface AutoVerificationCodingSession {
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
  recordVerificationPlanResult: (result: CapabilityValidationRunResult) => void
  recordVerificationFailure: (
    command: string,
    status: 'failed' | 'timed-out',
    issues: string[]
  ) => void
}

interface AutoVerificationToolContext {
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

function shouldSuppressRuntimeReminder(input: RuntimeReminderInput): boolean {
  return input.thinkingDepth === 'fast'
}

interface AutoVerificationEvents {
  emitToolStart: (payload: StreamToolCallPayload) => void
  emitToolDone: (payload: StreamToolResultPayload) => void
}

/**
 * 当前可见工具名解析器：只读取调用方暴露的工具列表。
 * 包本身不持有 main 的 ToolCollections，避免 runtime 反向依赖应用装配层。
 */
function buildCapabilityResolver(toolContext: AutoVerificationToolContext): ReminderCapabilityResolver {
  return (category: ToolCategoryId) => toolContext
      .listTools('all')
      .filter((tool) => tool.categoryId === category)
      .map((tool) => tool.name)
}


function buildAutoVerificationReminderInput(
  toolContext: AutoVerificationToolContext,
  capabilityToolNames: ReminderCapabilityResolver
): RuntimeReminderInput {
  const input = toolContext.codingSession.buildReminderInput()
  return { ...input, capabilityToolNames }
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

export function shouldBlockOnVerificationState(snapshot: CodingSessionSnapshot): boolean {
  return (
    !!snapshot.activeVerificationFailure &&
    hasVerificationRelevantModifiedPaths(snapshot.modifiedPaths)
  )
}

export function shouldRequestVerificationReminder(snapshot: CodingSessionSnapshot): boolean {
  return (
    snapshot.hasCapabilityMutations &&
    snapshot.needsVerificationCommand &&
    hasVerificationRelevantModifiedPaths(snapshot.modifiedPaths) &&
    !snapshot.verificationReminderIssuedForCurrentEdits
  )
}

export async function runAutomaticVerification(args: {
  toolContext: AutoVerificationToolContext
}): Promise<AutoVerificationGateResult> {
  const snapshot = args.toolContext.codingSession.getSnapshot()
  const capabilityToolNames = buildCapabilityResolver(args.toolContext)
  const sched = args.toolContext.codingSession.getReminderScheduler()

  const buildInput = (): RuntimeReminderInput =>
    buildAutoVerificationReminderInput(args.toolContext, capabilityToolNames)

  const finishWithScheduler = (): Nullable<AutoVerificationGateResult> => {
    const input = buildInput()
    if (shouldSuppressRuntimeReminder(input)) return null

    if (!sched) return null
    const out = sched.consume('finishing', input)
    args.toolContext.codingSession.finalizeReminderConsumeResult(out)
    if (!out) return null
    return {
      followupMessage: out.text,
      result: null,
    }
  }

  if (shouldBlockOnVerificationState(snapshot)) {
    const fromScheduler = finishWithScheduler()
    if (fromScheduler) return {
        followupMessage: fromScheduler.followupMessage ?? '',
        result: null,
      }
    if (shouldSuppressRuntimeReminder(buildInput())) return {
        followupMessage: null,
        result: null,
      }
    return { followupMessage: null, result: null }
  }

  // 已按用户决策移除「你还没验证，去验证一下」的收尾催促——只保留上面的「验证**失败**」告警。
  return {
    followupMessage: null,
    result: null,
  }
}

/**
 * Loop 各阶段统一的 reminder 入口。
 *
 * 调用方说明 turnPhase 即可，scheduler 通道 / scope 解析 / dev-env 增强等内部细节由这里集中处理。
 * 新增提醒类别时只需要在 producers 里挂上 trigger 并在这里把 phase 映射到对应 trigger，
 * 不必再在 SoloLoop / QueryLoop / AutoVerification 各自的调用点散落复制相同的 6 行胶水代码。
 */
/**
 * 内部 reminder 触发器实际消费实现。trigger 与 reminders/producers.ts 中的 RuntimeReminderTrigger 对齐。
 */
async function pickLoopReminder(
  toolContext: AutoVerificationToolContext,
  trigger: 'finishing' | 'post-tool'
): Promise<Nullable<string>> {
  const capabilityToolNames = buildCapabilityResolver(toolContext)
  const input = buildAutoVerificationReminderInput(toolContext, capabilityToolNames)
  if (shouldSuppressRuntimeReminder(input)) return null

  const sched = toolContext.codingSession.getReminderScheduler()
  const out = sched.consume(trigger, input)
  toolContext.codingSession.finalizeReminderConsumeResult(out)
  if (!out) return null

  return augmentReminderWithDevEnvironment(out.text, toolContext)
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
type LoopReminderMode = 'solo' | 'sub-agent'
type LoopReminderPhase = 'after-tool' | 'finishing'

interface TickLoopRemindersArgs {
  mode: LoopReminderMode
  phase: LoopReminderPhase
  toolContext: AutoVerificationToolContext
}

async function tickLoopReminders(args: TickLoopRemindersArgs): Promise<string[]> {
  if (args.phase === 'finishing') {
    const finishing = await pickLoopReminder(args.toolContext, 'finishing')
    return finishing ? [finishing] : []
  }

  // after-tool：solo 走 auto-verification gate，不在这里注入；
  // sub-agent 没有 gate，所以单独检查紧急（验证失败）提醒。
  if (args.mode === 'sub-agent') {
    const urgent = await pickLoopReminder(args.toolContext, 'post-tool')
    return urgent ? [urgent] : []
  }

  return []
}

export { pickLoopReminder, tickLoopReminders }
export type { LoopReminderMode, LoopReminderPhase, TickLoopRemindersArgs }

// augmentReminderWithDevEnvironment 已禁用自动追加。
// 环境摘要改为按需拉取：模型主动调用 summarize_current_dev_environment 获取。
// reminder 只包含直接相关的操作提示，不再附加环境状态块。
function augmentReminderWithDevEnvironment(
  baseMessage: string,
  _toolContext: AutoVerificationToolContext
): Promise<string> {
  return Promise.resolve(baseMessage)
}

export type {
  AutoVerificationCodingSession,
  AutoVerificationEvents,
  AutoVerificationToolContext,
}
