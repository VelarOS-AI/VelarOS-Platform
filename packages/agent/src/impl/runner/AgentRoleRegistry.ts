import type { AgentRoleDescriptorProvider } from '../../contract/requires.js'
import type { AgentRoleId } from '../../types/agent.js'
import type { AgentRoleDefinition, AgentRoleDescriptorProviderContext } from '../../types/runner.js'

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
