import { toNullable } from '@velaros-ai/core'

import type {CapabilityScopeId, ToolCategoryId } from '../../types/agent.js'
import type { ToolAccessRuntimeState, ToolCategoryAccessDecision } from '../../types/tools.js'
import { decideCapabilityScopeCategory, resolveCapabilityScopeId } from '../capabilities'


/**
 * 从运行态里取出本次工具可用性判定该用的作用域 id：把 `activeCapabilityScope` 和已满足的事实 id 一起交给作用域策略裁决。
 * 策略缺席时回退到运行态自报的 scopeId，再退到 `'default'`，所以这里永远给得出一个 id，不会因为没配策略而卡住判定。
 */
function resolveActiveCapabilityScope(state: ToolAccessRuntimeState): CapabilityScopeId {
  return resolveCapabilityScopeId(state.capabilityPorts, {
    scopeId: state.activeCapabilityScope,
    satisfiedFactIds: state.satisfiedScopeFactIds,
  })
}

/**
 * 在当前作用域下问「这个工具类别能不能开」，并把作用域策略的裁决摊平成 `{ allowed, reason, message }`。
 * 没配作用域策略 = 放行（拒绝必须由策略明确表态）；`reason` 取自策略的 reasonCode，缺省时为 null，`message` 是给模型看的人话解释。
 */
function decideToolCategoryAccess(
  categoryId: ToolCategoryId,
  state: ToolAccessRuntimeState
): ToolCategoryAccessDecision {
  const decision = decideCapabilityScopeCategory(state.capabilityPorts, categoryId, {
    scopeId: resolveActiveCapabilityScope(state),
    satisfiedFactIds: state.satisfiedScopeFactIds,
  })
  return {
    allowed: decision.allowed,
    reason: toNullable(decision.reasonCode),
    message: decision.message,
  }
}

/**
 * `decideToolCategoryAccess` 的布尔快捷式：只在作用域策略放行（或压根没有策略）时为真，丢掉 reason/message。
 * 用在只需要过滤、不需要向模型解释为什么被挡的地方；要给模型回执就别用这个，用带 reason 的那支。
 */
function isToolCategoryAvailable(
  categoryId: ToolCategoryId,
  state: ToolAccessRuntimeState
): boolean {
  return decideToolCategoryAccess(categoryId, state).allowed
}

export {
  decideToolCategoryAccess,
  isToolCategoryAvailable,
  resolveActiveCapabilityScope,
}
