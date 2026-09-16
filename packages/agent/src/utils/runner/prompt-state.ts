// 运行态提示词快照的纯函数零件：读消息正文、摘要工具分类、格式化计划预览。
// 这些逻辑只吃入参、不碰任何实例状态，因此从 `PromptStateBuilder` 搬到这里；类里只留需要注入依赖的那部分。
import type { ModelMessage } from 'ai'

import { isArray, isEmpty, isObject, isString, truncate } from '@velaros-ai/core'

import type { ChatPromptFeatureId, ExecutionTaskPlanStep, ExecutionTaskPlanStepStatus, RunProfileId, RunProfileSelectionId, ToolCategoryOverview, ToolDescriptor } from '../../types/agent.js'
import type { RuntimePromptToolCategorySummary } from '../../types/guidance.js'
import type { PromptStatePreparedToolCategories, PromptStateToolContext } from '../../types/runner.js'
import { CompactionSummaryMarker } from '../history/context-os-message'
import { isInternalFollowUpMessage } from '../history/internal-messages'
import { isRunProfileId } from '../wire/typed-field-asserts'

/** 取一条模型消息的纯文本：字符串正文直接返回，多段正文只拼接 `text` 段（工具调用、图片等非文本段一律跳过），没有文本时返回空串。 */
export function readPromptMessageText(message: ModelMessage): string {
  if (isString(message.content)) return message.content
  if (!isArray(message.content)) return ''
  return message.content
    .map((part) => {
      if (isString(part)) return part
      if (!isObject(part)) return ''
      // @arch-guard:suspend code-style/prefer-is-plain-object-over-guarded-record-cast 理由：part 是 ai-SDK 的判别联合，isPlainObject 会把它收窄到不含 text 的成员，`type === 'text'` 直接被判成无重叠；断言是这条守卫唯一能读到字段的写法。
      const record = part as Record<string, unknown>
      return record.type === 'text' && isString(record.text) ? record.text : ''
    })
    .filter(Boolean)
    .join('\n')
}

/** 从历史里倒着找最近一条**真人**发的消息正文：系统补发的内部续跑消息不算，正文空白视同没有，返回 null。 */
export function readLatestUserTurnText(messages: ModelMessage[]): Nullable<string> {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user' || isInternalFollowUpMessage(message)) continue
    const text = readPromptMessageText(message).trim()
    return text || null
  }
  return null
}

/** 历史里是否已经发生过压缩：按压缩摘要的固定前缀判定。提示词据此告诉模型「前面的细节已被摘要，别当作完整原文」。 */
export function hasCompactedContextInHistory(messages: ModelMessage[]): boolean {
  return messages.some((message) =>
    readPromptMessageText(message).startsWith(CompactionSummaryMarker)
  )
}

/**
 * 从最近的历史里挑出最多 4 条工具失败，按**从新到旧**排列，用于提醒模型别重复踩同一个坑。
 *
 * 判定口径有意宽松：`error-text` 输出、以 `Error:` 开头、或正文里出现 `command not found` / `"success": false`
 * 都算失败——工具各自的失败表达不统一，这里宁可多报一条，也不要让真失败静默。每条正文压成单行并截断，避免撑爆提示词。
 */
export function collectRecentToolFailures(messages: ModelMessage[]): string[] {
  const failures: string[] = []
  for (const message of messages.slice(-24).reverse()) {
    if (message.role !== 'tool' || !isArray(message.content)) continue
    for (const part of [...message.content].reverse()) {
      if (part.type !== 'tool-result') continue
      const output = isObject(part.output)
        ? (part.output as { type?: unknown; value?: unknown })
        : null
      const value = String(output?.value ?? '')
      if (
        output?.type === 'error-text' ||
        /^Error:/i.test(value) ||
        /command not found|"success"\s*:\s*false/i.test(value)
      ) {
        failures.push(`${part.toolName}: ${truncate(value.replace(/\s+/g, ' ').trim(), 140)}`)
        if (failures.length >= 4) return failures
      }
    }
  }
  return failures
}

/** 把会话上的运行档位收敛成快照能用的取值：`auto` 之类的选择态或未知值一律落到 `balanced`。 */
export function resolveSnapshotRunProfile(selection: LooseOptional<RunProfileSelectionId>): RunProfileId {
  return isRunProfileId(selection) ? selection : 'balanced'
}

/** 取本轮的工具分类总览：调用方已经算好就直接用（同一轮内避免重复枚举），否则现向工具上下文要一次 enabled 与 all 两份。 */
export function resolveToolCategoryOverviews(
  toolContext: PromptStateToolContext,
  prepared?: PromptStatePreparedToolCategories
): PromptStatePreparedToolCategories {
  return (
    prepared ?? {
      enabled: toolContext.listToolCategories('enabled'),
      all: toolContext.listToolCategories('all'),
    }
  )
}

/** 把启用分类摊成提示词里的能力清单：工具说明压成单行，`hiddenToolCount` 恒为 0（这批工具模型本来就都看得到）。 */
export function summarizeToolCategories(
  categories: ToolCategoryOverview[]
): RuntimePromptToolCategorySummary[] {
  return categories.map((entry) => ({
    id: entry.category.id,
    label: entry.category.label,
    description: entry.category.description,
    enabled: entry.enabled,
    toolOsDefaultState: entry.category.toolOs.defaultState,
    tools: entry.tools.map((tool) => ({
      name: tool.name,
      description: tool.description.replace(/\s+/g, ' ').trim(),
    })),
    hiddenToolCount: 0,
  }))
}

/**
 * 摊出「可申请换入」的分类：常驻分类不算（它们本来就在），只留还有工具没换入的那些，
 * 且只报数量不报工具名——让模型知道「这里还有 n 个能力可以申请」，而不是把整份工具目录塞进提示词。
 */
export function summarizeRequestableToolCategories(
  categories: ToolCategoryOverview[],
  enabledToolNames: ReadonlySet<string>
): RuntimePromptToolCategorySummary[] {
  return categories
    .filter((entry) => entry.category.toolOs.defaultState !== 'resident')
    .map((entry) => ({
      id: entry.category.id,
      label: entry.category.label,
      description: entry.category.description,
      enabled: entry.enabled,
      toolOsDefaultState: entry.category.toolOs.defaultState,
      tools: [],
      hiddenToolCount: entry.tools.filter((tool) => !enabledToolNames.has(tool.name)).length,
    }))
    .filter((entry) => entry.hiddenToolCount > 0)
}

/** 用角色允许的工具名过一遍分类总览：每个分类只留允许的工具，滤空之后整个分类也丢掉，保证提示词里不出现模型根本调不到的能力。 */
export function filterToolCategoryOverviewsByAllowedTools(
  categories: ToolCategoryOverview[],
  allowedToolNames: ReadonlySet<string>
): ToolCategoryOverview[] {
  return categories
    .map((entry) => ({
      ...entry,
      tools: entry.tools.filter((tool) => allowedToolNames.has(tool.name)),
    }))
    .filter((entry) => !isEmpty(entry.tools))
}

/** 把一批分类里的工具名摊平成一个集合，供「某个工具是否已换入」这类判定用。 */
export function collectToolNames(categories: ToolCategoryOverview[]): Set<string> {
  return new Set(categories.flatMap((entry) => entry.tools.map((tool: ToolDescriptor) => tool.name)))
}

/** 计划步骤状态的中文显示名；提示词里的计划预览用它，改这里等于改模型看到的措辞。 */
function formatExecutionPlanStatus(status: ExecutionTaskPlanStepStatus): string {
  const labels: Record<ExecutionTaskPlanStepStatus, string> = {
    pending: '待处理',
    delegated: '已委派',
    running: '进行中',
    completed: '完成',
    failed: '失败',
    skipped: '跳过',
  }
  return labels[status]
}

/** 把当前计划压成一行预览（最多 6 步，余下的只报还剩几步）；没有计划时返回 null，对应的提示词段整段不出。 */
export function formatExecutionPlanPreview(plan: ExecutionTaskPlanStep[]): Nullable<string> {
  if (isEmpty(plan)) return null
  const preview = plan.slice(0, 6).map(
    (step, index) => `${index + 1}. ${step.title}(${formatExecutionPlanStatus(step.status)})`
  )
  if (plan.length > preview.length) preview.push(`还有 ${plan.length - preview.length} 步`)
  return preview.join(' | ')
}

/** 本轮请求的提示词特性去重后原样返回：同一个 feature 被宿主与会话粘性各带一次时，展示与映射都只算一次。缺省（没传）得到空数组。 */
export function dedupeRuntimePromptFeatures(
  promptFeatures?: readonly ChatPromptFeatureId[]
): ChatPromptFeatureId[] {
  return [...new Set(promptFeatures ?? [])]
}
