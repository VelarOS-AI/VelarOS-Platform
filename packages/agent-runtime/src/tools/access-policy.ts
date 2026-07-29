import type {
  AgentRoleId,
  CapabilityScopeId,
  ToolCategoryId,
} from '@velaros-ai/core/types'

import {
  type AgentRuntimeCapabilityPorts,
  decideCapabilityScopeCategory,
  resolveCapabilityScopeId,
} from '../capabilities'

type ToolCategoryUnavailableReason = string

interface ToolAccessRuntimeState {
  roleId: AgentRoleId
  activeCapabilityScope?: CapabilityScopeId
  capabilityPorts?: AgentRuntimeCapabilityPorts
  satisfiedScopeFactIds?: readonly string[]
}

interface ToolCategoryAccessDecision {
  allowed: boolean
  reason: Nullable<ToolCategoryUnavailableReason>
  message?: string
}

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
    reason: decision.reasonCode ?? null,
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
export type {
  ToolAccessRuntimeState,
  ToolCategoryAccessDecision,
  ToolCategoryUnavailableReason,
}
