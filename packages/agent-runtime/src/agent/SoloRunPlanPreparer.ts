import type { ModelMessage } from 'ai'

import { isEmpty, isTrue, toNullable } from '@velaros-ai/core'
import type { ScopedLog } from '@velaros-ai/core/logger'
import type {
  AgentContextPhase,
  AgentSurfaceId,
  CapabilityScopeId,
  ChatPromptFeatureId,
  RunProfileId,
  RunProfileRuntimePolicy,
  RunProfileSelectionId,
  ThinkingDepth,
  ToolCategoryId,
  ToolDescriptor,
  ToolSurfaceProfileId,
  TurnPlanningTelemetryPayload,
} from '@velaros-ai/core/types'

import {
  type AgentRuntimeCapabilityPorts,
  resolveToolAllocationMetadata,
} from '../capabilities'
import { isExecutionModeSelected } from '../execution-modes'

import {
  type AgentRunPlan,
  agentRunPlanComposer,
  type BuildAgentRunPlanInput,
  type SessionToolAllocatorPlan,
  type ToolAllocatorRequest,
} from './control-plane'
import { createInternalFollowUpMessage } from './history'
import { extractLatestUserTextFromMessages, isLowSignalIntentText } from './IntentSignals'
import { resolveSoloLoopTools } from './LoopRuntime'
import type { AgentModelRequestOptions } from './model'
import type { PromptStatePreparedToolCategories } from './PromptState'
import { resolveRunProfilePolicyForRuntime, RunProfileDefinitions } from './RunProfile'
import type { ToolSpaceBootstrapState } from './ToolSpaceBootstrapPlanner'

interface SoloRunPlanToolCategory<TTool extends { name: string } = ToolDescriptor> {
  category: { id: ToolCategoryId }
  tools: TTool[]
}

interface SoloRunPlanCodingSession {
  getRunProfile(): RunProfileSelectionId
  enableToolCategories(categories: ToolCategoryId[], reason?: string): ToolCategoryId[]
  enableToolNames?(toolNames: string[], reason?: string): string[]
  getEnabledToolCategories(): ToolCategoryId[]
  getBudgetOverrideToolCategories(): ToolCategoryId[]
  getBudgetOverrideToolNames(): string[]
  drainToolAllocatorRequests?(): ToolAllocatorRequest[]
  isToolCategoryAllowed(categoryId: ToolCategoryId): boolean
  setThinkingDepth?(thinkingDepth: ThinkingDepth): ThinkingDepth
  setToolSurfaceProfile?(profile: ToolSurfaceProfileId, reason?: string): ToolSurfaceProfileId
  getToolUsageScores?: () => Readonly<Record<string, number>>
  getToolSchemaBudgetScale?: () => number
  setUsableContextWindowTokens?: (tokens: Nullable<number>) => void
  pruneExpiredToolNameLeases?: (turn: number) => string[]
  pruneExpiredToolCategoryLeases?: (turn: number) => ToolCategoryId[]
  getTurnPlanningSnapshot?: <TSnapshot = unknown>(signature: string) => Nullable<TSnapshot>
  setTurnPlanningSnapshot?: (signature: string, snapshot: unknown) => void
  recordTurnPlanningTelemetry?: (entry: TurnPlanningTelemetryPayload) => void
  collectNewlyEvictedPagedInTools?: (evictedToolNames: readonly string[]) => string[]
  getCapabilityEvidenceSnapshot?(): BuildAgentRunPlanInput['capabilityEvidenceSnapshot']
}

interface SoloRunPlanToolContext {
  capabilityPorts?: AgentRuntimeCapabilityPorts
  codingSession: SoloRunPlanCodingSession
  getCurrentVisibleToolNames(): string[]
  setCurrentVisibleToolNames(toolNames: string[]): void
  listToolCategories(
    scope?: 'enabled' | 'all' | 'system-enabled' | 'catalog'
  ): Array<SoloRunPlanToolCategory<ToolDescriptor>>
}

interface SoloRunPlanToolRegistry<TContext extends SoloRunPlanToolContext> {
  getCapabilityRevision?(): string | number
  listCategories?(
    toolContext: TContext,
    allowList?: string[],
    scope?: 'enabled' | 'all' | 'system-enabled' | 'catalog'
  ): Array<SoloRunPlanToolCategory<ToolDescriptor>>
  estimateToolSerializedCharsByName?: (
    toolContext: TContext,
    allowedTools: string[]
  ) => Record<string, number>
}

interface SoloRunPlanRoleRuntime {
  providerId: string
  model: string
  providerModel?: string
  contextWindow?: number
  modelRequestOptions?: AgentModelRequestOptions
  runProfilePolicy?: RunProfileRuntimePolicy
}

interface SoloRunPlanToolAllocator {
  plan(input: {
    turn: number
    latestUserText: string
    requests: readonly ToolAllocatorRequest[]
    runtimeToolCategories: Array<SoloRunPlanToolCategory<ToolDescriptor>>
    catalogToolCategories?: Array<SoloRunPlanToolCategory<ToolDescriptor>>
    enabledToolCategoryIds: readonly ToolCategoryId[]
    allowedToolCategoryIds: readonly ToolCategoryId[]
    satisfiedPrerequisiteIds?: readonly string[]
  }): SessionToolAllocatorPlan | Promise<SessionToolAllocatorPlan>
}

interface PrepareSoloRunPlanForTurnInput<TContext extends SoloRunPlanToolContext> {
  turn: number
  history: ModelMessage[]
  configuredTools?: readonly string[]
  roleAllowedTools: readonly string[]
  /** 显式选中技能声明的工具门控并集（allowed-tools）；null/空 = 不限制。 */
  skillAllowedToolNames?: LooseOptional<readonly string[]>
  promptFeatures?: readonly ChatPromptFeatureId[]
  goalMode?: boolean
  contextPhase: AgentContextPhase
  activeCapabilityScopeId: CapabilityScopeId
  agentSurfaceId?: LooseOptional<AgentSurfaceId>
  roleRuntime: SoloRunPlanRoleRuntime
  toolContext: TContext
  toolRegistry: SoloRunPlanToolRegistry<TContext>
  bootstrapState: ToolSpaceBootstrapState
  setBootstrapState(state: ToolSpaceBootstrapState): void
  log: Pick<ScopedLog, 'info'>
  toolAllocator?: SoloRunPlanToolAllocator
  toolAllocatorRequests?: readonly ToolAllocatorRequest[]
}

interface PrepareSoloRunPlanForTurnResult {
  resolvedRunProfile: RunProfileRuntimePolicy
  runProfile: RunProfileId
  runProfileDefinition: (typeof RunProfileDefinitions)[RunProfileId]
  runPlan: AgentRunPlan
  zoneAllocation: AgentRunPlan['context']['zoneAllocation']
  allowedTools: string[]
  toolSchemaChars?: Readonly<Record<string, number>>
  bootstrapToolChoice: Nullable<AgentRunPlan['capabilities']['forcedToolChoice']>
  enabledToolDescriptors: ToolDescriptor[]
  baseAllowedTools: string[]
  protectedTools: string[]
  toolExposure: {
    allowedTools: string[]
    droppedTools: string[]
    maxToolCount: Nullable<number>
  }
  promptToolCategories: PromptStatePreparedToolCategories
  promptBudget: Nullable<AgentRunPlan['prompt']['promptBudget']>
  toolAllocatorPlan: Nullable<SessionToolAllocatorPlan>
}

interface SoloTurnPlanningSnapshot {
  runtimeToolCategories: Array<SoloRunPlanToolCategory<ToolDescriptor>>
  allocatorCatalogToolCategories: Array<SoloRunPlanToolCategory<ToolDescriptor>>
  allowedToolCategoryIds: ToolCategoryId[]
  visibleEnabledToolCategories: Array<SoloRunPlanToolCategory<ToolDescriptor>>
  toolSchemaCandidateTools: string[]
  toolSchemaChars?: Readonly<Record<string, number>>
}

const PlanModeRequiredToolNames = ['update_plan', 'show_user_action_cards'] as const
const ProposalModeRequiredToolNames = [
  'get_proposal',
  'proposal_review',
  'ask_user',
  'dispatch_agent',
  'run_agent_workflow',
  'produce_artifact',
] as const
const ProposalLifecycleToolNameSet = new Set<string>(['get_proposal', 'proposal_review'])
const ProposalModeAllowedNonInspectToolNames = new Set<string>([
  ...ProposalModeRequiredToolNames,
  'read_background_job_output',
  'wait_background_jobs',
  'cancel_background_job',
  'tool_replace',
  // tool_read 是只读的技能/工具页读取入口：不带进来会把 runtime.available-skill-pages
  // 索引段一起干掉（段的 when 依赖 tool_read 在场），提案轮次对技能完全失明。
  'tool_read',
])
const GoalModeRequiredToolNames = ['get_goal', 'create_goal', 'update_goal'] as const
const BootstrapSharedToolNames = [
  'tool_map',
  'update_plan',
  'ask_user',
  'show_user_action_cards',
] as const
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
  'tool_read',
  'ask_user',
  'show_user_action_cards',
  'recall_context',
  'distill_context',
])
function excludeProposalLifecycleToolsWhenDisabled<T extends readonly string[] | undefined>(
  tools: T,
  promptFeatures?: readonly ChatPromptFeatureId[]
): T {
  if (!tools || isExecutionModeSelected('proposal', promptFeatures ?? [])) return tools
  return tools.filter((tool) => !ProposalLifecycleToolNameSet.has(tool)) as unknown as T
}

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

function sortedStrings(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))].sort()
}

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

function resolvePromptFeatureProtectedToolNames(input: {
  promptFeatures?: readonly ChatPromptFeatureId[]
  goalMode?: boolean
  budgetOverrideToolNames: readonly string[]
}): string[] {
  const toolNames = new Set(input.budgetOverrideToolNames)

  if (isExecutionModeSelected('plan', input.promptFeatures ?? [])) {
    for (const toolName of PlanModeRequiredToolNames) {
      toolNames.add(toolName)
    }
  }
  if (isExecutionModeSelected('proposal', input.promptFeatures ?? [])) {
    for (const toolName of ProposalModeRequiredToolNames) {
      toolNames.add(toolName)
    }
  }
  if (isTrue(input.goalMode)) {
    for (const toolName of GoalModeRequiredToolNames) {
      toolNames.add(toolName)
    }
  }

  return [...toolNames]
}

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

  return summary.sort((left, right) => left.id.localeCompare(right.id))
}

function sumPositiveRecordValues(values: LooseOptional<Readonly<Record<string, number>>>): number {
  return Object.values(values ?? {}).reduce((sum, value) => sum + Math.max(0, value), 0)
}

function buildTurnPlanningTelemetrySignature(signature: string): string {
  let hash = 0x811c9dc5

  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }

  return `turn-plan:fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function buildTurnPlanningSnapshotSignature(input: {
  capabilityRevision?: string | number
  providerId: string
  model: string
  contextWindow: number
  requestedRunProfile: RunProfileSelectionId
  runProfile: RunProfileId
  roleAllowedTools: readonly string[]
  configuredTools?: readonly string[]
  currentVisibleToolNames: readonly string[]
  enabledToolCategoryIds: readonly ToolCategoryId[]
  budgetOverrideToolCategoryIds: readonly ToolCategoryId[]
  budgetOverrideToolNames: readonly string[]
  promptFeatures?: readonly ChatPromptFeatureId[]
  goalMode?: boolean
  contextPhase: AgentContextPhase
}): string {
  return JSON.stringify({
    capabilityRevision: input.capabilityRevision ?? null,
    providerId: input.providerId,
    model: input.model,
    contextWindow: input.contextWindow,
    requestedRunProfile: input.requestedRunProfile,
    runProfile: input.runProfile,
    configuredTools: sortedStrings(input.configuredTools ?? []),
    roleAllowedTools: sortedStrings(input.roleAllowedTools),
    currentVisibleToolNames: sortedStrings(input.currentVisibleToolNames),
    enabledToolCategoryIds: sortedStrings(input.enabledToolCategoryIds),
    budgetOverrideToolCategoryIds: sortedStrings(input.budgetOverrideToolCategoryIds),
    budgetOverrideToolNames: sortedStrings(input.budgetOverrideToolNames),
    promptFeatures: sortedStrings(input.promptFeatures ?? []),
    goalMode: isTrue(input.goalMode),
    contextPhase: input.contextPhase,
  })
}

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
  const effectiveContextWindow = input.roleRuntime.contextWindow ?? resolvedRunProfile.contextWindow
  const planningStartedAt = Date.now()
  const expiredToolNameLeases =
    input.toolContext.codingSession.pruneExpiredToolNameLeases?.(input.turn) ?? []
  input.toolContext.codingSession.pruneExpiredToolCategoryLeases?.(input.turn)
  input.toolContext.codingSession.setThinkingDepth?.(runProfileDefinition.defaults.thinkingDepth)
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
  const budgetOverrideToolNames = resolvePromptFeatureProtectedToolNames({
    promptFeatures: input.promptFeatures,
    goalMode: input.goalMode,
    budgetOverrideToolNames: input.toolContext.codingSession.getBudgetOverrideToolNames(),
  })
  const effectiveConfiguredTools = excludeProposalLifecycleToolsWhenDisabled(
    input.configuredTools,
    input.promptFeatures
  )
  const effectiveRoleAllowedTools = excludeProposalLifecycleToolsWhenDisabled(
    input.roleAllowedTools,
    input.promptFeatures
  )
  const planningSnapshotSignature = buildTurnPlanningSnapshotSignature({
    capabilityRevision: input.toolRegistry.getCapabilityRevision?.(),
    providerId: input.roleRuntime.providerId,
    model: input.roleRuntime.model,
    contextWindow: effectiveContextWindow,
    requestedRunProfile,
    runProfile,
    configuredTools: effectiveConfiguredTools,
    roleAllowedTools: effectiveRoleAllowedTools,
    currentVisibleToolNames,
    enabledToolCategoryIds,
    budgetOverrideToolCategoryIds,
    budgetOverrideToolNames,
    promptFeatures: input.promptFeatures,
    goalMode: input.goalMode,
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
    runtimeToolCategories =
      input.toolRegistry.listCategories?.(input.toolContext, undefined, 'all') ??
      input.toolContext.listToolCategories('all')
    categoryListCalls += 1
    if (shouldRunToolAllocator) {
      allocatorCatalogToolCategories = mergeToolCategoryCatalog([
        ...runtimeToolCategories,
        ...(input.toolRegistry.listCategories?.(input.toolContext, undefined, 'catalog') ??
          input.toolContext.listToolCategories('catalog')),
      ])
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
    visibleEnabledToolCategories =
      input.toolRegistry.listCategories?.(input.toolContext, undefined, 'enabled') ??
      input.toolContext.listToolCategories('enabled')
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
  const runPlan = agentRunPlanComposer.build({
    ...runPlanTurnInput,
    ...runPlanRuntimeInput,
    ...runPlanToolInput,
    ...runPlanRecoveryInput,
  })

  if (!isEmpty(runPlan.capabilities.requestedCategories)) {
    input.toolContext.codingSession.enableToolCategories(
      runPlan.capabilities.requestedCategories,
      'agent run plan: capability request'
    )
  }
  const zoneAllocation = runPlan.context.zoneAllocation
  input.toolContext.codingSession.setUsableContextWindowTokens?.(zoneAllocation.usableContextWindow)
  const proposalMode = isExecutionModeSelected('proposal', input.promptFeatures ?? [])
  const descriptorByName = new Map(
    runtimeToolCategories.flatMap((entry) => entry.tools.map((tool) => [tool.name, tool] as const))
  )
  const skillGate = input.skillAllowedToolNames?.length
    ? new Set([...input.skillAllowedToolNames, ...SkillGateAlwaysKeptToolNames])
    : null
  const operationalAllowedTools = (
    proposalMode
      ? runPlan.capabilities.residentToolNames.filter((toolName) => {
          const role = descriptorByName.get(toolName)?.role
          return role === 'inspect' || ProposalModeAllowedNonInspectToolNames.has(toolName)
        })
      : runPlan.capabilities.residentToolNames
  ).filter((toolName) => !skillGate || skillGate.has(toolName))
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
    enabled:
      enabledRuntimeCategoryArtifacts.enabledToolCategories as unknown as PromptStatePreparedToolCategories['enabled'],
    all: runtimeToolCategories as unknown as PromptStatePreparedToolCategories['all'],
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

export { filterToolsForContextPhase, prepareSoloRunPlanForTurn }
export type {
  PrepareSoloRunPlanForTurnInput,
  PrepareSoloRunPlanForTurnResult,
  SoloRunPlanCodingSession,
  SoloRunPlanRoleRuntime,
  SoloRunPlanToolCategory,
  SoloRunPlanToolContext,
  SoloRunPlanToolRegistry,
}
