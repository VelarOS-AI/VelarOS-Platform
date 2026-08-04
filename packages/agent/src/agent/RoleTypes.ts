import type {
  AgentDelegationContract,
  AgentRoleExpectedOutputKind,
  AgentRoleId,
  AgentRoleProfileConfig,
  AgentSkillDescriptor,
  CapabilityScopeId,
  ChatPromptFeatureId,
  ToolCategoryId,
  WorkflowType,
} from '@velaros-ai/agent/protocol'

/** 角色合约：来自共享配置的 profile，加上后端运行所需 workflow 信息。 */
interface AgentRoleContract extends AgentRoleProfileConfig {
  /** 角色可承接的 workflow 类型。 */
  workflowTypes: WorkflowType[]
  /** 人类可读职责说明。 */
  responsibilities: string[]
  /** 角色默认期望产出类型。 */
  expectedOutputKind: AgentRoleExpectedOutputKind
}

/** 角色定义；builtIn 用于区分内置角色和未来扩展角色。 */
interface AgentRoleDefinition extends AgentRoleContract {
  builtIn: boolean
}

/** 角色解析输入。 */
interface ResolveAgentRoleOptions {
  /** 锁定角色，通常来自 team worker 或子 Agent。 */
  lockedRoleId?: LooseOptional<AgentRoleId>
  /** 已注册工具名，用于过滤角色声明中不存在的工具。 */
  knownToolNames: string[]
  /** 本次选择的技能 id。 */
  selectedSkillIds?: string[]
  /** 本次开启的 Prompt Feature。 */
  promptFeatures?: readonly ChatPromptFeatureId[]
  /** 当前由宿主声明的能力作用域。 */
  activeCapabilityScope?: CapabilityScopeId
}

/** 角色解析结果，供 prompt、tool context 和 execution debug 共享。 */
interface AgentRoleResolution {
  id: AgentRoleId
  label: string
  description: string
  workflowType: WorkflowType
  skillMarkdown: string
  skillDescriptors: AgentSkillDescriptor[]
  activeCapabilityScope?: CapabilityScopeId
  enabledToolCategories: ToolCategoryId[]
  allowedTools: string[]
  /** 显式选中技能声明的工具门控并集；null = 本轮无技能门控。 */
  selectedSkillAllowedTools: Nullable<string[]>
  usesCapabilityContext: boolean
  nextAllowedRoles: AgentRoleId[]
  routeNote: string
  contract: AgentRoleContract
}

export type {
  AgentDelegationContract,
  AgentRoleContract,
  AgentRoleDefinition,
  AgentRoleExpectedOutputKind,
  AgentRoleResolution,
  ResolveAgentRoleOptions,
  WorkflowType,
}
