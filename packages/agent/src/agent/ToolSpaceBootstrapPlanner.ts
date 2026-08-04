import type { ModelMessage } from 'ai'

import type { ToolCategoryId } from '@velaros-ai/agent/protocol'
import { isEmpty, isNumber, optionalWhen,toNullable, truncate } from '@velaros-ai/core'

import type { AgentRuntimeCapabilityPorts } from '../capabilities'

import {
  type AgentIntentSignalDomain,
  detectAgentIntentSignals,
  extractLatestUserTextFromMessages,
  isLowSignalIntentText,
  normalizeIntentText,
} from './IntentSignals'

const KernelDiscoveryTools = new Set(['tooling:map'])
const MaxForcedDiscoveryPerFingerprint = 2

type ToolSpaceBootstrapDecisionKind = 'none' | 'preload' | 'discover'

interface ToolSpaceBootstrapState {
  lastDecisionFingerprint?: string
  forcedDiscoveryCount?: number
  suppressedUntilTurn?: number
}

interface ToolSpaceBootstrapDecision {
  kind: ToolSpaceBootstrapDecisionKind
  reason?: string
}

interface ToolSpaceForcedToolChoice {
  type: 'tool'
  toolName: 'tooling:map'
}

interface ToolSpaceBootstrapPlannerInput {
  messages: ModelMessage[]
  currentVisibleToolNames: readonly string[]
  enabledToolCategories: readonly ToolCategoryId[]
  allowedToolCategories?: readonly ToolCategoryId[]
  capabilityPorts?: AgentRuntimeCapabilityPorts
  turn?: number
  state?: ToolSpaceBootstrapState
}

interface ToolSpaceBootstrapPlan {
  decision: ToolSpaceBootstrapDecision
  pageInCategories: ToolCategoryId[]
  pageInTools: string[]
  forcedToolChoice: Nullable<ToolSpaceForcedToolChoice>
  internalReminder: Nullable<string>
  nextState: ToolSpaceBootstrapState
}

interface IntentDomainMatch {
  id: AgentIntentSignalDomain
  categories: ToolCategoryId[]
  requiresDiscovery: boolean
}

function detectIntentDomains(
  text: string,
  capabilityPorts?: AgentRuntimeCapabilityPorts
): IntentDomainMatch[] {
  return detectAgentIntentSignals(text, capabilityPorts).domains
}

function resolveDiscoveryTool(_domains: readonly IntentDomainMatch[]): 'tooling:map' {
  return 'tooling:map'
}

function buildFingerprint(input: {
  kind: ToolSpaceBootstrapDecisionKind
  forcedToolName: Nullable<string>
  intentText: string
}): string {
  const toolPart = input.forcedToolName ?? 'none'
  return `${input.kind}:${toolPart}:${truncate(input.intentText, 80)}`
}

function shouldSuppressForcedDiscovery(input: {
  fingerprint: string
  state?: ToolSpaceBootstrapState
  turn?: number
}): boolean {
  if (
    isNumber(input.state?.suppressedUntilTurn) &&
    isNumber(input.turn) &&
    input.turn < input.state!.suppressedUntilTurn!
  ) return true

  return (
    input.state?.lastDecisionFingerprint === input.fingerprint &&
    (input.state?.forcedDiscoveryCount ?? 0) >= MaxForcedDiscoveryPerFingerprint
  )
}

function buildNextState(input: {
  fingerprint: string
  forced: boolean
  suppressed: boolean
  state?: ToolSpaceBootstrapState
}): ToolSpaceBootstrapState {
  if (!input.forced || input.suppressed) return {
      ...input.state,
      lastDecisionFingerprint: input.fingerprint,
    }

  const previousCount =
    input.state?.lastDecisionFingerprint === input.fingerprint
      ? input.state?.forcedDiscoveryCount ?? 0
      : 0

  return {
    ...input.state,
    lastDecisionFingerprint: input.fingerprint,
    forcedDiscoveryCount: previousCount + 1,
  }
}

function markToolSpaceBootstrapDiscoverySatisfied(
  state: ToolSpaceBootstrapState
): ToolSpaceBootstrapState {
  if (!state.lastDecisionFingerprint) return state

  return {
    ...state,
    forcedDiscoveryCount: Math.max(
      state.forcedDiscoveryCount ?? 0,
      MaxForcedDiscoveryPerFingerprint
    ),
  }
}

function buildDiscoveryReminder(input: {
  toolName: 'tooling:map'
  intentText: string
  pageInCategories: readonly ToolCategoryId[]
  complex: boolean
}): string {
  const categoryText = !isEmpty(input.pageInCategories)
    ? `已预换入候选类别：${input.pageInCategories.join('、')}。`
    : '当前不自动换入高风险或需用户动作的类别。'
  const scopeText = input.complex
    ? '这是跨域或多能力任务，先建立全局工具地图。'
    : '这是需要工具空间确认的任务，先查候选工具页。'

  return [
    `[系统] ContextOS 工具空间启动：${scopeText}`,
    categoryText,
    `本轮必须先调用 ${input.toolName}，按最近用户意图选择 op="find" 或 op="map"，必要时用 domainIds、toolOsStates 或 categoryIds 收窄。`,
    '不要在未确认工具页状态、依赖和 schema 前直接用现有工具凑答案。',
  ].join('\n')
}

function planToolSpaceBootstrap(input: ToolSpaceBootstrapPlannerInput): ToolSpaceBootstrapPlan {
  const latestUserText = extractLatestUserTextFromMessages(input.messages)
  const intentText = normalizeIntentText(latestUserText ?? '')
  const emptyState: ToolSpaceBootstrapState = input.state ?? {}

  if (isLowSignalIntentText(intentText)) return {
      decision: { kind: 'none' },
      pageInCategories: [],
      pageInTools: [],
      forcedToolChoice: null,
      internalReminder: null,
      nextState: emptyState,
    }

  const domains = detectIntentDomains(intentText, input.capabilityPorts)
  const pageInCategories = [
    ...new Set(
      domains
        .flatMap((domain) => domain.categories)
        .filter((categoryId) => !input.enabledToolCategories.includes(categoryId))
    ),
  ]

  if (isEmpty(domains) && isEmpty(pageInCategories)) return {
      decision: { kind: 'none' },
      pageInCategories: [],
      pageInTools: [],
      forcedToolChoice: null,
      internalReminder: null,
      nextState: emptyState,
    }

  // 已确认的发现策略：只有意图模糊（capability-uncertainty 命中的 unknown 域）或跨 ≥2 能力域的
  // 复杂任务才强制全局 tooling:map 发现；能直接定位到具体类别（如 category-*）的单域意图改走静默
  // 预载（下方 pageInCategories → 'preload'），不再每次干活前都逼模型先调一次 tooling:map。
  const complex = domains.length >= 2 || domains.some((domain) => domain.id === 'unknown')
  const hasDiscoveryNeed = complex
  const requestedDiscoveryTool = hasDiscoveryNeed ? resolveDiscoveryTool(domains) : null
  const discoveryToolVisible =
    requestedDiscoveryTool && input.currentVisibleToolNames.includes(requestedDiscoveryTool)
  const forcedToolChoice =
    requestedDiscoveryTool && discoveryToolVisible && KernelDiscoveryTools.has(requestedDiscoveryTool)
      ? ({ type: 'tool', toolName: requestedDiscoveryTool } satisfies ToolSpaceForcedToolChoice)
      : null
  const decisionKind: ToolSpaceBootstrapDecisionKind = forcedToolChoice ? 'discover' : 'preload'
  const fingerprint = buildFingerprint({
    kind: decisionKind,
    forcedToolName: toNullable(forcedToolChoice?.toolName),
    intentText,
  })
  const suppressed = shouldSuppressForcedDiscovery({
    fingerprint,
    state: input.state,
    turn: input.turn,
  })
  const effectiveForcedToolChoice = suppressed ? null : forcedToolChoice
  const effectiveDecisionKind: ToolSpaceBootstrapDecisionKind = effectiveForcedToolChoice
    ? 'discover'
    : !isEmpty(pageInCategories)
      ? 'preload'
      : 'none'
  return {
    decision: {
      kind: effectiveDecisionKind,
      reason: effectiveForcedToolChoice
        ? complex
          ? 'complex-multi-domain-discovery'
          : 'intent-discovery'
        : optionalWhen(!isEmpty(pageInCategories), 'intent-preload'),
    },
    pageInCategories,
    pageInTools: [],
    forcedToolChoice: effectiveForcedToolChoice,
    internalReminder: effectiveForcedToolChoice
      ? buildDiscoveryReminder({
          toolName: effectiveForcedToolChoice.toolName,
          intentText,
          pageInCategories,
          complex,
        })
      : null,
    nextState: buildNextState({
      fingerprint,
      forced: !!forcedToolChoice,
      suppressed,
      state: input.state,
    }),
  }
}

export { planToolSpaceBootstrap }
export { markToolSpaceBootstrapDiscoverySatisfied }
export type {
  ToolSpaceBootstrapDecision,
  ToolSpaceBootstrapPlan,
  ToolSpaceBootstrapPlannerInput,
  ToolSpaceBootstrapState,
}
