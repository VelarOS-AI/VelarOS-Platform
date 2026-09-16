
import type { ReminderCapabilityResolver } from '../../contract/requires.js'
import type {ToolCategoryId } from '../../types/agent.js'
import type { AutoVerificationGateResult, AutoVerificationToolContext, CodingSessionSnapshot, RuntimeReminderInput, TickLoopRemindersArgs } from '../../types/session.js'

import { hasVerificationRelevantModifiedPaths } from './paths'

/** 是否整体压掉本轮运行期提醒：只在 fast 思考档为真——快档求的就是少注入、别打断。 */
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


/**
 * 拼出 reminder scheduler 要的一次性输入：编码会话当场给的状态快照，
 * 再挂上「能力分类 → 当前可见工具名」解析器，让提醒文案只提到这一轮真实暴露的工具。
 */
function buildAutoVerificationReminderInput(
  toolContext: AutoVerificationToolContext,
  capabilityToolNames: ReminderCapabilityResolver
): RuntimeReminderInput {
  const input = toolContext.codingSession.buildReminderInput()
  return { ...input, capabilityToolNames }
}

/**
 * 是否处于「有验证失败待处理」的状态：要同时有未消解的 activeVerificationFailure，
 * 且当前改动路径里确实还有跟验证相关的文件——失败之后只改了图片/文档的话不再拦。
 */
export function shouldBlockOnVerificationState(snapshot: CodingSessionSnapshot): boolean {
  return (
    !!snapshot.activeVerificationFailure &&
    hasVerificationRelevantModifiedPaths(snapshot.modifiedPaths)
  )
}

/**
 * 是否该发一条「去验证」提醒：四条同时成立才为真——本会话动过能力（改了东西）、
 * 还欠一条验证命令、改动路径里有值得验证的文件、且这批改动还没发过提醒（发过就不再刷屏）。
 */
export function shouldRequestVerificationReminder(snapshot: CodingSessionSnapshot): boolean {
  return (
    snapshot.hasCapabilityMutations &&
    snapshot.needsVerificationCommand &&
    hasVerificationRelevantModifiedPaths(snapshot.modifiedPaths) &&
    !snapshot.verificationReminderIssuedForCurrentEdits
  )
}

/**
 * 收尾自动验证门：只在「验证失败尚未消解」时向 scheduler 要一条 finishing 提醒当 followupMessage。
 *
 * `result` 恒为 null——这道门从不替模型接管或改写本轮结果，最多追加一句提醒；fast 档连提醒也不发。
 * 「你还没验证，去验证一下」那类催促已按用户决策移除，只保留验证**失败**的告警。
 */
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
 * Loop 各阶段的提醒出口，最多返回一条（没有则空数组）。
 *
 * `finishing` 阶段取一条收尾提醒；工具执行后的阶段里，solo 模式返回空——那一段由
 * runAutomaticVerification 这道门负责，两边都发会重复；sub-agent 没有那道门，所以单独取
 * post-tool 通道的紧急（验证失败）提醒。
 */
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
/**
 * 提醒文案的环境增强位，现已停用：原样返回 baseMessage，不追加任何环境摘要。
 * 保留这一层是为了留住调用点（上面的 `//` 注释说明了停用理由与替代路径）。
 */
function augmentReminderWithDevEnvironment(
  baseMessage: string,
  _toolContext: AutoVerificationToolContext
): Promise<string> {
  return Promise.resolve(baseMessage)
}

