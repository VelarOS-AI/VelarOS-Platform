import type { AgentRoleId } from '@velaros-ai/agent/protocol'
import { toNullable } from '@velaros-ai/core'

import type { AgentRoleDefinition, ResolveAgentRoleOptions, WorkflowType } from './RoleTypes'

interface RoutedAgentRoleResult {
  /** 选中的角色定义。 */
  role: AgentRoleDefinition
  /** 选择原因，写入调试信息。 */
  routeNote: string
  /** 角色主 workflow。 */
  workflowType: WorkflowType
}

/**
 * 解析子 Agent 锁定角色（B4/D5 死枝清除后的唯一路由形态）。
 *
 * 唯一调用链 QueryLoop.execute → roleEngine.resolve **恒携带 lockedRoleId**：派发器传
 * typeConfig.roleId（描述符表值域 = 内置五角色），无显式合约时 LoopRuntime 兜 'operator'；
 * roleMap 恒含宿主注入的角色定义。旧「初始角色 / 作用域策略回退」分类从不触发，
 * 已随角色层收缩删除。
 */
function resolveLockedAgentRole(
  roleMap: Map<AgentRoleId, AgentRoleDefinition>,
  options: ResolveAgentRoleOptions
): RoutedAgentRoleResult {
  const lockedRole = options.lockedRoleId ? toNullable(roleMap.get(options.lockedRoleId)) : null
  if (!lockedRole) {
    throw new Error(
      `子 Agent 角色解析要求锁定内置角色，收到：${options.lockedRoleId ?? '(缺失)'}`
    )
  }
  return {
    role: lockedRole,
    // 角色 workflowTypes 的第一个值是主 workflow；内置五角色均有声明，'chat' 仅类型兜底。
    workflowType: lockedRole.workflowTypes[0] ?? 'chat',
    routeNote: `固定角色：${lockedRole.label}`,
  }
}

export { resolveLockedAgentRole }
export type { RoutedAgentRoleResult }
