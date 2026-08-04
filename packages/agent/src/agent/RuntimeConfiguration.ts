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
} from '@velaros-ai/agent/protocol'

import type { ContextGovernanceConfigInput } from './context/residency/governanceConfig'

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
  /**
   * 上下文治理配置（v2 §7 配置面）。宿主可传入，缺省全部走默认值兜底
   * （`resolveContextGovernanceConfig` 宽容解析：越界钳制不拒绝，一个手滑的值不打死治理链路）。
   *
   * 实验臂 = 同一引擎的预设（A0-truncation / A1-mechanical / A2-distill-always / A3-adaptive），
   * 不是第二条实现路径——见 `ContextGovernancePresets`。
   */
  contextGovernance?: LooseOptional<ContextGovernanceConfigInput>
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
  /** Triggering user message identity for execution observation and real-task evaluation. */
  rootInputId?: LooseOptional<string>
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
