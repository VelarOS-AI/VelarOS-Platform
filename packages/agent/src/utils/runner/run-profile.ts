import { isBoolean, isEmpty,isNumber, isPresent, isTrue, numberOrNull } from '@velaros-ai/core'

import type { RunProfileId,ToolDescriptor, ToolExposurePolicy, ToolExposureProfilePolicy, ToolExposureTier } from '../../types/agent.js'
import type { ResolvedToolExposure } from '../../types/runner.js'
import { compareStableStrings } from '../residency/determinism'
import { AgentTuning } from '../tuning'

import {
  describeRunProfiles,
  resolveRunProfileForRuntime,
  resolveRunProfilePolicyForRuntime,
  resolveRunProfileWorkingSetContextWindow,
  RunProfileDefinitions,
} from './runtime-profiles'

const ToolExposureTierRank: Record<ToolExposureTier, number> = {
  essential: 0,
  common: 1_000,
  situational: 2_000,
  specialized: 3_000,
  experimental: 4_000,
}

/**
 * 按传入顺序叠加多份工具暴露策略，**后者覆盖前者**（所以越靠后的越像"更具体的一层"）。
 * 只有显式给了值的字段才参与覆盖：tier 非空、rank 是数字、alwaysResident 是布尔才写入，
 * 因此上一层的设置不会被下一层的缺省字段抹掉。`profiles` 逐档位浅合并而不是整块替换，
 * 一层只调某一档的 rankBoost 时，其余档位保持原样。
 */
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

/**
 * 算出某个工具在某个运行档下的最终暴露参数（tier / rank / rankBoost / 是否常驻）。
 *
 * 描述符没声明时的缺省是刻意保守的：tier 取 `specialized`、rank 取 `MAX_SAFE_INTEGER`，
 * 也就是**没登记过暴露策略的工具排在最后**，预算紧张时最先被换出——新工具想常驻必须显式声明。
 * alwaysResident 由档位级设置优先，档位没说才看工具的全局设置。
 */
function resolveToolExposure(
  toolName: string,
  profile: RunProfileId,
  descriptor?: ToolDescriptor
): ResolvedToolExposure {
  const exposure = mergeToolExposurePolicies(descriptor?.exposure)
  const profilePolicy = exposure.profiles?.[profile]
  const alwaysResident = profilePolicy?.alwaysResident ?? isTrue(exposure.alwaysResident)

  return {
    tier: exposure.tier ?? 'specialized',
    rank: exposure.rank ?? Number.MAX_SAFE_INTEGER,
    rankBoost: profilePolicy?.rankBoost ?? 0,
    alwaysResident,
  }
}

/**
 * 把暴露参数压成一个排序分：tier 基分 + rank + 该档位的 rankBoost。**分越低越优先**（越不易被换出）。
 * tier 基分之间隔 1000，所以同一 tier 内的 rank 微调不会越过 tier 边界；要跨 tier 提优先级只能靠
 * 负的 rankBoost 或常驻标记。
 */
function getToolExposureScore(exposure: ResolvedToolExposure): number {
  return ToolExposureTierRank[exposure.tier] + exposure.rank + exposure.rankBoost
}

/**
 * schema 体积罚分：每满 1000 字符加 1 分（向上取整），让同等价值下"schema 更胖"的工具先被换出。
 * 没有实测字节或字节数 ≤ 0 时不罚——量不到就别猜，宁可按纯能力分级排。
 */
function getSchemaSizePenalty(
  toolName: string,
  toolSchemaChars?: Readonly<Record<string, number>>
): number {
  const chars = toolSchemaChars?.[toolName]
  if (!isNumber(chars) || chars <= 0) return 0

  return Math.ceil(chars / 1_000)
}

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

  return Math.min(
    AgentTuning.runProfile.maxToolHotnessBoost,
    uses * AgentTuning.runProfile.toolHotnessUnit
  )
}

/**
 * 按"该不该留在提示词里"给工具排序（升序，**排在前面的先存活**），不改入参数组。
 *
 * 分数 = 能力分级分 + schema 体积罚分 − 本会话热度减分 − 常驻保护减分，四项合起来表达
 * 「越重要、越小、越常用、越受保护的越靠前」。分数相同时按 {@link compareStableStrings} 的码元序定序：
 * 工具序会进提示词字节，必须跨机器稳定，因此不用 `localeCompare`。
 */
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

    // 这里曾有一级 categoryRank 次级排序（2026-08-06 删）：唯一的生产者把它硬编码成
    // `Number.MAX_SAFE_INTEGER`，两边恒相等，比较永不生效。工具序的权威只有分数 + 稳定串序。
    // P7-2：同档位内的工具序进 prompt 字节，禁 locale 相关比较。
    return compareStableStrings(left, right)
  })
}

/**
 * 受保护工具的排序减分：命中保护集给 1500，否则 0。
 * 1500 比一个 tier 的间隔（1000）还大，保证被保护的工具能跨越一整级 tier 排到前面去。
 */
function getToolResidentBoost(toolName: string, protectedToolSet?: ReadonlySet<string>): number {
  return protectedToolSet?.has(toolName) ? AgentTuning.runProfile.toolResidentBoost : 0
}

/**
 * 把工具数量硬上限放宽成"软上限"：额外允许超出 15%，且至少多给 2 个。
 * 字节预算生效时数量只是护栏，主约束是 schema 字节；留这点余量是为了不让一两个的数量差
 * 把字节预算内本可暴露的工具挡在外面。`maxToolCount` 为空（该档不限数量）时返回 null，照样不限。
 */
function getSoftToolCountLimit(maxToolCount: Nullable<number>): Nullable<number> {
  if (!isNumber(maxToolCount)) return null

  return (
    maxToolCount +
    Math.max(
      AgentTuning.runProfile.toolCountSoftOverageMin,
      Math.ceil(maxToolCount * AgentTuning.runProfile.toolCountSoftOverageRatio)
    )
  )
}

/**
 * 按数量上限截断已排好序的工具表：`soft` 为真时用放宽后的软上限，否则用硬上限。
 * 上限为空表示不限数量，原样返回。直接 `slice` 掐尾，所以**必须先排序再调**——
 * 顺序就是优先级，掉在后面的即被淘汰（它们会进 droppedTools，模型仍可按需换页调回来）。
 */
function applyToolCountBudget(
  tools: string[],
  maxToolCount: Nullable<number>,
  options: { soft: boolean }
): string[] {
  const limit = options.soft ? getSoftToolCountLimit(maxToolCount) : maxToolCount
  if (!isNumber(limit)) return tools

  return tools.slice(0, limit)
}

/**
 * 累加一组工具的 schema 字符数。表里查不到的工具按 0 计，负数也夹到 0，
 * 保证总和不会因为个别脏数据变成负值而把预算算大。
 */
function sumToolSchemaChars(
  tools: readonly string[],
  toolSchemaChars: Readonly<Record<string, number>>
): number {
  return tools.reduce((total, toolName) => total + Math.max(0, toolSchemaChars[toolName] ?? 0), 0)
}

/**
 * 定本次生效的工具 schema 字节上限：档位静态值与 ContextOS 动态值都在就**取较小者**（两边都是上限，谁更紧听谁的），
 * 只有一个就用那个，都没有返回 null = 不启用字节预算（此时只剩数量护栏）。
 */
function resolveEffectiveMaxToolSchemaChars(input: {
  profile: RunProfileId
  profileMaxToolSchemaChars: Nullable<number>
  dynamicMaxToolSchemaChars?: LooseOptional<number>
}): Nullable<number> {
  if (isNumber(input.profileMaxToolSchemaChars) && isNumber(input.dynamicMaxToolSchemaChars)) return Math.min(input.profileMaxToolSchemaChars, input.dynamicMaxToolSchemaChars)

  if (isNumber(input.profileMaxToolSchemaChars)) return input.profileMaxToolSchemaChars

  return numberOrNull(input.dynamicMaxToolSchemaChars)
}

/**
 * 工具换页的总入口：把"本次允许的全部工具"按运行档预算裁成"这一轮真正写进提示词的那些"，
 * 并原样交回被换出的名单（`droppedTools` 不是丢弃，模型可按需把它们换页调回来）。
 *
 * 工具分两角色：pinned（受保护或声明了 alwaysResident）先占预算、永不淘汰；其余全是 pooled，
 * 按 {@link sortToolsByBudgetPriority} 排队，预算装得下就常驻、装不下才掉进 droppedTools。
 * 字节预算只在"有字节上限且调用方给了各工具实测字节"时才生效，生效时它是主约束、数量上限退为软护栏；
 * 不生效时退化成纯按数量截断。pinned 占用会先从字节预算里扣掉，剩下的才给 pooled 用。
 * 边界：pinned 为空时允许第一个 pooled 工具超额入选（`allowOversizeFirst`），避免预算太小导致
 * **一个工具都暴露不出来**——没有工具的模型比超一点预算糟得多。
 */
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
  describeRunProfiles,
  resolveRunProfileForRuntime,
  resolveRunProfilePolicyForRuntime,
  resolveRunProfileWorkingSetContextWindow,
  RunProfileDefinitions,
}
