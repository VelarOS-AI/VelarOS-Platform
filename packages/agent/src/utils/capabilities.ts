import type { AgentRuntimeCapabilityPorts,CapabilityContextCollector, CapabilityDelegationPolicy, CapabilityIntentClassifier, CapabilityScopePolicy, CapabilityValidationInterpreter, ToolAllocationMetadata, ToolResultMiddleware, ToolValidationHintProvider } from '../contract/requires.js'
import type { CapabilityScopeId, ToolCategoryDefinition, ToolCategoryId } from '../types/agent.js'
import type { CapabilityScopeCategoryDecision, CapabilityScopeResidency, CapabilityScopeRuntimeFacts, ToolAllocationDelegation, ToolAllocationPrerequisite } from '../types/capabilities.js'
import type { PromptSegmentDefinition } from '../types/guidance.js'

import { compareStableStrings } from './residency/determinism'

export function resolveCapabilityDelegationPolicy(
  ports?: AgentRuntimeCapabilityPorts
): Required<CapabilityDelegationPolicy> {
  return {
    blockedToolNames: [...new Set(ports?.delegationPolicy?.blockedToolNames ?? [])],
    blockedCategoryIds: [...new Set(ports?.delegationPolicy?.blockedCategoryIds ?? [])],
  }
}

export function resolveCapabilityScopePolicy(
  ports?: LooseOptional<AgentRuntimeCapabilityPorts>
): CapabilityScopePolicy | undefined {
  if (ports?.scopePolicy) return ports.scopePolicy
  const policies = ports?.extensions
    ?.map((extension) => extension.scopePolicy)
    .filter((policy): policy is CapabilityScopePolicy => !!policy)
  if (!policies?.length) return undefined
  if (policies.length > 1)
    throw new Error('only one composed capability scope policy may be active')
  return policies[0]
}

export function resolveCapabilityScopeId(
  ports: LooseOptional<AgentRuntimeCapabilityPorts>,
  facts: CapabilityScopeRuntimeFacts
): CapabilityScopeId {
  return (
    resolveCapabilityScopePolicy(ports)?.resolveScopeId(facts) ??
    facts.scopeId?.trim() ??
    'default'
  )
}

export function decideCapabilityScopeCategory(
  ports: LooseOptional<AgentRuntimeCapabilityPorts>,
  categoryId: ToolCategoryId,
  facts: CapabilityScopeRuntimeFacts
): CapabilityScopeCategoryDecision {
  return (
    resolveCapabilityScopePolicy(ports)?.decideCategory(categoryId, facts) ?? {
      allowed: true,
    }
  )
}

export function expandCapabilityCategoryIds(
  ports: LooseOptional<AgentRuntimeCapabilityPorts>,
  categoryIds: readonly ToolCategoryId[]
): ToolCategoryId[] {
  const expanded = resolveCapabilityScopePolicy(ports)?.expandCategoryIds?.(categoryIds)
  return [...new Set(expanded ?? categoryIds)]
}

export function resolveCapabilityScopeResidency(
  ports: LooseOptional<AgentRuntimeCapabilityPorts>,
  facts: CapabilityScopeRuntimeFacts
): CapabilityScopeResidency {
  return resolveCapabilityScopePolicy(ports)?.getResidency?.(facts) ?? {}
}

export function resolveToolAliases(
  ports?: AgentRuntimeCapabilityPorts
): Readonly<Record<string, string>> {
  return Object.assign(
    {},
    ...(ports?.extensions?.map((extension) => extension.toolAliases ?? {}) ?? []),
    ports?.toolAliases ?? {}
  )
}

/** Product-owned category catalog assembled from the injected capability descriptors. */
export function resolveCapabilityCategoryDefinitions(
  ports?: AgentRuntimeCapabilityPorts
): Readonly<Record<ToolCategoryId, ToolCategoryDefinition>> {
  const definitions: Record<ToolCategoryId, ToolCategoryDefinition> = {}
  for (const extension of ports?.extensions ?? []) {
    for (const category of extension.descriptor.categories ?? []) {
      const existing = definitions[category.id]
      if (existing && JSON.stringify(existing) !== JSON.stringify(category)) {
        throw new Error(`conflicting injected tool category definition: ${category.id}`)
      }
      definitions[category.id] = category
    }
  }
  return definitions
}

function byPriority<T extends { priority?: number; id: string }>(left: T, right: T): number {
  return (left.priority ?? 0) - (right.priority ?? 0) || compareStableStrings(left.id, right.id)
}

export function resolveToolResultMiddlewares(
  ports?: AgentRuntimeCapabilityPorts
): Array<ToolResultMiddleware<any>> {
  return [
    ...(ports?.extensions?.flatMap((extension) => extension.resultMiddlewares ?? []) ?? []),
    ...(ports?.resultMiddlewares ?? []),
  ].sort(byPriority)
}

export function resolveToolValidationHintProviders(
  ports?: AgentRuntimeCapabilityPorts
): ToolValidationHintProvider[] {
  return [
    ...(ports?.extensions?.flatMap((extension) => extension.validationHintProviders ?? []) ?? []),
    ...(ports?.validationHintProviders ?? []),
  ].sort(byPriority)
}

export function resolveCapabilityValidationInterpreters(
  ports?: AgentRuntimeCapabilityPorts
): CapabilityValidationInterpreter[] {
  return [
    ...(ports?.extensions?.flatMap((extension) => extension.validationInterpreters ?? []) ?? []),
    ...(ports?.validationInterpreters ?? []),
  ].sort(byPriority)
}

export function resolveCapabilityPromptSegments(
  ports: LooseOptional<AgentRuntimeCapabilityPorts>,
  snapshot: unknown
): PromptSegmentDefinition[] {
  const contributors = [
    ...(ports?.extensions?.flatMap((extension) => extension.promptContributors ?? []) ?? []),
    ...(ports?.promptContributors ?? []),
  ].sort(byPriority)
  return contributors.flatMap((contributor) => [...contributor.getSegments(snapshot)])
}

export function resolveCapabilityContextCollectors(
  ports?: LooseOptional<AgentRuntimeCapabilityPorts>
): CapabilityContextCollector[] {
  return [
    ...(ports?.extensions?.flatMap((extension) => extension.contextCollectors ?? []) ?? []),
    ...(ports?.contextCollectors ?? []),
  ].sort(byPriority)
}

export function resolveCapabilityIntentClassifiers(
  ports?: AgentRuntimeCapabilityPorts
): CapabilityIntentClassifier[] {
  return [
    ...(ports?.extensions?.flatMap((extension) => extension.intentClassifiers ?? []) ?? []),
    ...(ports?.intentClassifiers ?? []),
  ].sort(byPriority)
}

export async function collectCapabilityContext(
  ports: LooseOptional<AgentRuntimeCapabilityPorts>,
  messages: readonly unknown[],
  context?: Readonly<Record<string, unknown>>
): Promise<Readonly<Record<string, unknown>>> {
  const entries = await Promise.all(
    resolveCapabilityContextCollectors(ports).map(async (collector) => [
      collector.id,
      await collector.collect(messages, context),
    ] as const)
  )
  return Object.fromEntries(entries)
}

export function resolveToolAllocationMetadata(
  ports?: AgentRuntimeCapabilityPorts
): ToolAllocationMetadata {
  const sources = [
    ...(ports?.extensions?.map((extension) => extension.allocation).filter(Boolean) ?? []),
    ports?.allocation,
  ].filter((source): source is ToolAllocationMetadata => !!source)

  const baselineToolNames = new Set<string>()
  const operationCategories: Record<string, ToolCategoryId[]> = {}
  const delegatedOperations: Record<string, ToolAllocationDelegation> = {}
  const prerequisites: ToolAllocationPrerequisite[] = []

  for (const source of sources) {
    source.baselineToolNames?.forEach((name) => baselineToolNames.add(name))
    for (const [operationId, categoryIds] of Object.entries(source.operationCategories ?? {})) {
      operationCategories[operationId] = [
        ...new Set([...(operationCategories[operationId] ?? []), ...categoryIds]),
      ]
    }
    Object.assign(delegatedOperations, source.delegatedOperations)
    prerequisites.push(...(source.prerequisites ?? []))
  }

  return {
    baselineToolNames: [...baselineToolNames],
    operationCategories,
    delegatedOperations,
    prerequisites,
  }
}
