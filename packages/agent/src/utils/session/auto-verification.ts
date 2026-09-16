
import type { ReminderCapabilityResolver } from '../../contract/requires.js'
import type {ToolCategoryId } from '../../types/agent.js'
import type { AutoVerificationGateResult, AutoVerificationToolContext, CodingSessionSnapshot, RuntimeReminderInput, TickLoopRemindersArgs } from '../../types/session.js'

import { hasVerificationRelevantModifiedPaths } from './paths'

function shouldSuppressRuntimeReminder(input: RuntimeReminderInput): boolean {
  return input.thinkingDepth === 'fast'
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

// augmentReminderWithDevEnvironment 已禁用自动追加。
// 环境摘要改为按需拉取：模型主动调用 summarize_current_dev_environment 获取。
// reminder 只包含直接相关的操作提示，不再附加环境状态块。
function augmentReminderWithDevEnvironment(
  baseMessage: string,
  _toolContext: AutoVerificationToolContext
): Promise<string> {
  return Promise.resolve(baseMessage)
}

