import type { ModelMessage } from 'ai'

import type {
  AgentContextPhase,
  AgentDeveloperContext,
  AgentRoleId,
  AgentSkillDescriptor,
  AgentSurfaceId,
  CapabilityScopeId,
  ChatPromptFeatureId,
  ExecutionModeId,
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
} from '@velaros-ai/agent/protocol'
import { isRunProfileId } from '@velaros-ai/agent/protocol'
import { isArray, isEmpty, isObject, isString, isTrue, toNullable, truncate } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import {
  type AgentRuntimeCapabilityPorts,
  resolveCapabilityPromptSegments,
} from '../capabilities'
import {
  isExecutionModeActive,
  resolveExecutionModes,
  stripExecutionModePromptFeatures,
} from '../execution-modes'
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
  sessionId?: string
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
  /** 执行模式轴；缺席时由旧形态（selectedPromptFeatures 里的模式 id / goalMode）折算。 */
  executionModes?: readonly ExecutionModeId[]
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
  /(?:可视化|图表|架构图|流程图|原型|看板|仪表盘|页面|网页|卡片|落地页|实时预览|复杂说明|复杂展示|交互|互动|讲解|演示|动态效果|实时效果|chart|diagram|dashboard|prototype|preview|artifact|html|svg|canvas|page|card|landing page|real-time|interactive|interaction|explain|explanation|demo|visual)/iu

function readPromptMessageText(message: ModelMessage): string {
  if (isString(message.content)) return message.content
  if (!isArray(message.content)) return ''
  return message.content
    .map((part) => {
      if (isString(part)) return part
      if (!isObject(part)) return ''
      // @arch-guard:suspend code-style/prefer-is-plain-object-over-guarded-record-cast 理由：part 是 ai-SDK 的判别联合，isPlainObject 会把它收窄到不含 text 的成员，`type === 'text'` 直接被判成无重叠；断言是这条守卫唯一能读到字段的写法。
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
    executionModes,
    goalMode,
    thinkingDepth,
    runProfile,
    contextPhase = 'operational',
  }: BuildRuntimePromptStateArgs): Promise<RuntimeStateContextResult> {
    const activeCapabilityScope = toolContext.codingSession.getActiveCapabilityScope()
    const promptFeatures = this.promptFeaturePolicy.normalizeForScope
      ? this.promptFeaturePolicy.normalizeForScope(
          selectedPromptFeatures ?? [],
          activeCapabilityScope
        )
      : this.promptFeaturePolicy.normalize(selectedPromptFeatures ?? [])
    const requestedFeatures = [
      ...new Set([...promptFeatures, ...toolContext.codingSession.getEnabledPromptFeatures()]),
    ]
    // 拆轴：模式先从两种形态折出来，能力轴随即剥掉模式 id——否则「本轮已选能力：计划模式」
    // 这类文案会把一个执行姿态展示成插件能力，feature→工具分类映射也会多算一次。
    const activeExecutionModes = resolveExecutionModes({
      executionModes,
      promptFeatures: requestedFeatures,
      goalMode,
    })
    const enabledPromptFeatureCandidates = stripExecutionModePromptFeatures(requestedFeatures)
    // 会话粘性里可能仍带着其他作用域的内置协议；合并所有来源后再按当前作用域收口，
    // 否则宿主在第一步筛掉的 feature 会被 codingSession 的旧值重新带回来。
    const enabledPromptFeatures = this.promptFeaturePolicy.normalizeForScope
      ? this.promptFeaturePolicy.normalizeForScope(
          enabledPromptFeatureCandidates,
          activeCapabilityScope
        )
      : enabledPromptFeatureCandidates
    const describedPromptFeatures = enabledPromptFeatures.filter(
      (feature) => this.promptFeaturePolicy.shouldDescribeAsSelected?.(feature) ?? true
    )
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
    const runtimeSnapshot: RuntimePromptSnapshot = {
      locale: toolContext.locale,
      roleId: roleResolution.id,
      roleLabel: roleResolution.label,
      workflowType: roleResolution.workflowType,
      thinkingDepth: thinkingDepth ?? 'balanced',
      // `AgentDeveloperContext` 是刻意停用的兼容槽位，类型固定为 `never`。
      developerContext: null,
      agentSurfaceId: toolContext.agentSurfaceId ?? 'chat',
      contextPhase,
      activeCapabilityScope,
      toolCategories: enabledCategories.map((entry) => entry.category.id),
      toolSurfaceProfile: toolContext.codingSession.getToolSurfaceProfile(),
      runProfile:
        runProfile ?? this.resolveSnapshotRunProfile(toolContext.codingSession.getRunProfile()),
      toolCapabilityCategories: this.summarizeToolCategories(enabledCategories),
      requestableToolCapabilityCategories: this.summarizeRequestableToolCategories(
        toolCategoryOverviews.all,
        enabledToolNames
      ),
      canUpdatePlan: enabledToolNames.has('plan:update'),
      userRequestedPlan: isExecutionModeActive('plan', activeExecutionModes),
      goalMode: isExecutionModeActive('goal', activeExecutionModes),
      selectedPromptFeatureLabels: describedPromptFeatures.map((feature) =>
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
        hasSelectedPromptFeatures: !isEmpty(describedPromptFeatures),
        shouldInjectHtmlArtifactPrompt: shouldInjectHtmlArtifactPromptForTurn({
          selectedPromptFeatureSet,
          messages,
          workflowType: roleResolution.workflowType,
        }),
        // 2026-08-06 补接：`runtime.visual-widget-tools` / `runtime.visual-rendering-routing`
        // 两段的谓词读这个 fact，而全树**从来没有生产者**——两段自诞生起就没进过任何一次提示词，
        // Widget 能力开着也拿不到用法指引（工具描述里那句「先读 skill:widget-visual-output」
        // 只在工具已经换入之后才看得到）。与 html-artifact 对称：能力开启即注入协议段。
        shouldInjectVisualWidgetPrompt: selectedPromptFeatureSet.has('widget'),
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
    } catch (error) {
      // 自定义子 Agent 清单只是提示词里的一段目录：列不出来时降级成空列表继续构建提示词，
      // 但不能静默——宿主 provider 抛错时这是唯一的线索。
      logRuntime
        .tag('PromptState')
        .warn('custom sub-agent listing failed, prompt falls back to an empty catalog', {
          error: AppError.getMessage(error),
        })
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
