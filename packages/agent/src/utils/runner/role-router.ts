import { toNullable } from '@velaros-ai/core'

import type { AgentRoleId, AgentSkillDescriptor } from '../../types/agent.js'
import type { AgentRoleDefinition, ResolveAgentRoleOptions, RoutedAgentRoleResult } from '../../types/runner.js'

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

/**
 * 显式选中技能的 allowed-tools 并集：用户挑了技能，且这些技能里**至少有一个**声明了工具门控时，
 * 返回它们允许的工具并集（只在这批工具里给模型）；一个都没声明门控就返回 null，表示本轮不额外限制工具面。
 *
 * 没有选中任何技能时同样返回 null——「没选技能」不该被当成「什么工具都不许用」。
 */
function resolveSelectedSkillAllowedTools(
  skillDescriptors: readonly AgentSkillDescriptor[],
  selectedSkillIds: Optional<readonly string[]>
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

export { resolveSelectedSkillAllowedTools }
