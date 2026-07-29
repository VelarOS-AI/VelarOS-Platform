import type { AgentSkillRepository } from '../skills'

import { AgentRolePolicy } from './RolePolicy'
import {
  type AgentRoleDescriptorProvider,
  AgentRoleRegistry,
  type AgentRoleToolBindings,
} from './RoleRegistry'
import { resolveLockedAgentRole } from './RoleRouter'
import type { AgentRoleResolution, ResolveAgentRoleOptions } from './RoleTypes'

/**
 * 智能体角色解析引擎。
 *
 * 输入当前运行环境（能力作用域、用户选择的技能等），
 * 输出本轮智能体的角色、系统提示词、可用工具和工具分类。
 *
 * 工具集合经 {@link AgentRoleToolBindings} 端口注入——内核不硬依赖任何具体工具库，
 * 宿主在装配点提供内置工具集与分类映射。
 */
class AgentRoleEngine {
  /** 角色工具策略：按角色/环境过滤工具并判断是否需要代码上下文。 */
  private readonly policy: AgentRolePolicy

  constructor(
    /** 技能仓库会把内置角色技能和用户配置技能合并进角色提示词。 */
    private readonly skillRepository: AgentSkillRepository,
    /** 角色工具集绑定（宿主注入）。 */
    private readonly toolBindings: AgentRoleToolBindings,
    private readonly roleProvider: AgentRoleDescriptorProvider
  ) {
    this.policy = new AgentRolePolicy({
      getToolCategoryId: this.toolBindings.getToolCategoryId,
    })
  }

  /** 解析完整角色运行结果。 */
  public resolve(options: ResolveAgentRoleOptions): AgentRoleResolution {
    // 注册表每次基于 selectedSkillIds 构建，保证技能开关实时生效。
    const registry = new AgentRoleRegistry(this.roleProvider, {
      selectedSkillIds: options.selectedSkillIds ?? [],
      promptFeatures: options.promptFeatures ?? [],
      capabilityScope: options.activeCapabilityScope,
    })
    const roleMap = registry.buildRoleMap()
    // 先解析锁定角色（子 Agent 恒 locked）；策略再按宿主能力作用域收窄工具面。
    const routedRole = resolveLockedAgentRole(roleMap, options)
    const role = routedRole.role

    const allowedTools = this.policy.buildAllowedTools(role, {
      knownToolNames: options.knownToolNames,
    })
    const enabledToolCategories = this.policy.getEnabledCategories(allowedTools)
    const nextAllowedRoles = role.allowedNextRoles ?? []

    // 角色解析结果是智能体宿主/提示词/工具上下文共用的快照。
    return {
      id: role.id,
      label: role.label,
      description: role.description,
      workflowType: routedRole.workflowType,
      skillMarkdown: role.skillMarkdown,
      skillDescriptors: this.skillRepository.listSkillsForRole(
        role.id,
        options.selectedSkillIds,
        options.activeCapabilityScope,
        undefined,
        options.promptFeatures
      ),
      // 多角色路径暂不接技能工具门控（主 surface 统一走 primary-agent）。
      selectedSkillAllowedTools: null,
      activeCapabilityScope: options.activeCapabilityScope,
      enabledToolCategories,
      allowedTools,
      nextAllowedRoles,
      routeNote: routedRole.routeNote,
      contract: role,
      usesCapabilityContext: true,
    }
  }
}

export { AgentRoleEngine }
