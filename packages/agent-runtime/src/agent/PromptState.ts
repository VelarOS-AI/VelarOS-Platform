import type { ModelMessage } from 'ai'

import { isArray, isEmpty, isObject, isString, isTrue, toNullable, truncate } from '@velaros-ai/core'
import { isRunProfileId } from '@velaros-ai/core/constants/typedFieldAsserts'
import type {
  AgentContextPhase,
  AgentDeveloperContext,
  AgentRoleId,
  AgentSkillDescriptor,
  AgentSurfaceId,
  CapabilityScopeId,
  ChatPromptFeatureId,
  ExecutionTaskPlanStep,
  ExecutionTaskPlanStepStatus,
  RunProfileId,
  RunProfileSelectionId,
  ThinkingDepth,
  ToolAvailabilityScope,
  ToolCategoryOverview,
  ToolDescriptor,
  ToolSurfaceProfileId,
  WorkflowType,
} from '@velaros-ai/core/types'

import {
  type AgentRuntimeCapabilityPorts,
  resolveCapabilityPromptSegments,
} from '../capabilities'
import { isExecutionModeSelected } from '../execution-modes'
import {
  createRuntimePromptSegments,
  type RuntimePromptSnapshot,
  type RuntimePromptToolCategorySummary,
} from '../prompts'
import { defaultRuntimePromptFeaturePolicy, type RuntimePromptFeaturePolicy } from '../tools'

import { CompactionSummaryMarker } from './history/contextOSMessage'

interface PromptStateRoleResolution {
  id: AgentRoleId
  label: string
  workflowType: WorkflowType
  allowedTools: string[]
  skillDescriptors?: AgentSkillDescriptor[]
}

interface PromptStateCodingSession {
  getEnabledPromptFeatures: () => ChatPromptFeatureId[]
  getActiveCapabilityScope(): CapabilityScopeId
  getToolSurfaceProfile: () => ToolSurfaceProfileId
  getRunProfile: () => Nullable<RunProfileSelectionId>
}

interface PromptStateExecutionApi {
  getCurrentPlan(): ExecutionTaskPlanStep[]
  getCurrentExecutionAdvice(): Nullable<{ mode: string; title: string }>
}

interface PromptStateSkillsApi {
  listRoleSkills(): AgentSkillDescriptor[]
}

interface PromptStateToolContext {
  locale: RuntimePromptSnapshot['locale']
  sessionId: string
  developerContext?: LooseOptional<AgentDeveloperContext>
  agentSurfaceId?: LooseOptional<AgentSurfaceId>
  capabilityPorts?: AgentRuntimeCapabilityPorts
  codingSession: PromptStateCodingSession
  skills?: PromptStateSkillsApi
  execution: PromptStateExecutionApi
  listToolCategories(scope: ToolAvailabilityScope): ToolCategoryOverview[]
  canDispatchSubAgents?: boolean
}

interface BuildRuntimePromptStateArgs {
  toolContext: PromptStateToolContext
  roleResolution: PromptStateRoleResolution
  messages: ModelMessage[]
  selectedPromptFeatures?: ChatPromptFeatureId[]
  preparedToolCategories?: PromptStatePreparedToolCategories
  goalMode?: boolean
  thinkingDepth?: LooseOptional<ThinkingDepth>
  runProfile?: LooseOptional<RunProfileId>
  contextPhase?: AgentContextPhase
}

interface PromptStatePreparedToolCategories {
  enabled: ToolCategoryOverview[]
  all: ToolCategoryOverview[]
}

interface RuntimeStateContextResult {
  facts: Record<string, unknown>
  segments: ReturnType<typeof createRuntimePromptSegments>
  /** Deprecated compatibility field; domain environment context is a capability contribution. */
  devEnvironmentContext: Nullable<string>
}

interface HtmlArtifactPromptTurnInput {
  selectedPromptFeatureSet: ReadonlySet<ChatPromptFeatureId>
  messages: ModelMessage[]
  workflowType: WorkflowType
}

const HtmlArtifactVisualSignal =
  /(?:可视化|图表|架构图|流程图|原型|看板|仪表盘|chart|diagram|dashboard|prototype|preview|artifact|html|svg|canvas)/iu

function readPromptMessageText(message: ModelMessage): string {
  if (isString(message.content)) return message.content
  if (!isArray(message.content)) return ''
  return message.content
    .map((part) => {
      if (isString(part)) return part
      if (!isObject(part)) return ''
      const record = part as Record<string, unknown>
      return record.type === 'text' && isString(record.text) ? record.text : ''
    })
    .filter(Boolean)
    .join('\n')
}

function readLatestUserTurnText(messages: ModelMessage[]): Nullable<string> {
  const latest = messages.at(-1)
  if (!latest || latest.role !== 'user') return null
  const text = readPromptMessageText(latest).trim()
  return text || null
}

function shouldInjectHtmlArtifactPromptForTurn({
  selectedPromptFeatureSet,
  messages,
}: HtmlArtifactPromptTurnInput): boolean {
  if (!selectedPromptFeatureSet.has('html-artifact')) return false
  const latest = readLatestUserTurnText(messages)
  return !!latest && HtmlArtifactVisualSignal.test(latest)
}

class PromptStateBuilder {
  private readonly promptFeaturePolicy: RuntimePromptFeaturePolicy

  constructor(
    promptFeaturePolicy: RuntimePromptFeaturePolicy = defaultRuntimePromptFeaturePolicy,
    private readonly listCustomSubAgents: () => RuntimePromptSnapshot['customSubAgents'] = () => []
  ) {
    this.promptFeaturePolicy = promptFeaturePolicy
  }

  public async build({
    toolContext,
    roleResolution,
    messages,
    selectedPromptFeatures,
    preparedToolCategories,
    goalMode,
    thinkingDepth,
    runProfile,
    contextPhase = 'operational',
  }: BuildRuntimePromptStateArgs): Promise<RuntimeStateContextResult> {
    const promptFeatures = this.promptFeaturePolicy.normalize(selectedPromptFeatures ?? [])
    const enabledPromptFeatures = [
      ...new Set([...promptFeatures, ...toolContext.codingSession.getEnabledPromptFeatures()]),
    ]
    const selectedPromptFeatureSet = new Set(enabledPromptFeatures)
    const toolCategoryOverviews = this.resolveToolCategoryOverviews(
      toolContext,
      preparedToolCategories
    )
    const allowedToolNames = new Set(roleResolution.allowedTools)
    const enabledCategories = this.filterToolCategoryOverviewsByAllowedTools(
      toolCategoryOverviews.enabled,
      allowedToolNames
    )
    const enabledToolNames = this.collectToolNames(enabledCategories)
    const executionPlanPreview = this.formatExecutionPlanPreview(
      toolContext.execution.getCurrentPlan()
    )
    const currentExecutionAdvice = toNullable(toolContext.execution.getCurrentExecutionAdvice())
    const proposalMode = isExecutionModeSelected('proposal', enabledPromptFeatures)
    const runtimeSnapshot: RuntimePromptSnapshot = {
      locale: toolContext.locale,
      roleId: roleResolution.id,
      roleLabel: roleResolution.label,
      workflowType: roleResolution.workflowType,
      thinkingDepth: thinkingDepth ?? 'balanced',
      // AgentDeveloperContext is an intentionally retired compatibility slot (`never`).
      developerContext: null,
      agentSurfaceId: toolContext.agentSurfaceId ?? 'chat',
      contextPhase,
      activeCapabilityScope: toolContext.codingSession.getActiveCapabilityScope(),
      toolCategories: enabledCategories.map((entry) => entry.category.id),
      toolSurfaceProfile: toolContext.codingSession.getToolSurfaceProfile(),
      runProfile:
        runProfile ?? this.resolveSnapshotRunProfile(toolContext.codingSession.getRunProfile()),
      toolCapabilityCategories: this.summarizeToolCategories(enabledCategories),
      requestableToolCapabilityCategories: this.summarizeRequestableToolCategories(
        toolCategoryOverviews.all,
        enabledToolNames
      ),
      canUpdatePlan: enabledToolNames.has('update_plan'),
      userRequestedPlan: isExecutionModeSelected('plan', enabledPromptFeatures),
      proposalMode,
      goalMode: isTrue(goalMode),
      selectedPromptFeatureLabels: enabledPromptFeatures.map((feature) =>
        this.promptFeaturePolicy.getLabel(feature)
      ),
      enabledPromptFeatures: [...enabledPromptFeatures],
      autoPromptFeatureLabels: [],
      availableSkills:
        contextPhase === 'bootstrap'
          ? []
          : (toolContext.skills?.listRoleSkills() ?? roleResolution.skillDescriptors ?? []),
      customSubAgents: contextPhase === 'bootstrap' ? [] : this.safeListCustomSubAgents(),
      executionPlanPreview,
      currentExecutionAdvice: currentExecutionAdvice
        ? `${currentExecutionAdvice.mode} / ${currentExecutionAdvice.title}`
        : null,
      recentToolFailures: this.collectRecentToolFailures(messages),
      hasCompactedContext: this.hasCompactedContextInHistory(messages),
    }

    return {
      facts: {
        locale: runtimeSnapshot.locale,
        roleId: runtimeSnapshot.roleId,
        workflowType: runtimeSnapshot.workflowType,
        activeCapabilityScope: runtimeSnapshot.activeCapabilityScope,
        selectedPromptFeatures: enabledPromptFeatures,
        hasSelectedPromptFeatures: !isEmpty(enabledPromptFeatures),
        shouldInjectHtmlArtifactPrompt: shouldInjectHtmlArtifactPromptForTurn({
          selectedPromptFeatureSet,
          messages,
          workflowType: roleResolution.workflowType,
        }),
        allowSubAgentDispatch: isTrue(toolContext.canDispatchSubAgents),
        hasExecutionPlan: !!executionPlanPreview,
      },
      segments: createRuntimePromptSegments(
        runtimeSnapshot,
        resolveCapabilityPromptSegments(toolContext.capabilityPorts, runtimeSnapshot)
      ),
      devEnvironmentContext: null,
    }
  }

  private safeListCustomSubAgents(): RuntimePromptSnapshot['customSubAgents'] {
    try {
      return this.listCustomSubAgents()
    } catch {
      return []
    }
  }

  private resolveSnapshotRunProfile(selection: LooseOptional<RunProfileSelectionId>): RunProfileId {
    return isRunProfileId(selection) ? selection : 'balanced'
  }

  private resolveToolCategoryOverviews(
    toolContext: PromptStateToolContext,
    prepared?: PromptStatePreparedToolCategories
  ): PromptStatePreparedToolCategories {
    return (
      prepared ?? {
        enabled: toolContext.listToolCategories('enabled'),
        all: toolContext.listToolCategories('all'),
      }
    )
  }

  private summarizeToolCategories(
    categories: ToolCategoryOverview[]
  ): RuntimePromptToolCategorySummary[] {
    return categories.map((entry) => ({
      id: entry.category.id,
      label: entry.category.label,
      description: entry.category.description,
      enabled: entry.enabled,
      toolOsDefaultState: entry.category.toolOs.defaultState,
      tools: entry.tools.map((tool) => ({
        name: tool.name,
        description: tool.description.replace(/\s+/g, ' ').trim(),
      })),
      hiddenToolCount: 0,
    }))
  }

  private summarizeRequestableToolCategories(
    categories: ToolCategoryOverview[],
    enabledToolNames: ReadonlySet<string>
  ): RuntimePromptToolCategorySummary[] {
    return categories
      .filter((entry) => entry.category.toolOs.defaultState !== 'resident')
      .map((entry) => ({
        id: entry.category.id,
        label: entry.category.label,
        description: entry.category.description,
        enabled: entry.enabled,
        toolOsDefaultState: entry.category.toolOs.defaultState,
        tools: [],
        hiddenToolCount: entry.tools.filter((tool) => !enabledToolNames.has(tool.name)).length,
      }))
      .filter((entry) => entry.hiddenToolCount > 0)
  }

  private filterToolCategoryOverviewsByAllowedTools(
    categories: ToolCategoryOverview[],
    allowedToolNames: ReadonlySet<string>
  ): ToolCategoryOverview[] {
    return categories
      .map((entry) => ({
        ...entry,
        tools: entry.tools.filter((tool) => allowedToolNames.has(tool.name)),
      }))
      .filter((entry) => !isEmpty(entry.tools))
  }

  private collectToolNames(categories: ToolCategoryOverview[]): Set<string> {
    return new Set(categories.flatMap((entry) => entry.tools.map((tool: ToolDescriptor) => tool.name)))
  }

  private formatExecutionPlanPreview(plan: ExecutionTaskPlanStep[]): Nullable<string> {
    if (isEmpty(plan)) return null
    const preview = plan.slice(0, 6).map(
      (step, index) => `${index + 1}. ${step.title}(${this.formatExecutionPlanStatus(step.status)})`
    )
    if (plan.length > preview.length) preview.push(`还有 ${plan.length - preview.length} 步`)
    return preview.join(' | ')
  }

  private formatExecutionPlanStatus(status: ExecutionTaskPlanStepStatus): string {
    const labels: Record<ExecutionTaskPlanStepStatus, string> = {
      pending: '待处理',
      delegated: '已委派',
      running: '进行中',
      completed: '完成',
      failed: '失败',
      skipped: '跳过',
    }
    return labels[status]
  }

  private hasCompactedContextInHistory(messages: ModelMessage[]): boolean {
    return messages.some((message) =>
      readPromptMessageText(message).startsWith(CompactionSummaryMarker)
    )
  }

  private collectRecentToolFailures(messages: ModelMessage[]): string[] {
    const failures: string[] = []
    for (const message of messages.slice(-24).reverse()) {
      if (message.role !== 'tool' || !isArray(message.content)) continue
      for (const part of [...message.content].reverse()) {
        if (part.type !== 'tool-result') continue
        const output = isObject(part.output)
          ? (part.output as { type?: unknown; value?: unknown })
          : null
        const value = String(output?.value ?? '')
        if (
          output?.type === 'error-text' ||
          /^Error:/i.test(value) ||
          /command not found|"success"\s*:\s*false/i.test(value)
        ) {
          failures.push(`${part.toolName}: ${truncate(value.replace(/\s+/g, ' ').trim(), 140)}`)
          if (failures.length >= 4) return failures
        }
      }
    }
    return failures
  }
}

export { PromptStateBuilder, shouldInjectHtmlArtifactPromptForTurn }
export type {
  BuildRuntimePromptStateArgs,
  PromptStateCodingSession,
  PromptStateExecutionApi,
  PromptStatePreparedToolCategories,
  PromptStateRoleResolution,
  PromptStateToolContext,
  RuntimeStateContextResult,
}
export { PromptStateBuilder as AgentRuntimePromptStateBuilder }
