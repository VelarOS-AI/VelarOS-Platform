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

import { isEmpty, optionalWhen, toNullable } from '@velaros-ai/core'

import type { ToolCategoryDomainId, ToolCategoryId, ToolOsState } from '../../types/agent.js'
import type { ToolCategoryFilterResolution, ToolDiscoveryCard, ToolMapCategoryKind, ToolSearchResultEntry } from '../../types/builtin.js'
import type { KernelToolContext as ToolContext } from '../../types/tool-context.js'
import { compareStableStrings } from '../residency/determinism'
import { ToolDiscoveryAvailabilityValues } from '../tools/discovery-availability'
import { PluginBackedToolCategoryIds } from '../tools/tool-space-resolver'

import { splitSearchTerms } from './tool-search-terms'
import { activationCapabilityIdForCategory, buildToolActivationRef, buildToolDiscoveryCards, summarizeReasonRef } from './tool-space-activation'
import {
  ToolDiscoveryKindValues,
  type toolSpaceFindSchema,
  type toolSpaceMapSchema,
  type toolSpacePageSchema,
  ToolSpaceQueryPageLimitMax,
} from './tool-space-schemas'
import { buildMatchSignals, buildToolSearchScoreContext, scoreCard, ToolFindLowConfidenceScoreRatio } from './tool-space-search'

const ToolMapTargetToolRows = 32

const ToolOsStateValues = [
  'resident',
  'loadable',
  'needs_setup',
  'unavailable',
] as const satisfies readonly ToolOsState[]

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

/**
 * 把「分类 → 域 id」做成 Map 便于按分类查。同一分类重复出现时后者覆盖前者（注入侧保证不重）。
 * map 结果里每个分类头的 `toolOs.domain` 就从这儿取。
 */
function categoryDomainById(ctx: ToolContext): Map<ToolCategoryId, ToolCategoryDomainId> {
  return new Map(categoryDomainEntries(ctx))
}

/**
 * 摘出一张页的访问判定：`finalState`、`toolOsState`、`nextAction` 与逐道 `gates`。
 * 这是「为什么这张页现在是这个状态」的可对账明细，只在 page op 里带（find 与 map 都嫌它太重）。
 */
function summarizeToolAccessRef(card: ToolDiscoveryCard) {
  return {
    finalState: card.access.finalState,
    toolOsState: card.access.toolOsState,
    nextAction: card.access.nextAction,
    gates: card.access.gates,
  }
}

/**
 * 三个只读 op 的返回条目都由它产出——**模型看到的页形状就是这里定的**：身份、summary、
 * `usageSkillId`（没声明 companion skill 的页恒为 null；透出来是免得模型换入工具、读完描述才发现
 * 深度用法在别处）、五个状态字段、nextAction、resident，加上瘦身后的 reasons 与 activation ref。
 * `access` 明细默认带、`includeAccess: false` 时整个字段不出现（map 用它省预算）。
 */
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

/**
 * 统计一批页的状态分布：总数（`total` 与 `totalPages` 同值，两个名字都对外保留）、
 * 按 kind（tool / capability / plugin）、按 availability、按 toolOsState 各自计数。
 * 三张分布表都**按枚举全量出键**，没有的状态记 0 而不是缺席，模型读的时候不必判 undefined。
 */
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

/**
 * `op:"find"` 的编排：查询词扩展 → 按 kind / toolOsState / 分类过滤 → 逐页打分 → 排序分页 → 出模型面条目。
 * 只保留得分 > 0 的页，同分时按工具名稳定排序（同一查询两次结果一致）。
 * **低置信截断**：以最高分的 30%（`ToolFindLowConfidenceScoreRatio`，向上取整）为门槛丢掉长尾，
 * 丢了多少条与门槛值都回报给模型（`lowConfidenceDiscarded` / `confidenceCutoffScore`）——
 * 不截断时长尾噪音会把「看起来相关」的页塞满上下文；最高分为 0（一条都没匹配上）时不截断。
 * 分页用纯偏移量游标，`hasMore` 为假时 `nextCursor` 为 null。
 * 统计给两份：过滤后整个搜索域的 `statusSummary`，以及命中集的 `matchedStatusSummary`。
 */
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

/**
 * 把游标串解析成偏移量：缺席、非数字、负数、超出安全整数一律**回落到 0**（从头开始）而不是报错——
 * 游标拼错的代价是重看第一页，比让模型卡在一个参数错误上便宜。
 * 游标就是纯偏移量：页集合在同一会话内由同一份注入描述符生成，偏移量足够稳定，
 * 换成不透明游标只会多一层无人能读的编码。
 */
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

/**
 * `op:"page"` 的编排：按 kind / toolOsState / 分类过滤后**平铺**（不打分、不分组），
 * 按 kind → categoryId → name 稳定排序，再按偏移量游标切一页。
 * 返回条目带完整 `access` 明细——page 是「细看某一批页」的 op，预算花在这里划算。
 * `statusSummary` 统计的是过滤后的**全集**而非当前页。
 */
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

/**
 * map 专用的页摘要：就是 `summarizeToolSpacePageRef` 去掉 `access` 明细。
 * map 一次会展开几十张页，每张都带逐道 gates 会把预算吃光；要看明细走 page op。
 */
function summarizeToolSpaceMapPage(card: ToolDiscoveryCard) {
  return summarizeToolSpacePageRef(card, { includeAccess: false })
}

/**
 * 按行预算压低 map 每个分类实际展开的工具数：把 `ToolMapTargetToolRows`（32 行）平摊到本页返回的
 * 分类数上（至少 1），再与模型请求的 `maxToolsPerCategory` 取小。
 * 所以分类越多每类展开越少，整页总行数大致恒定。本页一个分类都没有时原样返回请求值。
 * 压低的事实必须由 `toolMapParameterAdjustments` 回报，不能静默生效。
 */
function effectiveToolMapToolsPerCategory(
  input: z.output<typeof toolSpaceMapSchema>,
  returnedCategoryCount: number
): number {
  if (returnedCategoryCount === 0) return input.maxToolsPerCategory
  const categoryCount = Math.max(1, returnedCategoryCount)
  const rowBudgetForCategory = Math.max(1, Math.floor(ToolMapTargetToolRows / categoryCount))
  return Math.min(input.maxToolsPerCategory, rowBudgetForCategory)
}

/**
 * 生成「系统压低了哪个参数」的回显条目：实际值与请求值一致时返回空数组，被行预算压低了才产出一条
 * `{parameter, requested, effective, reason:'category_row_budget', message}`，
 * message 里直接给出路（用 categoryIds 收窄，或改走 `tooling:map(op:"page")` 看完整分类）。
 * 静默压低会让模型以为自己看到了该分类的全部工具（不变量②）。
 */
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
        'maxToolsPerCategory 被工具图的行预算压低了，本次每个分类只列出了一部分工具；要看某个分类的全部工具，请用 categoryIds 收窄范围，或改用 tooling:map(op:"page")。',
    },
  ]
}

/**
 * 拼 map 结果里那份**读图说明**：`fixedToolSpace.kernelTools` 列出本轮真实可见的工具名
 * （与宿主的 `getCurrentVisibleToolNames` 对齐，取不到时按空处理）；
 * `stateLegend` 给四种 toolOsState 各自的含义与下一步；
 * `dependencyRules` 给两条通用前置规则——隐藏工具要先开能力页，插件类工具要先备好用户动作入口，
 * 后者的 `status` / `pageId` / `availability` / `pageIn` 会按动作卡工具当前的真实状态填。
 * 说明本身不含任何具体能力知识，只有形状与状态映射。
 */
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

/**
 * `op:"map"` 的编排：把页按分类分组展开成系统工具地图，分类按 id 稳定排序后用游标分页
 * （游标走的是**分类**偏移，不是工具偏移）。
 * 三处刻意不跟随 kind / toolOsStates 过滤：① 每个分类的 `toolNames` 完整索引取自**全集**——
 * 模型常用 resident 过滤快速看常驻面，索引若跟着变空它会误判该分类没有 loadable 工具；
 * ② 分类头的 capability 页也从全集取，它是这一类的身份与激活路径，不该被状态过滤裁掉；
 * ③ 统计与 guide 各有各的取数范围。
 * 每类实际展开的状态页数受行预算压低，压低情况写进 `filters.parameterAdjustments`；
 * 被截断的分类会给一个 `toolPage`——可直接执行的 `{tool, input}` 续页调用，模型不必自己拼参数。
 * `categoryKind` / `parentCategoryId` / `subCategoryIds` / `childStatusSummary` / `childToolCount`
 * 恒为叶子常量：分类树属于注入侧描述符的表达力，保留字段是模型面形状契约，不是没写完的洞。
 */
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
