import type { ModelMessage } from 'ai'
import { z } from 'zod'

import { isArray, isBlank, isEmpty, isNonBlankString, isObject, isString, optionalWhen, optionalWhenLazy, truncate } from '@velaros-ai/core'

import type { BuildGuidanceRelayPromptInput, GuidanceRelayPlan, MainAgentGuidanceDelivery,SubAgentGuidanceRelayWorkerSnapshot } from '../../types/records.js'


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
  .passthrough() satisfies z.ZodType<GuidanceRelayPlan>

/**
 * 从一条 `ModelMessage` 里取出用户敲的那段引导文字：非 user 角色、内容为空白、或多段内容里一个 text 段都没有，
 * 一律返回 `null`；字符串内容去空白直接用，数组内容只收 `type === 'text'` 的段（图片、工具结果等一概略过），
 * 逐段去空白后用换行拼起来。
 * 返回 `null` 是 `provideGuidanceForSourceSession` 拒绝这次引导的判据——挡的是把一条空消息或助手消息
 * 当引导入队，占掉一次抢占主轮的机会却什么都没说。
 */
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

/**
 * 拼出交给小辅助模型的那条提示词：先把每个在跑的子 Agent 列成一段（threadId、agent、type、title、可选 description，
 * 以及截到 600 字符的 task——任务原文可以很长，不截会把提示词本身撑爆），再附上规则与用户原话。
 * 规则里最要紧的两条是「不得逐字照抄用户原文到 relay 里」和「主控必然收到这条消息，mainAgent 只决定收到的是改写还是原文」，
 * 后者对应下游 `resolveMainAgentGuidanceDelivery` 的无条件投递——提示词与实现必须同时说同一件事，
 * 否则模型会以为填 `mode: "none"` 就能把消息拦下来。
 */
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

/** 把辅助模型吐回来的原始结构按 `GuidanceRelayPlanSchema` 解析：`understanding` 必须非空，`relays` 与 `dependsOnThreadIds` 缺省补空数组，`mainAgent.mode` 缺省补 `immediate`；schema 走 passthrough，模型多写的字段原样留着。不合就抛，由调用方回落到「只投原文给主控」。 */
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

/**
 * 把规划里的 relay 逐条去空白后筛一遍，只留 `threadId` 确实还在跑、且 `message` 非空的那些。
 * 模型会编出已结束或根本不存在的 threadId；照单全收会投到一个没人接的线程上，引导就此静默消失——
 * 这里当场丢掉，主控那条投递不受影响（它是无条件的），所以用户的话不会因为筛掉 relay 而丢失。
 */
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

/** 规划的统一收敛入口：`relays` 过 `filterValidGuidanceRelays`、`mainAgent` 过 `normalizeMainAgentGuidance`，其余字段（含 passthrough 带进来的）原样保留。解析之后、使用之前必须过一次，下游就不用各自再去防模型编造的 threadId。 */
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

/**
 * 收敛规划里的 `mainAgent` 这一格：模型没填就保持缺席（缺席有自己的 fail-open 含义，见
 * `resolveMainAgentGuidanceMessage`，绝不能在这里补一个默认对象把它抹掉）；`message`/`reason` 去空白后
 * 只在非空时保留（空白值直接省略键，不写空串）；`dependsOnThreadIds` 只有 `mode === 'deferred'` 时才留，
 * 其余模式一律清空——非 deferred 的依赖没有任何人会去等，留着只会让主控读到一份假的等待清单。
 */
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
    message: optionalWhen(isNonBlankString, message),
    reason: optionalWhen(isNonBlankString, reason),
  }
}

/** 把模型填的依赖线程列表逐个去空白、丢掉空串、只留当前还在跑的 threadId，再按首次出现顺序去重。留下已结束或编造的 id，主控就会去等一个永不到来的结果而卡死。 */
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

/**
 * 模型**确实填了** `mainAgent` 时，算出主控该收到的改写文本；返回 `null` 表示「没有可用改写」，
 * 调用方改投用户原文（不是「不投」——投递本身是无条件的）。
 * `mode: 'none'` 直接给 `null`；`message` 空白就退回用 `understanding` 顶上；
 * 再按 `deferred` / `immediate` 分别交给两个 build 函数加上前缀与说明。
 */
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

/** 拼「主控下一轮就纳入」的那条补充文本：统一加 `[主控补充]` 前缀；有 relay 时再补一句说明已经 relay 给了几个子任务，好让主控知道同一条引导子 Agent 那边也收到了，不必再转发一遍。 */
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

/**
 * 拼「搁置给主控的后续事项」那条文本：加 `[主控搁置补充]` 前缀，并把处理时机写明白——
 * 有依赖线程就列出 threadId 并说清要等它们完成、读到结果后再继续；没有依赖就说成当前运行收敛后由主控自行判断。
 * 有 relay 时再补一句区分「已经 relay 出去的是当下可执行的部分，本条是留给主控的后续」。
 * 时机必须写进正文：这是一条塞进历史的普通用户消息，除了这几句话没有别的地方告诉主控它不该立刻动手。
 */
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
