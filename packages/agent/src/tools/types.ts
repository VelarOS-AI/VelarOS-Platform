import type {
  AgentModelInputModality,
  AgentRoleId,
  CapabilityScopeId,
  ChatPromptFeatureId,
  ToolCapabilitySchema,
  ToolCategoryId,
  ToolExposurePolicy,
  ToolPermission,
  ToolProviderKind,
  ToolRole,
  ToolSurfaceProfileId,
} from '@velaros-ai/agent/protocol'

import type { AgentRuntimeCapabilityPorts } from '../capabilities'

interface ToolRegistryCodingSession {
  isToolCategoryAllowed: (categoryId: ToolCategoryId) => boolean
  hasToolCategoryAccess(categoryId: ToolCategoryId): boolean
  hasActiveToolCategoryAccess: (categoryId: ToolCategoryId) => boolean
  /**
   * 具体工具是否由 tooling:replace 显式换入。
   *
   * Prompt feature 是产品入口选择，不是第二套工具权限。显式工具租约只对这一项
   * schema 生效，仍需通过类别、作用域、系统开关和工具自身运行态闸门。
   */
  hasToolNameAccess?: (toolName: string) => boolean
  hasPromptFeatureAccess: (feature: ChatPromptFeatureId) => boolean
  getToolSurfaceProfile: () => ToolSurfaceProfileId
  /** 会话声明/切换后的当前能力作用域；可选——外部端口缺失时回退运行态推断。 */
  getActiveCapabilityScope?: () => CapabilityScopeId
}

interface ToolRegistryContext {
  role: {
    id: AgentRoleId
  }
  codingSession: ToolRegistryCodingSession
  capabilityPorts?: AgentRuntimeCapabilityPorts
  isToolSystemEnabled(toolName: string): boolean
  /** 本轮实际模型声明支持的输入类型；缺席表示未知，注册表允许 provider 实际尝试。 */
  getSupportedModelInputModalities?: () => readonly AgentModelInputModality[]
}

interface RegistryTool<TContext extends ToolRegistryContext = ToolRegistryContext> {
  description: string
  /** companion skill id；描述末尾已带指路行，这里让工具页卡片也能结构化透出。 */
  usageSkillId?: string
  role?: ToolRole
  permissions: ToolPermission[]
  capabilities?: ToolCapabilitySchema
  requiredModelInputModalities?: readonly AgentModelInputModality[]
  exposure?: ToolExposurePolicy
  /** 输出禁止 page-out、始终内联（发现/索引类工具，如 tooling:map）。 */
  outputInline?: boolean
  /** 运行依赖不存在时从工具发现层彻底移除，而不是展示为不可用。 */
  hideWhenUnavailable?: boolean
  isAvailable?: (ctx: TContext) => boolean
  /**
   * 不可用时给发现层的**具体原因**（`hideWhenUnavailable: false` 的工具必须回答这一句）。
   *
   * 留在页表里却只给一句泛化的「当前运行态不可用」，模型读到的就是「此路不通」——与整族隐身
   * 同一个结局。返回 null = 没有比泛化文案更具体的可说的。
   */
  unavailableReason?: (ctx: TContext) => Nullable<string>
}

interface RegisteredTool<TTool extends RegistryTool<any> = RegistryTool<any>> {
  descriptorId?: string
  registrationSignature?: string
  categoryId: ToolCategoryId
  providerId?: string
  providerKind?: ToolProviderKind
  registrationStatus?: 'active' | 'overridden'
  overriddenByProviderId?: string
  overriddenByProviderKind?: ToolProviderKind
  tool: TTool
}

export type { RegisteredTool, RegistryTool, ToolRegistryCodingSession, ToolRegistryContext }
