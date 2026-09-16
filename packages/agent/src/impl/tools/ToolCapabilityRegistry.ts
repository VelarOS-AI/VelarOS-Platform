import { toNullable } from '@velaros-ai/core'

import type { RuntimePromptFeaturePolicy } from '../../contract/requires.js'
import type { ToolCategoryOverview, ToolDescriptor } from '../../types/agent.js'
import type { RegisteredToolMap, RegistryTool, ToolCapabilityPage, ToolCapabilityRegistryContext, ToolCapabilityRegistryListOptions, ToolDiscoveryToolAvailabilityInput, ToolRegistryContext } from '../../types/tools'
import { decideToolCategoryAccess } from '../../utils/tools/access-policy'
import { descriptorForRegisteredTool, reasonsForToolPage, schemaPolicyForAvailability } from '../../utils/tools/capability-registry'
import { nextActionForDiscoveryAvailability, resolveToolDiscoveryAvailability, schemaStateForDiscoveryAvailability } from '../../utils/tools/discovery-availability'
import { isToolCompatibleWithModelInputs } from '../../utils/tools/model-input-policy'
import { isPluginBackedToolCategory } from '../../utils/tools/tool-space-resolver'

import { defaultRuntimePromptFeaturePolicy } from './DefaultPromptFeaturePolicy'
import { ToolRegistryHelper } from './ToolRegistry'

/**
 * 工具能力发现面：给「模型现在能用什么、还能换入什么」这个问题出数据。
 *
 * 可见性判定本身复用 `ToolRegistry`（本类构造时自建一份持有），这里只多做一件事——
 * 把不可见的工具也按页列出来，并说清它为什么不可见、下一步该做什么（`tooling:map` 的数据源）。
 * 无自有状态，按会话或按需建都行。
 */
export interface ToolCapabilityRegistryApi {
  /** 列当前可见的工具 descriptor；`scope` 缺省 `enabled`（只算本轮真驻留的），`all` 连可换入的一起算。 */
  listTools<TContext extends ToolRegistryContext, TTool extends RegistryTool<TContext>>(
    registry: RegisteredToolMap<TTool>,
    ctx: TContext,
    options?: ToolCapabilityRegistryListOptions
  ): ToolDescriptor[]
  /** 同 `listTools`，但按类别聚合，供设置页与类别概览用。 */
  listCategories<TContext extends ToolRegistryContext, TTool extends RegistryTool<TContext>>(
    registry: RegisteredToolMap<TTool>,
    ctx: TContext,
    options?: ToolCapabilityRegistryListOptions
  ): ToolCategoryOverview[]
  /**
   * 列能力页：每个工具一页，带可用性档位（visible / loadable / requires_approval …）、schema 给多少、
   * 下一步动作与不可用原因。模型消费不了输出的工具（多模态不匹配）直接不出现——让它发现了也没用；
   * 声明了 `hideWhenUnavailable` 且当前运行态不可用的同样不出现，其余一律留在页表里并附原因。
   */
  listCapabilityPages<
    TContext extends ToolCapabilityRegistryContext,
    TTool extends RegistryTool<TContext>,
  >(
    registry: RegisteredToolMap<TTool>,
    ctx: TContext,
    options?: Pick<ToolCapabilityRegistryListOptions, 'allowList'>
  ): ToolCapabilityPage[]
}

class ToolCapabilityRegistry implements ToolCapabilityRegistryApi {
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

/** 建一份工具能力登记处：按能力声明决定工具在这一轮可不可见。 */
export function createToolCapabilityRegistry(promptFeaturePolicy: RuntimePromptFeaturePolicy = defaultRuntimePromptFeaturePolicy): ToolCapabilityRegistryApi {
  return new ToolCapabilityRegistry(promptFeaturePolicy)
}
