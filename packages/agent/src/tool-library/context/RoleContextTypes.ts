import type { AgentRoleId } from '@velaros-ai/agent/protocol'

/** 当前 Agent 角色状态，工具可据此了解身份和可委派方向。 */
export interface ToolRoleApi {
  /** 当前角色 id。 */
  readonly id: AgentRoleId
  /** 角色展示名称。 */
  readonly label: string
  /** 角色职责说明。 */
  readonly description: string
  /** 当前角色允许委派到的下一跳角色。 */
  readonly nextAllowedRoles: AgentRoleId[]
}
