import type { AgentRoleDescriptorProvider } from '../../contract/requires.js'
import type { AgentRoleId } from '../../types/agent.js'
import type { AgentRoleDefinition, AgentRoleDescriptorProviderContext } from '../../types/runner.js'

/**
 * 角色注册表：向宿主注入的角色 provider 要一份当前上下文（技能开关、提示词特性、能力作用域）下的角色清单，
 * 摊成 id → 定义的查表结构。由 `AgentRoleEngine.resolve` 每轮现建现用，不缓存——缓存会让技能开关改了不生效。
 */
export interface AgentRoleRegistryApi {
  /** 取一次角色清单并按 `id` 摊平；provider 给空清单时返回空 Map，由调用方决定怎么降级。同一份 id 重复出现时后来者覆盖前者。 */
  buildRoleMap(): Map<AgentRoleId, AgentRoleDefinition>
}

class AgentRoleRegistry implements AgentRoleRegistryApi {
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
