import { logRuntime } from '@velaros-ai/core/logger'

import type { ToolCategoryId } from '../../types/agent.js'
import type { AgentRoleDefinition, AgentRoleToolCategoryResolver } from '../../types/runner.js'
import { compareStableStrings } from '../../utils/residency/determinism'

/**
 * 角色策略：把角色声明的工具面，收窄成当前运行态真正可用的那一份，并反推出要展示给模型的工具分类。
 *
 * 由 `AgentRoleEngine` / `PrimaryAgentProfile` 在解析角色时各持一份，无状态、可反复调用。
 * 失败语义是**不阻断**：分类解析抛错时记 debug 日志并放行该工具，避免新工具还没补分类映射就整个不可用。
 */
export interface AgentRolePolicyApi {
  /**
   * 从角色声明的 `toolNames` 里过滤出本轮真正能给模型的工具：未注册（插件缺失、宿主没装）的直接丢掉，
   * 分类解析失败的保留。返回顺序与角色声明顺序一致，供提示词稳定渲染。
   */
  buildAllowedTools(role: AgentRoleDefinition, options: { knownToolNames: string[] }): string[]
  /** 从一批工具名反推它们所属的启用分类；分类未知的工具跳过，结果按稳定序排序（禁 locale 比较），保证提示词逐字节可复现。 */
  getEnabledCategories(toolNames: string[]): ToolCategoryId[]
}

class AgentRolePolicy implements AgentRolePolicyApi {
  private readonly log = logRuntime.tag('AgentRolePolicy')

  constructor(private readonly categoryResolver: AgentRoleToolCategoryResolver) {}

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
