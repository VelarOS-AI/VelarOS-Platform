import type {
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
} from '@velaros-ai/core/types'

import type { AgentRuntimeCapabilityPorts } from '../capabilities'

interface ToolRegistryCodingSession {
  isToolCategoryAllowed: (categoryId: ToolCategoryId) => boolean
  hasToolCategoryAccess(categoryId: ToolCategoryId): boolean
  hasActiveToolCategoryAccess: (categoryId: ToolCategoryId) => boolean
  hasPromptFeatureAccess: (feature: ChatPromptFeatureId) => boolean
  getToolSurfaceProfile: () => ToolSurfaceProfileId
  /** 会话声明/切换后的当前能力作用域；可选——外部端口缺失时回退运行态推断。 */
  getActiveCapabilityScope?: () => CapabilityScopeId
}

interface ToolRegistryContext {
  role: {
    id: AgentRoleId
  }
  grantedPermissions: ReadonlySet<ToolPermission>
  codingSession: ToolRegistryCodingSession
  capabilityPorts?: AgentRuntimeCapabilityPorts
  isToolSystemEnabled(toolName: string): boolean
}

interface RegistryTool<TContext extends ToolRegistryContext = ToolRegistryContext> {
  description: string
  role?: ToolRole
  permissions: ToolPermission[]
  capabilities?: ToolCapabilitySchema
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
