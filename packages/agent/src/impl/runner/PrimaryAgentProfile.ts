import type { ChatPromptFeatureId } from '../../types/agent'
import type { AgentRoleId, AgentSkillDescriptor,CapabilityScopeId } from '../../types/agent.js'
import type { AgentRoleDefinition, AgentRoleResolution, AgentRoleToolCategoryResolver } from '../../types/runner.js'
import { resolveSelectedSkillAllowedTools } from '../../utils/runner/role-router'

import { AgentRolePolicy } from './AgentRolePolicy'

/**
 * 主 Agent 需要的那一小面技能仓库：只用来取角色技能全文与本轮可见的技能清单，不承担安装、校验、落盘。
 * 由装配点注入真实仓库；参数一律透传给仓库，本件不解释它们的语义。
 */
interface PrimaryAgentProfileSkillRepository {
  /** 取某个角色的技能 Markdown 全文（按本轮选中的技能、提示词特性与能力作用域裁剪后的那一份）；没有内容时返回空串，调用方原样进提示词。 */
  getSkillMarkdownForRole(
    roleId: AgentRoleId,
    selectedSkillIds?: string[],
    promptFeatures?: readonly ChatPromptFeatureId[],
    capabilityScope?: CapabilityScopeId
  ): string
  /** 列出本轮该角色可见的技能描述（id、说明、可选的 allowed-tools 门控）；提示词的技能目录与技能工具门控都读这一份。 */
  listSkillsForRole(
    roleId: AgentRoleId,
    selectedSkillIds?: string[],
    capabilityScope?: CapabilityScopeId,
    promptFeatures?: readonly ChatPromptFeatureId[]
  ): AgentSkillDescriptor[]
}

/**
 * 当前作用域主 Agent 的角色画像：主 Agent 没有预设角色表，它的「角色」就是当前运行态实际开放的那一面能力。
 *
 * 由 `AgentRunner` 每轮调一次；无状态，工具面完全由入参（已知工具名、surface 隐藏名单、能否派子 Agent）决定。
 */
export interface PrimaryAgentProfileApi {
  /**
   * 解析本轮主 Agent 的角色结论：先按 surface 的隐藏名单剔掉不该让模型看见的工具，再交给角色策略过滤与分类，
   * 最后拼出一份 `AgentRoleResolution`（提示词、工具面、技能目录共用的同一份快照）。
   *
   * `allowSubAgents` 只影响职责文案，不改工具面本身——工具能不能用由 surface 的名单说了算。
   */
  resolve(options: {
    knownToolNames: string[]
    selectedSkillIds?: string[]
    promptFeatures?: readonly ChatPromptFeatureId[]
    activeCapabilityScope?: CapabilityScopeId
    /** 当前 surface 必须从模型和发现面移除的工具。 */
    hiddenToolNames?: readonly string[]
    /** 是否允许模型把复杂任务继续派发给子 Agent。 */
    allowSubAgents: boolean
  }): AgentRoleResolution
}

class PrimaryAgentProfile implements PrimaryAgentProfileApi {
  private readonly policy: AgentRolePolicy

  constructor(
    private readonly skillRepository: PrimaryAgentProfileSkillRepository,
    categoryResolver: AgentRoleToolCategoryResolver
  ) {
    this.policy = new AgentRolePolicy(categoryResolver)
  }

  public resolve(options: {
    knownToolNames: string[]
    selectedSkillIds?: string[]
    promptFeatures?: readonly ChatPromptFeatureId[]
    activeCapabilityScope?: CapabilityScopeId
    /** 当前 surface 必须从模型和发现面移除的工具。 */
    hiddenToolNames?: readonly string[]
    /** 是否允许模型把复杂任务继续派发给子 Agent。 */
    allowSubAgents: boolean
  }): AgentRoleResolution {
    const hiddenToolNames = new Set(options.hiddenToolNames ?? [])
    const knownToolNames = options.knownToolNames.filter((name) => !hiddenToolNames.has(name))
    const allowSubAgents = options.allowSubAgents
    const baseSkillMarkdown = this.skillRepository.getSkillMarkdownForRole(
      'primary-agent',
      options.selectedSkillIds,
      options.promptFeatures,
      options.activeCapabilityScope
    )
    const skillDescriptors = this.skillRepository.listSkillsForRole(
      'primary-agent',
      options.selectedSkillIds,
      options.activeCapabilityScope,
      options.promptFeatures
    )
    const contract: AgentRoleDefinition = {
      id: 'primary-agent',
      label: '主 Agent',
      description: '当前运行作用域的统一执行主体。',
      skillMarkdown: baseSkillMarkdown,
      toolNames: knownToolNames,
      allowedNextRoles: [],
      workflowTypes: ['system-task'],
      responsibilities: [
        '只使用当前作用域实际开放的能力完成任务。',
        allowSubAgents
          ? '复杂且可独立推进的子任务可以按当前运行态允许的范围派发。'
          : '当前运行态不提供子 Agent 派发。',
        '在无法执行时明确说明真实限制，并给出最直接的下一步方案。',
      ],
      expectedOutputKind: 'task-result',
      builtIn: false,
    }
    const initiallyAvailableTools = this.policy.buildAllowedTools(contract, {
      knownToolNames,
    })
    const allowedTools = initiallyAvailableTools
    const enabledToolCategories = this.policy.getEnabledCategories(initiallyAvailableTools)

    return {
      id: contract.id,
      label: contract.label,
      description: contract.description,
      workflowType: contract.workflowTypes[0],
      skillMarkdown: contract.skillMarkdown,
      skillDescriptors,
      selectedSkillAllowedTools: resolveSelectedSkillAllowedTools(
        skillDescriptors,
        options.selectedSkillIds
      ),
      activeCapabilityScope: options.activeCapabilityScope,
      enabledToolCategories,
      allowedTools,
      usesCapabilityContext: true,
      nextAllowedRoles: [],
      routeNote: '当前作用域主 Agent',
      contract,
    }
  }
}

export { PrimaryAgentProfile }
export type { PrimaryAgentProfileSkillRepository }
