import type {
  AgentRoleId,
  AgentSkillDescriptor,
  CapabilityScopeId,
  ChatPromptFeatureId,
} from '@velaros-ai/core/types'

import type { AgentRoleToolCategoryResolver } from './RolePolicy'
import { AgentRolePolicy } from './RolePolicy'
import type { AgentRoleDefinition, AgentRoleResolution } from './RoleTypes'

interface PrimaryAgentProfileSkillRepository {
  getSkillMarkdownForRole(
    roleId: AgentRoleId,
    selectedSkillIds?: string[],
    promptFeatures?: readonly ChatPromptFeatureId[],
    capabilityScope?: CapabilityScopeId
  ): string
  listSkillsForRole(
    roleId: AgentRoleId,
    selectedSkillIds?: string[],
    capabilityScope?: CapabilityScopeId,
    promptFeatures?: readonly ChatPromptFeatureId[]
  ): AgentSkillDescriptor[]
}

/** 显式选中技能的 allowed-tools 并集；没有任何选中技能声明门控时返回 null（不限制）。 */
function resolveSelectedSkillAllowedTools(
  skillDescriptors: readonly AgentSkillDescriptor[],
  selectedSkillIds: readonly string[] | undefined
): Nullable<string[]> {
  const selected = new Set((selectedSkillIds ?? []).map((id) => id.trim()).filter(Boolean))
  if (selected.size === 0) return null
  const union = new Set<string>()
  let declared = false
  for (const descriptor of skillDescriptors) {
    if (!selected.has(descriptor.id) || !descriptor.allowedTools?.length) continue
    declared = true
    for (const toolName of descriptor.allowedTools) union.add(toolName)
  }
  return declared ? [...union] : null
}

class PrimaryAgentProfile {
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
