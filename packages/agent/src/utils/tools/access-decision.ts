import { isFalse } from '@velaros-ai/core'

import type { BuildToolAccessDecisionInput, ToolAccessDecision, ToolAccessGates } from '../../types/tools.js'

import { toolOsStateForDiscoveryAvailability } from './discovery-availability'

function catalogGate(input: BuildToolAccessDecisionInput): ToolAccessGates['catalog'] {
  if (!input.categoryAllowed) return 'role_blocked'
  if (isFalse(input.systemEnabled)) return 'system_disabled'
  return 'ready'
}

function capabilityGate(input: BuildToolAccessDecisionInput): ToolAccessGates['capability'] {
  if (input.categoryEnabled) return 'enabled'
  return input.requiresApproval ? 'requires_approval' : 'loadable'
}

function runtimeGate(input: BuildToolAccessDecisionInput): ToolAccessGates['runtime'] {
  if (!input.categoryAccessAllowed) return 'tool_unavailable'
  return input.runtimeAvailable ? 'ready' : 'tool_unavailable'
}

function securityGate(): ToolAccessGates['security'] {
  return 'granted'
}

function approvalGate(input: BuildToolAccessDecisionInput): ToolAccessGates['approval'] {
  return input.finalState === 'requires_approval' ? 'manual_required' : 'not_required'
}

function residencyGate(input: BuildToolAccessDecisionInput): ToolAccessGates['residency'] {
  if (input.visible) return 'visible'
  return input.categoryEnabled && input.runtimeAvailable ? 'loadable' : 'not_resident'
}

function pluginGate(input: BuildToolAccessDecisionInput): ToolAccessGates['plugin'] {
  if (!input.pluginBacked) return 'not_required'
  return input.finalState === 'requires_user_action' ? 'requires_user_action' : 'enabled'
}

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
