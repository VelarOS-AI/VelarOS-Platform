import type {
  AgentDeveloperContext,
  AgentSurfaceId,
  CapabilityScopeId,
  ChatPromptFeatureId,
  ToolCategoryId,
} from '@velaros-ai/agent/protocol'

interface AgentSurfaceToolPolicy {
  baseCategories: readonly ToolCategoryId[]
  allowedCategories?: readonly ToolCategoryId[]
  includePromptFeatureCategories: boolean
  restoreApprovedCategories: boolean
  allowRuntimeScopeSwitching?: boolean
  hiddenToolNames?: readonly string[]
}

interface AgentSurfaceProfile {
  id: AgentSurfaceId
  toolPolicy: AgentSurfaceToolPolicy
  allowSubAgents: boolean
}

interface ResolveAgentSurfaceInput {
  agentSurfaceId?: LooseOptional<AgentSurfaceId>
  developerContext?: LooseOptional<AgentDeveloperContext>
}

interface DeriveSurfaceRunPolicyInput {
  profile: AgentSurfaceProfile
  declaredScope?: LooseOptional<CapabilityScopeId>
  promptFeatures: readonly ChatPromptFeatureId[]
  previousApprovedCategories: readonly ToolCategoryId[]
}

interface DerivedAgentSurfaceRunPolicy {
  activeSpace: CapabilityScopeId
  initialToolCategories: ToolCategoryId[]
  initialActiveToolCategories: ToolCategoryId[]
  initialPromptFeatures: ChatPromptFeatureId[]
  restoredApprovedCategories: ToolCategoryId[]
  allowedToolCategories?: ToolCategoryId[]
  allowSubAgents: boolean
}

/**
 * Product-owned surface collection.
 *
 * Runtime deliberately ships no registry, built-in profiles, or fallback surface.
 * A product resolves its own surface and maps feature ids to capability categories.
 */
interface AgentSurfaceProfileProvider {
  resolve(input: ResolveAgentSurfaceInput): AgentSurfaceProfile
  deriveRunPolicy(input: DeriveSurfaceRunPolicyInput): DerivedAgentSurfaceRunPolicy
}

export type {
  AgentSurfaceProfile,
  AgentSurfaceProfileProvider,
  DerivedAgentSurfaceRunPolicy,
  DeriveSurfaceRunPolicyInput,
  ResolveAgentSurfaceInput,
}
