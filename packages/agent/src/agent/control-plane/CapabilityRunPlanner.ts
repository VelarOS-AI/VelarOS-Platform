import type {
  CapabilityScopeId,
  RunProfileId,
  ToolCategoryId,
  ToolDescriptor,
} from '@velaros-ai/agent/protocol'
import { isEmpty } from '@velaros-ai/core'

import {
  type AgentRuntimeCapabilityPorts,
  expandCapabilityCategoryIds,
  resolveCapabilityScopePolicy,
  resolveCapabilityScopeResidency,
} from '../../capabilities'
import { resolveSoloLoopTools } from '../LoopRuntime'
import { applyRunProfileToolExposure } from '../RunProfile'
import {
  planToolSpaceBootstrap,
  type ToolSpaceBootstrapState,
} from '../ToolSpaceBootstrapPlanner'

import type { CapabilityRunPlan, ToolPageFault } from './AgentRunPlan'

interface ToolCategory<TTool extends { name: string } = ToolDescriptor> {
  category: { id: ToolCategoryId }
  tools: TTool[]
}

export interface PlanCapabilityRunInput {
  messages: Parameters<typeof planToolSpaceBootstrap>[0]['messages']
  runProfile: RunProfileId
  configuredTools?: string[]
  roleAllowedTools: string[]
  currentVisibleToolNames: readonly string[]
  enabledToolCategoryIds: readonly ToolCategoryId[]
  budgetOverrideToolCategoryIds: readonly ToolCategoryId[]
  budgetOverrideToolNames: readonly string[]
  visibleEnabledToolCategories: Array<ToolCategory<ToolDescriptor>>
  runtimeToolCategories: Array<ToolCategory<ToolDescriptor>>
  allowedToolCategoryIds: readonly ToolCategoryId[]
  capabilityPorts?: AgentRuntimeCapabilityPorts
  capabilityScopeId?: CapabilityScopeId
  turn: number
  toolSchemaChars?: Readonly<Record<string, number>>
  toolSchemaCharBudget: number
  toolUsageScores?: Readonly<Record<string, number>>
  bootstrapState?: ToolSpaceBootstrapState
  collectNewlyEvictedPagedInTools?: (evictedToolNames: readonly string[]) => readonly string[]
}

export interface ResolveCapabilityPageFaultsInput {
  requestedForcedToolChoice?: LooseOptional<{ type: 'tool'; toolName: string }>
  resolvedForcedToolChoice?: LooseOptional<{ type: 'tool'; toolName: string }>
  enabledToolDescriptors: readonly ToolDescriptor[]
  baseAllowedToolNames: readonly string[]
  droppedToolNames: readonly string[]
  budgetOverrideToolNames: readonly string[]
  collectNewlyEvictedPagedInTools?: (evictedToolNames: readonly string[]) => readonly string[]
}

class CapabilityRunPlanner {
  public plan(input: PlanCapabilityRunInput): CapabilityRunPlan {
    const bootstrap = planToolSpaceBootstrap({
      messages: input.messages,
      currentVisibleToolNames: [
        ...new Set([...input.currentVisibleToolNames, 'tooling:map']),
      ],
      enabledToolCategories: input.enabledToolCategoryIds,
      allowedToolCategories: input.allowedToolCategoryIds,
      capabilityPorts: input.capabilityPorts,
      turn: input.turn,
      state: input.bootstrapState,
    })
    const nextEnabledCategoryIds = [
      ...new Set([...input.enabledToolCategoryIds, ...bootstrap.pageInCategories]),
    ]
    const nextBudgetOverrideCategoryIds = [
      ...new Set([...input.budgetOverrideToolCategoryIds, ...bootstrap.pageInCategories]),
    ]
    const enabledToolCategories = this.resolveToolCategoriesForExposure({
      visibleEnabledToolCategories: input.visibleEnabledToolCategories,
      runtimeToolCategories: input.runtimeToolCategories,
      enabledToolCategoryIds: nextEnabledCategoryIds,
      budgetOverrideToolCategoryIds: nextBudgetOverrideCategoryIds,
    })
    const residency = resolveCapabilityScopeResidency(input.capabilityPorts, {
      scopeId: input.capabilityScopeId,
    })
    // 类别换入 = 准入，不是驻留。宿主声明了 residency 时，被换入的类别只把它**声明常驻**的
    // 那几个工具钉进每轮请求，其余留在 loadable，由模型按名换入。否则一次类别授权就把整个
    // 类别的工具灌进每轮 schema——类别越大越离谱，按名换入那条通路也就形同虚设。
    const declaredResidentToolNameSet = residency.residentToolNames
      ? new Set(residency.residentToolNames)
      : null
    const toolArtifacts = this.collectCapabilityToolArtifacts({
      enabledToolCategories,
      budgetOverrideToolCategoryIds: nextBudgetOverrideCategoryIds,
      budgetOverrideToolNames: input.budgetOverrideToolNames,
      categoryResidentToolNames: declaredResidentToolNameSet,
    })
    const protectedToolNames = toolArtifacts.protectedToolNames
    const enabledToolDescriptors = toolArtifacts.enabledToolDescriptors
    const rawBaseAllowedToolNames = resolveSoloLoopTools({
      configuredTools: input.configuredTools,
      roleAllowedTools: input.roleAllowedTools,
      enabledToolNames: toolArtifacts.enabledToolNames,
    })
    const enabledToolNameSet = new Set(toolArtifacts.enabledToolNames)
    const residentToolNames = (residency.residentToolNames ?? []).filter((toolName) =>
      enabledToolNameSet.has(toolName)
    )
    const excludedToolNameSet = new Set(residency.excludedToolNames ?? [])
    const baseAllowedToolNames = [
      ...new Set([
        ...rawBaseAllowedToolNames.filter((toolName) => !excludedToolNameSet.has(toolName)),
        ...residentToolNames,
      ]),
    ]
    const scopeProtectedToolNames = (residency.protectedToolNames ?? []).filter((toolName) =>
      enabledToolNameSet.has(toolName)
    )
    const effectiveProtectedToolNames = isEmpty(residentToolNames) &&
      isEmpty(scopeProtectedToolNames)
      ? protectedToolNames
      : [
          ...new Set([
            ...protectedToolNames,
            ...residentToolNames,
            ...scopeProtectedToolNames,
          ]),
        ]
    // 宿主一旦声明 residency，resident/protected 就是正式工作集，而不是“预算够时仍把
    // 其余全部工具顺便塞进请求”的排序提示。否则 tooling:map 把工具标成 loadable，
    // 下一轮却会因 operational 阶段直接暴露全表，tooling:replace 形同虚设并持续烧 schema token。
    const scopedResidencyEnabled = !!resolveCapabilityScopePolicy(input.capabilityPorts)?.getResidency
    const demandedToolNameSet = new Set([
      ...effectiveProtectedToolNames,
      ...(input.configuredTools ?? []),
    ])
    const exposureCandidates = scopedResidencyEnabled
      ? baseAllowedToolNames.filter((toolName) => demandedToolNameSet.has(toolName))
      : baseAllowedToolNames
    const exposure = applyRunProfileToolExposure(exposureCandidates, input.runProfile, {
      protectedTools: effectiveProtectedToolNames,
      toolDescriptors: enabledToolDescriptors,
      toolSchemaChars: input.toolSchemaChars,
      maxToolSchemaCharsOverride: input.toolSchemaCharBudget,
      toolUsageScores: input.toolUsageScores,
    })
    const exposedToolNameSet = new Set(exposure.allowedTools)
    const droppedToolNames = baseAllowedToolNames.filter(
      (toolName) => !exposedToolNameSet.has(toolName)
    )
    const forcedToolChoice =
      bootstrap.forcedToolChoice && exposure.allowedTools.includes(bootstrap.forcedToolChoice.toolName)
        ? bootstrap.forcedToolChoice
        : null
    const pageFaults = this.resolvePageFaults({
      requestedForcedToolChoice: bootstrap.forcedToolChoice,
      resolvedForcedToolChoice: forcedToolChoice,
      enabledToolDescriptors,
      baseAllowedToolNames,
      droppedToolNames,
      budgetOverrideToolNames: input.budgetOverrideToolNames,
      collectNewlyEvictedPagedInTools: input.collectNewlyEvictedPagedInTools,
    })
    const plan: CapabilityRunPlan = {
      requestedCategories: bootstrap.pageInCategories,
      enabledCategories: nextEnabledCategoryIds,
      protectedToolNames: effectiveProtectedToolNames,
      baseAllowedToolNames,
      residentToolNames: exposure.allowedTools,
      droppedToolNames,
      pageFaults,
      bootstrapState: forcedToolChoice ? bootstrap.nextState : input.bootstrapState ?? {},
    }

    if (forcedToolChoice) {
      plan.forcedToolChoice = forcedToolChoice
    }
    if (forcedToolChoice && bootstrap.internalReminder) {
      plan.bootstrapReminder = bootstrap.internalReminder
    }

    return plan
  }

  public resolveToolCategoriesForExposure<TTool extends { name: string }>(input: {
    visibleEnabledToolCategories: Array<ToolCategory<TTool>>
    runtimeToolCategories: Array<ToolCategory<TTool>>
    enabledToolCategoryIds: readonly ToolCategoryId[]
    budgetOverrideToolCategoryIds: readonly ToolCategoryId[]
    capabilityPorts?: AgentRuntimeCapabilityPorts
  }): Array<ToolCategory<TTool>> {
    const merged = new Map<ToolCategoryId, ToolCategory<TTool>>()
    const recoverableCategoryIds = new Set(
      expandCapabilityCategoryIds(input.capabilityPorts, [
        ...input.enabledToolCategoryIds,
        ...input.budgetOverrideToolCategoryIds,
      ])
    )

    for (const entry of input.visibleEnabledToolCategories) {
      this.mergeToolCategory(merged, entry)
    }
    for (const entry of input.runtimeToolCategories) {
      if (recoverableCategoryIds.has(entry.category.id)) {
        this.mergeToolCategory(merged, entry)
      }
    }

    return [...merged.values()]
  }

  public resolveProtectedTools(input: {
    enabledToolCategories: Array<ToolCategory<{ name: string }>>
    budgetOverrideToolCategoryIds: readonly ToolCategoryId[]
    budgetOverrideToolNames: readonly string[]
  }): string[] {
    return this.collectCapabilityToolArtifacts(input).protectedToolNames
  }

  private collectCapabilityToolArtifacts<TTool extends { name: string }>(input: {
    enabledToolCategories: Array<ToolCategory<TTool>>
    budgetOverrideToolCategoryIds: readonly ToolCategoryId[]
    budgetOverrideToolNames: readonly string[]
    /**
     * 宿主声明的常驻工具名；给出时，类别换入只保护其中的工具，其余留给按名换入。
     * 为 null 表示宿主没有 residency 面（无空间概念的宿主），沿用「整类别保护」。
     */
    categoryResidentToolNames?: LooseOptional<ReadonlySet<string>>
  }): {
    enabledToolDescriptors: TTool[]
    enabledToolNames: string[]
    protectedToolNames: string[]
  } {
    const protectedTools = new Set<string>()
    const budgetOverrideCategorySet = new Set(input.budgetOverrideToolCategoryIds)
    const enabledToolDescriptors: TTool[] = []
    const enabledToolNames: string[] = []
    const enabledToolNameSet = new Set<string>()
    for (const entry of input.enabledToolCategories) {
      for (const tool of entry.tools) {
        enabledToolDescriptors.push(tool)
        enabledToolNames.push(tool.name)
        enabledToolNameSet.add(tool.name)
        if (
          budgetOverrideCategorySet.has(entry.category.id) &&
          (input.categoryResidentToolNames?.has(tool.name) ?? true)
        ) {
          protectedTools.add(tool.name)
        }
      }
    }

    for (const toolName of input.budgetOverrideToolNames) {
      if (!enabledToolNameSet.has(toolName)) {
        enabledToolNames.push(toolName)
        enabledToolNameSet.add(toolName)
      }
      protectedTools.add(toolName)
    }

    return {
      enabledToolDescriptors,
      enabledToolNames,
      protectedToolNames: [...protectedTools],
    }
  }

  public resolvePageFaults(input: ResolveCapabilityPageFaultsInput): ToolPageFault[] {
    const forcedToolPageFaults =
      input.requestedForcedToolChoice && !input.resolvedForcedToolChoice
        ? [
            this.resolveForcedToolPageFault({
              toolName: input.requestedForcedToolChoice.toolName,
              enabledToolDescriptors: input.enabledToolDescriptors,
              baseAllowedToolNames: input.baseAllowedToolNames,
              droppedToolNames: input.droppedToolNames,
            }),
          ]
        : []

    return this.dedupePageFaults([
      ...forcedToolPageFaults,
      ...this.resolvePagedInToolEvictionPageFaults({
        budgetOverrideToolNames: input.budgetOverrideToolNames,
        droppedToolNames: input.droppedToolNames,
        enabledToolDescriptors: input.enabledToolDescriptors,
        collectNewlyEvictedPagedInTools: input.collectNewlyEvictedPagedInTools,
      }),
    ])
  }

  private mergeToolCategory<TTool extends { name: string }>(
    target: Map<ToolCategoryId, ToolCategory<TTool>>,
    entry: ToolCategory<TTool>
  ): void {
    const existing = target.get(entry.category.id)
    if (!existing) {
      target.set(entry.category.id, { category: entry.category, tools: [...entry.tools] })
      return
    }

    const existingToolNames = new Set(existing.tools.map((tool) => tool.name))
    for (const tool of entry.tools) {
      if (!existingToolNames.has(tool.name)) {
        existing.tools.push(tool)
        existingToolNames.add(tool.name)
      }
    }
  }

  private resolveForcedToolPageFault(input: {
    toolName: string
    enabledToolDescriptors: readonly ToolDescriptor[]
    baseAllowedToolNames: readonly string[]
    droppedToolNames: readonly string[]
  }): ToolPageFault {
    const descriptor = input.enabledToolDescriptors.find((tool) => tool.name === input.toolName)
    const category = descriptor?.categoryId ? { categoryId: descriptor.categoryId } : {}
    if (input.droppedToolNames.includes(input.toolName)) return {
        toolName: input.toolName,
        ...category,
        reason: 'schema-budget',
        recoveryHint: 'page-out-other-tools',
      }

    if (!input.baseAllowedToolNames.includes(input.toolName)) return {
        toolName: input.toolName,
        ...category,
        reason: 'role-boundary',
        recoveryHint: 'stop',
      }

    return {
      toolName: input.toolName,
      ...category,
      reason: 'runtime-unavailable',
      recoveryHint: 'request-user-action',
    }
  }

  private resolvePagedInToolEvictionPageFaults(input: {
    budgetOverrideToolNames: readonly string[]
    droppedToolNames: readonly string[]
    enabledToolDescriptors: readonly ToolDescriptor[]
    collectNewlyEvictedPagedInTools?: (evictedToolNames: readonly string[]) => readonly string[]
  }): ToolPageFault[] {
    const pagedIn = new Set(input.budgetOverrideToolNames)
    const evicted = input.droppedToolNames.filter((toolName) => pagedIn.has(toolName))
    if (isEmpty(evicted)) {
      input.collectNewlyEvictedPagedInTools?.([])
      return []
    }

    const evictedSet = new Set(evicted)
    const newlyEvicted =
      input.collectNewlyEvictedPagedInTools?.(evicted)?.filter((toolName) =>
        evictedSet.has(toolName)
      ) ?? evicted
    const seen = new Set<string>()

    return newlyEvicted.flatMap((toolName) => {
      if (seen.has(toolName)) return []
      seen.add(toolName)

      const descriptor = input.enabledToolDescriptors.find((tool) => tool.name === toolName)
      const category = descriptor?.categoryId ? { categoryId: descriptor.categoryId } : {}
      return [
        {
          toolName,
          ...category,
          reason: 'schema-budget' as const,
          recoveryHint: 'page-out-other-tools' as const,
        },
      ]
    })
  }

  private dedupePageFaults(pageFaults: readonly ToolPageFault[]): ToolPageFault[] {
    const seen = new Set<string>()
    const deduped: ToolPageFault[] = []
    for (const pageFault of pageFaults) {
      const key = `${pageFault.toolName}:${pageFault.reason}:${pageFault.recoveryHint}`
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      deduped.push(pageFault)
    }

    return deduped
  }
}

const capabilityRunPlanner = new CapabilityRunPlanner()

export { CapabilityRunPlanner,capabilityRunPlanner }
