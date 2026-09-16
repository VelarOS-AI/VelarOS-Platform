import { toNullable } from '@velaros-ai/core'

import type { RuntimePromptFeaturePolicy } from '../../contract/requires.js'
import type { RegistryTool, ToolRegistryContext } from '../../types/tools'
import type { RegisteredToolMap, ToolCapabilityPage, ToolCapabilityRegistryContext, ToolCapabilityRegistryListOptions, ToolDiscoveryToolAvailabilityInput } from '../../types/tools.js'
import { decideToolCategoryAccess } from '../../utils/tools/access-policy'
import { descriptorForRegisteredTool, reasonsForToolPage, schemaPolicyForAvailability } from '../../utils/tools/capability-registry'
import {
  nextActionForDiscoveryAvailability,
  resolveToolDiscoveryAvailability,
  schemaStateForDiscoveryAvailability,
} from '../../utils/tools/discovery-availability'
import { isToolCompatibleWithModelInputs } from '../../utils/tools/model-input-policy'
import { isPluginBackedToolCategory } from '../../utils/tools/tool-space-resolver'

import { defaultRuntimePromptFeaturePolicy } from './DefaultPromptFeaturePolicy'
import { ToolRegistryHelper } from './ToolRegistry'











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

      // 能力页是 tooling:map 的数据源；不能只过滤最终 tools，否则模型仍会发现并换入
      // 自己无法消费结果的工具。
      if (!isToolCompatibleWithModelInputs(entry.tool, ctx)) {
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
