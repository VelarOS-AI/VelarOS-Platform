import { type z } from 'zod'

import { isArray, isBoolean, isEmpty, isNumber, isPlainObject, isPresent, isString, optionalWhen, optionalWhenLazy,toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type {
  AgentSkillDescriptor,
  ChatPromptFeatureId,
  ToolCategoryDomainId,
  ToolCategoryId,
  ToolOsState,
} from '@velaros-ai/core/types'

import { compareStableStrings } from '../../agent/context/residency/determinism'
import { expandCapabilityCategoryIds } from '../../capabilities'
import {
  buildPluginEntries,
  buildToolSpaceCategoryFilter,
  buildToolSpacePages,
  isPluginBackedToolCategory,
  isPromptFeatureEffectivelyEnabled,
  PluginBackedToolCategoryIds,
  PluginFeatureDescriptions,
  type ToolDiscoveryAvailability,
  ToolDiscoveryAvailabilityValues,
  type ToolDiscoveryNextAction,
  type ToolDiscoverySchemaState,
  type ToolSpacePage,
  type ToolSpacePageKind,
  type ToolSpacePageRisk,
  type ToolSpaceReason,
  type ToolSpaceSchemaPolicy,
} from '../../tools'
import type { KernelToolContext as ToolContext } from '../KernelToolContext'

import {
  confirmAutoLoadedSkillPages,
  readSkillPageId,
  SkillPagePrefix,
} from './SkillLoadConfirmation'
import { readToolInputSchema } from './ToolReadDetails'
import {
  matchedTermsForField,
  splitIdentifierSearchTerm,
  splitSearchTerms,
} from './ToolSearchTerms'
import {
  type toolBatchMethodSchema,
  ToolDiscoveryKindValues,
  toolSpaceFindSchema,
  type toolSpaceMapSchema,
  type toolSpacePageSchema,
  type toolSpaceReadSchema,
  toolSpaceReplaceSchema,
  type toolSpaceSchema,
} from './ToolSpaceSchemas'

export type { ToolSpaceInput } from './ToolSpaceSchemas'
export {
  parseToolSpaceQueryMethodInput,
  toolAvailabilitySchema,
  toolBatchMethodSchema,
  toolDiscoveryKindSchema,
  toolSpaceFindMethodSchema,
  toolSpaceMapMethodSchema,
  toolSpacePageMethodSchema,
  toolSpaceQueryMethodSchema,
  toolSpaceReadMethodSchema,
  toolSpaceReplaceMethodSchema,
  toolSpaceSchema,
} from './ToolSpaceSchemas'

const ToolMapTargetToolRows = 32
const ToolFindLowConfidenceScoreRatio = 0.3

export type ToolAvailability = ToolDiscoveryAvailability
export type ToolDiscoveryKind = ToolSpacePageKind
export type ToolDiscoveryRisk = ToolSpacePageRisk
export type ToolSchemaState = ToolDiscoverySchemaState
export type ToolNextAction = ToolDiscoveryNextAction
export type ToolSchemaPolicy = ToolSpaceSchemaPolicy
export type ToolDiscoveryReason = ToolSpaceReason

export type ToolDiscoveryCard = ToolSpacePage

const ToolOsStateValues = [
  'resident',
  'loadable',
  'needs_setup',
  'unavailable',
] as const satisfies readonly ToolOsState[]

export interface ToolSearchResultEntry {
  id: string
  kind: ToolDiscoveryKind
  name: string
  categoryId: ToolCategoryId
  summary: string
  score: number
  availability: ToolAvailability
  toolOsState: ToolOsState
  risk: ToolDiscoveryRisk
  schemaState: ToolSchemaState
  schemaPolicy: ToolSchemaPolicy
  nextAction: ToolNextAction
  resident: boolean
  reasons: ToolReasonRef[]
  activation: ToolActivationRef
  matchSignals: ToolMatchSignal[]
}

interface ToolMatchSignal {
  field:
    | 'id'
    | 'name'
    | 'category'
    | 'aliases'
    | 'search_hints'
    | 'summary'
    | 'description'
    | 'suitable'
    | 'forbidden'
    | 'schema'
    | 'activation'
    | 'reverse_activation'
  terms: string[]
}

type ToolActivationMethod =
  | 'direct_call'
  | 'page_in_only'
  | 'request_approval'
  | 'request_user_action'
  | 'inspect_reasons'

type ToolDependencyKind =
  | 'capability'
  | 'plugin'
  | 'runtime'
  | 'residency'

type ToolDependencyState =
  | 'satisfied'
  | 'loadable'
  | 'requires_approval'
  | 'requires_user_action'
  | 'blocked'

type ToolMapCategoryKind = 'bundle' | 'leaf'

interface ToolDependencyGuide {
  id: string
  kind: ToolDependencyKind
  state: ToolDependencyState
  required: boolean
  summary: string
  pageId: Nullable<string>
  pageIn: string[]
  nextTool: Nullable<string>
  reasonKeys: string[]
  activationHint: string
}

interface ToolActivationGuide {
  method: ToolActivationMethod
  summary: string
  pageIn: string[]
  capabilityId: Nullable<string>
  nextTool: Nullable<string>
  notes: string[]
  dependencies: ToolDependencyGuide[]
  activationFlow: string[]
}

type ToolReasonRef = Pick<ToolDiscoveryReason, 'layer' | 'code' | 'message'>

type ToolDependencyRef = Pick<
  ToolDependencyGuide,
  'id' | 'kind' | 'state' | 'required' | 'pageId' | 'pageIn' | 'nextTool' | 'reasonKeys'
>

interface ToolActivationRef {
  method: ToolActivationMethod
  pageIn: string[]
  capabilityId: Nullable<string>
  nextTool: Nullable<string>
  dependencies: ToolDependencyRef[]
}

function expandToolCategoryFilterInput(input: {
  categoryIds: readonly ToolCategoryId[]
  domainIds?: readonly ToolCategoryDomainId[]
}): ToolCategoryId[] {
  const result: ToolCategoryId[] = []
  const seen = new Set<ToolCategoryId>()
  for (const categoryId of input.categoryIds) {
    if (!seen.has(categoryId)) {
      seen.add(categoryId)
      result.push(categoryId)
    }
  }

  return result
}

export {
  buildPluginEntries,
  isPluginBackedToolCategory,
  isPromptFeatureEffectivelyEnabled,
  PluginBackedToolCategoryIds,
  PluginFeatureDescriptions,
}

interface ToolSearchScoreContext {
  schemaTextById: ReadonlyMap<string, string>
  activationTextById: ReadonlyMap<string, string>
  reverseActivationTextByName: ReadonlyMap<string, string>
}

function scoreField(value: string, terms: readonly string[], weight: number): number {
  return matchedTermsForField(value, terms).length * weight
}

function scoreCard(
  card: ToolDiscoveryCard,
  terms: readonly string[],
  context: ToolSearchScoreContext
): number {
  if (isEmpty(terms)) return 0

  const aliasText = card.aliases.join(' ')
  const searchHintText = card.searchHints.join(' ')
  const suitableText = card.suitable.join(' ')
  const forbiddenText = card.forbidden.join(' ')
  return (
    scoreField(card.id, terms, 24) +
    scoreField(card.name, terms, 32) +
    scoreField(card.categoryId, terms, 16) +
    scoreField(aliasText, terms, 20) +
    scoreField(searchHintText, terms, 14) +
    scoreField(card.summary, terms, 10) +
    scoreField(card.description ?? '', terms, 8) +
    scoreField(suitableText, terms, 6) +
    scoreField(forbiddenText, terms, 2) +
    scoreField(context.schemaTextById.get(card.id) ?? '', terms, 18) +
    scoreField(context.activationTextById.get(card.id) ?? '', terms, 8) +
    scoreField(context.reverseActivationTextByName.get(card.name) ?? '', terms, 18)
  )
}

function buildMatchSignal(
  field: ToolMatchSignal['field'],
  value: string,
  terms: readonly string[]
): Nullable<ToolMatchSignal> {
  const matchedTerms = [...new Set(matchedTermsForField(value, terms))].slice(0, 8)
  if (isEmpty(matchedTerms)) return null
  return {
    field,
    terms: matchedTerms,
  }
}

function buildMatchSignals(
  card: ToolDiscoveryCard,
  terms: readonly string[],
  context: ToolSearchScoreContext
): ToolMatchSignal[] {
  const signals = [
    buildMatchSignal('id', card.id, terms),
    buildMatchSignal('name', card.name, terms),
    buildMatchSignal('category', card.categoryId, terms),
    buildMatchSignal('aliases', card.aliases.join(' '), terms),
    buildMatchSignal('search_hints', card.searchHints.join(' '), terms),
    buildMatchSignal('summary', card.summary, terms),
    buildMatchSignal('description', card.description ?? '', terms),
    buildMatchSignal('suitable', card.suitable.join(' '), terms),
    buildMatchSignal('forbidden', card.forbidden.join(' '), terms),
    buildMatchSignal('schema', context.schemaTextById.get(card.id) ?? '', terms),
    buildMatchSignal('activation', context.activationTextById.get(card.id) ?? '', terms),
    buildMatchSignal(
      'reverse_activation',
      context.reverseActivationTextByName.get(card.name) ?? '',
      terms
    ),
  ]

  return signals.filter(isPresent)
}

export function buildToolDiscoveryCards(ctx: ToolContext): ToolDiscoveryCard[] {
  return buildToolSpacePages(ctx)
}

function activationCapabilityIdForCategory(categoryId: ToolCategoryId): string {
  return `capability:${categoryId}`
}

function subCategoryIdsForCategory(_categoryId: ToolCategoryId): ToolCategoryId[] {
  return []
}

function parentCategoryIdForCategory(_categoryId: ToolCategoryId): Nullable<ToolCategoryId> {
  return null
}

function categoryKindForCategory(categoryId: ToolCategoryId): ToolMapCategoryKind {
  return isEmpty(subCategoryIdsForCategory(categoryId)) ? 'leaf' : 'bundle'
}

function activationCapabilityIdForCard(card: ToolDiscoveryCard): Nullable<string> {
  if (card.kind === 'plugin') return null
  return activationCapabilityIdForCategory(card.categoryId)
}

function reasonKey(reason: ToolDiscoveryReason): string {
  return `${reason.layer}.${reason.code}`
}

function hasReason(
  card: ToolDiscoveryCard,
  layer: ToolDiscoveryReason['layer'],
  code: string
): boolean {
  return card.reasons.some((reason) => reason.layer === layer && reason.code === code)
}

function isControlRoleToolPage(card: ToolDiscoveryCard): boolean {
  return card.kind === 'tool' && hasReason(card, 'runtime', 'control_tool')
}

function buildToolDependencyGuides(card: ToolDiscoveryCard): ToolDependencyGuide[] {
  const dependencies: ToolDependencyGuide[] = []
  const capabilityId = activationCapabilityIdForCard(card)

  if (hasReason(card, 'approval', 'required')) {
    dependencies.push({
      id: capabilityId ?? card.id,
      kind: 'capability',
      state: 'requires_approval',
      required: true,
      summary: '目标工具所属能力尚未启用；先申请能力页，优先按 capability 一类激活。',
      pageId: capabilityId ?? card.id,
      pageIn: [capabilityId ?? card.id],
      nextTool: 'tool_replace',
      reasonKeys: ['approval.required'],
      activationHint: `先 tool_replace(pageIn:["${capabilityId ?? card.id}"])；授权通过后，目标工具会按动态工具空间预算换入/暴露。`,
    })
  }

  if (hasReason(card, 'plugin', 'user_action_required')) {
    dependencies.push({
      id: 'plugin_user_action',
      kind: 'plugin',
      state: 'requires_user_action',
      required: true,
      summary: '目标能力依赖外部连接器或用户侧动作，必须向用户展示动作卡。',
      pageId: 'tool:show_user_action_cards',
      pageIn: ['tool:show_user_action_cards'],
      nextTool: 'show_user_action_cards',
      reasonKeys: ['plugin.user_action_required'],
      activationHint:
        '先定位阻塞页；再换入 show_user_action_cards，构造 blocking=true 的插件卡（enable_prompt_features 标"批准" + 一个 reject 标"拒绝"）等待用户完成。',
    })
  }

  if (
    hasReason(card, 'runtime', 'unavailable') ||
    hasReason(card, 'runtime', 'no_available_tools')
  ) {
    dependencies.push({
      id: 'runtime_available_tool',
      kind: 'runtime',
      state: 'blocked',
      required: true,
      summary: '工具或能力在当前运行态不可用。',
      pageId: null,
      pageIn: [],
      nextTool: 'tool_map',
      reasonKeys: card.reasons.filter((reason) => reason.layer === 'runtime').map(reasonKey),
      activationHint: '回到 tool_map 或 tool_map(op:"find") 查看替代工具或等待运行态恢复。',
    })
  }

  if (hasReason(card, 'resident', 'loadable')) {
    dependencies.push({
      id: `resident:${card.id}`,
      kind: 'residency',
      state: 'loadable',
      required: false,
      summary: '工具已授权但不在本轮可见工具空间；需要先 page-in，让真实 schema 在下一轮暴露。',
      pageId: card.id,
      pageIn: [card.id],
      nextTool: 'tool_replace',
      reasonKeys: ['resident.loadable'],
      activationHint: 'tool_replace(pageIn:[tool]) 后下一轮调用真实工具。',
    })
  }

  if (hasReason(card, 'resident', 'visible') || hasReason(card, 'capability', 'enabled')) {
    dependencies.push({
      id: card.kind === 'tool' ? `resident:${card.id}` : card.id,
      kind: card.kind === 'tool' ? 'residency' : 'capability',
      state: 'satisfied',
      required: false,
      summary: card.kind === 'tool' ? '工具已在本轮可见工具空间中。' : '能力已经启用。',
      pageId: card.id,
      pageIn: [],
      nextTool: card.kind === 'tool' ? card.name : null,
      reasonKeys: card.reasons
        .filter((reason) => reason.layer === 'resident' || reason.layer === 'capability')
        .map(reasonKey),
      activationHint:
        card.kind === 'tool' ? '直接调用真实工具。' : '查看具体工具页决定直接调用或 page-in。',
    })
  }

  return dependencies
}

function buildActivationFlow(input: {
  card: ToolDiscoveryCard
  method: ToolActivationMethod
  pageIn: readonly string[]
  nextTool: Nullable<string>
  dependencies: readonly ToolDependencyGuide[]
}): string[] {
  const flow = input.dependencies
    .filter((dependency) => dependency.required && dependency.state !== 'satisfied')
    .map((dependency) => dependency.activationHint)

  if (input.method === 'direct_call') {
    flow.push(`直接调用 ${input.card.name}，使用本轮 AI SDK tools 中的完整 schema。`)
  } else if (input.method === 'page_in_only') {
    if (input.card.kind === 'capability') {
      flow.push(
        `tool_replace(pageIn:["${input.card.id}"]) 启用该能力；下一轮重新查看具体工具页状态，再按目标工具 activation 调用。`
      )
    } else if (isControlRoleToolPage(input.card)) {
      flow.push(
        `tool_replace(pageIn:["${input.card.id}"])，下一轮直接调用 ${input.card.name}。`
      )
    } else {
      flow.push(
        `tool_replace(pageIn:["${input.card.id}"])，下一轮直接调用 ${input.card.name}。`
      )
    }
  } else if (input.method === 'request_approval') {
    const target = input.pageIn[0] ?? input.card.id
    flow.push(
      `tool_replace(pageIn:["${target}"]) 请求启用能力；通过后重新读取工具状态或下一轮调用。`
    )
  } else if (input.method === 'request_user_action') {
    if (!isEmpty(input.pageIn)) {
      flow.push(
        `先 tool_replace(pageIn:${JSON.stringify(input.pageIn)}) 换入前置入口，再调用 ${input.nextTool ?? '对应工具'} 完成用户动作。`
      )
    } else {
      flow.push('查看 reasons，按能力提供方声明的阻塞项请求用户动作。')
    }
  } else {
    flow.push('查看 reasons 和 dependency guide，改查替代工具或处理阻塞条件。')
  }

  return [...new Set(flow)]
}

function withActivationDependencies(
  card: ToolDiscoveryCard,
  guide: Omit<ToolActivationGuide, 'dependencies' | 'activationFlow'>
): ToolActivationGuide {
  const dependencies = buildToolDependencyGuides(card)
  return {
    ...guide,
    dependencies,
    activationFlow: buildActivationFlow({
      card,
      method: guide.method,
      pageIn: guide.pageIn,
      nextTool: guide.nextTool,
      dependencies,
    }),
  }
}

function buildToolActivationGuide(card: ToolDiscoveryCard): ToolActivationGuide {
  if (card.availability === 'visible') return withActivationDependencies(card, {
      method: 'direct_call',
      summary: '已在本轮 AI SDK tools 中暴露完整 schema，可直接调用。',
      pageIn: [],
      capabilityId: activationCapabilityIdForCard(card),
      nextTool: card.kind === 'tool' ? card.name : null,
      notes: ['按当前工具 schema 直接构造参数。'],
    })

  if (card.availability === 'loadable') {
    switch (card.kind) {
      case 'plugin':
        return withActivationDependencies(card, {
          method: 'page_in_only',
          summary:
            '插件可静默启用；用 tool_replace page-in 插件页，下一轮再调用目标能力的真实工具。',
          pageIn: [card.id],
          capabilityId: activationCapabilityIdForCard(card),
          nextTool: 'tool_replace',
          notes: [
            '插件页本身不是可执行工具；启用后重新查看目标工具页，或直接调用下一轮暴露的入口工具。',
          ],
        })
      case 'capability':
        return withActivationDependencies(card, {
          method: 'page_in_only',
          summary:
            '该能力已预授权但尚未启用；用 tool_replace page-in 启用能力，下一轮再按具体工具页状态调用目标工具。',
          pageIn: [card.id],
          capabilityId: activationCapabilityIdForCard(card),
          nextTool: 'tool_replace',
          notes: [
            '能力页本身不是可执行工具；启用后重新查看目标工具页，按目标工具的 toolOsState、activation 和真实 schema 执行。',
          ],
        })
      case 'tool':
        return withActivationDependencies(card, {
          method: 'page_in_only',
          summary:
            '已授权但未驻留；先用 tool_replace page-in，下一轮通过真实工具 schema 调用。',
          pageIn: [card.id],
          capabilityId: activationCapabilityIdForCard(card),
          nextTool: 'tool_replace',
          notes: [
            '主模型不通过反射代理或单工具详情读取来构造参数。',
            '需要执行该工具时，用 replace page-in，让真实 schema 在下一轮暴露。',
          ],
        })
    }
  }

  if (card.availability === 'requires_approval') {
    const capabilityId = activationCapabilityIdForCard(card)
    return withActivationDependencies(card, {
      method: 'request_approval',
      summary: '能力尚未启用；先用 tool_replace 请求启用能力或目标工具页。',
      pageIn: [capabilityId ?? card.id],
      capabilityId,
      nextTool: 'tool_replace',
      notes: ['replace 通过后，下一轮再调用真实工具；未通过则按 requiresApprovalDetails 处理。'],
    })
  }

  if (card.availability === 'requires_user_action') {
    const pluginUserAction = card.reasons.some(
      (reason) => reason.layer === 'plugin' && reason.code === 'user_action_required'
    )
    return withActivationDependencies(card, {
      method: 'request_user_action',
      summary: pluginUserAction
          ? '外部连接器或用户侧动作尚未完成；先用 show_user_action_cards 请求用户动作。'
          : '需要先完成能力提供方声明的用户动作；查看 reasons 和 dependencies。',
      pageIn: pluginUserAction
          ? ['tool:show_user_action_cards']
          : [],
      capabilityId: activationCapabilityIdForCard(card),
      nextTool: pluginUserAction
          ? 'show_user_action_cards'
          : null,
      notes: ['完成用户动作后重新查看工具页状态，不要重复调用当前不可用工具。'],
    })
  }

  return withActivationDependencies(card, {
    method: 'inspect_reasons',
    summary: '当前不可用；先查看 reasons，改查工具空间状态清单或选择替代工具。',
    pageIn: [],
    capabilityId: activationCapabilityIdForCard(card),
    nextTool: 'tool_map',
    notes: ['用 tool_map 或 tool_map(op:"find"/"page") 查看系统所有工具状态、功能摘要和替代路径。'],
  })
}

function summarizeReasonRef(reason: ToolDiscoveryReason): ToolReasonRef {
  return {
    layer: reason.layer,
    code: reason.code,
    message: reason.message,
  }
}

function summarizeDependencyRef(dependency: ToolDependencyGuide): ToolDependencyRef {
  return {
    id: dependency.id,
    kind: dependency.kind,
    state: dependency.state,
    required: dependency.required,
    pageId: dependency.pageId,
    pageIn: dependency.pageIn,
    nextTool: dependency.nextTool,
    reasonKeys: dependency.reasonKeys,
  }
}

function summarizeActivationRef(activation: ToolActivationGuide): ToolActivationRef {
  return {
    method: activation.method,
    pageIn: activation.pageIn,
    capabilityId: activation.capabilityId,
    nextTool: activation.nextTool,
    dependencies: activation.dependencies.map(summarizeDependencyRef),
  }
}

function buildToolActivationRef(card: ToolDiscoveryCard): ToolActivationRef {
  return summarizeActivationRef(buildToolActivationGuide(card))
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
  optionsOrIndex: { includeAccess?: boolean } | number = {}
) {
  const includeAccess =
    isNumber(optionsOrIndex) ? true : (optionsOrIndex.includeAccess ?? true)
  return {
    id: card.id,
    kind: card.kind,
    name: card.name,
    categoryId: card.categoryId,
    summary: card.summary,
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

type ToolBatchPageSummary = ReturnType<typeof summarizeToolSpacePageRef>

interface ToolBatchCategorySummary {
  categoryId: ToolCategoryId
  categoryLabel: string
  totalPages: number
  returnedPageCount: number
  pages: ToolBatchPageSummary[]
}

interface ToolBatchQueryResult {
  query: string
  pages: ToolSearchResultEntry[]
}

interface ToolBatchResolvedTargets {
  matchedCards: ToolDiscoveryCard[]
  explicitPageIds: string[]
  expandedCategoryIds: ToolCategoryId[]
  missingPageIds: string[]
  queryResults: ToolBatchQueryResult[]
  resolvedPageIn: string[]
  resolvedPageOut: string[]
}

function uniqueToolSpaceIds(ids: readonly string[]): string[] {
  return [
    ...new Set(
      ids
        .map((id) => id.trim())
        .filter((id) => !isEmpty(id))
    ),
  ]
}

function summarizeToolBatchPage(card: ToolDiscoveryCard): ToolBatchPageSummary {
  return summarizeToolSpacePageRef(card)
}

function groupToolBatchPages(
  cards: readonly ToolDiscoveryCard[],
  maxToolsPerCategory: number
): ToolBatchCategorySummary[] {
  const grouped = new Map<ToolCategoryId, ToolDiscoveryCard[]>()
  for (const card of cards) {
    const entries = grouped.get(card.categoryId) ?? []
    entries.push(card)
    grouped.set(card.categoryId, entries)
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => compareStableStrings(left, right))
    .map(([categoryId, categoryCards]) => {
      const sortedCards = [...categoryCards].sort((left, right) => compareStableStrings(left.name, right.name))
      const returnedCards = sortedCards.slice(0, maxToolsPerCategory)
      return {
        categoryId,
        categoryLabel: categoryId,
        totalPages: sortedCards.length,
        returnedPageCount: returnedCards.length,
        pages: returnedCards.map(summarizeToolBatchPage),
      }
    })
}

function pageIdsForCategories(
  cards: readonly ToolDiscoveryCard[],
  categoryIds: readonly ToolCategoryId[],
  kinds: readonly ToolDiscoveryKind[],
  maxToolsPerCategory: number,
  toolOsStates: readonly ToolOsState[] = []
): string[] {
  const categoryFilter = buildToolSpaceCategoryFilter([...categoryIds])
  if (!categoryFilter) return []

  const kindFilter = new Set<ToolDiscoveryKind>(kinds)
  const toolOsStateFilter = isEmpty(toolOsStates) ? null : new Set<ToolOsState>(toolOsStates)
  const grouped = new Map<ToolCategoryId, ToolDiscoveryCard[]>()
  for (const card of cards) {
    if (
      !categoryFilter.has(card.categoryId) ||
      !kindFilter.has(card.kind) ||
      (toolOsStateFilter && !toolOsStateFilter.has(card.toolOsState))
    ) {
      continue
    }
    const entries = grouped.get(card.categoryId) ?? []
    entries.push(card)
    grouped.set(card.categoryId, entries)
  }

  const pageIds: string[] = []
  for (const categoryId of [...grouped.keys()].sort(compareStableStrings)) {
    const sortedCards = [...(grouped.get(categoryId) ?? [])].sort((left, right) =>
      compareStableStrings(left.name, right.name)
    )
    pageIds.push(...sortedCards.slice(0, maxToolsPerCategory).map((card) => card.id))
  }
  return uniqueToolSpaceIds(pageIds)
}

function capabilityPageIdsForCategories(
  cardsById: ReadonlyMap<string, ToolDiscoveryCard>,
  categoryIds: readonly ToolCategoryId[],
  toolOsStates: readonly ToolOsState[] = []
): string[] {
  const toolOsStateFilter = isEmpty(toolOsStates) ? null : new Set<ToolOsState>(toolOsStates)
  return uniqueToolSpaceIds(
    categoryIds
      .map(activationCapabilityIdForCategory)
      .filter((id) => {
        if (!toolOsStateFilter) return true
        const card = cardsById.get(id)
        return !!card && toolOsStateFilter.has(card.toolOsState)
      })
  )
}

function addCardsById(
  target: Map<string, ToolDiscoveryCard>,
  cardsById: ReadonlyMap<string, ToolDiscoveryCard>,
  ids: readonly string[]
): void {
  for (const id of ids) {
    const card = cardsById.get(id)
    if (card) {
      target.set(card.id, card)
    }
  }
}

function resolveToolBatchTargets(
  ctx: ToolContext,
  input: z.output<typeof toolBatchMethodSchema>
): ToolBatchResolvedTargets {
  const cards = buildToolDiscoveryCards(ctx)
  const cardsById = new Map(cards.map((card) => [card.id, card]))
  const matchedCardsById = new Map<string, ToolDiscoveryCard>()
  const explicitPageIds = uniqueToolSpaceIds([...input.pageIds, ...input.pageIn, ...input.pageOut])
  const expandedCategoryIds = expandToolCategoryFilterInput(input)
  const categoryCapabilityPageIds = capabilityPageIdsForCategories(
    cardsById,
    expandedCategoryIds,
    input.toolOsStates
  )
  const categoryPageIds = pageIdsForCategories(
    cards,
    expandedCategoryIds,
    input.kinds,
    input.maxToolsPerCategory,
    input.toolOsStates
  )
  const stateOnlyPageIds =
    isEmpty(expandedCategoryIds) && !isEmpty(input.toolOsStates)
      ? pageIdsForCategories(
          cards,
          [...new Set(cards.map((card) => card.categoryId))],
          input.kinds,
          input.maxToolsPerCategory,
          input.toolOsStates
        )
      : []

  addCardsById(matchedCardsById, cardsById, explicitPageIds)
  addCardsById(matchedCardsById, cardsById, categoryCapabilityPageIds)
  addCardsById(matchedCardsById, cardsById, categoryPageIds)
  addCardsById(matchedCardsById, cardsById, stateOnlyPageIds)

  const queryResults = input.queries.map((query) => {
    const result = searchToolDiscoveryCards(
      ctx,
      toolSpaceFindSchema.parse({
        op: 'find',
        query,
        kind: input.kinds.length === 1 ? input.kinds[0] : 'all',
        categoryIds: [],
        domainIds: input.domainIds,
        toolOsStates: input.toolOsStates,
        limit: input.maxMatchesPerQuery,
      })
    )
    addCardsById(
      matchedCardsById,
      cardsById,
      result.pages.map((page) => page.id)
    )
    return {
      query,
      pages: result.pages,
    }
  })
  const queryPageIds = queryResults.flatMap((entry) => entry.pages.map((page) => page.id))
  const explicitPageIn = uniqueToolSpaceIds([...input.pageIds, ...input.pageIn])
  const explicitPageOut = uniqueToolSpaceIds(input.pageOut)

  return {
    matchedCards: [...matchedCardsById.values()],
    explicitPageIds,
    expandedCategoryIds,
    missingPageIds: explicitPageIds.filter((id) => !cardsById.has(id)),
    queryResults,
    resolvedPageIn:
      input.action === 'remove'
        ? []
        : uniqueToolSpaceIds([
            ...categoryCapabilityPageIds,
            ...(isEmpty(input.toolOsStates) ? [] : categoryPageIds),
            ...explicitPageIn,
            ...queryPageIds,
            ...stateOnlyPageIds,
          ]),
    resolvedPageOut:
      input.action === 'remove'
        ? uniqueToolSpaceIds([
            ...categoryCapabilityPageIds,
            ...stateOnlyPageIds,
            ...input.pageIds,
            ...input.pageOut,
          ])
        : explicitPageOut,
  }
}

function summarizeToolBatchFilters(
  input: z.output<typeof toolBatchMethodSchema>,
  resolved: ToolBatchResolvedTargets
) {
  return {
    kinds: input.kinds,
    categoryIds: input.categoryIds,
    domainIds: input.domainIds,
    toolOsStates: input.toolOsStates,
    expandedCategoryIds: resolved.expandedCategoryIds,
    maxMatchesPerQuery: input.maxMatchesPerQuery,
    maxToolsPerCategory: input.maxToolsPerCategory,
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

function isSchemaPlainObject(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value)
}

function collectSchemaSearchText(value: unknown, output: string[], depth = 0): void {
  if (depth > 6 || output.length > 240) return
  if (isString(value)) {
    output.push(value)
    output.push(...splitIdentifierSearchTerm(value))
    return
  }
  if (isNumber(value) || isBoolean(value)) {
    output.push(String(value))
    return
  }
  if (isArray(value)) {
    for (const item of value) {
      collectSchemaSearchText(item, output, depth + 1)
    }
    return
  }
  if (!isSchemaPlainObject(value)) return
  for (const [key, item] of Object.entries(value)) {
    output.push(key)
    output.push(...splitIdentifierSearchTerm(key))
    collectSchemaSearchText(item, output, depth + 1)
  }
}

function schemaSearchText(
  resolvedSchema: Nullable<{ profileId: string; description: string; schema: unknown }>
): string {
  if (!resolvedSchema) return ''
  const pieces = [resolvedSchema.profileId, resolvedSchema.description]
  collectSchemaSearchText(resolvedSchema.schema, pieces)
  return pieces.join(' ')
}

function activationSearchText(card: ToolDiscoveryCard): string {
  const activation = buildToolActivationGuide(card)
  return [
    activation.method,
    activation.summary,
    activation.capabilityId,
    activation.nextTool,
    ...activation.pageIn,
    ...activation.notes,
    ...activation.activationFlow,
    ...activation.dependencies.flatMap((dependency) => [
      dependency.id,
      dependency.kind,
      dependency.state,
      dependency.summary,
      dependency.pageId,
      dependency.nextTool,
      dependency.activationHint,
      ...dependency.pageIn,
      ...dependency.reasonKeys,
    ]),
  ]
    .filter((value): value is string => isString(value))
    .join(' ')
}

function buildToolSearchScoreContext(
  ctx: ToolContext,
  cards: readonly ToolDiscoveryCard[]
): ToolSearchScoreContext {
  const schemaTextById = new Map<string, string>()
  const activationTextById = new Map<string, string>()
  const reverseActivationTextByName = new Map<string, string[]>()

  for (const card of cards) {
    schemaTextById.set(card.id, schemaSearchText(readToolInputSchema(ctx, card)))

    const activation = buildToolActivationGuide(card)
    const activationText = activationSearchText(card)
    activationTextById.set(card.id, activationText)

    for (const dependency of activation.dependencies) {
      const nextToolNames = [
        dependency.nextTool,
        ...dependency.pageIn
          .filter((pageId) => pageId.startsWith('tool:'))
          .map((pageId) => pageId.slice('tool:'.length)),
      ].filter((toolName): toolName is string => isString(toolName))

      for (const nextToolName of nextToolNames) {
        const existing = reverseActivationTextByName.get(nextToolName) ?? []
        existing.push(activationText)
        reverseActivationTextByName.set(nextToolName, existing)
      }
    }
  }

  return {
    schemaTextById,
    activationTextById,
    reverseActivationTextByName: new Map(
      [...reverseActivationTextByName.entries()].map(([toolName, texts]) => [
        toolName,
        [...new Set(texts)].join(' '),
      ])
    ),
  }
}

export function searchToolDiscoveryCards(
  ctx: ToolContext,
  input: z.output<typeof toolSpaceFindSchema>
) {
  const terms = splitSearchTerms(input.query)
  const expandedCategoryIds = expandToolCategoryFilterInput(input)
  const categoryFilter = buildToolSpaceCategoryFilter(expandedCategoryIds)
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
    pages: page.map(
      ({ card, score }) =>
        ({
          ...summarizeToolSpacePageRef(card),
          score,
          matchSignals: buildMatchSignals(card, terms, scoreContext),
        }) satisfies ToolSearchResultEntry
    ),
    statusSummary,
    hasMore,
    nextCursor,
    message: '这是工具页索引；需要执行 loadable 工具时用 tool_replace 换入，下一轮通过真实 schema 调用。',
  }
}

function parseToolSpaceCursor(cursor: Nullable<string> | undefined): number {
  if (!cursor) return 0

  const value = Number(cursor)
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function filterToolSpaceCards(
  cards: ToolDiscoveryCard[],
  input: {
    kind: 'tool' | 'capability' | 'plugin' | 'all'
    categoryIds: ToolCategoryId[]
    domainIds?: ToolCategoryDomainId[]
    toolOsStates?: ToolOsState[]
  }
): ToolDiscoveryCard[] {
  const categoryFilter = buildToolSpaceCategoryFilter(expandToolCategoryFilterInput(input))
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
  const expandedCategoryIds = expandToolCategoryFilterInput(input)
  const cards = filterToolSpaceCards(buildToolDiscoveryCards(ctx), input)
  const offset = parseToolSpaceCursor(input.cursor)
  const page = cards.slice(offset, offset + input.limit)
  const nextOffset = offset + page.length

  return {
    op: 'page' as const,
    filters: {
      kind: input.kind,
      categoryIds: input.categoryIds,
      domainIds: input.domainIds,
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
    pages: page.map(summarizeToolSpacePageRef),
    statusSummary: buildToolSpaceStatusSummary(cards),
    message: '这是工具页索引；需要执行 loadable 工具时用 tool_replace 换入，下一轮通过真实 schema 调用。',
  }
}

function summarizeToolSpaceMapPage(card: ToolDiscoveryCard) {
  return summarizeToolSpacePageRef(card, { includeAccess: false })
}

function effectiveToolMapToolsPerCategory(input: z.output<typeof toolSpaceMapSchema>): number {
  const categoryLimit = Math.max(1, input.categoryLimit)
  const rowBudgetForCategory = Math.max(1, Math.floor(ToolMapTargetToolRows / categoryLimit))
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
        'maxToolsPerCategory was capped by the map row budget; use categoryIds or tool_map(op:"page") to inspect a category in full.',
    },
  ]
}

function buildToolSpaceMapGuide(ctx: ToolContext, cards: readonly ToolDiscoveryCard[]) {
  const visibleToolNames = new Set(ctx.getCurrentVisibleToolNames?.() ?? [])
  const showUserActionTool = cards.find((card) => card.id === 'tool:show_user_action_cards')
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
        meaning: '已授权或可通过 tool_replace 申请/换入；不需要把它当作权限分类。',
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
          nextTool: 'tool_replace',
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
          pageId: showUserActionTool?.id ?? 'tool:show_user_action_cards',
          availability: showUserActionTool?.availability ?? 'unavailable',
          pageIn:
            showUserActionTool && showUserActionTool.availability !== 'visible'
              ? ['tool:show_user_action_cards']
              : [],
          nextTool: 'show_user_action_cards',
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
  const expandedCategoryIds = expandToolCategoryFilterInput(input)
  const filteredCards = filterToolSpaceCards(allCards, input)
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
  const effectiveMaxToolsPerCategory = effectiveToolMapToolsPerCategory(input)
  const parameterAdjustments = toolMapParameterAdjustments(input, effectiveMaxToolsPerCategory)

  const categories = pagedCategoryEntries.map(([categoryId, cards]) => {
    const capability = cards.find((card) => card.kind === 'capability')
    const tools = cards.filter((card) => card.kind === 'tool')
    const plugins = cards.filter((card) => card.kind === 'plugin')
    const visibleTools = tools.slice(0, effectiveMaxToolsPerCategory)
    const toolNames = tools.map((card) => card.name).sort(compareStableStrings)
    const definition = capability
      ? {
          label: capability.name,
          description: capability.description,
          toolOs: { domain: 'injected', defaultState: capability.toolOsState },
        }
      : undefined
    const subCategoryIds = subCategoryIdsForCategory(categoryId)
    const childCards = subCategoryIds.flatMap((subCategoryId) => grouped.get(subCategoryId) ?? [])
    const childTools = childCards.filter((card) => card.kind === 'tool')

    return {
      categoryId,
      categoryKind: categoryKindForCategory(categoryId),
      parentCategoryId: parentCategoryIdForCategory(categoryId),
      subCategoryIds,
      label: definition?.label ?? categoryId,
      summary: toNullable(definition?.description),
      toolOs: toNullable(definition?.toolOs),
      statusSummary: buildToolSpaceStatusSummary(cards),
      childStatusSummary: isEmpty(subCategoryIds) ? null : buildToolSpaceStatusSummary(childCards),
      capability: capability ? summarizeToolSpaceMapPage(capability) : null,
      activation: capability
        ? buildToolActivationRef(capability)
        : {
            method: 'inspect_reasons' as const,
            pageIn: [],
            capabilityId: `capability:${categoryId}`,
            nextTool: 'tool_map',
            dependencies: [],
          },
      toolNames,
      tools: visibleTools.map(summarizeToolSpaceMapPage),
      plugins: plugins.map(summarizeToolSpaceMapPage),
      totalToolCount: tools.length,
      totalToolNameCount: toolNames.length,
      childToolCount: childTools.length,
      toolsReturnedCount: visibleTools.length,
      hasMoreTools: visibleTools.length < tools.length,
      hiddenToolCount: Math.max(0, tools.length - visibleTools.length),
      toolPage:
        visibleTools.length < tools.length
          ? {
              tool: 'tool_page' as const,
              categoryIds: [categoryId],
              kind: 'tool' as const,
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
      '这是分页工具页索引；每个分类附带完整 toolNames，详细状态页仍按 maxToolsPerCategory 展开；需要执行 loadable 工具时用 tool_replace 换入，下一轮通过真实 schema 调用；需要更多分类时用 page.nextCursor 继续。',
  }
}

interface SkillReadPage {
  id: string
  kind: 'skill'
  name: string
  label: string
  description: string
  sourceKind: AgentSkillDescriptor['sourceKind']
  sourceId: string
  roleIds: AgentSkillDescriptor['roleIds']
  priority: number
  markdown: string
  fullDetails?: {
    readGuidance: string[]
  }
}

function buildSkillReadPage(
  descriptor: AgentSkillDescriptor,
  markdown: string,
  detail: z.output<typeof toolSpaceReadSchema>['detail']
): SkillReadPage {
  return {
    id: `${SkillPagePrefix}${descriptor.id}`,
    kind: 'skill',
    name: descriptor.id,
    label: descriptor.label,
    description: descriptor.description ?? descriptor.label,
    sourceKind: descriptor.sourceKind,
    sourceId: descriptor.sourceId,
    roleIds: descriptor.roleIds,
    priority: descriptor.priority,
    markdown,
    fullDetails: optionalWhenLazy(detail === 'full', () => ({
      readGuidance: [
        '这是当前角色和 selectedSkillIds 下可见的技能正文；按需读取后只应用与当前任务相关的步骤。',
        '技能正文不会改变工具可见性；需要新工具仍按 tool_map / tool_replace 的工具空间流程处理。',
      ],
    })),
  }
}

function readRequestedSkillPage(
  ctx: ToolContext,
  id: string,
  detail: z.output<typeof toolSpaceReadSchema>['detail']
): Nullable<SkillReadPage> {
  const skillId = readSkillPageId(id)
  if (!skillId) return null

  const skill = ctx.skills?.readRoleSkill?.(skillId)
  if (!skill) return null

  return buildSkillReadPage(skill.descriptor, skill.markdown, detail)
}

/**
 * 读取当前角色可见的技能正文（skill:<id>）。
 *
 * 历史上这里也读「工具页 schema 预览」，那是旧的「工具默认隐藏→换入前先预览 schema」范式的产物。
 * 工具暴露改为「填满预算常驻」后，需要的工具 schema 大多已直接在本轮 tools 列表里可见，
 * 预览 + 重复深读拦截（ToolPageReadLedger）整套已无价值并一并退役。该入口现在只读技能（及未来其他可读资源）。
 */
export async function readRequestedSkillPages(
  ctx: ToolContext,
  input: z.output<typeof toolSpaceReadSchema>
) {
  const deniedSkillPageIds = await confirmAutoLoadedSkillPages(ctx, input.ids)
  const pages: SkillReadPage[] = []
  const missingIds: string[] = []
  const deniedSkillIds: string[] = []

  for (const id of input.ids) {
    if (deniedSkillPageIds.has(id)) {
      deniedSkillIds.push(id)
      continue
    }

    const skillPage = readRequestedSkillPage(ctx, id, input.detail)
    if (skillPage) {
      pages.push(skillPage)
      continue
    }

    missingIds.push(id)
  }

  return {
    op: 'read' as const,
    pages,
    missingIds,
    deniedSkillIds: optionalWhenLazy(!isEmpty(deniedSkillIds), () => deniedSkillIds),
    message: !isEmpty(deniedSkillIds)
      ? `用户拒绝读取技能：${deniedSkillIds.join('、')}。不要再次尝试读取这些技能，按用户意图继续当前任务。`
      : isEmpty(missingIds)
        ? '已读取技能正文。'
        : `部分技能 id 不存在：${missingIds.join('、')}。技能列表见任务提示词里的「可按需读取的技能」索引；tool_read 只读 skill:<id>，工具能力请用 tool_map 发现、tool_replace 换入。`,
  }
}

function protectedCategoryIds(categoryIds: readonly ToolCategoryId[]): ToolCategoryId[] {
  void categoryIds
  return []
}

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

function buildReplaceNextTurnHint(input: {
  preparedTools: readonly string[]
  enabledCapabilities: readonly ToolCategoryId[]
  requiresApprovalDetails: readonly ToolSpaceReplacePageDetail[]
  requiresUserActionDetails: readonly ToolSpaceReplacePageDetail[]
  skippedPageDetails: readonly ToolSpaceReplacePageDetail[]
  recommendedPageIn: readonly string[]
  recommendedTools: readonly string[]
  userActionHint: Nullable<string>
}): string {
  if (!isEmpty(input.preparedTools) || !isEmpty(input.enabledCapabilities)) return '工具页替换已记录；下一轮 AI SDK tools 会按动态工具空间预算暴露实际可调用工具 schema。preparedToolExamples 给出了每个换入工具的正确调用示例，请照其字段名与结构调用，不要凭摘要猜参数。'

  if (!isEmpty(input.recommendedTools)) return `没有新的工具页被换入；目标页不可用。下一步直接调用 ${input.recommendedTools.join(', ')}，不要重复 page-in unavailable targets。`

  if (!isEmpty(input.recommendedPageIn)) return `没有新的工具页被换入；目标页不可用。先 tool_replace(pageIn:${JSON.stringify(input.recommendedPageIn)}) 换入推荐页，下一轮调用真实工具；不要重复 page-in unavailable targets。`

  if (!isEmpty(input.requiresApprovalDetails) || !isEmpty(input.requiresUserActionDetails)) return '没有新的工具页被换入；请根据 requiresApprovalDetails / requiresUserActionDetails 的 reasons 处理授权、插件或用户动作。'

  if (!isEmpty(input.skippedPageDetails)) return '没有新的工具页被换入；请查看 skippedPageDetails 的 reasons，并改用可见工具、换入推荐页或重新查询工具页。'

  return '没有新的工具页被换入；请回到 tool_map(op:"find") 或 tool_map(op:"page") 重新确认目标页，再用 tool_replace 换入。'
}

async function planToolSpaceReplacement(
  ctx: ToolContext,
  input: z.output<typeof toolSpaceReplaceSchema>,
  options: { apply: boolean }
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
      if (options.apply) {
        const result = await ctx.requestToolCategoryAccess(categoriesToEnable, input.reason)
        enabledCapabilities.push(...result.enabledCategories)
        if (!result.approved) {
          requiresApproval.push(...pageIn.filter((id) => id.startsWith('capability:')))
        }
      } else {
        enabledCapabilities.push(...categoriesToEnable)
      }
    } else {
      if (options.apply) {
        ctx.codingSession.enableToolCategories(categoriesToEnable, input.reason)
      }
      enabledCapabilities.push(...categoriesToEnable)
    }
  }
  const finalPromptFeaturesToEnable = [...new Set(promptFeaturesToEnable)]
  if (!isEmpty(finalPromptFeaturesToEnable) && options.apply) {
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
  if (!isEmpty(preparedTools) && options.apply) {
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
      const categories = expandCapabilityCategoryIds(ctx.capabilityPorts, [card.categoryId])
      const protectedCategories = protectedCategoryIds(categories)
      const toDisable = categories.filter((categoryId) => !protectedCategories.includes(categoryId))
      if (!isEmpty(toDisable)) {
        disabledCapabilities.push(...toDisable)
      }
      skippedPages.push(...protectedCategories.map((categoryId) => `capability:${categoryId}`))
      continue
    }
    requiresUserAction.push(id)
  }

  if (!isEmpty(disabledCapabilities) && options.apply) {
    ctx.codingSession.disableToolCategories([...new Set(disabledCapabilities)], input.reason)
  }
  if (!isEmpty(pageOutTools) && options.apply) {
    ctx.codingSession.disableToolNames?.([...new Set(pageOutTools)], input.reason)
  }

  const requiresApprovalDetails = summarizeReplacePages(requiresApproval, cardsById)
  const requiresUserActionDetails = summarizeReplacePages(requiresUserAction, cardsById)
  const skippedPageDetails = summarizeReplacePages(skippedPages, cardsById)
  const unavailableTargetDetails = skippedPageDetails
  const recommendedPageIn: string[] = []
  const recommendedTools: string[] = []
  const preparedToolSet = new Set(preparedTools)
  const enabledCapabilitySetForResult = new Set(enabledCapabilities)

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
    unavailableTargets: [...new Set(skippedPages)],
    unavailableTargetDetails,
    recommendedPageIn,
    recommendedTools,
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
      enabledCapabilities: [...enabledCapabilitySetForResult],
      requiresApprovalDetails,
      requiresUserActionDetails,
      skippedPageDetails,
      recommendedPageIn,
      recommendedTools,
      userActionHint: null,
    }),
    message: options.apply
      ? alreadyResidentTools.length === preparedTools.length && !isEmpty(alreadyResidentTools)
        ? `换入目标已全部驻留(${alreadyResidentTools.join('、')}),本轮即可直接调用,无需再 tool_replace。`
        : 'ContextOS 工具页替换已处理。'
      : 'ContextOS 工具页替换计划已生成；dry-run 未改变会话工具状态。',
  }
}

export async function replaceToolSpacePages(
  ctx: ToolContext,
  input: z.output<typeof toolSpaceReplaceSchema>
) {
  return planToolSpaceReplacement(ctx, input, { apply: true })
}

async function previewToolSpacePagesReplacement(
  ctx: ToolContext,
  input: z.output<typeof toolSpaceReplaceSchema>
) {
  return planToolSpaceReplacement(ctx, input, { apply: false })
}

const ToolSpaceOpHandlers = {
  find: searchToolDiscoveryCards,
  page: pageToolDiscoveryCards,
  map: mapToolDiscoveryCards,
  read: readRequestedSkillPages,
  replace: replaceToolSpacePages,
} satisfies {
  [K in z.output<typeof toolSpaceSchema>['op']]: (
    ctx: ToolContext,
    input: Extract<z.output<typeof toolSpaceSchema>, { op: K }>
  ) => unknown
}

export async function runToolSpace(ctx: ToolContext, input: z.output<typeof toolSpaceSchema>) {
  const handler = ToolSpaceOpHandlers[input.op] as (
    ctx: ToolContext,
    input: z.output<typeof toolSpaceSchema>,
  ) => unknown
  return handler(ctx, input)
}

export async function runToolBatch(
  ctx: ToolContext,
  input: z.output<typeof toolBatchMethodSchema>
) {
  ctx.abortSignal.throwIfAborted()
  const resolved = resolveToolBatchTargets(ctx, input)
  const dryRun = input.dryRun || input.action === 'plan'
  const matchedPages = resolved.matchedCards.map(summarizeToolBatchPage)
  const groupedByCategory = groupToolBatchPages(resolved.matchedCards, input.maxToolsPerCategory)

  if (input.action === 'discover') return {
      action: input.action,
      dryRun,
      filters: summarizeToolBatchFilters(input, resolved),
      queryResults: resolved.queryResults,
      matchedPages,
      groupedByCategory,
      resolvedPageIn: resolved.resolvedPageIn,
      resolvedPageOut: resolved.resolvedPageOut,
      missingPageIds: resolved.missingPageIds,
      blockedBy: [],
      nextTurnHint:
        '这是批量发现结果；需要下一轮暴露工具时用 tool_batch(action:"import" 或 "replace")。',
      message: 'ContextOS 批量工具发现已处理。',
    }

  if (
    input.action === 'plan' ||
    input.action === 'import' ||
    input.action === 'replace' ||
    input.action === 'remove'
  ) {
    const replaceInput = toolSpaceReplaceSchema.parse({
      op: 'replace',
      pageIn: input.action === 'remove' ? [] : resolved.resolvedPageIn,
      pageOut: input.action === 'import' ? [] : resolved.resolvedPageOut,
      reason: input.reason,
    })
    const replaceResult =
      dryRun || input.action === 'plan'
        ? await previewToolSpacePagesReplacement(ctx, replaceInput)
        : await replaceToolSpacePages(ctx, replaceInput)

    return {
      action: input.action,
      dryRun,
      filters: summarizeToolBatchFilters(input, resolved),
      queryResults: resolved.queryResults,
      matchedPages,
      groupedByCategory,
      resolvedPageIn: replaceInput.pageIn,
      resolvedPageOut: replaceInput.pageOut,
      missingPageIds: resolved.missingPageIds,
      replaceResult,
      blockedBy: replaceResult.blockedBy,
      nextTurnHint: replaceResult.nextTurnHint,
      message:
        dryRun || input.action === 'plan'
          ? 'ContextOS 批量工具计划已生成；未改变会话工具状态。'
          : 'ContextOS 批量工具替换已处理。',
    }
  }

  const unsupportedAction: never = input.action
  throw new AppError(
    'VALIDATION',
    `Unsupported tool_batch action: ${String(unsupportedAction)}`
  )
}
