import type { ToolDescriptor } from '../../types/agent.js'
import type { RegisteredTool, RegistryTool } from '../../types/tools'
import type { ToolCapabilityReason, ToolCapabilitySchemaPolicy, ToolCategoryUnavailableReason, ToolDiscoveryAvailability } from '../../types/tools.js'

/**
 * 决定一个工具页在 tool_map 里给模型看多少入参契约：只有 `visible`（已驻留本轮 tools）给 `full`，其余档位一律 `preview`。
 * 这样没驻留的工具只暴露摘要，真 schema 等换页后的下一轮再给——既省上下文，也逼模型先 page-in 再调用。
 */
export function schemaPolicyForAvailability(
  availability: ToolDiscoveryAvailability
): ToolCapabilitySchemaPolicy {
  if (availability === 'visible') return 'full'
  return 'preview'
}

/**
 * 造一条 `ToolCapabilityReason`（层位 + 机器码 + 给模型看的人话 + 可选细节）的字面量构造器。
 * 不做任何校验或去重，只保证各处生成的理由形状一致；`details` 不传就是 undefined。
 */
export function reason(
  layer: ToolCapabilityReason['layer'],
  code: string,
  message: string,
  details?: Record<string, unknown>
): ToolCapabilityReason {
  return { layer, code, message, details }
}

/**
 * 把作用域策略给出的类别拒因包装成 `capability` 层的一条理由；没有拒因（策略放行或压根没策略）返回 null。
 * 机器码直接沿用策略的拒因串不做翻译，方便上层按码分支；message 是固定的泛化文案。
 */
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

/**
 * 把注册表条目摊成对外的 `ToolDescriptor`，如实带上 `systemEnabled`（由调用方传入）、注册状态与被谁覆盖的来源信息。
 * `descriptorId` 缺省回落到工具名，`registrationStatus` 缺省按 `'active'` 记。
 * 这是「连禁用项和被覆盖项一起摆出来」的那一版（设置页用）；只列当前可见工具用 `activeDescriptorForRegisteredTool`。
 */
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

/**
 * 为「当前上下文可见」的工具拼 descriptor：能走到这里说明它已经过了系统开关与注册覆盖的筛，
 * 所以 `systemEnabled` 恒为 true、`registrationStatus` 恒为 `active`，也不带覆盖来源字段。
 * 设置页那种要把禁用项和被覆盖项一起摆出来的场合用 `descriptorForRegisteredTool`，不要用这个。
 */
export function activeDescriptorForRegisteredTool<TTool extends RegistryTool<any>>(
  name: string,
  entry: RegisteredTool<TTool>
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
    systemEnabled: true,
    providerId: entry.providerId,
    providerKind: entry.providerKind,
    registrationStatus: 'active',
  }
}

/**
 * 为单个工具页汇总「为什么是这个状态」的理由清单，按 role → capability → system → runtime → 驻留/审批/插件 的层序追加。
 * 前四层是各自不通过时才记；最后一段按驻留情况二选一：已驻留记 `resident/visible`，
 * `loadable` 记 `resident/loadable`（类别已开但本轮没激活时改记 `inactive-category` 以区分成因），
 * `requires_approval` 记 `approval/required`，否则插件工具记 `plugin/user_action_required`。
 * 运行时不可用时优先用工具自报的原因，缺席才退到泛化文案——泛化文案会让模型以为此路不通而放弃，带上「缺什么」才留得住。
 * 返回的清单会进模型上下文，顺序即模型读到的顺序。
 */
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
