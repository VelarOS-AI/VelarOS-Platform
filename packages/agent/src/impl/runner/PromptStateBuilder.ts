import { isEmpty, isTrue, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import type {RuntimePromptFeaturePolicy } from '../../contract/requires.js'
import type { RuntimePromptSnapshot } from '../../types/guidance.js'
import type { BuildRuntimePromptStateArgs, HtmlArtifactPromptTurnInput } from '../../types/runner.js'
import { resolveCapabilityPromptSegments } from '../../utils/capabilities'
import { createRuntimePromptSegments } from '../../utils/guidance/runtime'
import {
  isExecutionModeActive,
  resolveExecutionModes,
  stripExecutionModePromptFeatures,
} from '../../utils/runner/execution-mode-registry'
import {
  collectRecentToolFailures,
  collectToolNames,
  filterToolCategoryOverviewsByAllowedTools,
  formatExecutionPlanPreview,
  hasCompactedContextInHistory,
  readLatestUserTurnText,
  resolveSnapshotRunProfile,
  resolveToolCategoryOverviews,
  summarizeRequestableToolCategories,
  summarizeToolCategories,
} from '../../utils/runner/prompt-state'
import { defaultRuntimePromptFeaturePolicy } from '../tools/DefaultPromptFeaturePolicy'

interface RuntimeStateContextResult {
  facts: Record<string, unknown>
  segments: ReturnType<typeof createRuntimePromptSegments>
  /** Deprecated compatibility field; domain environment context is a capability contribution. */
  devEnvironmentContext: Nullable<string>
}

function shouldInjectHtmlArtifactPromptForTurn({
  selectedPromptFeatureSet,
  messages,
}: HtmlArtifactPromptTurnInput): boolean {
  if (!selectedPromptFeatureSet.has('html-artifact')) return false
  const latest = readLatestUserTurnText(messages)
  const visualSignal =
    /(?:可视化|图表|架构图|流程图|原型|看板|仪表盘|页面|网页|卡片|落地页|实时预览|复杂说明|复杂展示|交互|互动|讲解|演示|动态效果|实时效果|chart|diagram|dashboard|prototype|preview|artifact|html|svg|canvas|page|card|landing page|real-time|interactive|interaction|explain|explanation|demo|visual)/iu
  return !!latest && visualSignal.test(latest)
}

/**
 * 运行态提示词状态的装配件：把「本轮到底开了什么、模型手上有什么、计划走到哪」收敛成一份快照，
 * 再渲染成提示词的 dynamic 段与判定用的 facts。由 `RunContext` 持有一份，跨轮复用，本身不存回合状态。
 *
 * 两条注入面：提示词特性策略（宿主可换，决定 feature 的归一与展示）与自定义子 Agent 清单（列不出来时降级成空表，不阻断整轮）。
 */
export interface PromptStateBuilderApi {
  /**
   * 装配本轮的运行态提示词状态。
   *
   * 先把执行模式轴从 feature 轴里折出来并按当前能力作用域收口，再用角色允许的工具面过滤分类总览，
   * 最后产出三样东西：给段落谓词用的 `facts`、真正要拼进提示词的 `segments`、以及已停用的 `devEnvironmentContext`（恒为 null）。
   * `contextPhase` 缺省按 `operational` 处理；`bootstrap` 阶段不注入技能目录与自定义子 Agent 目录。
   */
  build(args: BuildRuntimePromptStateArgs): Promise<RuntimeStateContextResult>
}

class PromptStateBuilder implements PromptStateBuilderApi {
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
    const toolCategoryOverviews = resolveToolCategoryOverviews(
      toolContext,
      preparedToolCategories
    )
    const allowedToolNames = new Set(roleResolution.allowedTools)
    const enabledCategories = filterToolCategoryOverviewsByAllowedTools(
      toolCategoryOverviews.enabled,
      allowedToolNames
    )
    const enabledToolNames = collectToolNames(enabledCategories)
    const executionPlanPreview = formatExecutionPlanPreview(
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
        runProfile ?? resolveSnapshotRunProfile(toolContext.codingSession.getRunProfile()),
      toolCapabilityCategories: summarizeToolCategories(enabledCategories),
      requestableToolCapabilityCategories: summarizeRequestableToolCategories(
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
      subAgentDispatchCatalog: enabledToolNames.has('agent:dispatch') || enabledToolNames.has('agent:run_workflow')
        ? toolContext.getSubAgentDispatchCatalog?.()
        : undefined,
      executionPlanPreview,
      currentExecutionAdvice: currentExecutionAdvice
        ? `${currentExecutionAdvice.mode} / ${currentExecutionAdvice.title}`
        : null,
      recentToolFailures: collectRecentToolFailures(messages),
      hasCompactedContext: hasCompactedContextInHistory(messages),
    }

    return {
      facts: {
        locale: runtimeSnapshot.locale,
        roleId: runtimeSnapshot.roleId,
        workflowType: runtimeSnapshot.workflowType,
        activeCapabilityScope: runtimeSnapshot.activeCapabilityScope,
        selectedPromptFeatures: enabledPromptFeatures,
        readableSkillIds: enabledToolNames.has('tooling:read')
          ? runtimeSnapshot.availableSkills.map((skill) => skill.id)
          : [],
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
}

export { PromptStateBuilder, shouldInjectHtmlArtifactPromptForTurn }
export type { RuntimeStateContextResult }
export { PromptStateBuilder as AgentRuntimePromptStateBuilder }
