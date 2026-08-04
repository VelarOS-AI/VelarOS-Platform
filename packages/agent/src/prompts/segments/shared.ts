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
