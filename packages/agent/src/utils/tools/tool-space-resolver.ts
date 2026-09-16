// 域：工具**能力作用域可见性**解析（哪些能力描述符在当前 scope/policy/runtime profile 下进入调用目录）。
//
// **为什么单独一层**：可见性不是权限（权限在 `./ExecutionPolicy.ts`），而是「模型这一轮能
// 看到什么」。两者刻意分开——看不见 ≠ 没权限；混在一处会让「工具消失」与「工具被拒」这两种
// 故障长得一样，而它们的补救路径相反（换空间 vs 求授权）。
//
// ## 组织
//  - **常驻集**：空间核心工具，不参与换入换出（否则模型每轮先做一次工具发现）；
//  - **分页/换入**：非常驻工具按需进出，页账本防「反复读同一页当进展」；
//  - **类别闸门**：并列作用域按类别隔离，一个作用域看不到另一个作用域的工具族。
//
// ## 关键不变量（改这些会破什么）
//  - **身份走声明、可用性走运行态**：作用域身份由 descriptor 声明决定，宿主资源是否已绑定只影响
//    可用性。历史事故：两者合取 → 资源未绑定时该作用域的工具全隐身，而绑定动作本身又需要那些
//    工具 = 死锁。
//  - **常驻集不为空**：核心工具必须常驻，否则进入空间的第一轮只能靠工具发现，表现为
//    「转好几轮才开始干活」。
//  - **隔离按类别不按名字**：类别是唯一隔离单位；逐名例外会随工具增加而腐坏。
import { isEmpty, isFunction, isPresent, isString, truncate } from '@velaros-ai/core'

import type { AgentRuntimeCapabilityPorts } from '../../contract/requires.js'
import type { ChatPromptFeatureId } from '../../types/agent'
import type { ToolCategoryId, ToolCategoryOverview, ToolDescriptor } from '../../types/agent.js'
import type { StructuredToolDescriptionParts } from '../../types/toolkit.js'
import type { PluginEntry, ToolAccessRuntimeState, ToolCapabilityPage, ToolCategoryAccessDecision, ToolCategoryUnavailableReason, ToolDiscoveryAvailability, ToolSpacePage, ToolSpacePageKind, ToolSpacePageRisk, ToolSpaceReason, ToolSpaceResolverContext, ToolSpaceSchemaPolicy } from '../../types/tools.js'
import { resolveCapabilityCategoryDefinitions } from '../capabilities'
import { parseStructuredToolDescription } from '../toolkit/tool-description'

import { buildToolAccessDecision } from './access-decision'
import { decideToolCategoryAccess } from './access-policy'
import { nextActionForDiscoveryAvailability, resolveCapabilityDiscoveryAvailability, resolveToolDiscoveryAvailability, schemaStateForDiscoveryAvailability, toolOsStateForDiscoveryAvailability } from './discovery-availability'

const ToolSpacePageKindValues = ['tool', 'capability', 'plugin'] as const satisfies readonly ToolSpacePageKind[]
/**
 * 收敛提示特性 id 列表：丢掉空白项并按原值去重，保留首次出现的顺序。
 * 注意判空用的是 `feature.trim()` 但保留的是原串——不改 id 本身，只是不让空白项混进插件条目。
 */
function normalizePromptFeatures(features: readonly ChatPromptFeatureId[]): ChatPromptFeatureId[] {
  return [...new Set(features.filter((feature) => feature.trim()))]
}

const PluginBackedToolCategoryIds = new Set<ToolCategoryId>()
const PluginFeatureDescriptions: Partial<Record<ChatPromptFeatureId, string>> = {}

/**
 * 该工具类别是否由外部插件提供——查 `PluginBackedToolCategoryIds` 登记表，命中为真。
 * 为真的类别不可用时走「需要用户去装/配插件」而不是「此路不通」。该表当前为空（由宿主在运行期填），所以默认一律为假。
 */
function isPluginBackedToolCategory(categoryId: ToolCategoryId): boolean {
  return PluginBackedToolCategoryIds.has(categoryId)
}

/**
 * 把描述文本压成单行：所有连续空白（含换行）折成一个空格，再去首尾空白。
 * 只用于页摘要与检索线索这类要参与截断/比较的短文本；工具页的完整 `description` 另存原文，分节与示例结构不动。
 */
function normalizeDescription(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * 给工具页生成检索别名：工具全名，外加按 `_`/`-` 拆出的各个词段，去重后返回（全名永远排第一）。
 * 模型只记得半个名字（比如只写 `read` 而工具叫 `project_read`）时靠这些词段仍能在 tooling:find 里命中。
 */
function aliasesForTool(tool: ToolDescriptor): string[] {
  const pieces = tool.name
    .split(/[_-]+/)
    .map((piece) => piece.trim())
    .filter(Boolean)
  return [...new Set([tool.name, ...pieces])]
}

/**
 * 把一串可能有空缺的候选文本收成检索线索数组：丢掉非字符串项，逐条折空白归一，再去掉空串并按归一后的值去重，保留首次顺序。
 * 各处线索来源（工具名、类别、权限、描述分节…）形状不一，统一从这里出，保证页表里的 searchHints 干净且不重复。
 */
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

/**
 * 从工具自报的能力契约里抽检索线索：副作用类型、并发性、理由，以及文件系统读写、进程执行、读写作用域清单。
 * 工具没声明 capabilities 时返回空数组。这样模型用「能写文件」「会执行命令」这类说法搜工具也能命中，而不必记住工具名。
 */
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

/**
 * 汇总一个工具页的全部检索线索：工具名、类别 id、角色、能力线索、权限键，
 * 再加上结构化描述解析出的 description / suitable / protocol / usage / examples / notes 各段。
 * 描述没解析成功时那几段自然缺席，不影响前面的线索；整体经 compactSearchHints 归一去重。
 */
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
    ...(parts?.protocol ?? []),
    ...(parts?.usage ?? []),
    ...(parts?.examples ?? []),
    ...(parts?.notes ?? []),
  ])
}

/**
 * 给工具页定风险档。优先级：权限里带 `:unsafe` 直接判 `destructive`；
 * 其次认工具自报的 `capabilities.effectKind`（destructive/execute/write/external/read，大小写与空白不敏感）；
 * 都没有才退到按权限键猜——含 `:exec` → execute，`:write` 结尾 → write，既非 read 也非 write 的权限 → external，`:read` 结尾 → read，全无权限 → none。
 * 先信 effectKind 是关键：只看权限会把「不需要宿主授权但真有副作用」的工具错标成 risk:none（见函数体内注释）。
 */
function riskForTool(tool: ToolDescriptor): ToolSpacePageRisk {
  const permissions = tool.permissions ?? []
  if (permissions.some((permission) => permission.endsWith(':unsafe'))) return 'destructive'

  // capabilities.effectKind 是工具 owner 声明的正式副作用契约；permissions 只是宿主授权键。
  // 只看 permissions 会把无需宿主权限、但真实有副作用的工具错标成 risk:none。
  // 本层只解释通用副作用词汇；具体产品域 effect 仍由能力 owner 保持不透明。
  switch (tool.capabilities?.effectKind.trim().toLowerCase()) {
    case 'destructive':
      return 'destructive'
    case 'execute':
      return 'execute'
    case 'write':
      return 'write'
    case 'external':
      return 'external'
    case 'read':
      return 'read'
    default:
      break
  }

  if (permissions.some((permission) => permission.includes(':exec'))) return 'execute'
  if (permissions.some((permission) => permission.endsWith(':write'))) return 'write'
  if (
    permissions.some(
      (permission) => !permission.endsWith(':read') && !permission.endsWith(':write')
    )
  )
    return 'external'
  if (permissions.some((permission) => permission.endsWith(':read'))) return 'read'
  return 'none'
}

/**
 * 工具页给模型看多少入参契约：只有已驻留（`visible`）给 `full`，其余档位一律 `preview`。
 * 没驻留的工具只给摘要，真 schema 等 page-in 之后那一轮再给——省上下文，也逼模型先换页再调用。
 */
function schemaPolicyForToolAvailability(
  availability: ToolDiscoveryAvailability
): ToolSpaceSchemaPolicy {
  if (availability === 'visible') return 'full'
  return 'preview'
}

/**
 * 按页类型决定 schema 展示策略：只有 `tool` 页按可用性给 full/preview，capability 与 plugin 页恒为 `none`。
 * 后两类页表示的是一族能力而不是某个可调用的工具，压根没有单一入参契约可展示。
 */
function schemaPolicyForPage(kind: ToolSpacePageKind, availability: ToolDiscoveryAvailability) {
  return kind === 'tool' ? schemaPolicyForToolAvailability(availability) : 'none'
}

/**
 * 启用这个工具类别要不要先申请授权：上下文给了 `requiresToolCategoryApproval` 就听它的，
 * 否则按「宿主是否实现了 `requestToolCategoryAccess`」推断——有申请通道就意味着要走审批，没有就当预授权（模型可直接 tooling:replace 换入）。
 */
function requiresToolCategoryApproval(
  ctx: ToolSpaceResolverContext,
  categoryId: ToolCategoryId
): boolean {
  return ctx.requiresToolCategoryApproval?.(categoryId) ?? isFunction(ctx.requestToolCategoryAccess)
}

/**
 * 造一条 `ToolSpaceReason`（层位 + 机器码 + 给模型看的人话 + 可选细节）的字面量构造器。
 * 不校验不去重，只保证本文件各处生成的理由形状一致；`details` 不传即为 undefined。
 */
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

/**
 * 把作用域策略的类别拒因包成 `capability` 层的一条理由；没有拒因（放行或无策略）返回 null。
 * 机器码原样沿用策略给的拒因串不翻译，上层可按码分支处理。
 */
function reasonForCategoryAccess(
  unavailableReason: Nullable<ToolCategoryUnavailableReason>
): Nullable<ToolSpaceReason> {
  if (!unavailableReason) return null
  return reason(
    'capability',
    unavailableReason,
    '注入的能力策略在当前作用域里拒绝了这个类别。'
  )
}

/**
 * 拼「工具注册了但当前作用域里跑不了」的说明文案；工具名缺席时用「这个工具」兜底，保证句子完整。
 */
function runtimeUnavailableMessage(toolName: LooseOptional<string>): string {
  return `${toolName ?? '这个工具'} 已经注册，但当前能力范围里用不了。`
}

/**
 * 为一张工具页汇总「为什么是这个状态」的理由清单，按 role → system → capability → runtime → 驻留/审批/插件 的层序追加。
 * runtime 那条只在前三层都通过时才记——否则「角色不给用」和「跑不了」会一起冒出来，模型分不清该换空间还是该求授权。
 * 末段按驻留情况四选一：已驻留记 `resident/visible`；`loadable` 记 `resident/loadable`，且类别未启用又不需要审批时再补一条 `approval/preauthorized` 明说可直接 tooling:replace；
 * `requires_approval` 记 `approval/required`；否则插件类工具记 `plugin/user_action_required`。
 * 这份清单会随工具页进模型上下文，顺序即模型读到的顺序。
 */
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
        reason('approval', 'preauthorized', '当前运行态允许 tooling:replace 直接启用该工具类别。')
      )
    }
  } else if (input.availability === 'requires_approval') {
    reasons.push(reason('approval', 'required', '该工具类别需要先申请启用。'))
  } else if (input.pluginBacked) {
    reasons.push(reason('plugin', 'user_action_required', '该工具类别依赖外部连接器或用户动作。'))
  }
  return reasons
}

/**
 * 为一张能力（工具类别）页汇总理由清单，层序同工具页但少了 system 与 resident 两层。
 * `runtime/no_available_tools` 只在角色与作用域都放行、能力又没启用、且类别下一个运行态可用工具都没有时才记。
 * 末段四选一：已启用记 `capability/enabled`；`loadable` 且不需审批记 `approval/preauthorized`（明说可直接 tooling:replace 启用）；
 * `requires_approval` 记 `approval/required`；否则插件类记 `plugin/user_action_required`。
 */
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
      reason('approval', 'preauthorized', '当前运行态允许 tooling:replace 直接启用该能力。')
    )
  } else if (input.availability === 'requires_approval') {
    reasons.push(reason('approval', 'required', '该能力需要先申请启用。'))
  } else if (input.pluginBacked) {
    reasons.push(reason('plugin', 'user_action_required', '该能力依赖外部连接器或用户动作。'))
  }
  return reasons
}

/**
 * 把一个工具描述符做成 tool_map 里的工具页（id 形如 `tool:<name>`）：解析结构化描述、算出可用性档位、下一步动作、
 * 理由清单与七闸判定，并附别名、检索线索、权限、风险档与 schema 策略。
 * `systemEnabled` 缺省视为开着；驻留与否看这个工具名在不在本轮 visibleToolNames 里。
 * 摘要（summary）走归一化并截到 180 字符，但 `description` 保留去掉首尾空白的完整原文——分节与示例结构是模型正确调用的依据，不能被摘要挤掉。
 */
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
    // 保留完整描述的分节与示例结构；摘要字段单独归一化。
    description: input.tool.description.trim(),
    usageSkillId: input.tool.usageSkillId,
  }
}

/**
 * 把一个工具类别做成 tool_map 里的能力页（id 形如 `capability:<categoryId>`）：取类别定义的 label/description 当摘要与别名，
 * 算可用性档位、理由清单与七闸判定。类别定义缺席时摘要退回类别 id 本身，页照发不误。
 * 下一步动作与工具页不同：能力页 visible 时给 `describe` 而不是 `call_tool`（能力本身不可调用，得先看它下面有什么工具）。
 * 插件类别额外塞一串中英文插件关键词进检索线索，让模型用「启用插件」「激活」这类说法也能搜到这张页。
 * schema 相关一律 `not_applicable` / `none`；`resident` 就等于类别是否已启用。
 */
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

/**
 * 某个提示特性此刻是否算启用——当前判定就是「在已启用集合里」，没有派生或继承规则。
 * 单列成函数是为了给这条判定留一个唯一改点：将来要加「被别的特性隐含开启」之类的规则，只动这里。
 */
function isPromptFeatureEffectivelyEnabled(
  enabledFeatures: ReadonlySet<ChatPromptFeatureId>,
  feature: ChatPromptFeatureId
): boolean {
  return enabledFeatures.has(feature)
}

/**
 * 把提示特性列表摊成插件条目：先去空去重，逐条标出是否已启用，描述取 `PluginFeatureDescriptions` 登记的文案、没登记就用 id 顶上。
 * `includeEnabled` 为假时只留未启用的条目（给「还能开什么」这类清单用）；为真则全留。
 * 这里不填 `toolCategoryIds`（恒为空数组）——特性与工具类别的对应关系不在这一层维护。
 */
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

/**
 * 取本次解析用的工具目录——按 `'catalog'` 口径列类别（是「系统里登记了什么」的全集，不是「本轮能用什么」）。
 * 可用性、驻留与否都在后面按运行态另算，这一层只负责把候选摆全，免得工具因为当前用不了就整个从页表里消失。
 */
function resolveCatalog(ctx: ToolSpaceResolverContext): ToolCategoryOverview[] {
  return ctx.listToolCategories('catalog')
}

/**
 * 列出运行时真有实现的工具：宿主提供了 `listTools` 就用它的 `'all'` 口径，否则退而从目录摊平，
 * 只留 `systemEnabled` 未被显式关掉的工具，并给每个工具补上 `categoryId`（自身没带就继承所在类别）。
 * 这份集合决定页表里哪些工具算 runtimeAvailable——注册存在但运行时没有的工具会留在页表里、但不会显示成可加载。
 */
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

/**
 * 能力页用的类别准入裁决——当前直接原样返回工具页那份裁决，能力页与工具页共用同一份结论。
 * 保留这个接缝（连同两个未使用的形参）是为了将来能力页要单独放宽/收紧时只改这一处，不必回头拆调用点。
 */
function resolveCapabilityCategoryAccess(
  _categoryId: ToolCategoryId,
  _input: ToolAccessRuntimeState,
  toolCategoryAccess: ToolCategoryAccessDecision
): ToolCategoryAccessDecision {
  return toolCategoryAccess
}

/**
 * 把宿主能力页自报的 schema 策略收敛成本层的取值：`full`/`preview`/`none` 原样沿用，其余一律降级为 `hidden`。
 * 默认往严的一侧收——认不出的策略值宁可不给模型看 schema，也不要误暴露一份可能对不上的入参契约。
 */
function schemaPolicyFromCapabilityPage(page: ToolCapabilityPage): ToolSpaceSchemaPolicy {
  if (page.schemaPolicy === 'full' || page.schemaPolicy === 'preview') return page.schemaPolicy
  if (page.schemaPolicy === 'none') return 'none'
  return 'hidden'
}

/**
 * 宿主已经自己算好能力页时，把它们逐张翻成本层的工具页（kind 一律 `tool`）：可用性、下一步动作、驻留状态、理由清单全部沿用宿主的结论，
 * 本层只补描述解析、别名、检索线索、风险档与七闸判定。
 * 派生规则：`runtimeAvailable = availability !== 'unavailable'`，`categoryEnabled = resident || availability === 'loadable'`，
 * `categoryAccessAllowed = availability !== 'requires_user_action'`——宿主口径下没有单独的类别拒因，故 `categoryUnavailableReason` 恒为 null。
 */
function buildToolSpacePagesFromCapabilities(pages: ToolCapabilityPage[]): ToolSpacePage[] {
  return pages.map((page) => {
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
      usageSkillId: descriptor.usageSkillId,
    }
  })
}

/**
 * 解析出本轮 tool_map 的全部页卡，是本文件的总入口。
 * 两条路：宿主实现了 `listCapabilityPages` 就以它为准（工具卡由 buildToolSpacePagesFromCapabilities 翻译，且只给出现在能力页里的类别发能力卡，
 * 免得留下 toolNames 为空的幽灵分类）；没实现则退回从 catalog + 运行态工具自行拼页。
 * 作用域隔离在最外层做：`decideToolCategoryAccess` 拒掉的类别整类不发卡（catalog 分支、能力衍生卡都一样），保证一个作用域看不到另一个作用域的工具族。
 * 类别只有在有工具时才发能力卡；空类别不发。角色 id 缺省按 `'primary-agent'` 记。
 */
function buildToolSpacePages(ctx: ToolSpaceResolverContext): ToolSpacePage[] {
  const capabilityPages = ctx.listCapabilityPages?.()
  const capabilityPageCategoryIds = capabilityPages
    ? new Set(capabilityPages.map((page) => page.categoryId))
    : null
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
    // 宿主提供 capability 页时，它已经按当前角色/模型输入能力裁过工具。分类页必须跟同一份
    // 裁决走；否则 catalog 里有工具、当前角色却一个都看不到时会留下 toolNames=[] 的幽灵分类。
    if (
      !isEmpty(entry.tools) &&
      (!capabilityPageCategoryIds || capabilityPageCategoryIds.has(entry.category.id))
    ) {
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

/**
 * 把「只看这几个类别」的筛选条件做成 Set；给的是空列表则返回 null，表示不筛（而不是「一个都不要」）。
 * 调用方靠 null 与空集的区别决定是全量展示还是按集合过滤，别把两者混为一谈。
 */
function buildToolSpaceCategoryFilter(
  categoryIds: readonly ToolCategoryId[]
): Nullable<Set<ToolCategoryId>> {
  if (isEmpty(categoryIds)) return null

  return new Set<ToolCategoryId>(categoryIds)
}

const ToolSpacePageMatchReasonByAvailability: Record<ToolDiscoveryAvailability, string> = {
  visible: '工具页已驻留，可直接调用完整 schema。',
  loadable: '工具页可按需换入；调用前用 tooling:replace page-in。',
  requires_approval: '能力尚未启用；需要先通过 tooling:replace 请求授权。',
  requires_user_action: '能力依赖外部连接器、资源绑定或其他用户动作。',
  unavailable: '当前运行环境、权限、系统设置或角色边界不可用。',
}

/**
 * 给搜索命中的页卡配一句「这张页现在能拿它怎么办」的说明，按可用性档位查固定文案表（五档全覆盖，不会取空）。
 * 这句直接进模型上下文，写的是行动指引而非状态名——搜到 loadable 的页要先 tooling:replace 换入，搜到 unavailable 的别再原地重试。
 */
function matchReasonForToolSpacePage(card: ToolSpacePage): string {
  return ToolSpacePageMatchReasonByAvailability[card.availability]
}

export {
  buildPluginEntries,
  buildToolSpaceCategoryFilter,
  buildToolSpacePages,
  buildToolSpacePagesFromCapabilities,
  isPluginBackedToolCategory,
  isPromptFeatureEffectivelyEnabled,
  matchReasonForToolSpacePage,
  PluginBackedToolCategoryIds,
  PluginFeatureDescriptions,
  ToolSpacePageKindValues,
}
