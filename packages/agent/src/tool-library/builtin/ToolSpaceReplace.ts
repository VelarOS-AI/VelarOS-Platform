// 域：`op:"replace"` —— 工具页的**换入换出规划与落地**。工具空间五个 op 里唯一会改会话状态的
// 一个：其余四个只读，这个会调 `codingSession` 的启停接口和注入侧的授权入口。
//
// ## 从哪读起
// 只有一个入口 `replaceToolSpacePages`，函数体按顺序分四段：
//  1. **pageIn 分拣** —— 逐页按 `kind` × `availability` 判成 prepared / 待授权 / 待用户动作 /
//     跳过；需要先开能力的工具先记进 `pendingToolsAfterCapability` 等第 2 段结果。
//  2. **能力授权** —— 有注入的授权入口就走它（可能被用户拒），否则直接开；随后按实际开成的
//     能力回填第 1 段挂起的工具。
//  3. **pageOut** —— 对称的关停。
//  4. **结果组装** —— `summarizeReplacePages` 出模型面详情，`buildReplaceNextTurnHint` 出下一步。
//
// ## 关键不变量
//  1. **换入是下一轮生效**（`effectiveTurn:'next'`）。replace 只改会话的工具驻留/能力状态，真实
//     schema 要等下一轮 AI SDK tools 重建才暴露——除非目标本轮已驻留，那条快路径由
//     `alreadyResidentTools` 明说（不说的代价实测是模型连续四轮重复换入同一个已可用的工具）。
//  2. **`availability === 'visible'` 必须最先判**。已启用的插件 availability 同样是 visible，
//     排在 plugin 分支后面会把「已开启的插件」错报成 requiresUserAction。
//  3. **`nextTurnHint` 一条都不许落空**，理由同 activation flow：空提示会退化成重复 page-in。
//  4. **模型面输出形状是契约**。`recommendedPageIn` / `recommendedTools` / `userActionHint` 在本层
//     恒为空——「推荐替代页」属于能力描述符的表达力；字段保留让消费方免于分支。
//  5. 本文件不认识任何具体能力，只有形状与流程。语义中立门（`check:agent-arch` 防线⑤）连注释一起扫。
//
// ## 非显然的妥协
//  - `preparedToolExamples` 从工具描述里抠「示例：」整段回给模型：首调凭摘要猜参数被 schema 打回
//    是实测最贵的一类空转，把正确形状直接摆上比让它猜错再重试省一整轮。
//  - 「不可关停的分类」没有本地保护名单：那是具体产品策略，由注入侧在授权入口/描述符层表达。

import { type z } from 'zod'

import { isEmpty, isPresent } from '@velaros-ai/core'
import type { ChatPromptFeatureId, ToolCategoryId } from '@velaros-ai/core/types'

import { expandCapabilityCategoryIds } from '../../capabilities'
import type { KernelToolContext as ToolContext } from '../KernelToolContext'

import {
  buildToolActivationRef,
  buildToolDiscoveryCards,
  summarizeReasonRef,
  type ToolActivationRef,
  type ToolDiscoveryCard,
  type ToolReasonRef,
} from './ToolSpaceActivation'
import { type toolSpaceReplaceSchema } from './ToolSpaceSchemas'

type ToolSpaceReplacePageDetail = Pick<
  ToolDiscoveryCard,
  | 'id'
  | 'kind'
  | 'name'
  | 'categoryId'
  | 'summary'
  | 'availability'
  | 'toolOsState'
  | 'schemaState'
  | 'schemaPolicy'
  | 'nextAction'
  | 'resident'
> & {
  reasons: ToolReasonRef[]
  activation: ToolActivationRef
}

function findPluginEntryTool(
  card: ToolDiscoveryCard,
  cardsById: ReadonlyMap<string, ToolDiscoveryCard>
): Nullable<ToolDiscoveryCard> {
  for (const candidate of cardsById.values()) {
    if (candidate.kind === 'tool' && candidate.categoryId === card.categoryId) return candidate
  }

  return null
}

function summarizeReplacePage(card: ToolDiscoveryCard): ToolSpaceReplacePageDetail {
  return {
    id: card.id,
    kind: card.kind,
    name: card.name,
    categoryId: card.categoryId,
    summary: card.summary,
    availability: card.availability,
    toolOsState: card.toolOsState,
    schemaState: card.schemaState,
    schemaPolicy: card.schemaPolicy,
    nextAction: card.nextAction,
    resident: card.resident,
    reasons: card.reasons.map(summarizeReasonRef),
    activation: buildToolActivationRef(card),
  }
}

function summarizeReplacePages(
  ids: readonly string[],
  cardsById: ReadonlyMap<string, ToolDiscoveryCard>
): ToolSpaceReplacePageDetail[] {
  return [...new Set(ids)]
    .map((id) => cardsById.get(id))
    .filter(isPresent)
    .map(summarizeReplacePage)
}

/** 从结构化工具描述里抽出「示例：」整段，作为换入后首调的正确形状参考。 */
function extractToolExampleSection(description: string | null | undefined): Nullable<string> {
  if (!description) return null
  const block = description
    .split(/\n{2,}/)
    .find((section) => section.trimStart().startsWith('示例：'))
  return block ? block.trim() : null
}

/**
 * 为本轮换入的工具各取一条正确调用示例。
 *
 * 解决「agent 首次调用某工具时凭摘要猜参数、被 schema 打回、白费一轮」的门槛：换入即把每个
 * 工具的示例（含确切字段名/必填项/结构形态）回给模型，照抄即可，无需先猜错再重试。
 */
function buildPreparedToolExamples(
  toolNames: readonly string[],
  cardsById: Map<string, { name: string; description?: string }>
): Array<{ tool: string; example: string }> {
  const examples: Array<{ tool: string; example: string }> = []
  for (const name of toolNames) {
    const example = extractToolExampleSection(cardsById.get(`tool:${name}`)?.description)
    if (example) examples.push({ tool: name, example })
  }
  return examples
}

/**
 * 换入结果 → 给模型的下一步提示。分支序即优先级：**有进展先说进展**，没进展时按"能自己解开的
 * 阻塞"（授权/用户动作）优先于"只能换个思路"（reasons/重新查页）。
 * 一条都不落空是硬要求——返回空串等于让模型自己猜下一步，实测会退化成重复 page-in 同一张不可用页。
 */
function buildReplaceNextTurnHint(input: {
  preparedTools: readonly string[]
  enabledCapabilities: readonly ToolCategoryId[]
  requiresApprovalDetails: readonly ToolSpaceReplacePageDetail[]
  requiresUserActionDetails: readonly ToolSpaceReplacePageDetail[]
  skippedPageDetails: readonly ToolSpaceReplacePageDetail[]
}): string {
  if (!isEmpty(input.preparedTools) || !isEmpty(input.enabledCapabilities)) return '工具页替换已记录；下一轮 AI SDK tools 会按动态工具空间预算暴露实际可调用工具 schema。preparedToolExamples 给出了每个换入工具的正确调用示例，请照其字段名与结构调用，不要凭摘要猜参数。'

  if (!isEmpty(input.requiresApprovalDetails) || !isEmpty(input.requiresUserActionDetails)) return '没有新的工具页被换入；请根据 requiresApprovalDetails / requiresUserActionDetails 的 reasons 处理授权、插件或用户动作。'

  if (!isEmpty(input.skippedPageDetails)) return '没有新的工具页被换入；请查看 skippedPageDetails 的 reasons，并改用可见工具、换入推荐页或重新查询工具页。'

  return '没有新的工具页被换入；请回到 tooling:map(op:"find") 或 tooling:map(op:"page") 重新确认目标页，再用 tooling:replace 换入。'
}

export async function replaceToolSpacePages(
  ctx: ToolContext,
  input: z.output<typeof toolSpaceReplaceSchema>
) {
  ctx.abortSignal.throwIfAborted()

  const cards = buildToolDiscoveryCards(ctx)
  const cardsById = new Map(cards.map((card) => [card.id, card]))
  const pageIn = [...new Set(input.pageIn)]
  const pageOut = [...new Set(input.pageOut)]
  const missingPages = [...pageIn, ...pageOut].filter((id) => !cardsById.has(id))
  const preparedTools: string[] = []
  const pageOutTools: string[] = []
  const enabledCapabilities: ToolCategoryId[] = []
  const disabledCapabilities: ToolCategoryId[] = []
  const requiresApproval: string[] = []
  const requiresUserAction: string[] = []
  const promptFeaturesToEnable: ChatPromptFeatureId[] = []
  const skippedPages = [...missingPages]
  const pendingToolsAfterCapability: Array<{
    id: string
    name: string
    categoryId: ToolCategoryId
  }> = []

  for (const id of pageIn) {
    const card = cardsById.get(id)
    if (!card) {
      continue
    }
    // 已驻留/已启用的页 page-in 是 no-op：工具已可见、能力已启用，或插件已开启。
    // 注意：插件已启用时其 availability 也是 'visible'，必须先于下面的 plugin 分支判断，
    // 否则会把“已开启的插件”错误回报成 requiresUserAction。
    if (card.availability === 'visible') {
      continue
    }
    if (card.kind === 'plugin') {
      if (card.availability !== 'loadable') {
        requiresUserAction.push(id)
        continue
      }
      enabledCapabilities.push(
        ...expandCapabilityCategoryIds(ctx.capabilityPorts, [card.categoryId])
      )
      promptFeaturesToEnable.push(card.name as ChatPromptFeatureId)
      const entryTool = findPluginEntryTool(card, cardsById)
      if (entryTool) {
        pendingToolsAfterCapability.push({
          id: entryTool.id,
          name: entryTool.name,
          categoryId: entryTool.categoryId,
        })
      }
      continue
    }
    if (card.availability === 'requires_user_action') {
      requiresUserAction.push(id)
      continue
    }
    if (card.kind === 'capability') {
      if (card.availability !== 'requires_approval' && card.availability !== 'loadable') {
        skippedPages.push(id)
        continue
      }
      enabledCapabilities.push(
        ...expandCapabilityCategoryIds(ctx.capabilityPorts, [card.categoryId])
      )
      continue
    }
    if (card.kind === 'tool') {
      if (card.availability === 'loadable') {
        if (!ctx.codingSession.hasToolCategoryAccess(card.categoryId)) {
          pendingToolsAfterCapability.push({
            id,
            name: card.name,
            categoryId: card.categoryId,
          })
          enabledCapabilities.push(
            ...expandCapabilityCategoryIds(ctx.capabilityPorts, [card.categoryId])
          )
        } else {
          preparedTools.push(card.name)
        }
        continue
      }
      if (card.availability === 'requires_approval') {
        pendingToolsAfterCapability.push({
          id,
          name: card.name,
          categoryId: card.categoryId,
        })
        enabledCapabilities.push(
          ...expandCapabilityCategoryIds(ctx.capabilityPorts, [card.categoryId])
        )
        continue
      }
      skippedPages.push(id)
    }
  }

  const categoriesToEnable = [
    ...new Set(enabledCapabilities),
  ]
  enabledCapabilities.length = 0
  if (!isEmpty(categoriesToEnable)) {
    if (ctx.requestToolCategoryAccess) {
      const result = await ctx.requestToolCategoryAccess(categoriesToEnable, input.reason)
      enabledCapabilities.push(...result.enabledCategories)
      if (!result.approved) {
        requiresApproval.push(...pageIn.filter((id) => id.startsWith('capability:')))
      }
    } else {
      ctx.codingSession.enableToolCategories(categoriesToEnable, input.reason)
      enabledCapabilities.push(...categoriesToEnable)
    }
  }
  const finalPromptFeaturesToEnable = [...new Set(promptFeaturesToEnable)]
  if (!isEmpty(finalPromptFeaturesToEnable)) {
    ctx.codingSession.enablePromptFeatures?.(finalPromptFeaturesToEnable, input.reason)
  }

  const enabledCapabilitySet = new Set(enabledCapabilities)
  for (const pending of pendingToolsAfterCapability) {
    if (enabledCapabilitySet.has(pending.categoryId)) {
      preparedTools.push(pending.name)
      continue
    }
    requiresApproval.push(pending.id)
  }

  // 反馈闭环:换入目标本轮已经可见(跨 run 驻留恢复/本就常驻)时,明确告诉模型
  // "已驻留,直接调用"——否则模型每条消息都习惯性 map+replace 一轮纯仪式
  // (真机:跨 run 恢复生效后模型仍连续 4 轮重复换入同一工具,因为结果从不说已可用)。
  const visibleNow = new Set(ctx.getCurrentVisibleToolNames?.() ?? [])
  const alreadyResidentTools = preparedTools.filter((name) => visibleNow.has(name))
  if (!isEmpty(preparedTools)) {
    ctx.codingSession.enableToolNames(preparedTools, input.reason)
  }

  for (const id of pageOut) {
    const card = cardsById.get(id)
    if (!card) {
      continue
    }
    if (card.kind === 'tool') {
      pageOutTools.push(card.name)
      continue
    }
    if (card.kind === 'capability') {
      // 「不可关停的分类」是具体产品策略，由注入侧在 requestToolCategoryAccess / 描述符层表达；
      // 本层无保护名单，展开出的分类一律可关。
      disabledCapabilities.push(...expandCapabilityCategoryIds(ctx.capabilityPorts, [card.categoryId]))
      continue
    }
    requiresUserAction.push(id)
  }

  if (!isEmpty(disabledCapabilities)) {
    ctx.codingSession.disableToolCategories([...new Set(disabledCapabilities)], input.reason)
  }
  if (!isEmpty(pageOutTools)) {
    ctx.codingSession.disableToolNames?.([...new Set(pageOutTools)], input.reason)
  }

  const requiresApprovalDetails = summarizeReplacePages(requiresApproval, cardsById)
  const requiresUserActionDetails = summarizeReplacePages(requiresUserAction, cardsById)
  const skippedPageDetails = summarizeReplacePages(skippedPages, cardsById)
  const preparedToolSet = new Set(preparedTools)

  return {
    op: 'replace' as const,
    pageIn,
    pageOut,
    preparedTools: [...new Set(preparedTools)],
    // 换入即给正确示例：照其字段名与结构调用，避免首调凭摘要猜参数被 schema 打回。
    preparedToolExamples: buildPreparedToolExamples([...preparedToolSet], cardsById),
    pageOutTools: [...new Set(pageOutTools)],
    enabledCapabilities: [...new Set(enabledCapabilities)],
    disabledCapabilities: [...new Set(disabledCapabilities)],
    enabledPromptFeatures: finalPromptFeaturesToEnable,
    requiresApproval: [...new Set(requiresApproval)],
    requiresUserAction: [...new Set(requiresUserAction)],
    requiresApprovalDetails,
    requiresUserActionDetails,
    skippedPages: [...new Set(skippedPages)],
    skippedPageDetails,
    // unavailableTargets / recommendedPageIn / recommendedTools / userActionHint 是模型面形状契约的
    // 一部分：本层没有"推荐替代页"的知识（那是能力描述符的表达力），故恒为空；字段保留让消费方
    // 无需分支。skipped 与 unavailable 在本层是同一件事，两个名字都对外保留。
    unavailableTargets: [...new Set(skippedPages)],
    unavailableTargetDetails: skippedPageDetails,
    recommendedPageIn: [] as string[],
    recommendedTools: [] as string[],
    userActionHint: null,
    blockedBy: [
      ...new Set(
        [...requiresApprovalDetails, ...requiresUserActionDetails, ...skippedPageDetails].flatMap(
          (detail) => detail.reasons.map((reason) => `${reason.layer}.${reason.code}`)
        )
      ),
    ],
    // 已可见的换入目标本轮即可直接调用,不必等下一轮。
    alreadyResidentTools,
    effectiveTurn: 'next' as const,
    activeThisTurn: false,
    nextTurnHint: buildReplaceNextTurnHint({
      preparedTools: [...preparedToolSet],
      enabledCapabilities: [...new Set(enabledCapabilities)],
      requiresApprovalDetails,
      requiresUserActionDetails,
      skippedPageDetails,
    }),
    message:
      alreadyResidentTools.length === preparedTools.length && !isEmpty(alreadyResidentTools)
        ? `换入目标已全部驻留(${alreadyResidentTools.join('、')}),本轮即可直接调用,无需再 tooling:replace。`
        : 'ContextOS 工具页替换已处理。',
  }
}
