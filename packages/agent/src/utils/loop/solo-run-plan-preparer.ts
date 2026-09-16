
import { isEmpty, toNullable } from '@velaros-ai/core'

import type { AgentRuntimeCapabilityPorts } from '../../contract/requires.js'
import type {
  AgentContextPhase,
  ChatPromptFeatureId,
  ExecutionModeId,
} from '../../types/agent'
import type { AgentModelInputModality, RunProfileId, RunProfileSelectionId, ToolCategoryId, ToolDescriptor } from '../../types/agent.js'
import type { BuildAgentRunPlanInput,PrepareSoloRunPlanForTurnInput, PrepareSoloRunPlanForTurnResult, SoloRunPlanToolCategory, SoloRunPlanToolContext, SoloTurnPlanningSnapshot } from '../../types/loop.js'
import type { PromptStatePreparedToolCategories } from '../../types/runner.js'
import type { SessionToolAllocatorPlan } from '../../types/tools.js'
import { resolveToolAllocationMetadata } from '../capabilities'
import { createInternalFollowUpMessage } from '../history/internal-messages'
import { compareStableStrings } from '../residency/determinism'
import {
  isExecutionModeActive,
  resolveExecutionModes,
} from '../runner/execution-mode-registry'
import {
  resolveRunProfilePolicyForRuntime,
  resolveRunProfileWorkingSetContextWindow,
  RunProfileDefinitions,
} from '../runner/runtime-profiles'

import { buildAgentRunPlan } from './agent-run-planner'
import { extractLatestUserTextFromMessages, isLowSignalIntentText } from './intent-signals'
import { resolveSoloLoopTools } from './loop-runtime'

const PlanModeRequiredToolNames = ['plan:update', 'interaction:show_action_cards'] as const
const GoalModeRequiredToolNames = ['goal:get', 'goal:create', 'goal:update'] as const
const BootstrapSharedToolNames = [
  'tooling:map',
  'plan:update',
  'interaction:ask_user',
  'interaction:show_action_cards',
] as const
/**
 * 按本轮上下文档位削工具面：`operational` 原样全放；非 operational（即全新交互任务的第一次请求）
 * 只留 `BootstrapSharedToolNames` 与能力端口声明的 baseline 工具，其余全部滤掉。
 * 被削掉的工具这一轮模型看不见，但下一轮档位一定回到 operational 就全回来——这是省首轮 schema 开销，
 * 不是禁用；所以任何"必须能调到"的工具都得同时进 `resolvePromptFeatureProtectedToolNames`。
 */
function filterToolsForContextPhase(input: {
  tools: readonly string[]
  contextPhase: AgentContextPhase
  capabilityPorts?: AgentRuntimeCapabilityPorts
}): string[] {
  if (input.contextPhase === 'operational') return [...input.tools]

  const bootstrapTools = new Set<string>([
    ...BootstrapSharedToolNames,
    ...(resolveToolAllocationMetadata(input.capabilityPorts).baselineToolNames ?? []),
  ])
  return input.tools.filter((toolName) => bootstrapTools.has(toolName))
}
/**
 * 技能工具门控（allowed-tools）轮次仍保留的交互必备工具：读技能正文/资源、追问与确认卡、
 * 上下文自理。声明集之外全部收掉——显式选中即用户对工具面的明确授权边界。
 */
const SkillGateAlwaysKeptToolNames = new Set<string>([
  'tooling:read',
  'interaction:ask_user',
  'interaction:show_action_cards',
  'context:recall',
  'context:handoff',
])

/**
 * 把多份类别清单（运行时那份 + catalog 那份）按类别 id 并成一张目录：同 id 只认第一次出现的类别元数据
 * 与 enabled 态，工具按 name 去重后按出现顺序追加。
 * 后来者只补工具、不覆盖已有条目，所以运行时的真实启用态不会被 catalog 里的静态声明冲掉。
 */
function mergeToolCategoryCatalog(
  categories: ReadonlyArray<SoloRunPlanToolCategory<ToolDescriptor>>
): Array<SoloRunPlanToolCategory<ToolDescriptor>> {
  const merged = new Map<ToolCategoryId, SoloRunPlanToolCategory<ToolDescriptor>>()
  const seenToolsByCategory = new Map<ToolCategoryId, Set<string>>()

  for (const entry of categories) {
    const existing = merged.get(entry.category.id)
    if (!existing) {
      merged.set(entry.category.id, {
        category: entry.category,
        enabled: entry.enabled,
        tools: [],
      })
      seenToolsByCategory.set(entry.category.id, new Set())
    }

    const target = merged.get(entry.category.id)
    const seenTools = seenToolsByCategory.get(entry.category.id)
    if (!target || !seenTools) continue
    for (const tool of entry.tools) {
      if (seenTools.has(tool.name)) continue
      seenTools.add(tool.name)
      target.tools.push(tool)
    }
  }

  return [...merged.values()]
}

/**
 * 把一串字符串去空白、去空、去重后按字典序排好。只服务于规划快照指纹：
 * 同一份配置换个枚举顺序不能算「变了」，否则指纹每轮都不同，跨轮缓存永远命不中。
 */
function sortedStrings(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))].sort()
}

/**
 * 按 `isAllowed` 过出当前会话许可的类别 id，保持入参顺序。
 * 这批 id 是交给工具分配器的「可申请范围」，只说明允许换入，不等于本轮已启用。
 */
function collectAllowedToolCategoryIds(
  categories: ReadonlyArray<SoloRunPlanToolCategory<ToolDescriptor>>,
  isAllowed: (categoryId: ToolCategoryId) => boolean
): ToolCategoryId[] {
  const categoryIds: ToolCategoryId[] = []

  for (const entry of categories) {
    if (isAllowed(entry.category.id)) {
      categoryIds.push(entry.category.id)
    }
  }

  return categoryIds
}

/**
 * 把若干类别里的工具名平铺成一串（不去重、保持顺序），作为 `resolveSoloLoopTools` 的「已启用工具」入参，
 * 最终定出要估算 schema 字符数的候选集。
 */
function collectToolNamesFromCategories(
  categories: ReadonlyArray<SoloRunPlanToolCategory<ToolDescriptor>>
): string[] {
  const toolNames: string[] = []

  for (const entry of categories) {
    for (const tool of entry.tools) {
      toolNames.push(tool.name)
    }
  }

  return toolNames
}

/**
 * 汇出这一轮「预算裁剪不许砍」的工具名：会话自己的豁免名单，加上显式选中的技能所声明的工具，
 * 加上非 operational 档位下的 `BootstrapSharedToolNames`，再按激活的执行模式补上该模式的命脉工具
 * （plan 模式的 `plan:update` 与 `interaction:show_action_cards`，goal 模式的三个 `goal:*`）。
 *
 * 不保这些工具的后果是实打实的：工具面一旦被 schema 预算削到它们，模式自己就再也收不了尾——
 * 目标模式调不到 `goal:update`，收尾门会永远判目标未收束，直到连拦三次熔断。
 */
function resolvePromptFeatureProtectedToolNames(input: {
  executionModes: readonly ExecutionModeId[]
  contextPhase: AgentContextPhase
  budgetOverrideToolNames: readonly string[]
  selectedSkillToolNames?: LooseOptional<readonly string[]>
}): string[] {
  const toolNames = new Set(input.budgetOverrideToolNames)

  for (const toolName of input.selectedSkillToolNames ?? []) {
    toolNames.add(toolName)
  }

  if (input.contextPhase !== 'operational') {
    for (const toolName of BootstrapSharedToolNames) {
      toolNames.add(toolName)
    }
  }

  if (isExecutionModeActive('plan', input.executionModes)) {
    for (const toolName of PlanModeRequiredToolNames) {
      toolNames.add(toolName)
    }
  }
  if (isExecutionModeActive('goal', input.executionModes)) {
    for (const toolName of GoalModeRequiredToolNames) {
      toolNames.add(toolName)
    }
  }

  return [...toolNames]
}

/**
 * 从全量运行时类别里挑出本轮实际启用的那些，同时把它们的工具描述符平铺出来。
 * 两份产物一次遍历得出：类别列表进提示词渲染，描述符进执行器。
 */
function collectEnabledRuntimeCategoryArtifacts(
  categories: ReadonlyArray<SoloRunPlanToolCategory<ToolDescriptor>>,
  enabledCategoryIds: readonly ToolCategoryId[]
): {
  enabledToolDescriptors: ToolDescriptor[]
  enabledToolCategories: Array<SoloRunPlanToolCategory<ToolDescriptor>>
} {
  const enabledCategorySet = new Set(enabledCategoryIds)
  const enabledToolDescriptors: ToolDescriptor[] = []
  const enabledToolCategories: Array<SoloRunPlanToolCategory<ToolDescriptor>> = []

  for (const entry of categories) {
    if (!enabledCategorySet.has(entry.category.id)) {
      continue
    }
    enabledToolCategories.push(entry)
    for (const tool of entry.tools) {
      enabledToolDescriptors.push(tool)
    }
  }

  return { enabledToolDescriptors, enabledToolCategories }
}

/**
 * 滤掉本轮所选具体模型吃不下其结果的工具：工具声明的 `requiredModelInputModalities` 必须被模型支持的
 * 模态全覆盖，否则从所在类别里摘除；摘空了的类别整个不再出现在结果里。
 * 挡的是「截图工具返回图片、而这个模型只收文本」这类一调用就废的暴露——与其让模型调完拿不到结果，
 * 不如一开始就别给它看见。
 */
function filterToolCategoriesForModelInputs(
  categories: ReadonlyArray<SoloRunPlanToolCategory<ToolDescriptor>>,
  supportedInputModalities: readonly AgentModelInputModality[]
): Array<SoloRunPlanToolCategory<ToolDescriptor>> {
  const supported = new Set(supportedInputModalities)
  return categories.flatMap((entry) => {
    const tools = entry.tools.filter((tool) =>
      (tool.requiredModelInputModalities ?? []).every((modality) => supported.has(modality))
    )
    return !isEmpty(tools) ? [{ ...entry, tools }] : []
  })
}

/**
 * 把类别压成 `{ id, toolCount }` 的摘要供遥测记录：同名工具算一个、无名的不计，
 * 最后按 id 的码元序（`compareStableStrings`）排好。排序是为了让同一份工具面在不同机器、不同轮次
 * 产出逐字节一致的摘要，否则遥测里每轮都像"类别变了"。
 */
function toolCategorySummary(
  categories: ReadonlyArray<SoloRunPlanToolCategory<ToolDescriptor>>
): Array<{ id: ToolCategoryId; toolCount: number }> {
  const summary: Array<{ id: ToolCategoryId; toolCount: number }> = []

  for (const entry of categories) {
    const toolNames = new Set<string>()
    for (const tool of entry.tools) {
      if (tool.name) {
        toolNames.add(tool.name)
      }
    }
    summary.push({
      id: entry.category.id,
      toolCount: toolNames.size,
    })
  }

  return summary.sort((left, right) => compareStableStrings(left.id, right.id))
}

/**
 * 把一张 `名字 → 数值` 的表求和，其中负值按 0 计，整张表缺席按 0。
 * 用来把每个工具的 schema 字符数加成本轮总量；负值一律不抵扣，免得某个估算器给出负数把总量做低。
 */
function sumPositiveRecordValues(values: LooseOptional<Readonly<Record<string, number>>>): number {
  return Object.values(values ?? {}).reduce((sum, value) => sum + Math.max(0, value), 0)
}

/**
 * 把（可能很长的）规划快照指纹压成定长短串 `turn-plan:fnv1a32:xxxxxxxx`（FNV-1a 32 位）。
 * 只进遥测、用来在日志里对比「这两轮是不是同一份规划」；缓存命中判定用的始终是原始指纹串，
 * 所以这里即便哈希碰撞也不会让两轮规划互相串用。
 */
function buildTurnPlanningTelemetrySignature(signature: string): string {
  let hash = 0x811c9dc5

  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }

  return `turn-plan:fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

/**
 * 把「决定本轮工具面长什么样」的全部输入序列化成一个指纹串，作为回合规划快照的缓存键：能力表修订号、
 * provider / 模型 / 窗口 / 输入模态、请求档与实际 run profile、角色与配置工具、当前可见工具、
 * 已启用与豁免的类别和工具、promptFeatures、执行模式、上下文档位。
 *
 * 清单类字段一律过 `sortedStrings` 去重排序，让枚举顺序的抖动不至于打穿缓存；
 * 但凡有一项真的变了指纹就变，上一轮那份类别枚举与 schema 估算全部作废重算（这两件事正是规划里最贵的）。
 */
function buildTurnPlanningSnapshotSignature(input: {
  capabilityRevision?: string | number
  providerId: string
  model: string
  contextWindow: number
  supportedInputModalities: readonly AgentModelInputModality[]
  requestedRunProfile: RunProfileSelectionId
  runProfile: RunProfileId
  roleAllowedTools: readonly string[]
  configuredTools?: readonly string[]
  currentVisibleToolNames: readonly string[]
  enabledToolCategoryIds: readonly ToolCategoryId[]
  budgetOverrideToolCategoryIds: readonly ToolCategoryId[]
  budgetOverrideToolNames: readonly string[]
  promptFeatures?: readonly ChatPromptFeatureId[]
  executionModes: readonly ExecutionModeId[]
  contextPhase: AgentContextPhase
}): string {
  return JSON.stringify({
    capabilityRevision: toNullable(input.capabilityRevision),
    providerId: input.providerId,
    model: input.model,
    contextWindow: input.contextWindow,
    supportedInputModalities: sortedStrings(input.supportedInputModalities),
    requestedRunProfile: input.requestedRunProfile,
    runProfile: input.runProfile,
    configuredTools: sortedStrings(input.configuredTools ?? []),
    roleAllowedTools: sortedStrings(input.roleAllowedTools),
    currentVisibleToolNames: sortedStrings(input.currentVisibleToolNames),
    enabledToolCategoryIds: sortedStrings(input.enabledToolCategoryIds),
    budgetOverrideToolCategoryIds: sortedStrings(input.budgetOverrideToolCategoryIds),
    budgetOverrideToolNames: sortedStrings(input.budgetOverrideToolNames),
    promptFeatures: sortedStrings(input.promptFeatures ?? []),
    executionModes: [...input.executionModes],
    contextPhase: input.contextPhase,
  })
}

/**
 * 每一轮发模型之前的总装配，产出这一轮的工具面、上下文分区与提示词预算。
 * 流程：定 run profile 与可用上下文窗口 → 清掉过期的工具租约、把思考深度与 tool surface 档写回会话 →
 * 枚举工具类别（先按模型输入模态滤一遍）→ 必要时跑工具分配器换入类别/工具 → 交给 `buildAgentRunPlan`
 * 算出运行计划 → 把 before-model 的内部提醒压进 history，最后记一条规划遥测。
 *
 * 几处不显然的取舍：
 * - 类别枚举与 schema 估算是规划里最贵的两件事，所以按 `buildTurnPlanningSnapshotSignature` 的指纹做
 *   跨轮缓存；但只要本轮有工具分配器请求就既不复用也不写回——换入结果必须当场生效，缓存会把它盖掉。
 * - 工具分配器只在 operational 档、且「有显式请求」或「用户这句话确有意图」时才跑；打招呼、说"继续"
 *   这类低信号轮次直接跳过，不白烧一次分配。
 * - 技能门（`skillAllowedToolNames`）之外的工具会被收掉，只留 `SkillGateAlwaysKeptToolNames` 那几个
 *   交互必备的——显式选中技能即用户对工具面划定的授权边界。
 * - 强制工具选择只有在它确实还在本轮 allowedTools 里时才作数，否则退化成不强制：逼模型去调一个它
 *   根本看不见的工具，只会白费一轮。
 */
async function prepareSoloRunPlanForTurn<TContext extends SoloRunPlanToolContext>(
  input: PrepareSoloRunPlanForTurnInput<TContext>
): Promise<PrepareSoloRunPlanForTurnResult> {
  const requestedRunProfile = input.toolContext.codingSession.getRunProfile()
  const resolvedRunProfile =
    input.roleRuntime.runProfilePolicy ??
    resolveRunProfilePolicyForRuntime({
      requested: requestedRunProfile,
      contextWindow: input.roleRuntime.contextWindow,
      model: input.roleRuntime.model,
    })
  const runProfile = resolvedRunProfile.profile
  const runProfileDefinition = RunProfileDefinitions[runProfile]
  const physicalContextWindow = input.roleRuntime.contextWindow ?? resolvedRunProfile.contextWindow
  const effectiveContextWindow = resolveRunProfileWorkingSetContextWindow({
    physicalContextWindow,
    profile: runProfile,
  })
  const planningStartedAt = Date.now()
  const expiredToolNameLeases =
    input.toolContext.codingSession.pruneExpiredToolNameLeases?.(input.turn) ?? []
  input.toolContext.codingSession.pruneExpiredToolCategoryLeases?.(input.turn)
  // 思考深度单源：写入调用方算定的那一个值，档位在这一层不再参与。
  //
  // 这里曾经是每轮无条件 `setThinkingDepth(档位默认)`（2026-08-06 改）：主会话第一轮就把用户在
  // composer/设置里选的力度打回档位默认，而档位本身由模型窗口自动推（<192K→fast、≥1M→deep），
  // 于是「换一个大窗口模型」= 主会话被静默切到 deep，用户没有任何入口关掉；反过来把默认调成
  // 快速省钱的用户，子 agent 与辅助任务照办、主会话不办。被覆盖的值有真实后果
  // （`coding/AutoVerification.ts` 的 runtime reminder 抑制只看 fast）。
  input.toolContext.codingSession.setThinkingDepth?.(input.thinkingDepth)
  input.toolContext.codingSession.setToolSurfaceProfile?.(
    runProfileDefinition.defaults.toolSurfaceProfile,
    `run profile ${runProfile}`
  )
  if (!isEmpty(runProfileDefinition.automaticToolCategories)) {
    input.toolContext.codingSession.enableToolCategories(
      [...runProfileDefinition.automaticToolCategories],
      `run profile ${runProfile}`
    )
  }
  input.toolContext.setCurrentVisibleToolNames([])

  const toolAllocatorRequests = input.toolAllocatorRequests
    ? [...input.toolAllocatorRequests]
    : (input.toolContext.codingSession.drainToolAllocatorRequests?.() ?? [])
  const latestUserText = extractLatestUserTextFromMessages(input.history) ?? ''
  const toolAllocator = input.toolAllocator
  const shouldRunToolAllocator =
    input.contextPhase === 'operational' &&
    !!toolAllocator &&
    (!isEmpty(toolAllocatorRequests) || !isLowSignalIntentText(latestUserText))
  const currentVisibleToolNames = input.toolContext.getCurrentVisibleToolNames()
  const enabledToolCategoryIds = input.toolContext.codingSession.getEnabledToolCategories()
  const budgetOverrideToolCategoryIds =
    input.toolContext.codingSession.getBudgetOverrideToolCategories()
  const activeExecutionModes = resolveExecutionModes(input)
  const budgetOverrideToolNames = resolvePromptFeatureProtectedToolNames({
    executionModes: activeExecutionModes,
    contextPhase: input.contextPhase,
    budgetOverrideToolNames: input.toolContext.codingSession.getBudgetOverrideToolNames(),
    selectedSkillToolNames: input.skillAllowedToolNames,
  })
  const effectiveConfiguredTools = input.configuredTools ? [...input.configuredTools] : undefined
  const effectiveRoleAllowedTools = [...input.roleAllowedTools]
  const planningSnapshotSignature = buildTurnPlanningSnapshotSignature({
    capabilityRevision: input.toolRegistry.getCapabilityRevision?.(),
    providerId: input.roleRuntime.providerId,
    model: input.roleRuntime.model,
    contextWindow: effectiveContextWindow,
    supportedInputModalities: input.roleRuntime.supportedInputModalities,
    requestedRunProfile,
    runProfile,
    configuredTools: effectiveConfiguredTools,
    roleAllowedTools: effectiveRoleAllowedTools,
    currentVisibleToolNames,
    enabledToolCategoryIds,
    budgetOverrideToolCategoryIds,
    budgetOverrideToolNames,
    promptFeatures: input.promptFeatures,
    executionModes: activeExecutionModes,
    contextPhase: input.contextPhase,
  })
  const canReusePlanningSnapshot = isEmpty(toolAllocatorRequests)
  const cachedPlanningSnapshot = canReusePlanningSnapshot
    ? input.toolContext.codingSession.getTurnPlanningSnapshot?.<SoloTurnPlanningSnapshot>(
        planningSnapshotSignature
      )
    : null
  let categoryListCalls = 0
  let schemaEstimateCalls = 0
  let runtimeToolCategories: Array<SoloRunPlanToolCategory<ToolDescriptor>>
  let allocatorCatalogToolCategories: Array<SoloRunPlanToolCategory<ToolDescriptor>>
  let allowedToolCategoryIds: ToolCategoryId[]
  let visibleEnabledToolCategories: Array<SoloRunPlanToolCategory<ToolDescriptor>>
  let toolSchemaCandidateTools: string[]
  let toolSchemaChars: Readonly<Record<string, number>> | undefined
  let toolAllocatorPlan: Nullable<SessionToolAllocatorPlan> = null

  if (cachedPlanningSnapshot) {
    runtimeToolCategories = cachedPlanningSnapshot.runtimeToolCategories
    allocatorCatalogToolCategories = cachedPlanningSnapshot.allocatorCatalogToolCategories
    allowedToolCategoryIds = cachedPlanningSnapshot.allowedToolCategoryIds
    visibleEnabledToolCategories = cachedPlanningSnapshot.visibleEnabledToolCategories
    toolSchemaCandidateTools = cachedPlanningSnapshot.toolSchemaCandidateTools
    toolSchemaChars = cachedPlanningSnapshot.toolSchemaChars
  } else {
    runtimeToolCategories = filterToolCategoriesForModelInputs(
      input.toolRegistry.listCategories?.(input.toolContext, undefined, 'all') ??
        input.toolContext.listToolCategories('all'),
      input.roleRuntime.supportedInputModalities
    )
    categoryListCalls += 1
    if (shouldRunToolAllocator) {
      allocatorCatalogToolCategories = filterToolCategoriesForModelInputs(mergeToolCategoryCatalog([
        ...runtimeToolCategories,
        ...(input.toolRegistry.listCategories?.(input.toolContext, undefined, 'catalog') ??
          input.toolContext.listToolCategories('catalog')),
      ]), input.roleRuntime.supportedInputModalities)
      categoryListCalls += 1
    } else {
      allocatorCatalogToolCategories = runtimeToolCategories
    }
    allowedToolCategoryIds = collectAllowedToolCategoryIds(
      allocatorCatalogToolCategories,
      (categoryId) => input.toolContext.codingSession.isToolCategoryAllowed(categoryId)
    )

    toolAllocatorPlan =
      shouldRunToolAllocator && toolAllocator
        ? await toolAllocator.plan({
            turn: input.turn,
            latestUserText,
            requests: toolAllocatorRequests,
            runtimeToolCategories,
            catalogToolCategories: allocatorCatalogToolCategories,
            enabledToolCategoryIds,
            allowedToolCategoryIds,
            satisfiedPrerequisiteIds:
              input.toolContext.capabilityPorts?.satisfiedAllocationPrerequisiteIds,
          })
        : null
    if (toolAllocatorPlan) {
      if (!isEmpty(toolAllocatorPlan.grantedCategoryIds)) {
        input.toolContext.codingSession.enableToolCategories(
          toolAllocatorPlan.grantedCategoryIds,
          'tool allocator lease'
        )
      }
      if (!isEmpty(toolAllocatorPlan.grantedToolNames)) {
        input.toolContext.codingSession.enableToolNames?.(
          toolAllocatorPlan.grantedToolNames,
          'tool allocator lease'
        )
      }
    }
    toolSchemaCandidateTools = resolveSoloLoopTools({
      configuredTools: effectiveConfiguredTools,
      roleAllowedTools: effectiveRoleAllowedTools,
      enabledToolNames: collectToolNamesFromCategories(runtimeToolCategories),
    })
    visibleEnabledToolCategories = filterToolCategoriesForModelInputs(
      input.toolRegistry.listCategories?.(input.toolContext, undefined, 'enabled') ??
        input.toolContext.listToolCategories('enabled'),
      input.roleRuntime.supportedInputModalities
    )
    categoryListCalls += 1
    toolSchemaChars = input.toolRegistry.estimateToolSerializedCharsByName?.(
      input.toolContext,
      toolSchemaCandidateTools
    )
    if (input.toolRegistry.estimateToolSerializedCharsByName) {
      schemaEstimateCalls += 1
    }
    if (canReusePlanningSnapshot) {
      input.toolContext.codingSession.setTurnPlanningSnapshot?.(planningSnapshotSignature, {
        runtimeToolCategories,
        allocatorCatalogToolCategories,
        allowedToolCategoryIds,
        visibleEnabledToolCategories,
        toolSchemaCandidateTools,
        toolSchemaChars,
      } satisfies SoloTurnPlanningSnapshot)
    }
  }
  const runPlanTurnInput = {
    turn: input.turn,
    history: input.history,
    requestedRunProfile,
  } satisfies Pick<BuildAgentRunPlanInput, 'turn' | 'history' | 'requestedRunProfile'>
  const runPlanRuntimeInput = {
    roleRuntime: {
      providerId: input.roleRuntime.providerId,
      model: input.roleRuntime.model,
      contextWindow: effectiveContextWindow,
      runProfile,
      runProfileReason: resolvedRunProfile.reason,
      modelRequestOptions: input.roleRuntime.modelRequestOptions,
    },
  } satisfies Pick<BuildAgentRunPlanInput, 'roleRuntime'>
  const runPlanToolInput = {
    configuredTools: effectiveConfiguredTools ? [...effectiveConfiguredTools] : undefined,
    roleAllowedTools: [...effectiveRoleAllowedTools],
    currentVisibleToolNames,
    enabledToolCategoryIds,
    budgetOverrideToolCategoryIds,
    budgetOverrideToolNames,
    visibleEnabledToolCategories,
    runtimeToolCategories,
    allowedToolCategoryIds,
    capabilityPorts: input.toolContext.capabilityPorts,
    capabilityScopeId: input.activeCapabilityScopeId,
    toolSchemaChars,
    toolSchemaBudgetScale: input.toolContext.codingSession.getToolSchemaBudgetScale?.() ?? 1,
    toolUsageScores: input.toolContext.codingSession.getToolUsageScores?.(),
  } satisfies Pick<
    BuildAgentRunPlanInput,
    | 'configuredTools'
    | 'roleAllowedTools'
    | 'currentVisibleToolNames'
    | 'enabledToolCategoryIds'
    | 'budgetOverrideToolCategoryIds'
    | 'budgetOverrideToolNames'
    | 'visibleEnabledToolCategories'
    | 'runtimeToolCategories'
    | 'allowedToolCategoryIds'
    | 'capabilityPorts'
    | 'capabilityScopeId'
    | 'toolSchemaChars'
    | 'toolSchemaBudgetScale'
    | 'toolUsageScores'
  >
  const runPlanRecoveryInput = {
    bootstrapState: input.bootstrapState,
    capabilityEvidenceSnapshot:
      input.toolContext.codingSession.getCapabilityEvidenceSnapshot?.(),
    collectNewlyEvictedPagedInTools: (evictedToolNames) =>
      input.toolContext.codingSession.collectNewlyEvictedPagedInTools?.(evictedToolNames) ??
      evictedToolNames,
  } satisfies Pick<
    BuildAgentRunPlanInput,
    'bootstrapState' | 'capabilityEvidenceSnapshot' | 'collectNewlyEvictedPagedInTools'
  >
  const runPlan = buildAgentRunPlan({
    ...runPlanTurnInput,
    ...runPlanRuntimeInput,
    ...runPlanToolInput,
    ...runPlanRecoveryInput,
    ledgerFactory: input.ledgerFactory,
  })

  if (!isEmpty(runPlan.capabilities.requestedCategories)) {
    input.toolContext.codingSession.enableToolCategories(
      runPlan.capabilities.requestedCategories,
      'agent run plan: capability request'
    )
  }
  const zoneAllocation = runPlan.context.zoneAllocation
  input.toolContext.codingSession.setUsableContextWindowTokens?.(zoneAllocation.usableContextWindow)
  const skillGate = input.skillAllowedToolNames?.length
    ? new Set([...input.skillAllowedToolNames, ...SkillGateAlwaysKeptToolNames])
    : null
  const operationalAllowedTools = runPlan.capabilities.residentToolNames.filter(
    (toolName) => !skillGate || skillGate.has(toolName)
  )
  const allowedTools = filterToolsForContextPhase({
    tools: operationalAllowedTools,
    contextPhase: input.contextPhase,
    capabilityPorts: input.toolContext.capabilityPorts,
  })
  const forcedToolChoice = toNullable(runPlan.capabilities.forcedToolChoice)
  const bootstrapToolChoice =
    forcedToolChoice && allowedTools.includes(forcedToolChoice.toolName) ? forcedToolChoice : null
  input.setBootstrapState(runPlan.capabilities.bootstrapState)

  for (const reminder of runPlan.prompt.internalReminders.filter(
    (entry) => entry.phase === 'before-model'
  )) {
    input.history.push(createInternalFollowUpMessage(reminder.text))
  }
  if (toolAllocatorPlan && toolAllocatorRequests.length > 0) {
    input.history.push(
      createInternalFollowUpMessage(`[系统] 工具分配器：${toolAllocatorPlan.message}`)
    )
  }
  if (bootstrapToolChoice && runPlan.capabilities.bootstrapReminder) {
    input.log.info('tool-space bootstrap forced discovery', {
      turn: input.turn,
      toolName: bootstrapToolChoice.toolName,
      pageInCategories: runPlan.capabilities.requestedCategories,
    })
  }

  const enabledRuntimeCategoryArtifacts = collectEnabledRuntimeCategoryArtifacts(
    runtimeToolCategories,
    runPlan.capabilities.enabledCategories
  )
  const enabledToolDescriptors = enabledRuntimeCategoryArtifacts.enabledToolDescriptors
  const baseAllowedTools = runPlan.capabilities.baseAllowedToolNames
  const protectedTools = runPlan.capabilities.protectedToolNames
  const toolExposure = {
    allowedTools,
    droppedTools: [
      ...new Set([
        ...runPlan.capabilities.droppedToolNames,
        ...runPlan.capabilities.residentToolNames.filter(
          (toolName) => !allowedTools.includes(toolName)
        ),
      ]),
    ],
    maxToolCount: runProfileDefinition.budget.maxToolCount,
  }
  const promptToolCategories = {
    enabled: enabledRuntimeCategoryArtifacts.enabledToolCategories,
    all: runtimeToolCategories,
  } satisfies PromptStatePreparedToolCategories
  input.toolContext.codingSession.recordTurnPlanningTelemetry?.({
    turn: input.turn,
    runProfile,
    cacheHit: !!cachedPlanningSnapshot,
    signature: buildTurnPlanningTelemetrySignature(planningSnapshotSignature),
    durationMs: Date.now() - planningStartedAt,
    categoryListCalls,
    schemaEstimateCalls,
    runtimeToolCategoryCount: runtimeToolCategories.length,
    allocatorCatalogCategoryCount: allocatorCatalogToolCategories.length,
    visibleEnabledCategoryCount: visibleEnabledToolCategories.length,
    toolSchemaCandidateCount: toolSchemaCandidateTools.length,
    estimatedToolSchemaChars: sumPositiveRecordValues(toolSchemaChars),
    toolSchemaBudgetScale: runPlan.context.toolSchemaBudgetScale,
    residentToolCount: allowedTools.length,
    droppedToolCount: runPlan.capabilities.droppedToolNames.length,
    expiredToolNameLeases,
    categorySummary: toolCategorySummary(visibleEnabledToolCategories),
  })

  return {
    resolvedRunProfile,
    runProfile,
    runProfileDefinition,
    runPlan,
    zoneAllocation,
    allowedTools,
    toolSchemaChars,
    bootstrapToolChoice,
    enabledToolDescriptors,
    baseAllowedTools,
    protectedTools,
    toolExposure,
    promptToolCategories,
    promptBudget: toNullable(runPlan.prompt.promptBudget),
    toolAllocatorPlan,
  }
}

export {
  filterToolCategoriesForModelInputs,
  filterToolsForContextPhase,
  prepareSoloRunPlanForTurn,
}
