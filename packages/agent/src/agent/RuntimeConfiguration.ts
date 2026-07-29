import type {
  AgentDeveloperContext,
  AgentSurfaceId,
  AppLocale,
  CapabilityScopeId,
  ChatPromptFeatureId,
  PermissionConfirmationMode,
  PromptSegmentOverride,
  ReasoningLevel,
  RunProfileSelectionId,
  SessionLineageContext,
  ThinkingDepth,
  ToolExecutionApi,
  ToolPermission,
  ToolSurfaceProfileId,
} from '@velaros-ai/core/types'

/**
 * Product-owned model configuration is deliberately opaque to Agent Runtime.
 * Model packages own provider ids, credentials, catalogs and fallback policy.
 */
export interface AgentChatRuntimeConfig {
  modelSelection?: unknown
  systemPromptAppend: string
}

export interface AgentSystemRuntimeConfig {
  thinkingDepth: ThinkingDepth
  reasoningLanguage: 'auto' | 'zh' | 'en'
  disabledToolNames: string[]
  prompt: {
    segmentOverrides: PromptSegmentOverride[]
  }
  advancedRuntime: {
    maxConcurrentSubAgents?: number
    maxSubAgentsPerExecution?: number
  }
  /** Product-owned provider collection context; Agent Runtime only forwards it. */
  modelRuntimeContext?: unknown
}

/**
 * Per-run execution configuration consumed by the host-neutral Agent Runtime.
 *
 * Provider/auth fields intentionally do not exist here. The product passes an
 * opaque selection to its injected AgentModelResolverPort.
 */
export interface AgentExecutionConfig {
  modelSelection?: unknown
  locale?: AppLocale
  sessionId?: string
  tools?: string[]
  thinkingDepth?: ThinkingDepth
  reasoningLevel?: ReasoningLevel
  sessionLineage?: LooseOptional<SessionLineageContext>
  grantedPermissions?: ToolPermission[]
  promptFeatures?: ChatPromptFeatureId[]
  goalMode?: boolean
  /** Enables a host-injected execution isolation resource for this run. */
  executionIsolationEnabled?: boolean
  scope?: CapabilityScopeId
  toolSurfaceProfile?: ToolSurfaceProfileId
  runProfile?: RunProfileSelectionId
  permissionConfirmationMode?: PermissionConfirmationMode
  unattended?: boolean
  windowId?: number
  abortController?: AbortController
  execution?: LooseOptional<ToolExecutionApi>
  selectedSkillIds?: string[]
  skillArguments?: string
  agentSurfaceId?: LooseOptional<AgentSurfaceId>
  developerContext?: LooseOptional<AgentDeveloperContext>
}
