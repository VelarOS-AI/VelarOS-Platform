import { isEmpty } from '@velaros-ai/core'

import type { AgentRuntimeCapabilityPorts, RuntimePromptFeaturePolicy } from '../../contract/requires.js'
import type { ToolAvailabilityScope, ToolCategoryId, ToolCategoryOverview, ToolDescriptor } from '../../types/agent.js'
import type { OverriddenToolMap, RegisteredTool, RegisteredToolMap, RegistryTool, ToolRegistryContext } from '../../types/tools'
import { compareStableStrings } from '../../utils/residency/determinism'
import { isToolCategoryAvailable } from '../../utils/tools/access-policy'
import { activeDescriptorForRegisteredTool } from '../../utils/tools/capability-registry'
import { isToolCompatibleWithModelInputs } from '../../utils/tools/model-input-policy'
import { resolveCategoryDefinition } from '../../utils/tools/tool-registry'

import { defaultRuntimePromptFeaturePolicy } from './DefaultPromptFeaturePolicy'

/**
 * 工具可见性过滤器（别名 `ToolRegistryHelper`）：回答「这个上下文下哪些工具该出现」。
 *
 * 自己不存工具——注册表按名存工具、管 provider 生命周期，这里每次都从调用方传进来的
 * `registry` 现算。只读一份 prompt feature 策略作为构造依赖，除此之外无状态，可安全共用一份实例。
 * 过滤顺序从便宜到昂贵（allowList → 类别 → 系统开关 → 模型可消费性 → 工具自判 → 会话授权），
 * 判不出结论一律按「不可见」收敛。
 */
export interface ToolRegistryApi {
  /** 这个工具类别在当前上下文（角色、能力作用域、注入端口）下是否整体可见；整类不可见时里面的工具一个都不出现。 */
  isCategoryAvailable(ctx: ToolRegistryContext, categoryId: RegisteredTool['categoryId']): boolean
  /**
   * 列出当前上下文可用的注册表 entry（名字 + 原始条目），是 `listAvailable` / `listCategories` 的共同底座。
   * `allowList` 非空时先按名收窄（子 Agent 与反射调用用它划边界）；`scope` 为 `enabled` 时还要过会话类别授权、
   * 本轮 active 类别与 prompt feature 三道，`all` 只过前面那几道硬门。
   */
  listAvailableEntries<TContext extends ToolRegistryContext, TTool extends RegistryTool<TContext>>(
    registry: RegisteredToolMap<TTool>,
    ctx: TContext,
    allowList?: string[],
    scope?: ToolAvailabilityScope
  ): Array<[string, RegisteredTool<TTool>]>
  /** 把可用 entry 渲染成 descriptor 列表，供模型工具表、UI 与 list_tools 类工具展示；顺序跟随注册表插入序。 */
  listAvailable<TContext extends ToolRegistryContext, TTool extends RegistryTool<TContext>>(
    registry: RegisteredToolMap<TTool>,
    ctx: TContext,
    allowList?: string[],
    scope?: ToolAvailabilityScope
  ): ToolDescriptor[]
  /** 同 `listAvailable`，但按类别聚合并按类别名、工具名稳定排序；一个工具都不剩的类别整条丢掉。 */
  listCategories<TContext extends ToolRegistryContext, TTool extends RegistryTool<TContext>>(
    registry: RegisteredToolMap<TTool>,
    ctx: TContext,
    allowList?: string[],
    scope?: ToolAvailabilityScope
  ): ToolCategoryOverview[]
  /**
   * 设置页用的全量概览：不看会话上下文，所以不会因为当前授权隐藏任何工具，只按 `disabledToolNames`
   * 标出系统层禁用。被覆盖的注册（`overriddenRegistry`）也一并列出并标 `overridden`，供用户看清是谁顶掉了谁。
   */
  getOverviewWithDisabledTools<TTool extends RegistryTool<any>>(
    registry: RegisteredToolMap<TTool>,
    disabledToolNames: string[],
    overriddenRegistry?: OverriddenToolMap<TTool>,
    capabilityPorts?: AgentRuntimeCapabilityPorts
  ): ToolCategoryOverview[]
}

/**
 * 工具注册表辅助类。
 *
 * 这里集中处理“某个上下文下哪些工具可见”的过滤规则，ToolRegistry 本身只负责
 * 存储和 provider 生命周期，避免注册表类膨胀。
 */
class ToolRegistry implements ToolRegistryApi {
  constructor(
    private readonly promptFeaturePolicy: RuntimePromptFeaturePolicy = defaultRuntimePromptFeaturePolicy
  ) {}

  /** 结合会话声明的能力作用域、角色和注入端口判断类别是否可见。 */
  public isCategoryAvailable(
    ctx: ToolRegistryContext,
    categoryId: RegisteredTool['categoryId']
  ): boolean {
    return isToolCategoryAvailable(categoryId, {
      roleId: ctx.role.id,
      activeCapabilityScope: ctx.codingSession.getActiveCapabilityScope?.(),
      capabilityPorts: ctx.capabilityPorts,
    })
  }

  /**
   * 列出当前上下文可用的 Registry entry。
   *
   * 过滤顺序从便宜到昂贵：allowList -> 类别运行时状态 -> 系统开关 ->
   * 工具自定义可见性 -> session 类别授权/prompt feature。
   *
   * ToolPermission 是工具的底层能力/风险 metadata，不作为默认可见性门槛；真正的硬阻断
   * 由角色、运行态、系统禁用、能力启用和高风险审批承担。
   */
  public listAvailableEntries<
    TContext extends ToolRegistryContext,
    TTool extends RegistryTool<TContext>,
  >(
    registry: RegisteredToolMap<TTool>,
    ctx: TContext,
    allowList?: string[],
    scope: ToolAvailabilityScope = 'enabled'
  ): Array<[string, RegisteredTool<TTool>]> {
    const entries: Array<[string, RegisteredTool<TTool>]> = []

    for (const [name, entry] of registry) {
      // 子 Agent 或特定执行场景可传 allowList 限制工具边界。
      if (allowList && !allowList.includes(name)) {
        continue
      }

      if (!ctx.codingSession.isToolCategoryAllowed(entry.categoryId)) {
        continue
      }

      // 类别所需能力端口未注入或作用域不可用时整类隐藏。
      if (!this.isCategoryAvailable(ctx, entry.categoryId)) {
        continue
      }

      // 设置页可禁用单个工具，这里把禁用项从模型工具列表移除。
      if (!ctx.isToolSystemEnabled(name)) {
        continue
      }

      // 工具输出会成为下一轮模型输入；实际模型无法消费时不得进入发现或执行表面。
      if (!isToolCompatibleWithModelInputs(entry.tool, ctx)) {
        continue
      }

      // 工具可基于宿主上下文做更细的可见性判断。
      if (entry.tool.isAvailable && !entry.tool.isAvailable(ctx)) {
        continue
      }

      if (scope === 'enabled') {
        // enabled 范围需要检查当前 session 是否已打开该类别能力。
        if (!ctx.codingSession.hasToolCategoryAccess(entry.categoryId)) {
          continue
        }

        // 如果本轮设置了 active category 边界，则只把当前意图需要的类别注入模型。
        if (!ctx.codingSession.hasActiveToolCategoryAccess(entry.categoryId)) {
          continue
        }

        // 某些插件能力还受 prompt feature 控制，例如 Office 细分类工具。
        if (!this.hasRequiredPromptFeature(ctx, name, entry.categoryId)) {
          continue
        }
      }

      entries.push([name, entry])
    }

    return entries
  }

  /** 检查工具是否满足 prompt feature 要求，Office 总开关可覆盖细分能力。 */
  private hasRequiredPromptFeature(
    ctx: ToolRegistryContext,
    toolName: string,
    categoryId: RegisteredTool['categoryId']
  ): boolean {
    const requiredPromptFeature = this.promptFeaturePolicy.getRequiredFeatureForTool(
      toolName,
      categoryId
    )
    if (!requiredPromptFeature) return true

    if (ctx.codingSession.hasPromptFeatureAccess(requiredPromptFeature)) return true

    // tooling:replace 对具体工具的 page-in 是一个精确、短期的工具选择。它只绕过产品入口的
    // prompt-feature 筛选，不绕过类别/作用域/系统开关/isAvailable 等真正执行边界。
    // 否则 Word 这类按需工具会陷入「发现层说可换入，换入后仍因未点 UI feature 而消失」的死路。
    if (ctx.codingSession.hasToolNameAccess?.(toolName)) return true

    return (
      this.promptFeaturePolicy.isOfficeFeature(requiredPromptFeature) &&
      ctx.codingSession.hasPromptFeatureAccess('office')
    )
  }

  /** 输出工具 descriptor，供 UI、调试面板和 list_tools 类工具展示。 */
  public listAvailable<TContext extends ToolRegistryContext, TTool extends RegistryTool<TContext>>(
    registry: RegisteredToolMap<TTool>,
    ctx: TContext,
    allowList?: string[],
    scope: ToolAvailabilityScope = 'enabled'
  ): ToolDescriptor[] {
    return this.listAvailableEntries(registry, ctx, allowList, scope).map(([name, entry]) =>
      activeDescriptorForRegisteredTool(name, entry)
    )
  }

  /** 按类别聚合当前可见工具。 */
  public listCategories<TContext extends ToolRegistryContext, TTool extends RegistryTool<TContext>>(
    registry: RegisteredToolMap<TTool>,
    ctx: TContext,
    allowList?: string[],
    scope: ToolAvailabilityScope = 'enabled'
  ): ToolCategoryOverview[] {
    const grouped = new Map<ToolCategoryId, ToolDescriptor[]>()

    // 复用 listAvailableEntries 的过滤逻辑，但直接分组，避免先构造一整份 flat descriptors。
    for (const [name, entry] of this.listAvailableEntries(registry, ctx, allowList, scope)) {
      const bucket = grouped.get(entry.categoryId) ?? []
      bucket.push(activeDescriptorForRegisteredTool(name, entry))
      grouped.set(entry.categoryId, bucket)
    }

    return [...grouped.keys()]
      .sort(compareStableStrings)
      .map((categoryId) => {
        const category = resolveCategoryDefinition(categoryId, ctx.capabilityPorts)
        const tools = (grouped.get(categoryId) ?? []).sort((left, right) =>
          compareStableStrings(left.name, right.name)
        )
        return {
          category,
          enabled: !isEmpty(tools) && ctx.codingSession.hasToolCategoryAccess(category.id),
          tools,
        }
      })
      .filter((entry) => !isEmpty(entry.tools))
  }

  /**
   * 生成设置页使用的全量概览。
   *
   * 这个方法不依赖 ToolContext，所以不会因为当前 session 权限隐藏工具；
   * 它只标注系统层 disabled 状态。
   */
  public getOverviewWithDisabledTools<TTool extends RegistryTool<any>>(
    registry: RegisteredToolMap<TTool>,
    disabledToolNames: string[],
    overriddenRegistry: OverriddenToolMap<TTool> = new Map(),
    capabilityPorts?: AgentRuntimeCapabilityPorts
  ): ToolCategoryOverview[] {
    const disabledTools = new Set(disabledToolNames)
    const grouped = new Map<ToolCategoryId, ToolDescriptor[]>()

    // 逐个工具装入所属类别 bucket，并标出系统开关是否启用。
    for (const [name, entry] of registry) {
      const bucket = grouped.get(entry.categoryId) ?? []
      bucket.push({
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
        systemEnabled: !disabledTools.has(name),
        providerId: entry.providerId,
        providerKind: entry.providerKind,
        registrationStatus: 'active',
      })
      grouped.set(entry.categoryId, bucket)
    }

    for (const [name, entries] of overriddenRegistry) {
      entries.forEach((entry) => {
        const bucket = grouped.get(entry.categoryId) ?? []
        bucket.push({
          descriptorId: entry.descriptorId ?? `${name}:overridden:${entry.providerId ?? 'unknown'}`,
          name,
          description: entry.tool.description,
          usageSkillId: entry.tool.usageSkillId,
          role: entry.tool.role,
          permissions: entry.tool.permissions,
          capabilities: entry.tool.capabilities,
          requiredModelInputModalities: entry.tool.requiredModelInputModalities,
          exposure: entry.tool.exposure,
          categoryId: entry.categoryId,
          systemEnabled: false,
          providerId: entry.providerId,
          providerKind: entry.providerKind,
          registrationStatus: 'overridden',
          overriddenByProviderId: entry.overriddenByProviderId,
          overriddenByProviderKind: entry.overriddenByProviderKind,
        })
        grouped.set(entry.categoryId, bucket)
      })
    }

    return [...grouped.keys()].sort(compareStableStrings).map((categoryId) => {
      const category = resolveCategoryDefinition(categoryId, capabilityPorts)
      const tools = (grouped.get(categoryId) ?? []).sort((left, right) => {
        const nameOrder = compareStableStrings(left.name, right.name)
        if (nameOrder !== 0) return nameOrder

        const statusOrder =
          (left.registrationStatus === 'overridden' ? 1 : 0) -
          (right.registrationStatus === 'overridden' ? 1 : 0)
        if (statusOrder !== 0) return statusOrder

        return compareStableStrings(left.providerId ?? '', right.providerId ?? '')
      })
      return {
        category,
        enabled: category.toolOs.defaultState === 'resident' && tools.some((tool) => tool.systemEnabled),
        tools,
      }
    })
  }
}

export { ToolRegistry }
export type { RegisteredTool }
export { ToolRegistry as ToolRegistryHelper }

/** 建一份工具登记处：工具、类别与可见性判定都在它身上。 */
export function createToolRegistry(promptFeaturePolicy: RuntimePromptFeaturePolicy = defaultRuntimePromptFeaturePolicy): ToolRegistryApi {
  return new ToolRegistry(promptFeaturePolicy)
}
