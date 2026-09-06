// 域：工具空间的**三个只读 op**——find（按意图检索）/ page（平铺分页）/ map（按分类展开）。
// 三者共享同一条流水线：取页（ToolSpaceActivation）→ 过滤（分类/域/kind/运行态）→ 排序分页 →
// 翻译成模型面 ref。差别只在中间那一段：find 交给 ToolSpaceSearch 打分，page 直排，map 分组。
//
// ## 从哪读起
// 先看 `summarizeToolSpacePageRef`——三个 op 的返回条目都由它产出，它决定了模型看到的页形状。
// 然后按 op 各读一个入口函数：`searchToolDiscoveryCards` / `pageToolDiscoveryCards` /
// `mapToolDiscoveryCards`。`resolveToolCategoryFilterInput` 与 `filterToolSpaceCards` 是三者共用的
// 过滤前置，`buildToolSpaceStatusSummary` 是三者共用的统计尾巴。
//
// ## 关键不变量
//  1. **回带的过滤器必须与实际过滤同源**。`expandedCategoryIds` 先算一次再分别传给过滤和返回值，
//     不许两处各算一遍——模型靠这个字段判断自己的域名有没有拼错。
//  2. **压低参数必须明说**。map 的 `maxToolsPerCategory` 会被行预算（`ToolMapTargetToolRows`）主动
//     压低，并在 `filters.parameterAdjustments` 里说明压了什么；静默压低会让模型以为看到了全部。
//  3. **模型面输出形状是契约**。`categoryKind` / `parentCategoryId` / `subCategoryIds` 在本层恒为
//     叶子常量——分类树属于注入侧描述符的表达力。保留字段是为了让消费方免于分支；现场都标了
//     恒常的理由，别当成"没写完的洞"补一张本地表。
//  4. 本文件不认识任何具体能力，只有形状与流程。语义中立门（`check:agent-arch` 防线⑤）连注释一起扫。
//
// ## 非显然的妥协
//  - find 结果按最高分的 30%（`ToolFindLowConfidenceScoreRatio`）做低置信截断，并把丢弃条数
//    回报给模型——不截断时长尾噪音会把"看起来相关"的页塞满上下文。
//  - 游标是纯偏移量字符串：页集合在同一会话内由同一份注入描述符生成，偏移量足够稳定，
//    换成不透明游标只会多一层无人能读的编码。

import { type z } from 'zod'

import type { ToolCategoryDomainId, ToolCategoryId, ToolOsState } from '@velaros-ai/agent/protocol'
import { isEmpty, optionalWhen, toNullable } from '@velaros-ai/core'

import { compareStableStrings } from '../../agent/context/residency/determinism'
import {
  PluginBackedToolCategoryIds,
  ToolDiscoveryAvailabilityValues,
} from '../../tools'
import type { KernelToolContext as ToolContext } from '../KernelToolContext'

import { splitSearchTerms } from './ToolSearchTerms'
import {
  activationCapabilityIdForCategory,
  buildToolActivationRef,
  buildToolDiscoveryCards,
  summarizeReasonRef,
  type ToolDiscoveryCard,
} from './ToolSpaceActivation'
import {
  ToolDiscoveryKindValues,
  type toolSpaceFindSchema,
  type toolSpaceMapSchema,
  type toolSpacePageSchema,
  ToolSpaceQueryPageLimitMax,
} from './ToolSpaceSchemas'
import {
  buildMatchSignals,
  buildToolSearchScoreContext,
  scoreCard,
  ToolFindLowConfidenceScoreRatio,
  type ToolSearchResultEntry,
} from './ToolSpaceSearch'

const ToolMapTargetToolRows = 32

const ToolOsStateValues = [
  'resident',
  'loadable',
  'needs_setup',
  'unavailable',
] as const satisfies readonly ToolOsState[]

type ToolMapCategoryKind = 'bundle' | 'leaf'

interface ToolCategoryFilterResolution {
  expandedCategoryIds: ToolCategoryId[]
  validDomainIds: ToolCategoryDomainId[]
  unknownDomainIds: ToolCategoryDomainId[]
  categoryFilter: Nullable<Set<ToolCategoryId>>
}

/**
 * 分类过滤输入 → 实际分类集 + 可对账的域校验结果。
 * 显式传了域即表示确实要过滤；即使所有域都拼错，也会得到空集而不是静默扩大为全量。
 * validDomainIds / unknownDomainIds 与展开共用同一份宿主注入描述符，模型不用猜它的拼写错在哪。
 */
function resolveToolCategoryFilterInput(
  ctx: ToolContext,
  input: {
    categoryIds: readonly ToolCategoryId[]
    domainIds?: readonly ToolCategoryDomainId[]
  }
): ToolCategoryFilterResolution {
  const domainEntries = categoryDomainEntries(ctx)
  const validDomainIds = [...new Set(domainEntries.map(([, domainId]) => domainId))]
    .sort(compareStableStrings)
  const validDomainIdSet = new Set(validDomainIds)
  const requestedDomainIds = [...new Set(input.domainIds ?? [])]
  const unknownDomainIds = requestedDomainIds.filter((domainId) => !validDomainIdSet.has(domainId))
  const result: ToolCategoryId[] = []
  const seen = new Set<ToolCategoryId>()
  const append = (categoryId: ToolCategoryId): void => {
    if (seen.has(categoryId)) return
    seen.add(categoryId)
    result.push(categoryId)
  }

  for (const categoryId of input.categoryIds) append(categoryId)
  const requestedDomains = new Set<ToolCategoryDomainId>(requestedDomainIds)
  for (const [categoryId, domainId] of domainEntries) {
    if (requestedDomains.has(domainId)) append(categoryId)
  }

  const hasExplicitFilter = !isEmpty(input.categoryIds) || !isEmpty(requestedDomainIds)
  return {
    expandedCategoryIds: result,
    validDomainIds,
    unknownDomainIds,
    categoryFilter: hasExplicitFilter ? new Set(result) : null,
  }
}

/** 分类 → 注入描述符声明的域 id（与工具页构建同一 scope，保证展开结果都能对应上真实页）。 */
function categoryDomainEntries(ctx: ToolContext): Array<[ToolCategoryId, ToolCategoryDomainId]> {
  return ctx
    .listToolCategories('catalog')
    .map((overview): [ToolCategoryId, ToolCategoryDomainId] => [
      overview.category.id,
      overview.category.toolOs.domain,
    ])
}

function categoryDomainById(ctx: ToolContext): Map<ToolCategoryId, ToolCategoryDomainId> {
  return new Map(categoryDomainEntries(ctx))
}

function summarizeToolAccessRef(card: ToolDiscoveryCard) {
  return {
    finalState: card.access.finalState,
    toolOsState: card.access.toolOsState,
    nextAction: card.access.nextAction,
    gates: card.access.gates,
  }
}

function summarizeToolSpacePageRef(
  card: ToolDiscoveryCard,
  options: { includeAccess?: boolean } = {}
) {
  const includeAccess = options.includeAccess ?? true
  return {
    id: card.id,
    kind: card.kind,
    name: card.name,
    categoryId: card.categoryId,
    summary: card.summary,
    // 工具是调用面、技能是用法面：声明了 companion skill 的页在这里把 id 透出来，
    // 模型不必先换入工具、读完描述才发现「深度用法在别处」。没声明的页恒为 null。
    usageSkillId: toNullable(card.usageSkillId),
    availability: card.availability,
    toolOsState: card.toolOsState,
    risk: card.risk,
    schemaState: card.schemaState,
    schemaPolicy: card.schemaPolicy,
    nextAction: card.nextAction,
    resident: card.resident,
    access: optionalWhen(includeAccess, summarizeToolAccessRef(card)),
    reasons: card.reasons.map(summarizeReasonRef),
    activation: buildToolActivationRef(card),
  }
}

/**
 * find 是高频路由结果，只返回“选哪张页、下一步怎么做”所需字段。
 * 完整 access gates / reasons / dependency graph 留在 page/map 结果，避免一次意图检索把同一依赖
 * 以多种展开形状重复塞进后续每轮历史。
 */
function summarizeToolSpaceFindRef(
  card: ToolDiscoveryCard,
  score: number,
  matchedFields: ToolSearchResultEntry['matchedFields']
): ToolSearchResultEntry {
  const activation = buildToolActivationRef(card)
  return {
    id: card.id,
    kind: card.kind,
    name: card.name,
    categoryId: card.categoryId,
    summary: card.summary,
    usageSkillId: toNullable(card.usageSkillId),
    score,
    availability: card.availability,
    toolOsState: card.toolOsState,
    risk: card.risk,
    schemaState: card.schemaState,
    schemaPolicy: card.schemaPolicy,
    nextAction: card.nextAction,
    resident: card.resident,
    activation: {
      method: activation.method,
      pageIn: activation.pageIn,
      capabilityId: activation.capabilityId,
      nextTool: activation.nextTool,
    },
    matchedFields,
  }
}

function buildToolSpaceStatusSummary(cards: readonly ToolDiscoveryCard[]) {
  const byKind = Object.fromEntries(
    ToolDiscoveryKindValues.map((kind) => [kind, cards.filter((card) => card.kind === kind).length])
  )
  return {
    total: cards.length,
    totalPages: cards.length,
    totalTools: byKind.tool,
    totalCapabilities: byKind.capability,
    totalPlugins: byKind.plugin,
    byKind,
    byAvailability: Object.fromEntries(
      ToolDiscoveryAvailabilityValues.map((availability) => [
        availability,
        cards.filter((card) => card.availability === availability).length,
      ])
    ),
    byToolOsState: Object.fromEntries(
      ToolOsStateValues.map((state) => [
        state,
        cards.filter((card) => card.toolOsState === state).length,
      ])
    ),
  }
}

export function searchToolDiscoveryCards(
  ctx: ToolContext,
  input: z.output<typeof toolSpaceFindSchema>
) {
  const terms = splitSearchTerms(input.query)
  const categoryResolution = resolveToolCategoryFilterInput(ctx, input)
  const { categoryFilter, expandedCategoryIds } = categoryResolution
  const kindFilter = input.kind === 'all' ? null : input.kind
  const toolOsStateFilter = isEmpty(input.toolOsStates) ? null : new Set(input.toolOsStates)
  const cards = buildToolDiscoveryCards(ctx)
  const scoreContext = buildToolSearchScoreContext(ctx, cards)
  const domainCards = cards
    .filter((card) => !kindFilter || card.kind === kindFilter)
    .filter((card) => !toolOsStateFilter || toolOsStateFilter.has(card.toolOsState))
    .filter((card) => !categoryFilter || categoryFilter.has(card.categoryId))
  const scored = domainCards
    .map((card) => ({ card, score: scoreCard(card, terms, scoreContext) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      return compareStableStrings(left.card.name, right.card.name)
    })
  const topScore = scored[0]?.score ?? 0
  const confidenceCutoffScore = Math.ceil(topScore * ToolFindLowConfidenceScoreRatio)
  const relevantScored = confidenceCutoffScore > 0
    ? scored.filter((entry) => entry.score >= confidenceCutoffScore)
    : scored
  const lowConfidenceDiscarded = scored.length - relevantScored.length

  const offset = parseToolSpaceCursor(input.cursor)
  const page = relevantScored.slice(offset, offset + input.limit)
  const nextOffset = offset + page.length
  const hasMore = nextOffset < relevantScored.length
  const nextCursor = hasMore ? String(nextOffset) : null
  const statusSummary = {
    ...buildToolSpaceStatusSummary(domainCards),
    scope: 'search_domain' as const,
    matchedTotal: relevantScored.length,
    lowConfidenceDiscarded,
    confidenceCutoffScore,
    matchedStatusSummary: buildToolSpaceStatusSummary(relevantScored.map((entry) => entry.card)),
  }
  return {
    op: 'find' as const,
    query: input.query,
    filters: {
      kind: input.kind,
      categoryIds: input.categoryIds,
      domainIds: input.domainIds,
      validDomainIds: categoryResolution.validDomainIds,
      unknownDomainIds: categoryResolution.unknownDomainIds,
      toolOsStates: input.toolOsStates,
      expandedCategoryIds,
      limit: input.limit,
      cursor: toNullable(input.cursor),
    },
    page: {
      returnedPageCount: page.length,
      matchedTotal: relevantScored.length,
      lowConfidenceDiscarded,
      confidenceCutoffScore,
      hasMore,
      nextCursor,
    },
    pages: page.map(({ card, score }) =>
      summarizeToolSpaceFindRef(
        card,
        score,
        [...new Set(buildMatchSignals(card, terms, scoreContext).map((signal) => signal.field))]
      )
    ),
    statusSummary,
    hasMore,
    nextCursor,
    message: '这是工具页索引；需要执行 loadable 工具时用 tooling:replace 换入，下一轮通过真实 schema 调用。',
  }
}

function parseToolSpaceCursor(cursor: LooseOptional<string>): number {
  if (!cursor) return 0

  const value = Number(cursor)
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/** 调用方传入同一次解析出的分类集合，保证实际过滤与回带的过滤器同源。 */
function filterToolSpaceCards(
  cards: ToolDiscoveryCard[],
  categoryFilter: Nullable<ReadonlySet<ToolCategoryId>>,
  input: {
    kind: 'tool' | 'capability' | 'plugin' | 'all'
    toolOsStates?: ToolOsState[]
  }
): ToolDiscoveryCard[] {
  const kindFilter = input.kind === 'all' ? null : input.kind
  const toolOsStateFilter =
    !input.toolOsStates || isEmpty(input.toolOsStates)
      ? null
      : new Set<ToolOsState>(input.toolOsStates)

  return cards
    .filter((card) => !kindFilter || card.kind === kindFilter)
    .filter((card) => !toolOsStateFilter || toolOsStateFilter.has(card.toolOsState))
    .filter((card) => !categoryFilter || categoryFilter.has(card.categoryId))
    .sort((left, right) => {
      if (left.kind !== right.kind) return compareStableStrings(left.kind, right.kind)
      if (left.categoryId !== right.categoryId) return compareStableStrings(left.categoryId, right.categoryId)
      return compareStableStrings(left.name, right.name)
    })
}

export function pageToolDiscoveryCards(
  ctx: ToolContext,
  input: z.output<typeof toolSpacePageSchema>
) {
  const categoryResolution = resolveToolCategoryFilterInput(ctx, input)
  const { categoryFilter, expandedCategoryIds } = categoryResolution
  const cards = filterToolSpaceCards(buildToolDiscoveryCards(ctx), categoryFilter, input)
  const offset = parseToolSpaceCursor(input.cursor)
  const page = cards.slice(offset, offset + input.limit)
  const nextOffset = offset + page.length

  return {
    op: 'page' as const,
    filters: {
      kind: input.kind,
      categoryIds: input.categoryIds,
      domainIds: input.domainIds,
      validDomainIds: categoryResolution.validDomainIds,
      unknownDomainIds: categoryResolution.unknownDomainIds,
      toolOsStates: input.toolOsStates,
      expandedCategoryIds,
      limit: input.limit,
      cursor: toNullable(input.cursor),
    },
    page: {
      returnedPageCount: page.length,
      totalPageCount: cards.length,
      hasMore: nextOffset < cards.length,
      nextCursor: nextOffset < cards.length ? String(nextOffset) : null,
    },
    pages: page.map((card) => summarizeToolSpacePageRef(card)),
    statusSummary: buildToolSpaceStatusSummary(cards),
    message: '这是工具页索引；需要执行 loadable 工具时用 tooling:replace 换入，下一轮通过真实 schema 调用。',
  }
}

function summarizeToolSpaceMapPage(card: ToolDiscoveryCard) {
  return summarizeToolSpacePageRef(card, { includeAccess: false })
}

function effectiveToolMapToolsPerCategory(
  input: z.output<typeof toolSpaceMapSchema>,
  returnedCategoryCount: number
): number {
  if (returnedCategoryCount === 0) return input.maxToolsPerCategory
  const categoryCount = Math.max(1, returnedCategoryCount)
  const rowBudgetForCategory = Math.max(1, Math.floor(ToolMapTargetToolRows / categoryCount))
  return Math.min(input.maxToolsPerCategory, rowBudgetForCategory)
}

function toolMapParameterAdjustments(
  input: z.output<typeof toolSpaceMapSchema>,
  effectiveMaxToolsPerCategory: number
) {
  if (effectiveMaxToolsPerCategory === input.maxToolsPerCategory) return []

  return [
    {
      parameter: 'maxToolsPerCategory',
      requested: input.maxToolsPerCategory,
      effective: effectiveMaxToolsPerCategory,
      reason: 'category_row_budget',
      message:
        'maxToolsPerCategory was capped by the map row budget; use categoryIds or tooling:map(op:"page") to inspect a category in full.',
    },
  ]
}

function buildToolSpaceMapGuide(ctx: ToolContext, cards: readonly ToolDiscoveryCard[]) {
  const visibleToolNames = new Set(ctx.getCurrentVisibleToolNames?.() ?? [])
  const showUserActionTool = cards.find((card) => card.id === 'tool:interaction:show_action_cards')
  const kernelTools = cards
    .filter((card) => card.kind === 'tool' && visibleToolNames.has(card.name))
    .map((card) => ({ name: card.name, visible: true }))

  return {
    fixedToolSpace: { kernelTools },
    stateLegend: [
      {
        toolOsState: 'resident',
        availability: 'visible',
        meaning: '工具已驻留在本轮 AI SDK tools 中。',
        nextStep: 'call_tool',
      },
      {
        toolOsState: 'loadable',
        availability: 'loadable',
        meaning: '已授权或可通过 tooling:replace 申请/换入；不需要把它当作权限分类。',
        nextStep: 'follow page.activation.method',
      },
      {
        toolOsState: 'needs_setup',
        availability: 'requires_user_action',
        meaning: '存在能力提供方声明的前置 setup 或用户动作。',
        nextStep: 'follow page.activation.dependencies',
      },
      {
        toolOsState: 'unavailable',
        availability: 'unavailable',
        meaning: '当前运行态不可用或被策略阻止，通常需要替代方案。',
        nextStep: '查看 reasons，改用替代工具',
      },
    ],
    dependencyRules: [
      {
        id: 'capability-before-hidden-tools',
        appliesToAvailability: ['requires_approval'],
        requiredBefore: ['tool_call', 'page_in_tool'],
        status: 'per_page',
        prerequisite: {
          id: 'capability:*',
          kind: 'capability',
          pageId: 'capability:<category>',
          availability: 'requires_approval',
          pageIn: ['capability:<category>'],
          nextTool: 'tooling:replace',
        },
      },
      {
        id: 'plugin-before-plugin-tools',
        appliesToCategoryIds: [...PluginBackedToolCategoryIds],
        requiredBefore: ['capability_activation', 'tool_call'],
        status: showUserActionTool?.availability === 'visible' ? 'ready' : 'load_tool_entry',
        prerequisite: {
          id: 'plugin_user_action',
          kind: 'plugin',
          pageId: showUserActionTool?.id ?? 'tool:interaction:show_action_cards',
          availability: showUserActionTool?.availability ?? 'unavailable',
          pageIn:
            showUserActionTool && showUserActionTool.availability !== 'visible'
              ? ['tool:interaction:show_action_cards']
              : [],
          nextTool: 'interaction:show_action_cards',
        },
      },
    ],
  }
}

export function mapToolDiscoveryCards(
  ctx: ToolContext,
  input: z.output<typeof toolSpaceMapSchema>
) {
  const allCards = buildToolDiscoveryCards(ctx)
  // toolOsState/kind 是“本次展开哪些状态页”的过滤器，不得把分类的完整工具名索引一起裁掉。
  // 模型常用 resident 过滤快速看常驻面；若 toolNames 也跟着变空，它会误判该能力没有 loadable 工具。
  const allToolNamesByCategoryId = new Map<ToolCategoryId, string[]>()
  for (const card of allCards) {
    if (card.kind !== 'tool') continue
    const names = allToolNamesByCategoryId.get(card.categoryId) ?? []
    names.push(card.name)
    allToolNamesByCategoryId.set(card.categoryId, names)
  }
  const categoryResolution = resolveToolCategoryFilterInput(ctx, input)
  const { categoryFilter, expandedCategoryIds } = categoryResolution
  const filteredCards = filterToolSpaceCards(allCards, categoryFilter, input)
  // kind/toolOsStates 只决定分类下展开的状态页；分类头的 capability
  // 是该类的身份与激活路径，从未按 kind 裁掉的同源卡片单独取。
  const capabilityByCategoryId = new Map<ToolCategoryId, ToolDiscoveryCard>()
  for (const card of allCards) {
    if (card.kind !== 'capability') continue
    if (categoryFilter && !categoryFilter.has(card.categoryId)) continue
    capabilityByCategoryId.set(card.categoryId, card)
  }
  const grouped = new Map<ToolCategoryId, ToolDiscoveryCard[]>()

  for (const card of filteredCards) {
    const list = grouped.get(card.categoryId) ?? []
    list.push(card)
    grouped.set(card.categoryId, list)
  }

  const orderedCategoryEntries = [...grouped.entries()].sort(
    ([left], [right]) => compareStableStrings(left, right)
  )

  const categoryOffset = parseToolSpaceCursor(input.cursor)
  const pagedCategoryEntries = orderedCategoryEntries.slice(
    categoryOffset,
    categoryOffset + input.categoryLimit
  )
  const nextCategoryOffset = categoryOffset + pagedCategoryEntries.length
  const effectiveMaxToolsPerCategory = effectiveToolMapToolsPerCategory(
    input,
    pagedCategoryEntries.length
  )
  const parameterAdjustments = toolMapParameterAdjustments(input, effectiveMaxToolsPerCategory)
  // 域 id 是 domainIds 过滤的取值集合，必须从这里可见——否则模型只能猜域名，猜错就静默拿到全量。
  const domainByCategoryId = categoryDomainById(ctx)

  const categories = pagedCategoryEntries.map(([categoryId, cards]) => {
    const capability = capabilityByCategoryId.get(categoryId)
    const tools = cards.filter((card) => card.kind === 'tool')
    const plugins = cards.filter((card) => card.kind === 'plugin')
    const visibleTools = tools.slice(0, effectiveMaxToolsPerCategory)
    const toolNames = [...(allToolNamesByCategoryId.get(categoryId) ?? [])]
      .sort(compareStableStrings)
    const definition = capability
      ? {
          label: capability.name,
          description: capability.description,
          toolOs: {
            domain: domainByCategoryId.get(categoryId) ?? 'injected',
            defaultState: capability.toolOsState,
          },
        }
      : undefined

    return {
      categoryId,
      // 本层的分类表是**平的**：父子关系属于能力描述符的表达力，中立执行主链不持有分类树，
      // 因此这四个字段恒为叶子常量。字段保留是模型面形状契约（消费方按固定形状读），不是待填的洞；
      // 真要支持分类树，改法是让注入侧的描述符带上父子指针，不是在这里加一张本地表。
      categoryKind: 'leaf' as ToolMapCategoryKind,
      parentCategoryId: null,
      subCategoryIds: [] as ToolCategoryId[],
      label: definition?.label ?? categoryId,
      summary: toNullable(definition?.description),
      toolOs: toNullable(definition?.toolOs),
      statusSummary: buildToolSpaceStatusSummary(cards),
      childStatusSummary: null,
      capability: capability ? summarizeToolSpaceMapPage(capability) : null,
      activation: capability
        ? buildToolActivationRef(capability)
        : {
            method: 'inspect_reasons' as const,
            pageIn: [],
            capabilityId: activationCapabilityIdForCategory(categoryId),
            nextTool: 'tooling:map',
            dependencies: [],
          },
      toolNames,
      tools: visibleTools.map(summarizeToolSpaceMapPage),
      plugins: plugins.map(summarizeToolSpaceMapPage),
      totalToolCount: tools.length,
      totalToolNameCount: toolNames.length,
      childToolCount: 0,
      toolsReturnedCount: visibleTools.length,
      hasMoreTools: visibleTools.length < tools.length,
      hiddenToolCount: Math.max(0, tools.length - visibleTools.length),
      toolPage:
        visibleTools.length < tools.length
          ? {
              tool: 'tooling:map' as const,
              input: {
                op: 'page' as const,
                kind: 'tool' as const,
                categoryIds: [categoryId],
                domainIds: [] as ToolCategoryDomainId[],
                toolOsStates: [...input.toolOsStates],
                limit: ToolSpaceQueryPageLimitMax,
                cursor: String(visibleTools.length),
              },
            }
          : null,
    }
  })
  const truncatedInCategories = categories
    .filter((category) => category.hasMoreTools)
    .map((category) => category.categoryId)

  return {
    op: 'map' as const,
    filters: {
      kind: input.kind,
      categoryIds: input.categoryIds,
      domainIds: input.domainIds,
      validDomainIds: categoryResolution.validDomainIds,
      unknownDomainIds: categoryResolution.unknownDomainIds,
      toolOsStates: input.toolOsStates,
      expandedCategoryIds,
      categoryLimit: input.categoryLimit,
      cursor: toNullable(input.cursor),
      maxToolsPerCategory: input.maxToolsPerCategory,
      effectiveMaxToolsPerCategory,
      parameterAdjusted: !isEmpty(parameterAdjustments),
      parameterAdjustments,
    },
    page: {
      returnedCategoryCount: categories.length,
      totalCategoryCount: orderedCategoryEntries.length,
      hasMore: nextCategoryOffset < orderedCategoryEntries.length,
      nextCursor:
        nextCategoryOffset < orderedCategoryEntries.length ? String(nextCategoryOffset) : null,
      returnedCategoryIds: categories.map((category) => category.categoryId),
      remainingCategoryIds: orderedCategoryEntries
        .slice(nextCategoryOffset)
        .map(([categoryId]) => categoryId),
      truncatedInCategories,
    },
    statusSummary: buildToolSpaceStatusSummary(filteredCards),
    guide: buildToolSpaceMapGuide(ctx, allCards),
    categories,
    message:
      '这是分页工具页索引；每个分类附带完整 toolNames，详细状态页仍按 maxToolsPerCategory 展开，toolPage 是可直接执行的 {tool,input} 续页调用；需要执行 loadable 工具时用 tooling:replace 换入，下一轮通过真实 schema 调用；需要更多分类时用 page.nextCursor 继续。',
  }
}
