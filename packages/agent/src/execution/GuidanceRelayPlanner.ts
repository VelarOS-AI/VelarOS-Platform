import type { ModelMessage } from 'ai'
import { z } from 'zod'

import { isArray, isBlank, isEmpty, isObject, isString, optionalWhenLazy, truncate } from '@velaros-ai/core'

import type { SubAgentGuidanceRelayWorkerSnapshot } from './SubAgentGuidanceRelayRegistry'

const GuidanceRelayTargetSchema = z.object({
  threadId: z.string().min(1),
  message: z.string().min(1),
})

const GuidanceRelayMainAgentSchema = z
  .object({
    mode: z.enum(['none', 'immediate', 'deferred']).default('immediate'),
    message: z.string().optional(),
    dependsOnThreadIds: z.array(z.string().min(1)).default([]),
    reason: z.string().optional(),
  })
  .passthrough()

/**
 * `notifyMainAgent`（遗留布尔，2026-08-06 删）曾与 `mainAgent.mode` 三态并存：提示词只教后者，
 * 模型永远不会填前者，于是「有 relay 且没填遗留布尔」这条最常见路径恒判「主控不用知道」。
 * 现在只有 `mainAgent.mode` 一格，而且它只决定**主控收到的是改写还是原文**，不再决定收不收得到
 * （投递保证在 `ExecutionService.provideGuidanceForSourceSession`）。
 */
const GuidanceRelayPlanSchema = z
  .object({
    understanding: z.string().min(1),
    relays: z.array(GuidanceRelayTargetSchema).default([]),
    mainAgent: GuidanceRelayMainAgentSchema.optional(),
  })
  .passthrough()

type GuidanceRelayPlan = z.infer<typeof GuidanceRelayPlanSchema>

interface BuildGuidanceRelayPromptInput {
  userGuidance: string
  workers: readonly SubAgentGuidanceRelayWorkerSnapshot[]
}

function extractGuidanceUserText(message: ModelMessage): Nullable<string> {
  if (message.role !== 'user') return null

  if (isString(message.content)) {
    const normalized = message.content.trim()
    return isBlank(normalized) ? null : normalized
  }

  if (!isArray(message.content) || isEmpty(message.content)) return null

  const parts = message.content
    .map((part) => {
      if (!part || !isObject(part)) return ''
      const record = part as { type?: unknown; text?: unknown }
      return record.type === 'text' && isString(record.text) ? record.text.trim() : ''
    })
    .filter(Boolean)

  if (isEmpty(parts)) return null
  return parts.join('\n')
}

function buildGuidanceRelayPrompt(input: BuildGuidanceRelayPromptInput): string {
  const workerLines = input.workers.map((worker, index) => {
    const description = worker.description?.trim()
    return [
      `${index + 1}. threadId=${worker.threadId}`,
      `   agent=${worker.agentName}`,
      `   type=${worker.subagentType}`,
      `   title=${worker.title}`,
      optionalWhenLazy(description, () => `   description=${description}`),
      `   task=${truncate(worker.prompt.trim(), 600)}`,
    ]
      .filter(Boolean)
      .join('\n')
  })

  return [
    'The user appended follow-up guidance while parallel sub-agents are still running.',
    'Act as the coordinating main agent: interpret the intent first, then decide which sub-agents (if any) should receive relayed guidance.',
    'Rules:',
    '- Do NOT copy the user text verbatim into relay messages.',
    '- Rewrite each relay in your own words so the target sub-agent can act immediately.',
    '- Only target sub-agents whose current task is clearly related to the guidance.',
    '- Relay-only guidance is internal: do not create a main-agent follow-up just to expose or acknowledge that rewrite.',
    '- If the guidance is only for the main agent, return an empty relays array.',
    '- The main agent always receives the user message; mainAgent only decides whether it arrives as your rewrite or verbatim. You can never hide it.',
    '- Set mainAgent.mode to "none" when no parent/main-agent action is needed; the raw user text is still delivered to the main agent.',
    '- Set mainAgent.mode to "immediate" when the main agent should consider the guidance on its next turn without waiting for sub-agent results.',
    '- Set mainAgent.mode to "deferred" when the guidance is a later task, a follow-up, or requires one or more active sub-agents to finish first.',
    '- For deferred main-agent work, fill dependsOnThreadIds with only active threadId values whose results are needed. Leave it empty for general follow-up work after the current run settles.',
    '- A single user message can produce both relays and deferred mainAgent work.',
    '- Do not drop follow-up tasks: if no sub-agent should receive a relay, still set mainAgent.mode to immediate or deferred when the main agent must remember it.',
    '- understanding must summarize what the user wants in plain language.',
    '',
    'Active sub-agents:',
    workerLines.join('\n\n'),
    '',
    'User guidance:',
    input.userGuidance.trim(),
  ].join('\n')
}

function parseGuidanceRelayPlan(raw: unknown): GuidanceRelayPlan {
  return GuidanceRelayPlanSchema.parse(raw)
}

/**
 * 主控要收到的**改写**文本；`null` = 没有可用的改写，调用方投递用户原文。
 *
 * 注意语义：返回 `null` 不代表「主控不用知道」——投递是无条件的（见
 * `ExecutionService.provideGuidanceForSourceSession`），这里只回答「用改写还是用原文」。
 */
function resolveMainAgentGuidanceMessage(plan: GuidanceRelayPlan): Nullable<string> {
  const understanding = plan.understanding.trim()
  if (isBlank(understanding)) return null

  if (plan.mainAgent) return resolveExplicitMainAgentGuidanceMessage(plan, understanding)

  // 模型没填 mainAgent 这一格：按「主控也要知道」处理（fail-open）。
  if (isEmpty(plan.relays)) return `[主控补充] ${understanding}`

  return `[主控补充] ${understanding}\n\n（已向 ${plan.relays.length} 个子任务 relay 引导，子 Agent 会按主控理解继续执行。）`
}

/** 主控这一侧本次收到的是规划改写还是用户原文。 */
interface MainAgentGuidanceDelivery {
  message: ModelMessage
  kind: 'planned-rewrite' | 'verbatim'
}

/**
 * relay 纯增量的**投递判决**——这是一个无条件投递的函数，没有「不投递」这个返回值。
 *
 * 规划只回答「主控收到的是改写还是原文」，回答不了「主控要不要知道」：这句话是用户敲进输入框
 * 回车发出的，主控不知道它存在 = 用户输入丢失。规划由小辅助模型完成，判错的代价必须是多花一点
 * token（多一条原文入历史），不是丢消息。
 */
function resolveMainAgentGuidanceDelivery(input: {
  plannedMainAgentMessage: LooseOptional<string>
  originalMessage: ModelMessage
}): MainAgentGuidanceDelivery {
  const planned = input.plannedMainAgentMessage
  if (isString(planned) && !isBlank(planned))
    return { message: { role: 'user', content: planned }, kind: 'planned-rewrite' }

  return { message: input.originalMessage, kind: 'verbatim' }
}

function filterValidGuidanceRelays(
  plan: GuidanceRelayPlan,
  workers: readonly SubAgentGuidanceRelayWorkerSnapshot[]
): GuidanceRelayPlan['relays'] {
  const activeThreadIds = new Set(workers.map((worker) => worker.threadId))
  return plan.relays
    .map((relay) => ({
      threadId: relay.threadId.trim(),
      message: relay.message.trim(),
    }))
    .filter((relay) => activeThreadIds.has(relay.threadId) && !isBlank(relay.message))
}

function normalizeGuidanceRelayPlan(
  plan: GuidanceRelayPlan,
  workers: readonly SubAgentGuidanceRelayWorkerSnapshot[]
): GuidanceRelayPlan {
  return {
    ...plan,
    relays: filterValidGuidanceRelays(plan, workers),
    mainAgent: normalizeMainAgentGuidance(plan.mainAgent, workers),
  }
}

function normalizeMainAgentGuidance(
  mainAgent: GuidanceRelayPlan['mainAgent'],
  workers: readonly SubAgentGuidanceRelayWorkerSnapshot[]
): GuidanceRelayPlan['mainAgent'] {
  if (!mainAgent) return undefined

  const message = mainAgent.message?.trim()
  const reason = mainAgent.reason?.trim()
  const dependsOnThreadIds =
    mainAgent.mode === 'deferred'
      ? normalizeActiveThreadIds(mainAgent.dependsOnThreadIds, workers)
      : []

  return {
    mode: mainAgent.mode,
    dependsOnThreadIds,
    ...(message && !isBlank(message) ? { message } : {}),
    ...(reason && !isBlank(reason) ? { reason } : {}),
  }
}

function normalizeActiveThreadIds(
  threadIds: readonly string[],
  workers: readonly SubAgentGuidanceRelayWorkerSnapshot[]
): string[] {
  const activeThreadIds = new Set(workers.map((worker) => worker.threadId))
  return [
    ...new Set(
      threadIds
        .map((threadId) => threadId.trim())
        .filter((threadId) => !isBlank(threadId) && activeThreadIds.has(threadId))
    ),
  ]
}

function resolveExplicitMainAgentGuidanceMessage(
  plan: GuidanceRelayPlan,
  understanding: string
): Nullable<string> {
  const mainAgent = plan.mainAgent
  if (!mainAgent || mainAgent.mode === 'none') return null

  const message = mainAgent.message?.trim() || understanding
  if (isBlank(message)) return null

  if (mainAgent.mode === 'deferred') return buildDeferredMainAgentGuidanceMessage(
      plan,
      message,
      mainAgent.dependsOnThreadIds
    )

  return buildImmediateMainAgentGuidanceMessage(plan, message)
}

function buildImmediateMainAgentGuidanceMessage(
  plan: GuidanceRelayPlan,
  message: string
): string {
  if (isEmpty(plan.relays)) return `[主控补充] ${message}`

  return [
    `[主控补充] ${message}`,
    '',
    `（已向 ${plan.relays.length} 个子任务 relay 引导，主控也会在下一轮纳入这条补充。）`,
  ].join('\n')
}

function buildDeferredMainAgentGuidanceMessage(
  plan: GuidanceRelayPlan,
  message: string,
  dependsOnThreadIds: readonly string[]
): string {
  return [
    `[主控搁置补充] ${message}`,
    '',
    isEmpty(dependsOnThreadIds)
      ? '处理时机：当前运行中的子任务或主流程恢复后，由主控再判断是否作为后续任务执行。'
      : `依赖子任务：${dependsOnThreadIds.join(', ')}`,
    ...(!isEmpty(dependsOnThreadIds)
      ? ['处理时机：等待这些子任务完成并读取结果后，由主控再继续该后续事项。']
      : []),
    ...(!isEmpty(plan.relays)
      ? [
          `（已向 ${plan.relays.length} 个子任务 relay 当前可执行引导；本条作为后续事项搁置给主控。）`,
        ]
      : []),
  ]
    .filter(Boolean)
    .join('\n')
}

export {
  buildGuidanceRelayPrompt,
  extractGuidanceUserText,
  filterValidGuidanceRelays,
  GuidanceRelayPlanSchema,
  normalizeGuidanceRelayPlan,
  parseGuidanceRelayPlan,
  resolveMainAgentGuidanceDelivery,
  resolveMainAgentGuidanceMessage,
}
export type { GuidanceRelayPlan, MainAgentGuidanceDelivery }
