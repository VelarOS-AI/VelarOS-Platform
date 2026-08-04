import type {
  AgentRoleId,
  CapabilityScopeId,
  ChatPromptFeatureId,
  ToolCategoryId,
} from '@velaros-ai/agent/protocol'

import type { AgentRoleDefinition } from './RoleTypes'

export interface AgentRoleToolBindings {
  getToolCategoryId: (toolName: string) => ToolCategoryId
  getToolNamesForCategories: (categories: ToolCategoryId[]) => string[]
  conversationToolNames: readonly string[]
}

export interface AgentRoleDescriptorProviderContext {
  selectedSkillIds: readonly string[]
  promptFeatures: readonly ChatPromptFeatureId[]
  capabilityScope?: CapabilityScopeId
}

/** Product composition owns concrete roles, skills and category bindings. */
export interface AgentRoleDescriptorProvider {
  listRoles(context: AgentRoleDescriptorProviderContext): readonly AgentRoleDefinition[]
}

class AgentRoleRegistry {
  constructor(
    private readonly provider: AgentRoleDescriptorProvider,
    private readonly context: AgentRoleDescriptorProviderContext
  ) {}

  public buildRoleMap(): Map<AgentRoleId, AgentRoleDefinition> {
    return new Map(
      this.provider
        .listRoles(this.context)
        .map((definition) => [definition.id, definition] as const)
    )
  }
}

export { AgentRoleRegistry }
