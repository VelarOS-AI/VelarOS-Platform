import type { ToolCategoryId } from '@velaros-ai/agent/protocol'
import { logRuntime } from '@velaros-ai/core/logger'

import { compareStableStrings } from './context/residency/determinism'
import type { AgentRoleDefinition } from './RoleTypes'

interface AgentRoleToolCategoryResolver {
  getToolCategoryId(toolName: string): ToolCategoryId
}

/** 角色策略：按宿主作用域和工具分类计算角色可用能力。 */
class AgentRolePolicy {
  private readonly log = logRuntime.tag('AgentRolePolicy')

  constructor(private readonly categoryResolver: AgentRoleToolCategoryResolver) {}

  /** 从角色声明的工具里过滤出当前上下文真正可用的工具。 */
  public buildAllowedTools(
    role: AgentRoleDefinition,
    options: {
      knownToolNames: string[]
    }
  ): string[] {
    const knownTools = new Set(options.knownToolNames)
    const rawToolNames = role.toolNames

    return rawToolNames.filter((toolName) => {
      // 角色定义里可能引用了未注册/插件缺失的工具，直接过滤掉。
      if (!knownTools.has(toolName)) return false

      try {
        this.categoryResolver.getToolCategoryId(toolName)
        return true
      } catch (error) {
        this.log.debug('构建允许工具列表时工具类别不可用', {
          roleId: role.id,
          toolName,
          error,
        })
        // 未知分类映射不阻断工具，避免新工具尚未补全映射时完全不可用。
        return true
      }
    })
  }

  /** 从工具名反推启用分类，并按 ToolCatalog 中的顺序稳定排序。 */
  public getEnabledCategories(toolNames: string[]): ToolCategoryId[] {
    const categories = new Set<ToolCategoryId>()

    toolNames.forEach((toolName) => {
      try {
        categories.add(this.categoryResolver.getToolCategoryId(toolName))
      } catch (error) {
        this.log.debug('收集启用类别时工具类别不可用', {
          toolName,
          error,
        })
        // ignore unknown tool mapping
      }
    })

    // P7-2：类目序进工具清单渲染，禁 locale 相关比较。
    return [...categories].sort(compareStableStrings)
  }
}

export { AgentRolePolicy }
export type { AgentRoleToolCategoryResolver }
