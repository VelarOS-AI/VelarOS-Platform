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
  PromptSegmentTier,
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

/**
 * 段优先级带（按行为知识三层分带；层序由注册表保证，带内数值只决定同层内部顺序与裁剪判据）。
 *
 * Tier0（core，0–99）：内置身份与品牌语气；宿主自有不可变纪律可使用预留的安全边界位。
 * Tier1（runtime，1_000–8_999）：运行态指导。`capabilityProtocol` 是用户显式开启的能力协议段；
 *   `runtimeAdvice` 是执行模式/计划一类本轮建议。
 * Tier2（skill，9_000）：技能索引与命中指针。
 *
 * 2026-08-06 删除的死常量（全树零消费者）：`developmentP0` / `role` / `strategy` / `guardrail`，
 * 以及 `datetime: 500`——真实的 datetime 段自带字面量 9_020，从来没读过这个常量。
 */
export const PromptSegmentPriority = {
  identity: 0,
  brandVoice: 10,
  // 对外兼容的通用纪律优先级；内置 Tier0 保持身份与品牌语气两段。
  safetyBoundary: 20,
  runtime: 1_000,
  capabilityProtocol: 1_200,
  runtimeAdvice: 1_500,
  skill: 9_000,
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

/**
 * Tier0 段工厂（唯一入口）。
 *
 * **刻意不接受 `when` 谓词、也拿不到 `PromptRenderContext`**：Tier0 的契约是「稳定前缀逐字不变」，
 * 一旦允许按 facts 判定，前缀就会随会话状态分叉，而分叉的代价（整段历史掉出 provider 前缀缓存）
 * 是静默且以 token 计的。要按运行态开关的内容一律是 Tier1。
 */
export function createCorePromptSegment(args: {
  id: string
  label: string
  source: PromptSegmentSource
  priority: number
  text: string
}): PromptSegmentDefinition {
  return {
    id: args.id,
    label: args.label,
    tier: 'core',
    source: args.source,
    priority: args.priority,
    render: () => args.text,
  }
}

export function createTextPromptSegment(args: {
  id: string
  label: string
  /** 行为知识层；缺省 Tier1。Tier0 走 {@link createCorePromptSegment}，此处不接受 `core`。 */
  tier?: Exclude<PromptSegmentTier, 'core'>
  source: PromptSegmentSource
  priority: number
  retention?: PromptSegmentRetention
  text: Nullable<string>
  when?: () => boolean
}): PromptSegmentDefinition {
  return {
    id: args.id,
    label: args.label,
    tier: args.tier ?? 'runtime',
    source: args.source,
    priority: args.priority,
    retention: args.retention,
    when: args.when,
    render: () => args.text,
  }
}

/**
 * Tier2 技能段（角色技能全文档位）。
 *
 * 技能索引承载用户显式选择，`retention: 'protected'` 保证该意图跨预算裁剪保留。
 */
export function createSkillPromptSegment(id: string, text: string): PromptSegmentDefinition {
  return createTextPromptSegment({
    id: `skill.${id}`,
    label: 'Role Skill',
    tier: 'skill',
    retention: 'protected',
    source: 'skill',
    priority: PromptSegmentPriority.skill,
    text,
  })
}

/** Tier2 技能段（主 Agent 本轮命中/选中的技能指针）。 */
export function createSelectedSkillPromptSegment(text: string): PromptSegmentDefinition {
  return createTextPromptSegment({
    id: 'skill.active',
    label: 'Active Skills',
    tier: 'skill',
    retention: 'protected',
    source: 'skill',
    priority: PromptSegmentPriority.skill,
    text,
  })
}
