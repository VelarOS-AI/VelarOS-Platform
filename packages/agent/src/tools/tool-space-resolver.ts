// 域：工具**空间可见性**解析（哪些工具在当前工作区/角色/运行档下出现在模型的工具表里）。
//
// **为什么单独一层**：可见性不是权限（权限在 `./ExecutionPolicy.ts`），而是「模型这一轮能
// 看到什么」。两者刻意分开——看不见 ≠ 没权限；混在一处会让「工具消失」与「工具被拒」这两种
// 故障长得一样，而它们的补救路径相反（换空间 vs 求授权）。
//
// ## 组织
//  - **常驻集**：空间核心工具，不参与换入换出（否则模型每轮先做一次工具发现）；
//  - **分页/换入**：非常驻工具按需进出，页账本防「反复读同一页当进展」；
//  - **类别闸门**：并列工作区按类别隔离，一个空间看不到另一个空间的工具族。
//
// ## 关键不变量（改这些会破什么）
//  - **身份走声明、可用性走运行态**：空间身份由 descriptor 声明决定，站点/根是否已绑定只影响
//    可用性。历史事故：两者合取 → 未绑站点时浏览器工具全隐身，而绑定又需要那些工具 = 死锁。
//  - **常驻集不为空**：核心工具必须常驻，否则进入空间的第一轮只能靠工具发现，表现为
//    「转好几轮才开始干活」。
//  - **隔离按类别不按名字**：类别是唯一隔离单位；逐名例外会随工具增加而腐坏。
import { isEmpty, isFunction, isPresent, isString, truncate } from '@velaros-ai/core'
import type {
  AgentRoleId,
  CapabilityScopeId,
  ChatPromptFeatureId,
  ToolAvailabilityScope,
  ToolCategoryId,
  ToolCategoryOverview,
  ToolDescriptor,
  ToolOsState,
} from '@velaros-ai/core/types'
import {
  parseStructuredToolDescription,
  type StructuredToolDescriptionParts,
} from '@velaros-ai/core/utils/ToolDescription'

import {
  type AgentRuntimeCapabilityPorts,
  resolveCapabilityCategoryDefinitions,
} from '../capabilities'

import { buildToolAccessDecision, type ToolAccessDecision } from './access-decision'
import {
  decideToolCategoryAccess,
  type ToolAccessRuntimeState,
  type ToolCategoryAccessDecision,
  type ToolCategoryUnavailableReason,
} from './access-policy'
import type { ToolCapabilityPage } from './capability-types'
import {
  isReflectEligibleDiscoveryAvailability,
  nextActionForDiscoveryAvailability,
  resolveCapabilityDiscoveryAvailability,
  resolveToolDiscoveryAvailability,
  schemaStateForDiscoveryAvailability,
  type ToolDiscoveryAvailability,
  type ToolDiscoveryNextAction,
  type ToolDiscoverySchemaState,
  toolOsStateForDiscoveryAvailability,
} from './discovery-availability'

const ToolSpacePageKindValues = ['tool', 'capability', 'plugin'] as const
const ReflectionBlockedControlToolNames = new Set(['tool_reflect'])

function normalizePromptFeatures(features: readonly ChatPromptFeatureId[]): ChatPromptFeatureId[] {
  return [...new Set(features.filter((feature) => feature.trim()))]
}

type ToolSpacePageKind = (typeof ToolSpacePageKindValues)[number]
type ToolSpacePageRisk = 'none' | 'read' | 'write' | 'execute' | 'external' | 'destructive'
type ToolSpaceSchemaPolicy = 'full' | 'preview' | 'hidden' | 'none'

interface ToolSpaceReason {
  layer: string
  code: string
  message: string
  details?: Record<string, unknown>
}

interface ToolSpacePage {
  id: string
  kind: ToolSpacePageKind
  name: string
  categoryId: ToolCategoryId
  summary: string
  suitable: string[]
  forbidden: string[]
  aliases: string[]
  searchHints: string[]
  permissions: string[]
  risk: ToolSpacePageRisk
  availability: ToolDiscoveryAvailability
  toolOsState: ToolOsState
  schemaState: ToolDiscoverySchemaState
  schemaPolicy: ToolSpaceSchemaPolicy
  nextAction: ToolDiscoveryNextAction
  resident: boolean
  reflectEligible: boolean
  access: ToolAccessDecision
  reasons: ToolSpaceReason[]
  description?: string
}

interface ToolSpaceResolverCodingSession {
  hasToolCategoryAccess(categoryId: ToolCategoryId): boolean
  isToolCategoryAllowed?: (categoryId: ToolCategoryId) => boolean
  getEnabledPromptFeatures(): ChatPromptFeatureId[]
  /** 会话声明/切换后的当前能力作用域。 */
  getActiveCapabilityScope?: () => CapabilityScopeId
}

interface ToolSpaceResolverContext {
  capabilityPorts?: AgentRuntimeCapabilityPorts
  role?: { id?: AgentRoleId }
  codingSession: ToolSpaceResolverCodingSession
  requiresToolCategoryApproval?: (categoryId: ToolCategoryId) => boolean
  requestToolCategoryAccess?: unknown
  getCurrentVisibleToolNames(): string[]
  listCapabilityPages?: () => ToolCapabilityPage[]
  listTools?: (scope?: ToolAvailabilityScope) => ToolDescriptor[]
  listToolCategories(scope?: ToolAvailabilityScope): ToolCategoryOverview[]
}

interface PluginEntry {
  id: ChatPromptFeatureId
  label: string
  description: string
  toolCategoryIds: readonly ToolCategoryId[]
  enabled: boolean
}

const PluginBackedToolCategoryIds = new Set<ToolCategoryId>()
const PluginFeatureDescriptions: Partial<Record<ChatPromptFeatureId, string>> = {}

function isPluginBackedToolCategory(categoryId: ToolCategoryId): boolean {
  return PluginBackedToolCategoryIds.has(categoryId)
}

function normalizeDescription(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function aliasesForTool(tool: ToolDescriptor): string[] {
  const pieces = tool.name
    .split(/[_-]+/)
    .map((piece) => piece.trim())
    .filter(Boolean)
  return [...new Set([tool.name, ...pieces])]
}

function compactSearchHints(items: ReadonlyArray<LooseOptional<string>>): string[] {
  return [
    ...new Set(
      items
        .filter((item): item is string => isString(item))
        .map((item) => normalizeDescription(item))
        .filter((item) => item.length > 0)
    ),
  ]
}

function capabilitySearchHints(tool: ToolDescriptor): string[] {
  const capabilities = tool.capabilities
  if (!capabilities) return []

  return compactSearchHints([
    capabilities.effectKind,
    capabilities.concurrency,
    capabilities.reason,
    capabilities.filesystem?.read,
    capabilities.filesystem?.write,
    capabilities.process?.execution,
    ...(capabilities.readScopes ?? []),
    ...(capabilities.writeScopes ?? []),
  ])
}

function searchHintsForTool(input: {
  tool: ToolDescriptor
  categoryId: ToolCategoryId
  descriptionParts: Nullable<StructuredToolDescriptionParts>
}): string[] {
  const parts = input.descriptionParts
  return compactSearchHints([
    input.tool.name,
    input.categoryId,
    input.tool.role,
    ...capabilitySearchHints(input.tool),
    ...(input.tool.permissions ?? []),
    parts?.description,
    ...(parts?.suitable ?? []),
    ...(parts?.forbidden ?? []),
    ...(parts?.protocol ?? []),
    ...(parts?.usage ?? []),
    ...(parts?.examples ?? []),
    ...(parts?.notes ?? []),
  ])
}

function riskForTool(tool: ToolDescriptor): ToolSpacePageRisk {
  const permissions = tool.permissions ?? []
  if (permissions.some((permission) => permission.endsWith(':unsafe'))) return 'destructive'
  if (permissions.some((permission) => permission.includes(':exec'))) return 'execute'
  if (permissions.some((permission) => permission.endsWith(':write'))) return 'write'
  if (
    permissions.some((permission) =>
      !permission.endsWith(':read') && !permission.endsWith(':write')
    )
  )
    return 'external'
  if (permissions.some((permission) => permission.endsWith(':read'))) return 'read'
  return 'none'
}

function schemaPolicyForToolAvailability(
  availability: ToolDiscoveryAvailability
): ToolSpaceSchemaPolicy {
  if (availability === 'visible') return 'full'
  return 'preview'
}

function schemaPolicyForPage(kind: ToolSpacePageKind, availability: ToolDiscoveryAvailability) {
  return kind === 'tool' ? schemaPolicyForToolAvailability(availability) : 'none'
}

function isReflectionBlockedTool(tool: ToolDescriptor): boolean {
  return tool.role === 'control' || ReflectionBlockedControlToolNames.has(tool.name)
}

function requiresToolCategoryApproval(
  ctx: ToolSpaceResolverContext,
  categoryId: ToolCategoryId
): boolean {
  return ctx.requiresToolCategoryApproval?.(categoryId) ?? isFunction(ctx.requestToolCategoryAccess)
}

function reason(
  layer: ToolSpaceReason['layer'],
  code: string,
  message: string,
  details?: Record<string, unknown>
): ToolSpaceReason {
  return {
    layer,
    code,
    message,
    details,
  }
}

function reasonForCategoryAccess(
  unavailableReason: Nullable<ToolCategoryUnavailableReason>
): Nullable<ToolSpaceReason> {
  if (!unavailableReason) return null
  return reason(
    'capability',
    unavailableReason,
    'The injected capability policy denied this category in the active scope.'
  )
}

function runtimeUnavailableMessage(toolName: LooseOptional<string>): string {
  return `${toolName ?? 'This tool'} is registered but unavailable in the active capability scope.`
}

function reasonsForTool(input: {
  toolName?: string
  categoryAllowed: boolean
  systemEnabled: boolean
  categoryAccessAllowed: boolean
  categoryUnavailableReason: Nullable<ToolCategoryUnavailableReason>
  visible: boolean
  runtimeAvailable: boolean
  categoryEnabled: boolean
  requiresApproval: boolean
  pluginBacked: boolean
  reflectionBlocked: boolean
  availability: ToolDiscoveryAvailability
}): ToolSpaceReason[] {
  const reasons: ToolSpaceReason[] = []
  if (!input.categoryAllowed) {
    reasons.push(reason('role', 'category_not_allowed', '当前角色或运行配置不允许该工具类别。'))
  }
  if (!input.systemEnabled) {
    reasons.push(reason('system', 'disabled', '该工具已被系统设置禁用。'))
  }
  const categoryAccessReason = reasonForCategoryAccess(input.categoryUnavailableReason)
  if (!input.categoryAccessAllowed && categoryAccessReason) {
    reasons.push(categoryAccessReason)
  }
  if (
    input.categoryAllowed &&
    input.systemEnabled &&
    input.categoryAccessAllowed &&
    !input.runtimeAvailable
  ) {
    reasons.push(reason('runtime', 'unavailable', runtimeUnavailableMessage(input.toolName)))
  }
  if (input.visible) {
    reasons.push(reason('resident', 'visible', '该工具已驻留在本轮 AI SDK tools 中。'))
  } else if (input.availability === 'loadable') {
    reasons.push(reason('resident', 'loadable', '该工具已授权但未驻留，可换入动态工具空间。'))
    if (!input.categoryEnabled && !input.requiresApproval) {
      reasons.push(
        reason('approval', 'preauthorized', '当前运行态允许 tool_replace 直接启用该工具类别。')
      )
    }
  } else if (input.availability === 'requires_approval') {
    reasons.push(reason('approval', 'required', '该工具类别需要先申请启用。'))
  } else if (input.pluginBacked) {
    reasons.push(reason('plugin', 'user_action_required', '该工具类别依赖外部连接器或用户动作。'))
  }
  if (
    input.reflectionBlocked &&
    (input.availability === 'visible' || input.availability === 'loadable')
  ) {
    reasons.push(
      reason(
        'runtime',
        'control_tool',
        '该工具是 control-role 编排/控制工具；可见时直接调用，未驻留时必须先 page-in，不能通过代理或链式嵌套调用。'
      )
    )
  }
  return reasons
}

function reasonsForCapability(input: {
  categoryAllowed: boolean
  categoryAccessAllowed: boolean
  categoryUnavailableReason: Nullable<ToolCategoryUnavailableReason>
  enabled: boolean
  pluginBacked: boolean
  availability: ToolDiscoveryAvailability
  hasRuntimeAvailableTool: boolean
  requiresApproval: boolean
}): ToolSpaceReason[] {
  const reasons: ToolSpaceReason[] = []
  if (!input.categoryAllowed) {
    reasons.push(reason('role', 'category_not_allowed', '当前角色或运行配置不允许该能力。'))
  }
  const categoryAccessReason = reasonForCategoryAccess(input.categoryUnavailableReason)
  if (!input.categoryAccessAllowed && categoryAccessReason) {
    reasons.push(categoryAccessReason)
  }
  if (
    input.categoryAllowed &&
    input.categoryAccessAllowed &&
    !input.enabled &&
    !input.hasRuntimeAvailableTool
  ) {
    reasons.push(reason('runtime', 'no_available_tools', '该能力当前没有运行态可用工具。'))
  }
  if (input.enabled) {
    reasons.push(reason('capability', 'enabled', '该能力已经启用。'))
  } else if (input.availability === 'loadable' && !input.requiresApproval) {
    reasons.push(
      reason('approval', 'preauthorized', '当前运行态允许 tool_replace 直接启用该能力。')
    )
  } else if (input.availability === 'requires_approval') {
    reasons.push(reason('approval', 'required', '该能力需要先申请启用。'))
  } else if (input.pluginBacked) {
    reasons.push(reason('plugin', 'user_action_required', '该能力依赖外部连接器或用户动作。'))
  }
  return reasons
}

function createToolPage(input: {
  tool: ToolDescriptor
  categoryId: ToolCategoryId
  categoryEnabled: boolean
  categoryAllowed: boolean
  categoryAccessAllowed: boolean
  categoryUnavailableReason: Nullable<ToolCategoryUnavailableReason>
  requiresApproval: boolean
  runtimeAvailable: boolean
  visibleToolNames: ReadonlySet<string>
}): ToolSpacePage {
  const descriptionParts = parseStructuredToolDescription(input.tool.description)
  const permissions = input.tool.permissions ?? []
  const visible = input.visibleToolNames.has(input.tool.name)
  const systemEnabled = input.tool.systemEnabled ?? true
  const pluginBacked = isPluginBackedToolCategory(input.categoryId)
  const reflectionBlocked = isReflectionBlockedTool(input.tool)
  const availability = resolveToolDiscoveryAvailability({
    toolName: input.tool.name,
    categoryId: input.categoryId,
    categoryEnabled: input.categoryEnabled,
    categoryAllowed: input.categoryAllowed,
    categoryAccessAllowed: input.categoryAccessAllowed,
    categoryUnavailableReason: input.categoryUnavailableReason,
    requiresApproval: input.requiresApproval,
    pluginBacked,
    hasRuntimeAvailableTool: input.runtimeAvailable,
    systemEnabled,
    visible,
    runtimeAvailable: input.runtimeAvailable,
  })
  const nextAction = nextActionForDiscoveryAvailability(availability)
  const reasons = reasonsForTool({
    toolName: input.tool.name,
    categoryAllowed: input.categoryAllowed,
    systemEnabled,
    categoryAccessAllowed: input.categoryAccessAllowed,
    categoryUnavailableReason: input.categoryUnavailableReason,
    visible,
    runtimeAvailable: input.runtimeAvailable,
    categoryEnabled: input.categoryEnabled,
    requiresApproval: input.requiresApproval,
    pluginBacked,
    reflectionBlocked,
    availability,
  })
  const id = `tool:${input.tool.name}`
  return {
    id,
    kind: 'tool',
    name: input.tool.name,
    categoryId: input.categoryId,
    summary: truncate(
      normalizeDescription(descriptionParts?.description ?? input.tool.description),
      180
    ),
    suitable: descriptionParts?.suitable ?? [],
    forbidden: descriptionParts?.forbidden ?? [],
    aliases: aliasesForTool(input.tool),
    searchHints: searchHintsForTool({
      tool: input.tool,
      categoryId: input.categoryId,
      descriptionParts,
    }),
    permissions: [...permissions],
    risk: riskForTool(input.tool),
    availability,
    toolOsState: toolOsStateForDiscoveryAvailability(availability),
    schemaState: schemaStateForDiscoveryAvailability(availability),
    schemaPolicy: schemaPolicyForPage('tool', availability),
    nextAction,
    resident: visible,
    reflectEligible: isReflectEligibleDiscoveryAvailability(availability) && !reflectionBlocked,
    access: buildToolAccessDecision({
      targetId: id,
      kind: 'tool',
      toolName: input.tool.name,
      categoryId: input.categoryId,
      finalState: availability,
      nextAction,
      categoryAllowed: input.categoryAllowed,
      systemEnabled,
      categoryAccessAllowed: input.categoryAccessAllowed,
      categoryUnavailableReason: input.categoryUnavailableReason,
      visible,
      runtimeAvailable: input.runtimeAvailable,
      categoryEnabled: input.categoryEnabled,
      requiresApproval: input.requiresApproval,
      pluginBacked,
      reasons,
    }),
    reasons,
    description: normalizeDescription(input.tool.description),
  }
}

function createCapabilityPage(input: {
  capabilityPorts?: AgentRuntimeCapabilityPorts
  categoryId: ToolCategoryId
  enabled: boolean
  categoryAllowed: boolean
  categoryAccessAllowed: boolean
  categoryUnavailableReason: Nullable<ToolCategoryUnavailableReason>
  hasRuntimeAvailableTool: boolean
  requiresApproval: boolean
}): ToolSpacePage {
  const definition = resolveCapabilityCategoryDefinitions(input.capabilityPorts)[input.categoryId]
  const pluginBacked = isPluginBackedToolCategory(input.categoryId)
  const availability = resolveCapabilityDiscoveryAvailability({
    categoryId: input.categoryId,
    categoryEnabled: input.enabled,
    categoryAllowed: input.categoryAllowed,
    categoryAccessAllowed: input.categoryAccessAllowed,
    categoryUnavailableReason: input.categoryUnavailableReason,
    requiresApproval: input.requiresApproval,
    pluginBacked,
    hasRuntimeAvailableTool: input.hasRuntimeAvailableTool,
  })
  const nextAction =
    availability === 'visible'
      ? 'describe'
      : availability === 'requires_approval'
        ? 'request_approval'
        : availability === 'requires_user_action'
          ? 'request_user_action'
          : 'none'
  const reasons = reasonsForCapability({
    categoryAllowed: input.categoryAllowed,
    categoryAccessAllowed: input.categoryAccessAllowed,
    categoryUnavailableReason: input.categoryUnavailableReason,
    enabled: input.enabled,
    pluginBacked,
    availability,
    hasRuntimeAvailableTool: input.hasRuntimeAvailableTool,
    requiresApproval: input.requiresApproval,
  })
  const id = `capability:${input.categoryId}`
  return {
    id,
    kind: 'capability',
    name: input.categoryId,
    categoryId: input.categoryId,
    summary: definition?.description ?? input.categoryId,
    suitable: [],
    forbidden: [],
    aliases: [input.categoryId, definition?.label ?? input.categoryId],
    searchHints: compactSearchHints([
      input.categoryId,
      definition?.label,
      definition?.description,
      pluginBacked
        ? 'plugin extension capability feature plugin activation enable plugin turn on extension silent auto load 插件 插件开启 启用插件 激活插件 静默 自动'
        : null,
    ]),
    permissions: [],
    risk: 'none',
    availability,
    toolOsState: toolOsStateForDiscoveryAvailability(availability),
    schemaState: 'not_applicable',
    schemaPolicy: 'none',
    nextAction,
    resident: input.enabled,
    reflectEligible: false,
    access: buildToolAccessDecision({
      targetId: id,
      kind: 'capability',
      categoryId: input.categoryId,
      finalState: availability,
      nextAction,
      categoryAllowed: input.categoryAllowed,
      categoryEnabled: input.enabled,
      categoryAccessAllowed: input.categoryAccessAllowed,
      categoryUnavailableReason: input.categoryUnavailableReason,
      systemEnabled: true,
      pluginBacked,
      visible: input.enabled,
      runtimeAvailable: input.hasRuntimeAvailableTool,
      requiresApproval: input.requiresApproval,
      reasons,
    }),
    reasons,
    description: definition?.description,
  }
}

function isPromptFeatureEffectivelyEnabled(
  enabledFeatures: ReadonlySet<ChatPromptFeatureId>,
  feature: ChatPromptFeatureId
): boolean {
  if (enabledFeatures.has(feature)) return true

  return false
}

function buildPluginEntries(
  features: readonly ChatPromptFeatureId[],
  enabledFeatures: ReadonlySet<ChatPromptFeatureId>,
  includeEnabled: boolean
): PluginEntry[] {
  return normalizePromptFeatures(features)
    .map((feature) => {
      const enabled = isPromptFeatureEffectivelyEnabled(enabledFeatures, feature)
      return {
        id: feature,
        label: feature,
        description: PluginFeatureDescriptions[feature] ?? feature,
        toolCategoryIds: [],
        enabled,
      }
    })
    .filter((entry) => includeEnabled || !entry.enabled)
}

function resolveCatalog(ctx: ToolSpaceResolverContext): ToolCategoryOverview[] {
  return ctx.listToolCategories('catalog')
}

function resolveRuntimeTools(
  ctx: ToolSpaceResolverContext,
  catalog: ToolCategoryOverview[]
): ToolDescriptor[] {
  return (
    ctx.listTools?.('all') ??
    catalog.flatMap((entry) =>
      entry.tools
        .filter((tool) => tool.systemEnabled ?? true)
        .map((tool) => ({
          ...tool,
          categoryId: tool.categoryId ?? entry.category.id,
        }))
    )
  )
}

function resolveCapabilityCategoryAccess(
  _categoryId: ToolCategoryId,
  _input: ToolAccessRuntimeState,
  toolCategoryAccess: ToolCategoryAccessDecision
): ToolCategoryAccessDecision {
  return toolCategoryAccess
}

function schemaPolicyFromCapabilityPage(page: ToolCapabilityPage): ToolSpaceSchemaPolicy {
  if (page.schemaPolicy === 'full' || page.schemaPolicy === 'preview') return page.schemaPolicy
  if (page.schemaPolicy === 'none') return 'none'
  return 'hidden'
}

function buildToolSpacePagesFromCapabilities(pages: ToolCapabilityPage[]): ToolSpacePage[] {
  return pages
    .map((page) => {
      const descriptor = page.descriptor
      const descriptionParts = parseStructuredToolDescription(descriptor.description)
      const runtimeAvailable = page.availability !== 'unavailable'
      const categoryEnabled = page.resident || page.availability === 'loadable'
      return {
        id: page.id,
        kind: 'tool',
        name: page.name,
        categoryId: page.categoryId,
        summary: normalizeDescription(descriptionParts?.description ?? descriptor.description),
        suitable: descriptionParts?.suitable ?? [],
        forbidden: descriptionParts?.forbidden ?? [],
        aliases: aliasesForTool(descriptor),
        searchHints: searchHintsForTool({
          tool: descriptor,
          categoryId: page.categoryId,
          descriptionParts,
        }),
        permissions: page.permissions,
        risk: riskForTool(descriptor),
        availability: page.availability,
        toolOsState: toolOsStateForDiscoveryAvailability(page.availability),
        schemaState: page.schemaState,
        schemaPolicy: schemaPolicyFromCapabilityPage(page),
        nextAction: page.nextAction,
        resident: page.resident,
        reflectEligible: page.reflectEligible && !isReflectionBlockedTool(descriptor),
        access: buildToolAccessDecision({
          targetId: page.id,
          kind: 'tool',
          toolName: page.name,
          categoryId: page.categoryId,
          finalState: page.availability,
          nextAction: page.nextAction,
          categoryAllowed: true,
          categoryEnabled,
          categoryAccessAllowed: page.availability !== 'requires_user_action',
          categoryUnavailableReason: null,
          systemEnabled: true,
          pluginBacked: false,
          visible: page.resident,
          runtimeAvailable,
          requiresApproval: page.availability === 'requires_approval',
          reasons: page.reasons,
        }),
        reasons: page.reasons,
        description: descriptor.description,
      }
    })
}

function buildToolSpacePages(ctx: ToolSpaceResolverContext): ToolSpacePage[] {
  const capabilityPages = ctx.listCapabilityPages?.()
  const visibleToolNames = capabilityPages
    ? new Set<string>()
    : new Set(ctx.getCurrentVisibleToolNames())
  const catalog = resolveCatalog(ctx)
  const runtimeTools = capabilityPages ? [] : resolveRuntimeTools(ctx, catalog)
  const runtimeAvailableTools = new Set(runtimeTools.map((tool) => tool.name))
  const runtimeAvailableCategories = new Set(
    capabilityPages
      ? capabilityPages
          .filter((page) => page.availability !== 'unavailable')
          .map((page) => page.categoryId)
      : runtimeTools.map((tool) => tool.categoryId).filter(isPresent)
  )
  const cards: ToolSpacePage[] = []
  const runtimeState: ToolAccessRuntimeState = {
    roleId: ctx.role?.id ?? 'primary-agent',
    activeCapabilityScope: ctx.codingSession.getActiveCapabilityScope?.(),
    capabilityPorts: ctx.capabilityPorts,
  }
  const isCategoryIsolated = (categoryId: ToolCategoryId): boolean =>
    !decideToolCategoryAccess(categoryId, runtimeState).allowed

  for (const entry of catalog) {
    if (isCategoryIsolated(entry.category.id)) continue

    const access = decideToolCategoryAccess(entry.category.id, runtimeState)
    const capabilityAccess = resolveCapabilityCategoryAccess(
      entry.category.id,
      runtimeState,
      access
    )
    const categoryAllowed = ctx.codingSession.isToolCategoryAllowed?.(entry.category.id) ?? true
    const categoryEnabled = ctx.codingSession.hasToolCategoryAccess(entry.category.id)
    const requiresApproval = requiresToolCategoryApproval(ctx, entry.category.id)
    if (!isEmpty(entry.tools)) {
      cards.push(
        createCapabilityPage({
          capabilityPorts: ctx.capabilityPorts,
          categoryId: entry.category.id,
          enabled: categoryEnabled,
          categoryAllowed,
          categoryAccessAllowed: capabilityAccess.allowed,
          categoryUnavailableReason: capabilityAccess.reason,
          requiresApproval,
          hasRuntimeAvailableTool: runtimeAvailableCategories.has(entry.category.id),
        })
      )
    }
    if (!capabilityPages) {
      for (const tool of entry.tools) {
        cards.push(
          createToolPage({
            tool,
            categoryId: entry.category.id,
            categoryEnabled,
            categoryAllowed,
            categoryAccessAllowed: access.allowed,
            categoryUnavailableReason: access.reason,
            requiresApproval,
            runtimeAvailable: runtimeAvailableTools.has(tool.name),
            visibleToolNames,
          })
        )
      }
    }
  }

  if (capabilityPages) {
    // 并列能力作用域隔离同样适用于 capability 衍生的工具卡：归属其他作用域的分类整类不发卡，
    // 与上面 catalog 能力页 / 下面插件页保持一致，避免跨作用域泄漏工具。
    cards.push(
      ...buildToolSpacePagesFromCapabilities(capabilityPages).filter(
        (card) => !isCategoryIsolated(card.categoryId)
      )
    )
  }

  return cards
}

function buildToolSpaceCategoryFilter(
  categoryIds: readonly ToolCategoryId[]
): Nullable<Set<ToolCategoryId>> {
  if (isEmpty(categoryIds)) return null

  return new Set<ToolCategoryId>(categoryIds)
}

const ToolSpacePageMatchReasonByAvailability: Record<ToolDiscoveryAvailability, string> = {
  visible: '工具页已驻留，可直接调用完整 schema。',
  loadable: '工具页可按需换入；调用前用 tool_replace page-in。',
  requires_approval: '能力尚未启用；需要先通过 tool_replace 请求授权。',
  requires_user_action: '能力依赖外部连接器、资源绑定或其他用户动作。',
  unavailable: '当前运行环境、权限、系统设置或角色边界不可用。',
}

function matchReasonForToolSpacePage(card: ToolSpacePage): string {
  return ToolSpacePageMatchReasonByAvailability[card.availability]
}

function isReflectEligibleToolSpacePage(card: ToolSpacePage): boolean {
  return card.kind === 'tool' && card.reflectEligible
}

export {
  buildPluginEntries,
  buildToolSpaceCategoryFilter,
  buildToolSpacePages,
  buildToolSpacePagesFromCapabilities,
  isPluginBackedToolCategory,
  isPromptFeatureEffectivelyEnabled,
  isReflectEligibleToolSpacePage,
  matchReasonForToolSpacePage,
  PluginBackedToolCategoryIds,
  PluginFeatureDescriptions,
  ToolSpacePageKindValues,
}
export type {
  PluginEntry,
  ToolSpacePage,
  ToolSpacePageKind,
  ToolSpacePageRisk,
  ToolSpaceReason,
  ToolSpaceResolverContext,
  ToolSpaceSchemaPolicy,
}
