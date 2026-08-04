import type {
  AgentEvent,
  CapabilityScopeId,
  ChatContextEvidenceRecord,
  StreamToolResultEffects,
  ToolCategoryDefinition,
  ToolCategoryId,
} from '@velaros-ai/agent/protocol'

import { compareStableStrings } from '../agent/context/residency/determinism'
import type { PromptSegmentDefinition } from '../prompts/registry'

/**
 * Host-neutral description of a capability that can be composed into Agent Runtime.
 *
 * The descriptor intentionally contains no product vocabulary or executable policy.
 * Capability packages own their tool names, operation aliases, validation guidance,
 * result middleware, and allocation prerequisites and inject them at composition time.
 */
export interface AgentRuntimeCapabilityDescriptor {
  id: string
  version?: string
  toolNames?: readonly string[]
  categories?: readonly ToolCategoryDefinition[]
  categoryIds?: readonly ToolCategoryId[]
  operationIds?: readonly string[]
  metadata?: Readonly<Record<string, unknown>>
}

export interface ToolResultMiddlewareContext<TExecutionContext = unknown> {
  toolCallId: string
  toolName: string
  args: Readonly<Record<string, unknown>>
  result: unknown
  executionContext: TExecutionContext
}

export interface ToolResultModelImage {
  data: string
  mediaType: 'image/png' | 'image/jpeg'
  /** Capability-owned display metadata. Agent Runtime treats this as opaque data. */
  artifact?: unknown
}

export interface ToolResultMiddlewareResult {
  result: unknown
  modelImage?: ToolResultModelImage
  effects?: StreamToolResultEffects
  notices?: Array<Extract<AgentEvent, { type: 'notice' }>>
}

/** Capability-owned post-processing stage for a completed tool call. */
export interface ToolResultMiddleware<TExecutionContext = unknown> {
  id: string
  priority?: number
  matches?(context: ToolResultMiddlewareContext<TExecutionContext>): boolean
  transform(
    context: ToolResultMiddlewareContext<TExecutionContext>
  ): Promise<ToolResultMiddlewareResult | void> | ToolResultMiddlewareResult | void
}

export interface ToolValidationIssueDetail {
  path: string
  message: string
}

export interface ToolValidationHintContext {
  toolName: string
  pageId: string
  issues: string
  issueDetails: readonly ToolValidationIssueDetail[]
}

export interface ToolValidationRecovery {
  hint?: string
  nextActions?: readonly string[]
}

/** Capability-owned schema recovery guidance. */
export interface ToolValidationHintProvider {
  id: string
  priority?: number
  getRecovery(context: ToolValidationHintContext): ToolValidationRecovery | void
}

export interface CapabilityValidationInterpretation {
  status: 'passed' | 'failed' | 'timed-out' | 'unknown'
  failure?: {
    operation: string
    status: 'failed' | 'timed-out'
    issues: readonly string[]
  }
  notes?: readonly string[]
}

export interface CapabilityValidationInterpreter {
  id: string
  priority?: number
  matches(toolName: string): boolean
  collect(toolName: string, result: unknown): CapabilityValidationInterpretation | void
  fingerprint?(toolName: string, args: Readonly<Record<string, unknown>>): string | void
  isPassed?(toolName: string, result: unknown): boolean
  evidenceMatches?(cited: string, observed: string): boolean
}

/** Capability-owned prompt contribution. Snapshot shape is deliberately opaque to Kernel. */
export interface CapabilityPromptContributor {
  id: string
  priority?: number
  getSegments(snapshot: unknown): readonly PromptSegmentDefinition[]
}

export interface CapabilityContextCollector {
  id: string
  priority?: number
  collect(
    messages: readonly unknown[],
    context?: Readonly<Record<string, unknown>>
  ): Promise<unknown> | unknown
}

export interface CapabilityEvidenceExtractorContext {
  toolCallId: string
  toolName: string
  args?: Readonly<Record<string, unknown>>
  result: unknown
  error?: string
  effects?: StreamToolResultEffects
}

export interface CapabilityEvidenceExtractor {
  id: string
  priority?: number
  extract(context: CapabilityEvidenceExtractorContext): readonly ChatContextEvidenceRecord[]
}

export interface CapabilityIntentSignal {
  domainId: string
  categoryIds?: readonly ToolCategoryId[]
  requiresDiscovery?: boolean
  requiresEvidence?: boolean
  requiresMutation?: boolean
  requiresValidation?: boolean
  minimumActionIds?: readonly string[]
}

/** Product/capability-owned intent classification; Agent merges only generic signals. */
export interface CapabilityIntentClassifier {
  id: string
  priority?: number
  classify(text: string): readonly CapabilityIntentSignal[]
}

export interface ToolAllocationDelegation {
  code?: string
  message: string
}

export interface ToolAllocationPrerequisite {
  id: string
  categoryIds: readonly ToolCategoryId[]
  denialCode?: string
  message: string
}

/**
 * Declarative allocation metadata. The allocator interprets only generic categories,
 * operations, prerequisites, and delegation decisions.
 */
export interface ToolAllocationMetadata {
  baselineToolNames?: readonly string[]
  operationCategories?: Readonly<Record<string, readonly ToolCategoryId[]>>
  delegatedOperations?: Readonly<Record<string, ToolAllocationDelegation>>
  prerequisites?: readonly ToolAllocationPrerequisite[]
}

export interface CapabilityScopeRuntimeFacts {
  scopeId?: CapabilityScopeId
  satisfiedFactIds?: readonly string[]
}

export interface CapabilityScopeCategoryDecision {
  allowed: boolean
  reasonCode?: string
  message?: string
}

export interface CapabilityScopeResidency {
  residentToolNames?: readonly string[]
  excludedToolNames?: readonly string[]
  protectedToolNames?: readonly string[]
}

/**
 * Host-supplied scope policy.
 *
 * Kernel treats scope ids and fact ids as opaque. Product packages own all
 * Product-specific scope semantics.
 */
export interface CapabilityScopePolicy {
  resolveScopeId(facts: CapabilityScopeRuntimeFacts): CapabilityScopeId
  decideCategory(
    categoryId: ToolCategoryId,
    facts: CapabilityScopeRuntimeFacts
  ): CapabilityScopeCategoryDecision
  expandCategoryIds?(categoryIds: readonly ToolCategoryId[]): readonly ToolCategoryId[]
  getDefaultCategoryIds?(
    facts: CapabilityScopeRuntimeFacts,
    options?: Readonly<Record<string, unknown>>
  ): readonly ToolCategoryId[]
  getResidency?(facts: CapabilityScopeRuntimeFacts): CapabilityScopeResidency
}

export interface AgentRuntimeCapabilityExtension {
  descriptor: AgentRuntimeCapabilityDescriptor
  toolAliases?: Readonly<Record<string, string>>
  resultMiddlewares?: ReadonlyArray<ToolResultMiddleware<any>>
  validationHintProviders?: readonly ToolValidationHintProvider[]
  validationInterpreters?: readonly CapabilityValidationInterpreter[]
  promptContributors?: readonly CapabilityPromptContributor[]
  contextCollectors?: readonly CapabilityContextCollector[]
  evidenceExtractors?: readonly CapabilityEvidenceExtractor[]
  intentClassifiers?: readonly CapabilityIntentClassifier[]
  allocation?: ToolAllocationMetadata
  scopePolicy?: CapabilityScopePolicy
}

export interface CapabilityDelegationPolicy {
  blockedToolNames?: readonly string[]
  blockedCategoryIds?: readonly ToolCategoryId[]
}

export interface AgentRuntimeCapabilityPorts {
  extensions?: readonly AgentRuntimeCapabilityExtension[]
  toolAliases?: Readonly<Record<string, string>>
  resultMiddlewares?: ReadonlyArray<ToolResultMiddleware<any>>
  validationHintProviders?: readonly ToolValidationHintProvider[]
  validationInterpreters?: readonly CapabilityValidationInterpreter[]
  promptContributors?: readonly CapabilityPromptContributor[]
  contextCollectors?: readonly CapabilityContextCollector[]
  evidenceExtractors?: readonly CapabilityEvidenceExtractor[]
  intentClassifiers?: readonly CapabilityIntentClassifier[]
  allocation?: ToolAllocationMetadata
  scopePolicy?: CapabilityScopePolicy
  delegationPolicy?: CapabilityDelegationPolicy
  /** Runtime prerequisite facts supplied by the host for the current execution. */
  satisfiedAllocationPrerequisiteIds?: readonly string[]
}

export function resolveCapabilityDelegationPolicy(
  ports?: AgentRuntimeCapabilityPorts
): Required<CapabilityDelegationPolicy> {
  return {
    blockedToolNames: [...new Set(ports?.delegationPolicy?.blockedToolNames ?? [])],
    blockedCategoryIds: [...new Set(ports?.delegationPolicy?.blockedCategoryIds ?? [])],
  }
}

export function resolveCapabilityScopePolicy(
  ports?: AgentRuntimeCapabilityPorts
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
  ports: AgentRuntimeCapabilityPorts | undefined,
  facts: CapabilityScopeRuntimeFacts
): CapabilityScopeId {
  return (
    resolveCapabilityScopePolicy(ports)?.resolveScopeId(facts) ??
    facts.scopeId?.trim() ??
    'default'
  )
}

export function decideCapabilityScopeCategory(
  ports: AgentRuntimeCapabilityPorts | undefined,
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
  ports: AgentRuntimeCapabilityPorts | undefined,
  categoryIds: readonly ToolCategoryId[]
): ToolCategoryId[] {
  const expanded = resolveCapabilityScopePolicy(ports)?.expandCategoryIds?.(categoryIds)
  return [...new Set(expanded ?? categoryIds)]
}

export function resolveCapabilityScopeResidency(
  ports: AgentRuntimeCapabilityPorts | undefined,
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
  ports: AgentRuntimeCapabilityPorts | undefined,
  snapshot: unknown
): PromptSegmentDefinition[] {
  const contributors = [
    ...(ports?.extensions?.flatMap((extension) => extension.promptContributors ?? []) ?? []),
    ...(ports?.promptContributors ?? []),
  ].sort(byPriority)
  return contributors.flatMap((contributor) => [...contributor.getSegments(snapshot)])
}

export function resolveCapabilityContextCollectors(
  ports?: AgentRuntimeCapabilityPorts
): CapabilityContextCollector[] {
  return [
    ...(ports?.extensions?.flatMap((extension) => extension.contextCollectors ?? []) ?? []),
    ...(ports?.contextCollectors ?? []),
  ].sort(byPriority)
}

export function resolveCapabilityEvidenceExtractors(
  ports?: AgentRuntimeCapabilityPorts
): CapabilityEvidenceExtractor[] {
  return [
    ...(ports?.extensions?.flatMap((extension) => extension.evidenceExtractors ?? []) ?? []),
    ...(ports?.evidenceExtractors ?? []),
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
  ports: AgentRuntimeCapabilityPorts | undefined,
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
