import { isNotUndefined, isNumber } from '@velaros-ai/core'

import type { RunProfileDefinition, RunProfileRuntimePolicy } from '../../types/agent'
import type { RunProfileId, RunProfileSelectionId,ToolSurfaceProfileId } from '../../types/agent.js'
import type { AgentRunProfileCatalogSnapshot } from '../../types/runner.js'
import {
  assertRunProfileId,
  parseOptionalRunProfileSelectionId,
} from '../wire/typed-field-asserts'

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
    },
    automaticToolCategories: [],
  },
}

/** 只读 profile 目录；用于诊断和配置解释，不提供运行期覆盖 Ring 0/执行策略的 patch 入口。 */
function describeRunProfiles(): AgentRunProfileCatalogSnapshot {
  const profiles = Object.keys(RunProfileDefinitions)
    .sort()
    .map((id) => {
      const profile = RunProfileDefinitions[id as RunProfileId]
      return Object.freeze({
        ...profile,
        budget: Object.freeze({ ...profile.budget }),
        defaults: Object.freeze({ ...profile.defaults }),
        automaticToolCategories: Object.freeze([...profile.automaticToolCategories]),
      })
    })
  return Object.freeze({
    schemaVersion: 1,
    defaultSelection: DefaultRunProfileSelectionId,
    automaticSelection: Object.freeze({
      unknownContextWindowFallback: UnknownContextWindowFallback,
      balancedAtOrAbove: BalancedContextWindowThreshold,
      expandedAtOrAbove: ExpandedContextWindowThreshold,
    }),
    profiles: Object.freeze(profiles),
  })
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

/**
 * 判本次运行用哪个运行档，并把该档的默认值与预算一并带出（档位判定的唯一权威）。
 *
 * 显式指定了 compact/balanced/expanded 就用它（reason 记 `explicit`）；`auto` 或没指定时按模型上下文窗口分档：
 * < 192K 走 compact、≥ 1M 走 expanded、之间走 balanced。窗口未知时按 128_000 兜底——**兜底值落在 compact 区间**，
 * 即拿不准就保守收紧，而不是放开预算去赌窗口够大。`reason` 会写明分档依据（含阈值），供诊断复盘为什么是这一档。
 */
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

/**
 * {@link resolveRunProfilePolicyForRuntime} 的轻量出口：只要档位 id 与判档理由，不带默认值与预算。
 * 判档逻辑完全复用，不存在两套口径。
 */
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

/**
 * 取某个工具面档位的回退链：首项是它自己，后面是该面不可用时依次降级的目标
 * （如 `preset` → `guided` → `direct`；`direct` 是链底，不再降级）。
 * 传入未登记的档位时给 `[guided, direct]` 兜底，保证调用方永远拿得到一条非空链。
 */
function getToolSurfaceFallbackChain(
  profile: ToolSurfaceProfileId
): readonly ToolSurfaceProfileId[] {
  return ToolSurfaceFallbackChains[profile] ?? [DefaultToolSurfaceProfileId, 'direct']
}

export {
  AutoRunProfileSelectionId,
  DefaultRunProfileSelectionId,
  DefaultToolSurfaceProfileId,
  describeRunProfiles,
  getToolSurfaceFallbackChain,
  resolveRunProfileForRuntime,
  resolveRunProfilePolicyForRuntime,
  resolveRunProfileWorkingSetContextWindow,
  RunProfileDefinitions,
}
