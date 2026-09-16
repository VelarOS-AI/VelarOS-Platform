import { toNullable } from '@velaros-ai/core'

import type {CapabilityScopeId, ToolCategoryId } from '../../types/agent.js'
import type { ToolAccessRuntimeState, ToolCategoryAccessDecision } from '../../types/tools.js'
import { decideCapabilityScopeCategory, resolveCapabilityScopeId } from '../capabilities'


function resolveActiveCapabilityScope(state: ToolAccessRuntimeState): CapabilityScopeId {
  return resolveCapabilityScopeId(state.capabilityPorts, {
    scopeId: state.activeCapabilityScope,
    satisfiedFactIds: state.satisfiedScopeFactIds,
  })
}

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
