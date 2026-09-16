import type { ToolDescriptor } from '../../types/agent.js'
import type { RegisteredTool, RegistryTool } from '../../types/tools'
import type { ToolCapabilityReason, ToolCapabilitySchemaPolicy, ToolCategoryUnavailableReason, ToolDiscoveryAvailability } from '../../types/tools.js'

export function schemaPolicyForAvailability(
  availability: ToolDiscoveryAvailability
): ToolCapabilitySchemaPolicy {
  if (availability === 'visible') return 'full'
  return 'preview'
}

export function reason(
  layer: ToolCapabilityReason['layer'],
  code: string,
  message: string,
  details?: Record<string, unknown>
): ToolCapabilityReason {
  return { layer, code, message, details }
}

export function categoryAccessReason(
  unavailableReason: Nullable<ToolCategoryUnavailableReason>
): Nullable<ToolCapabilityReason> {
  if (!unavailableReason) return null
  return reason(
    'capability',
    unavailableReason,
    'The injected capability policy denied this category in the active scope.'
  )
}

export function descriptorForRegisteredTool<TTool extends RegistryTool<any>>(
  name: string,
  entry: RegisteredTool<TTool>,
  systemEnabled: boolean
): ToolDescriptor {
  return {
    descriptorId: entry.descriptorId ?? name,
    name,
    description: entry.tool.description,
    usageSkillId: entry.tool.usageSkillId,
    role: entry.tool.role,
    permissions: entry.tool.permissions,
    capabilities: entry.tool.capabilities,
    requiredModelInputModalities: entry.tool.requiredModelInputModalities,
    exposure: entry.tool.exposure,
    categoryId: entry.categoryId,
    systemEnabled,
    providerId: entry.providerId,
    providerKind: entry.providerKind,
    registrationStatus: entry.registrationStatus ?? 'active',
    overriddenByProviderId: entry.overriddenByProviderId,
    overriddenByProviderKind: entry.overriddenByProviderKind,
  }
}

export function reasonsForToolPage(input: {
  categoryAllowed: boolean
  categoryAccessAllowed: boolean
  categoryUnavailableReason: Nullable<ToolCategoryUnavailableReason>
  systemEnabled: boolean
  runtimeAvailable: boolean
  visible: boolean
  categoryEnabled: boolean
  activeCategory: boolean
  availability: ToolDiscoveryAvailability
  pluginBacked: boolean
  /** 工具自报的不可用原因；缺席时才退到泛化文案。 */
  runtimeUnavailableReason: Nullable<string>
}): ToolCapabilityReason[] {
  const reasons: ToolCapabilityReason[] = []

  if (!input.categoryAllowed) {
    reasons.push(reason('role', 'category_not_allowed', '当前角色或运行配置不允许该工具类别。'))
  }

  const accessReason = categoryAccessReason(input.categoryUnavailableReason)
  if (!input.categoryAccessAllowed && accessReason) {
    reasons.push(accessReason)
  }

  if (!input.systemEnabled) {
    reasons.push(reason('system', 'disabled', '该工具已被系统设置禁用。'))
  }

  if (!input.runtimeAvailable) {
    // 工具自报的原因优先：泛化的「当前运行态不可用」在页表里等于「此路不通」，模型据此会去搜
    // 别的工具或退回手搓。带上「缺什么、谁来解除」才让「留在发现层」这条判决真的成立。
    reasons.push(
      reason(
        'runtime',
        'unavailable',
        input.runtimeUnavailableReason ?? '工具注册存在，但当前运行态不可用。'
      )
    )
  }

  if (input.visible) {
    reasons.push(reason('resident', 'visible', '该工具已驻留在本轮 tools 中。'))
  } else if (input.availability === 'loadable') {
    reasons.push(
      reason(
        'resident',
        input.categoryEnabled && !input.activeCategory ? 'inactive-category' : 'loadable',
        '该工具已授权但未驻留，可按需换入动态工具空间。'
      )
    )
  } else if (input.availability === 'requires_approval') {
    reasons.push(reason('approval', 'required', '该工具类别需要先申请启用。'))
  } else if (input.pluginBacked) {
    reasons.push(reason('plugin', 'user_action_required', '该工具类别依赖外部连接器或用户动作。'))
  }

  return reasons
}
