import { isFalse } from '@velaros-ai/core'

import type { BuildToolAccessDecisionInput, ToolAccessDecision, ToolAccessGates } from '../../types/tools.js'

import { toolOsStateForDiscoveryAvailability } from './discovery-availability'

/**
 * 目录闸：判定这个工具/类别在「本角色的工具目录里存不存在」这一层是否通过。
 * 角色不允许该类别 → `role_blocked`；类别在但系统开关被显式关掉（`systemEnabled === false`）→ `system_disabled`；开关缺省视为开着 → `ready`。
 */
function catalogGate(input: BuildToolAccessDecisionInput): ToolAccessGates['catalog'] {
  if (!input.categoryAllowed) return 'role_blocked'
  if (isFalse(input.systemEnabled)) return 'system_disabled'
  return 'ready'
}

/**
 * 能力闸：判定所属工具类别当前是已开启，还是只是「可以开」。
 * 已开 → `enabled`；未开且需要人工批准 → `requires_approval`；未开但模型自己就能换页装上 → `loadable`。这一层不看运行时是否真的可用。
 */
function capabilityGate(input: BuildToolAccessDecisionInput): ToolAccessGates['capability'] {
  if (input.categoryEnabled) return 'enabled'
  return input.requiresApproval ? 'requires_approval' : 'loadable'
}

/**
 * 运行时闸：判定宿主这一侧到底有没有这个工具的实现可跑。
 * 作用域策略拒了该类别，或运行时根本没注册该工具，都算 `tool_unavailable`；两条都过才 `ready`。
 */
function runtimeGate(input: BuildToolAccessDecisionInput): ToolAccessGates['runtime'] {
  if (!input.categoryAccessAllowed) return 'tool_unavailable'
  return input.runtimeAvailable ? 'ready' : 'tool_unavailable'
}

/**
 * 安全闸：恒为 `granted` 的占位实现——真正的权限拦截在执行期由审批端口做，可用性判定这一层不重复拦。
 * 保留这个闸位是为了让 `ToolAccessDecision.gates` 的形状稳定（下游按固定七闸展示/诊断），将来接入安全策略时只换这一个函数。
 */
function securityGate(): ToolAccessGates['security'] {
  return 'granted'
}

/**
 * 审批闸：只把已经算出来的终态回读成闸位——终态是 `requires_approval` 就 `manual_required`，否则 `not_required`。
 * 它不自己判断要不要审批，纯粹让 gates 与 finalState 保持一致，避免两处各说各话。
 */
function approvalGate(input: BuildToolAccessDecisionInput): ToolAccessGates['approval'] {
  return input.finalState === 'requires_approval' ? 'manual_required' : 'not_required'
}

/**
 * 驻留闸：说明这个工具此刻是不是已经在模型看得见的工具集里。
 * 已在本回合暴露 → `visible`；没暴露但类别已开且运行时可用（换页即可拿到）→ `loadable`；其余 → `not_resident`。
 */
function residencyGate(input: BuildToolAccessDecisionInput): ToolAccessGates['residency'] {
  if (input.visible) return 'visible'
  return input.categoryEnabled && input.runtimeAvailable ? 'loadable' : 'not_resident'
}

/**
 * 插件闸：非插件提供的工具一律 `not_required`，与插件安装状态无关。
 * 插件提供的工具则看终态：需要用户去装/配才能用 → `requires_user_action`，否则 `enabled`。
 */
function pluginGate(input: BuildToolAccessDecisionInput): ToolAccessGates['plugin'] {
  if (!input.pluginBacked) return 'not_required'
  return input.finalState === 'requires_user_action' ? 'requires_user_action' : 'enabled'
}

/**
 * 把一个工具/能力页的可用性输入摊成完整的 `ToolAccessDecision`：终态与下一步动作照抄调用方算好的值，
 * 七个闸位（catalog/capability/runtime/security/approval/residency/plugin）在这里逐个求值，`toolOsState` 由终态映射而来。
 * `reasons` 做浅拷贝，调用方之后改自己的数组不会串改已产出的判定；这份结果同时供诊断面板和给模型的「为什么用不了」回执使用。
 */
function buildToolAccessDecision(input: BuildToolAccessDecisionInput): ToolAccessDecision {
  return {
    targetId: input.targetId,
    kind: input.kind,
    toolName: input.toolName,
    categoryId: input.categoryId,
    finalState: input.finalState,
    toolOsState: toolOsStateForDiscoveryAvailability(input.finalState),
    nextAction: input.nextAction,
    gates: {
      catalog: catalogGate(input),
      capability: capabilityGate(input),
      runtime: runtimeGate(input),
      security: securityGate(),
      approval: approvalGate(input),
      residency: residencyGate(input),
      plugin: pluginGate(input),
    },
    reasons: [...input.reasons],
  }
}

export { buildToolAccessDecision }
