import type {
  AgentContextPhase,
  AgentDeveloperContext,
  AgentRoleId,
  AgentSkillDescriptor,
  AgentSurfaceId,
  AppLocale,
  CapabilityScopeId,
  ChatPromptFeatureId,
  RunProfileId,
  ThinkingDepth,
  ToolOsState,
  ToolSurfaceProfileId,
  WorkflowType,
} from '@velaros-ai/agent/protocol'
import { isEmpty } from '@velaros-ai/core'

import type {
  PromptSegmentDefinition,
  PromptSegmentRetention,
  PromptSegmentSource,
  PromptSegmentStability,
} from '../registry'

export interface RuntimePromptToolSummary {
  name: string
  description: string
}

export interface RuntimePromptToolCategorySummary {
  id: string
  label: string
  description: string
  enabled: boolean
  toolOsDefaultState: ToolOsState
  tools: RuntimePromptToolSummary[]
  hiddenToolCount: number
}

export interface RuntimePromptCustomSubAgent {
  id: string
  description: string
  base: string
}

/** Host-neutral snapshot passed to prompt contributors. */
export interface RuntimePromptSnapshot {
  locale: AppLocale
  roleId: AgentRoleId
  roleLabel: string
  workflowType: WorkflowType
  thinkingDepth: ThinkingDepth
  developerContext: Nullable<AgentDeveloperContext>
  agentSurfaceId: AgentSurfaceId
  contextPhase: AgentContextPhase
  activeCapabilityScope: CapabilityScopeId
  toolCategories: string[]
  toolSurfaceProfile: ToolSurfaceProfileId
  runProfile: RunProfileId
  toolCapabilityCategories: RuntimePromptToolCategorySummary[]
  requestableToolCapabilityCategories: RuntimePromptToolCategorySummary[]
  canUpdatePlan: boolean
  userRequestedPlan: boolean
  proposalMode: boolean
  goalMode: boolean
  selectedPromptFeatureLabels: string[]
  enabledPromptFeatures: ChatPromptFeatureId[]
  autoPromptFeatureLabels: string[]
  availableSkills: AgentSkillDescriptor[]
  customSubAgents: RuntimePromptCustomSubAgent[]
  executionPlanPreview: Nullable<string>
  currentExecutionAdvice: Nullable<string>
  recentToolFailures: string[]
  hasCompactedContext: boolean
}

export const PromptSegmentPriority = {
  identity: 0,
  developmentP0: 10,
  role: 100,
  skill: 120,
  datetime: 500,
  runtime: 1_000,
  runtimeAdvice: 1_500,
  strategy: 3_400,
  guardrail: 3_600,
  user: 10_000,
} as const

export function formatLabelList(labels: string[]): string {
  return !isEmpty(labels) ? labels.join('、') : '无'
}

export function getRuntimeToolNames(snapshot: RuntimePromptSnapshot): Set<string> {
  return new Set(
    snapshot.toolCapabilityCategories.flatMap((category) =>
      category.tools.map((tool) => tool.name)
    )
  )
}

export function hasRuntimeTool(snapshot: RuntimePromptSnapshot, toolName: string): boolean {
  return getRuntimeToolNames(snapshot).has(toolName)
}

export function hasAnyRuntimeTool(
  snapshot: RuntimePromptSnapshot,
  toolNames: string[]
): boolean {
  const available = getRuntimeToolNames(snapshot)
  return toolNames.some((toolName) => available.has(toolName))
}

export function hasAnyRuntimeToolAvailable(snapshot: RuntimePromptSnapshot): boolean {
  return snapshot.toolCapabilityCategories.some(
    (category) => category.enabled && !isEmpty(category.tools)
  )
}

export function createTextPromptSegment(args: {
  id: string
  label: string
  stability: PromptSegmentStability
  source: PromptSegmentSource
  priority: number
  retention?: PromptSegmentRetention
  text: Nullable<string>
  when?: () => boolean
}): PromptSegmentDefinition {
  return {
    id: args.id,
    label: args.label,
    stability: args.stability,
    source: args.source,
    priority: args.priority,
    retention: args.retention,
    when: args.when,
    render: () => args.text,
  }
}

export function createSkillPromptSegment(id: string, text: string): PromptSegmentDefinition {
  return createTextPromptSegment({
    id: `skill.${id}`,
    label: 'Role Skill',
    stability: 'stable',
    source: 'skill',
    priority: PromptSegmentPriority.skill,
    text,
  })
}

export function createSelectedSkillPromptSegment(text: string): PromptSegmentDefinition {
  return createTextPromptSegment({
    id: 'skill.active',
    label: 'Active Skills',
    stability: 'stable',
    source: 'skill',
    priority: PromptSegmentPriority.skill,
    text,
  })
}

function buildThinkingDepthPrompt(depth?: LooseOptional<ThinkingDepth>): string {
  switch (depth) {
    case 'fast':
      return '当前运行策略：低。只补足完成请求必需的上下文，优先最直接可交付路径。'
    case 'deep':
      return '当前运行策略：高。在落定方案前检查上下游约束、隐藏依赖和高风险副作用。'
    default:
      return '当前运行策略：中。在速度、正确性和改动范围之间做稳妥折中。'
  }
}

export function createThinkingDepthPromptSegment(
  depth?: LooseOptional<ThinkingDepth>
): PromptSegmentDefinition {
  return createTextPromptSegment({
    id: 'runtime.run-strategy',
    label: 'Run Strategy',
    stability: 'dynamic',
    source: 'runtime',
    priority: PromptSegmentPriority.runtimeAdvice - 30,
    text: [
      buildThinkingDepthPrompt(depth),
      '该约束只控制执行方式；不要暴露隐藏思考过程。',
    ].join('\n'),
  })
}
