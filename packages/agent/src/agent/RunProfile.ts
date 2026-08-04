import type {
  RunProfileId,
  ToolDescriptor,
  ToolExposurePolicy,
  ToolExposureProfilePolicy,
  ToolExposureTier,
} from '@velaros-ai/agent/protocol'
import { isBoolean, isEmpty,isNumber, isPresent, isTrue, numberOrNull } from '@velaros-ai/core'

import { compareStableStrings } from './context/residency/determinism'
import {
  resolveRunProfileForRuntime,
  resolveRunProfilePolicyForRuntime,
  resolveRunProfileWorkingSetContextWindow,
  RunProfileDefinitions,
} from './RuntimeProfiles'

interface ResolvedToolExposure {
  tier: ToolExposureTier
  rank: number
  rankBoost: number
  categoryRank: number
  alwaysResident: boolean
}

const ToolExposureTierRank: Record<ToolExposureTier, number> = {
  essential: 0,
  common: 1_000,
  situational: 2_000,
  specialized: 3_000,
  experimental: 4_000,
}

function mergeToolExposurePolicies(
  ...policies: Array<LooseOptional<ToolExposurePolicy>>
): ToolExposurePolicy {
  const merged: ToolExposurePolicy = {}

  for (const policy of policies) {
    if (!policy) {
      continue
    }

    if (policy.tier) {
      merged.tier = policy.tier
    }
    if (isNumber(policy.rank)) {
      merged.rank = policy.rank
    }
    if (isBoolean(policy.alwaysResident)) {
      merged.alwaysResident = policy.alwaysResident
    }
    if (policy.profiles) {
      merged.profiles ??= {}
      for (const [profile, profilePolicy] of Object.entries(policy.profiles) as Array<
        [RunProfileId, ToolExposureProfilePolicy]
      >) {
        merged.profiles[profile] = {
          ...(merged.profiles[profile] ?? {}),
          ...profilePolicy,
        }
      }
    }
  }

  return merged
}

function resolveToolExposure(
  toolName: string,
  profile: RunProfileId,
  descriptor?: ToolDescriptor
): ResolvedToolExposure {
  const exposure = mergeToolExposurePolicies(descriptor?.exposure)
  const profilePolicy = exposure.profiles?.[profile]
  const alwaysResident = profilePolicy?.alwaysResident ?? isTrue(exposure.alwaysResident)
  const categoryRank = Number.MAX_SAFE_INTEGER

  return {
    tier: exposure.tier ?? 'specialized',
    rank: exposure.rank ?? Number.MAX_SAFE_INTEGER,
    rankBoost: profilePolicy?.rankBoost ?? 0,
    categoryRank,
    alwaysResident,
  }
}

function getToolExposureScore(exposure: ResolvedToolExposure): number {
  return ToolExposureTierRank[exposure.tier] + exposure.rank + exposure.rankBoost
}

function getSchemaSizePenalty(
  toolName: string,
  toolSchemaChars?: Readonly<Record<string, number>>
): number {
  const chars = toolSchemaChars?.[toolName]
  if (!isNumber(chars) || chars <= 0) return 0

  return Math.ceil(chars / 1_000)
}

/** 单个工具最多可获得的“热度”分数减免；上限约一个 tier，避免热工具完全压倒能力分级。 */
const MaxToolHotnessBoost = 80
const ToolHotnessUnit = 8

/**
 * 冷热感知减分：本会话用过越多次的工具分数越低（排序越靠前 → 越不易被换出）。
 * 这让“工作集”在触达字节预算时优先存活，类似 OS 的 LRU/工作集页面置换。
 */
function getToolHotnessBoost(
  toolName: string,
  toolUsageScores?: Readonly<Record<string, number>>
): number {
  const uses = toolUsageScores?.[toolName]
  if (!isNumber(uses) || uses <= 0) return 0

  return Math.min(MaxToolHotnessBoost, uses * ToolHotnessUnit)
}

function sortToolsByBudgetPriority(
  tools: string[],
  profile: RunProfileId,
  toolDescriptorByName: ReadonlyMap<string, ToolDescriptor>,
  toolSchemaChars?: Readonly<Record<string, number>>,
  toolUsageScores?: Readonly<Record<string, number>>,
  protectedToolSet?: ReadonlySet<string>
): string[] {
  return [...tools].sort((left, right) => {
    const leftExposure = resolveToolExposure(left, profile, toolDescriptorByName.get(left))
    const rightExposure = resolveToolExposure(right, profile, toolDescriptorByName.get(right))
    const leftScore =
      getToolExposureScore(leftExposure) +
      getSchemaSizePenalty(left, toolSchemaChars) -
      getToolHotnessBoost(left, toolUsageScores) -
      getToolResidentBoost(left, protectedToolSet)
    const rightScore =
      getToolExposureScore(rightExposure) +
      getSchemaSizePenalty(right, toolSchemaChars) -
      getToolHotnessBoost(right, toolUsageScores) -
      getToolResidentBoost(right, protectedToolSet)
    if (leftScore !== rightScore) return leftScore - rightScore

    if (leftExposure.categoryRank !== rightExposure.categoryRank) return leftExposure.categoryRank - rightExposure.categoryRank

    // P7-2：同档位内的工具序进 prompt 字节，禁 locale 相关比较。
    return compareStableStrings(left, right)
  })
}

const ToolResidentBoost = 1_500

function getToolResidentBoost(toolName: string, protectedToolSet?: ReadonlySet<string>): number {
  return protectedToolSet?.has(toolName) ? ToolResidentBoost : 0
}

const ToolCountSoftOverageRatio = 0.15
const ToolCountSoftOverageMin = 2

function getSoftToolCountLimit(maxToolCount: Nullable<number>): Nullable<number> {
  if (!isNumber(maxToolCount)) return null

  return (
    maxToolCount +
    Math.max(ToolCountSoftOverageMin, Math.ceil(maxToolCount * ToolCountSoftOverageRatio))
  )
}

function applyToolCountBudget(
  tools: string[],
  maxToolCount: Nullable<number>,
  options: { soft: boolean }
): string[] {
  const limit = options.soft ? getSoftToolCountLimit(maxToolCount) : maxToolCount
  if (!isNumber(limit)) return tools

  return tools.slice(0, limit)
}

function sumToolSchemaChars(
  tools: readonly string[],
  toolSchemaChars: Readonly<Record<string, number>>
): number {
  return tools.reduce((total, toolName) => total + Math.max(0, toolSchemaChars[toolName] ?? 0), 0)
}

function resolveEffectiveMaxToolSchemaChars(input: {
  profile: RunProfileId
  profileMaxToolSchemaChars: Nullable<number>
  dynamicMaxToolSchemaChars?: LooseOptional<number>
}): Nullable<number> {
  if (isNumber(input.profileMaxToolSchemaChars) && isNumber(input.dynamicMaxToolSchemaChars)) return Math.min(input.profileMaxToolSchemaChars, input.dynamicMaxToolSchemaChars)

  if (isNumber(input.profileMaxToolSchemaChars)) return input.profileMaxToolSchemaChars

  return numberOrNull(input.dynamicMaxToolSchemaChars)
}

function applyRunProfileToolExposure(
  allowedTools: string[],
  profile: RunProfileId,
  options: {
    protectedTools?: readonly string[]
    toolDescriptors?: readonly ToolDescriptor[]
    toolSchemaChars?: Readonly<Record<string, number>>
    /**
     * 由 ContextOS 预算调度器按真实窗口算出的工具 schema 区字节预算。
     * 提供时覆盖档位静态 maxToolSchemaChars，使工具换页随模型窗口动态伸缩。
     */
    maxToolSchemaCharsOverride?: LooseOptional<number>
    /** 工具运行时使用计数（冷热感知换页用，热工具在淘汰时优先存活）。 */
    toolUsageScores?: Readonly<Record<string, number>>
  } = {}
): {
  allowedTools: string[]
  droppedTools: string[]
  maxToolCount: Nullable<number>
} {
  const definition = RunProfileDefinitions[profile]
  const maxToolCount = definition.budget.maxToolCount
  const maxToolSchemaChars = resolveEffectiveMaxToolSchemaChars({
    profile,
    profileMaxToolSchemaChars: definition.budget.maxToolSchemaChars,
    dynamicMaxToolSchemaChars: options.maxToolSchemaCharsOverride,
  })
  const protectedToolSet = new Set(options.protectedTools ?? [])
  const toolDescriptorByName = new Map(
    (options.toolDescriptors ?? []).map((tool) => [tool.name, tool])
  )
  // 工具 schema 字节预算只有在“档位或 ContextOS 提供了字节上限”且“调用方提供了各工具实测字节”时才生效。
  // 生效时它是动态工具空间的主约束；maxToolCount 只作为带容错的软护栏。
  const schemaBudgetActive = isNumber(maxToolSchemaChars) && isPresent(options.toolSchemaChars)
  // 两角色模型（已移除「只换入」的结构件层）：
  // - pinned（alwaysResident/protected）：先占预算、不淘汰；
  // - pooled（其余全部）：按分数排队，预算够就常驻、装不下才掉成可换入。
  // 因此每个 allowedTool 都是候选，是否常驻只由「是否 pinned」和「预算」决定，不再有默认隐藏。
  const candidateTools = [...allowedTools]
  const residentTools = candidateTools.filter(
    (toolName) =>
      protectedToolSet.has(toolName) ||
      resolveToolExposure(toolName, profile, toolDescriptorByName.get(toolName)).alwaysResident
  )
  const residentToolSet = new Set(residentTools)
  const pageableTools = candidateTools.filter((toolName) => !residentToolSet.has(toolName))
  const orderedResidentTools =
    residentTools.length > 1
      ? sortToolsByBudgetPriority(
          residentTools,
          profile,
          toolDescriptorByName,
          options.toolSchemaChars,
          options.toolUsageScores,
          protectedToolSet
        )
      : residentTools
  // compact 本就按预算优先级排序；当字节预算生效时，无数量上限的档位也需要排序，
  // 以便在触达字节上限时优先保留高价值（低分）工具，淘汰最“冷”的大 schema 工具。
  const orderedTools =
    profile === 'compact' || schemaBudgetActive
      ? sortToolsByBudgetPriority(
          pageableTools,
          profile,
          toolDescriptorByName,
          options.toolSchemaChars,
          options.toolUsageScores,
          protectedToolSet
        )
      : pageableTools
  const pageableSchemaBudget = schemaBudgetActive
    ? Math.max(
        0,
        maxToolSchemaChars! - sumToolSchemaChars(orderedResidentTools, options.toolSchemaChars!)
      )
    : null
  const exposedToolLimit = schemaBudgetActive
    ? getSoftToolCountLimit(maxToolCount)
    : maxToolCount
  const pageableToolLimit = isNumber(exposedToolLimit)
    ? Math.max(0, exposedToolLimit - orderedResidentTools.length)
    : null
  const exposedPageableTools = schemaBudgetActive
    ? applyToolCountBudget(
        applyToolSchemaCharBudget(orderedTools, {
          maxToolSchemaChars: pageableSchemaBudget!,
          toolSchemaChars: options.toolSchemaChars!,
          allowOversizeFirst: isEmpty(orderedResidentTools),
        }),
        pageableToolLimit,
        { soft: false }
      )
    : applyToolCountBudget(orderedTools, pageableToolLimit, { soft: false })
  const exposedTools = [...new Set([...orderedResidentTools, ...exposedPageableTools])]
  const exposedSet = new Set(exposedTools)

  return {
    allowedTools: exposedTools,
    droppedTools: allowedTools.filter((toolName) => !exposedSet.has(toolName)),
    maxToolCount,
  }
}

/**
 * 工具换页：在已按优先级排序的工具上，按累计 schema 字节预算逐个保留，超出即淘汰。
 * page-in 工具只提升优先级，不再无限绕过预算；这是动态工具空间的硬保证。
 */
function applyToolSchemaCharBudget(
  tools: string[],
  options: {
    maxToolSchemaChars: number
    toolSchemaChars: Readonly<Record<string, number>>
    allowOversizeFirst?: boolean
  }
): string[] {
  const budget = Math.max(0, options.maxToolSchemaChars)
  let used = 0
  const kept: string[] = []

  for (const toolName of tools) {
    const cost = Math.max(0, options.toolSchemaChars[toolName] ?? 0)
    if (used + cost > budget && (!options.allowOversizeFirst || !isEmpty(kept))) {
      continue
    }

    kept.push(toolName)
    used += cost
  }

  return kept
}

export {
  applyRunProfileToolExposure,
  resolveRunProfileForRuntime,
  resolveRunProfilePolicyForRuntime,
  resolveRunProfileWorkingSetContextWindow,
  RunProfileDefinitions,
}
