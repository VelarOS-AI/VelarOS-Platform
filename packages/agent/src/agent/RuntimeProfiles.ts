import type {
  RunProfileDefinition,
  RunProfileId,
  RunProfileRuntimePolicy,
  RunProfileSelectionId,
  ToolSurfaceProfileId,
} from '@velaros-ai/agent/protocol'
import {
  assertRunProfileId,
  parseOptionalRunProfileSelectionId,
} from '@velaros-ai/agent/protocol'
import { isNotUndefined, isNumber } from '@velaros-ai/core'

const AutoRunProfileSelectionId: RunProfileSelectionId = 'auto'
const DefaultRunProfileSelectionId: RunProfileSelectionId = AutoRunProfileSelectionId
const DefaultToolSurfaceProfileId = 'guided' as const satisfies ToolSurfaceProfileId
const UnknownContextWindowFallback = 128_000
const BalancedContextWindowThreshold = 192_000
const ExpandedContextWindowThreshold = 1_000_000

const RunProfileDefinitions: Record<RunProfileId, RunProfileDefinition> = {
  compact: {
    id: 'compact',
    label: 'Compact',
    description: 'Bounded runtime profile for smaller context windows.',
    budget: {
      maxToolCount: 32,
      maxSystemPromptChars: 80_000,
      maxInputWorkingSetTokens: 48_000,
      maxToolSchemaChars: 48_000,
    },
    defaults: {
      thinkingDepth: 'fast',
      toolSurfaceProfile: 'guided',
      modelRequestPolicy: { temperature: 0.15, topP: 0.85, maxOutputTokens: 8192 },
    },
    automaticToolCategories: [],
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    description: 'Default runtime profile for medium and large context windows.',
    budget: {
      maxToolCount: 64,
      maxSystemPromptChars: 220_000,
      maxInputWorkingSetTokens: 96_000,
      maxToolSchemaChars: 96_000,
    },
    defaults: {
      thinkingDepth: 'balanced',
      toolSurfaceProfile: 'direct',
      modelRequestPolicy: { temperature: 0.2, topP: 0.9, maxOutputTokens: 16_384 },
    },
    automaticToolCategories: [],
  },
  expanded: {
    id: 'expanded',
    label: 'Expanded',
    description: 'Broad but cognitively bounded runtime profile for very large context windows.',
    budget: {
      maxToolCount: 128,
      maxSystemPromptChars: null,
      maxInputWorkingSetTokens: 192_000,
      maxToolSchemaChars: 192_000,
    },
    defaults: {
      thinkingDepth: 'deep',
      toolSurfaceProfile: 'expert',
      modelRequestPolicy: { temperature: 0.25, topP: 0.95, maxOutputTokens: 32_768 },
    },
    automaticToolCategories: [],
  },
}

/**
 * 物理模型窗口定义“最多能装多少”，run profile 定义“本次运行允许长期携带多少”。
 * 两者取较小值，使 compact/balanced/expanded 的成本语义不随 1M 等大窗口模型失效。
 */
function resolveRunProfileWorkingSetContextWindow(input: {
  physicalContextWindow: number
  profile: RunProfileId
}): number {
  const physicalContextWindow = Math.max(1, Math.floor(input.physicalContextWindow))
  const limit = RunProfileDefinitions[input.profile].budget.maxInputWorkingSetTokens
  return isNumber(limit)
    ? Math.min(physicalContextWindow, Math.max(1, Math.floor(limit)))
    : physicalContextWindow
}

function resolveRunProfilePolicyForRuntime(input: {
  requested?: LooseOptional<unknown>
  contextWindow?: LooseOptional<number>
  model?: LooseOptional<string>
}): RunProfileRuntimePolicy {
  const explicitSelection = parseOptionalRunProfileSelectionId(
    input.requested,
    'runProfile.requested'
  )
  const requested = explicitSelection ?? DefaultRunProfileSelectionId
  const contextWindow = isNumber(input.contextWindow)
    ? input.contextWindow
    : UnknownContextWindowFallback
  let profile: RunProfileId
  let reason: string

  if (isNotUndefined(explicitSelection) && explicitSelection !== AutoRunProfileSelectionId) {
    profile = assertRunProfileId(explicitSelection, 'runProfile.requested')
    reason = 'explicit'
  } else if (contextWindow < BalancedContextWindowThreshold) {
    profile = 'compact'
    reason = `context-window<${BalancedContextWindowThreshold}`
  } else if (contextWindow >= ExpandedContextWindowThreshold) {
    profile = 'expanded'
    reason = `context-window>=${ExpandedContextWindowThreshold}`
  } else {
    profile = 'balanced'
    reason = 'context-window-default'
  }

  const definition = RunProfileDefinitions[profile]
  return {
    requested,
    profile,
    reason,
    contextWindow,
    defaults: definition.defaults,
    budget: definition.budget,
  }
}

function resolveRunProfileForRuntime(input: {
  requested?: LooseOptional<unknown>
  contextWindow?: LooseOptional<number>
  model?: LooseOptional<string>
}): { profile: RunProfileId; reason: string } {
  const policy = resolveRunProfilePolicyForRuntime(input)
  return { profile: policy.profile, reason: policy.reason }
}

const ToolSurfaceFallbackChains: Record<
  ToolSurfaceProfileId,
  readonly ToolSurfaceProfileId[]
> = {
  preset: ['preset', 'guided', 'direct'],
  guided: ['guided', 'preset', 'direct'],
  direct: ['direct'],
  expert: ['expert', 'direct'],
}

function getToolSurfaceFallbackChain(
  profile: ToolSurfaceProfileId
): readonly ToolSurfaceProfileId[] {
  return ToolSurfaceFallbackChains[profile] ?? [DefaultToolSurfaceProfileId, 'direct']
}

export {
  AutoRunProfileSelectionId,
  DefaultRunProfileSelectionId,
  DefaultToolSurfaceProfileId,
  getToolSurfaceFallbackChain,
  resolveRunProfileForRuntime,
  resolveRunProfilePolicyForRuntime,
  resolveRunProfileWorkingSetContextWindow,
  RunProfileDefinitions,
}
