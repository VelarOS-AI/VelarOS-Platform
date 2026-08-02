import { toNullable } from '@velaros-ai/core'
import type { ToolDescriptor } from '@velaros-ai/core/types'

import { decideToolCategoryAccess, type ToolCategoryUnavailableReason } from './access-policy'
import type {
  RegisteredToolMap,
  ToolCapabilityPage,
  ToolCapabilityReason,
  ToolCapabilityRegistryContext,
  ToolCapabilityRegistryListOptions,
  ToolCapabilitySchemaPolicy,
} from './capability-types'
import type {
  ToolDiscoveryAvailability,
  ToolDiscoveryToolAvailabilityInput,
} from './discovery-availability'
import {
  nextActionForDiscoveryAvailability,
  resolveToolDiscoveryAvailability,
  schemaStateForDiscoveryAvailability,
} from './discovery-availability'
import {
  defaultRuntimePromptFeaturePolicy,
  type RuntimePromptFeaturePolicy,
} from './prompt-feature-policy'
import { ToolRegistryHelper } from './registry'
import { isPluginBackedToolCategory } from './tool-space-resolver'
import type { RegisteredTool, RegistryTool, ToolRegistryContext } from './types'

function schemaPolicyForAvailability(
  availability: ToolDiscoveryAvailability
): ToolCapabilitySchemaPolicy {
  if (availability === 'visible') return 'full'
  return 'preview'
}

function reason(
  layer: ToolCapabilityReason['layer'],
  code: string,
  message: string,
  details?: Record<string, unknown>
): ToolCapabilityReason {
  return { layer, code, message, details }
}

function categoryAccessReason(
  unavailableReason: Nullable<ToolCategoryUnavailableReason>
): Nullable<ToolCapabilityReason> {
  if (!unavailableReason) return null
  return reason(
    'capability',
    unavailableReason,
    'The injected capability policy denied this category in the active scope.'
  )
}

function descriptorForRegisteredTool<TTool extends RegistryTool<any>>(
  name: string,
  entry: RegisteredTool<TTool>,
  systemEnabled: boolean
): ToolDescriptor {
  return {
    descriptorId: entry.descriptorId ?? name,
    name,
    description: entry.tool.description,
    role: entry.tool.role,
    permissions: entry.tool.permissions,
    capabilities: entry.tool.capabilities,
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

function reasonsForToolPage(input: {
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

class ToolCapabilityRegistry {
  private readonly helper: ToolRegistryHelper

  constructor(promptFeaturePolicy: RuntimePromptFeaturePolicy = defaultRuntimePromptFeaturePolicy) {
    this.helper = new ToolRegistryHelper(promptFeaturePolicy)
  }

  public listTools<TContext extends ToolRegistryContext, TTool extends RegistryTool<TContext>>(
    registry: RegisteredToolMap<TTool>,
    ctx: TContext,
    options: ToolCapabilityRegistryListOptions = {}
  ) {
    return this.helper.listAvailable(registry, ctx, options.allowList, options.scope ?? 'enabled')
  }

  public listCategories<TContext extends ToolRegistryContext, TTool extends RegistryTool<TContext>>(
    registry: RegisteredToolMap<TTool>,
    ctx: TContext,
    options: ToolCapabilityRegistryListOptions = {}
  ) {
    return this.helper.listCategories(registry, ctx, options.allowList, options.scope ?? 'enabled')
  }

  public listCapabilityPages<
    TContext extends ToolCapabilityRegistryContext,
    TTool extends RegistryTool<TContext>,
  >(
    registry: RegisteredToolMap<TTool>,
    ctx: TContext,
    options: Pick<ToolCapabilityRegistryListOptions, 'allowList'> = {}
  ): ToolCapabilityPage[] {
    const visibleNames = new Set(ctx.getCurrentVisibleToolNames())
    const pages: ToolCapabilityPage[] = []

    for (const [name, entry] of registry) {
      if (options.allowList && !options.allowList.includes(name)) {
        continue
      }

      const categoryAccess = decideToolCategoryAccess(entry.categoryId, {
        roleId: ctx.role.id,
        activeCapabilityScope: ctx.codingSession.getActiveCapabilityScope?.(),
        capabilityPorts: ctx.capabilityPorts,
      })
      const systemEnabled = ctx.isToolSystemEnabled(name)
      const categoryAllowed = ctx.codingSession.isToolCategoryAllowed(entry.categoryId)
      const categoryEnabled = ctx.codingSession.hasToolCategoryAccess(entry.categoryId)
      const activeCategory = ctx.codingSession.hasActiveToolCategoryAccess(entry.categoryId)
      const runtimeAvailable = entry.tool.isAvailable ? entry.tool.isAvailable(ctx) : true
      if (!runtimeAvailable && entry.tool.hideWhenUnavailable) continue
      // 只在真的不可用时问原因：可用路径上不该为了一句文案多跑一次工具自己的探测。
      const runtimeUnavailableReason = runtimeAvailable
        ? null
        : toNullable(entry.tool.unavailableReason?.(ctx))

      const visible = visibleNames.has(name)
      const pluginBacked = isPluginBackedToolCategory(entry.categoryId)
      const availabilityInput: ToolDiscoveryToolAvailabilityInput = {
        toolName: name,
        categoryId: entry.categoryId,
        categoryEnabled,
        categoryAllowed,
        categoryAccessAllowed: categoryAccess.allowed,
        categoryUnavailableReason: categoryAccess.reason,
        pluginBacked,
        hasRuntimeAvailableTool: runtimeAvailable,
        requiresApproval: false,
        systemEnabled,
        visible,
        runtimeAvailable,
      }
      const availability = resolveToolDiscoveryAvailability(availabilityInput)

      pages.push({
        id: `tool:${name}`,
        kind: 'tool',
        name,
        categoryId: entry.categoryId,
        descriptor: descriptorForRegisteredTool(name, entry, systemEnabled),
        permissions: [...entry.tool.permissions],
        availability,
        schemaState: schemaStateForDiscoveryAvailability(availability),
        schemaPolicy: schemaPolicyForAvailability(availability),
        nextAction: nextActionForDiscoveryAvailability(availability),
        resident: visible,
        reasons: reasonsForToolPage({
          categoryAllowed,
          categoryAccessAllowed: categoryAccess.allowed,
          categoryUnavailableReason: categoryAccess.reason,
          systemEnabled,
          runtimeAvailable,
          visible,
          categoryEnabled,
          activeCategory,
          availability,
          pluginBacked,
          runtimeUnavailableReason,
        }),
      })
    }

    return pages
  }
}

export { ToolCapabilityRegistry }
