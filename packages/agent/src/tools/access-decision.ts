import type { ToolCategoryId, ToolOsState } from '@velaros-ai/agent/protocol'
import { isFalse } from '@velaros-ai/core'

import type { ToolCategoryUnavailableReason } from './access-policy'
import {
  type ToolDiscoveryAvailability,
  type ToolDiscoveryNextAction,
  toolOsStateForDiscoveryAvailability,
} from './discovery-availability'

type ToolAccessLayer = string

type ToolAccessPageKind = 'tool' | 'capability' | 'plugin'
type ToolAccessFinalState = ToolDiscoveryAvailability

interface ToolAccessReason {
  layer: ToolAccessLayer
  code: string
  message: string
  details?: Record<string, unknown>
}

interface ToolAccessGates {
  catalog: 'ready' | 'role_blocked' | 'system_disabled'
  capability: 'enabled' | 'default_open' | 'loadable' | 'requires_approval'
  runtime: 'ready' | 'tool_unavailable'
  security: 'granted'
  approval: 'not_required' | 'auto_approved' | 'manual_required' | 'rejected'
  residency: 'visible' | 'loadable' | 'not_resident'
  plugin: 'not_required' | 'enabled' | 'requires_user_action'
}

interface ToolAccessDecision {
  targetId: string
  kind: ToolAccessPageKind
  toolName?: string
  categoryId: ToolCategoryId
  finalState: ToolAccessFinalState
  toolOsState: ToolOsState
  nextAction: ToolDiscoveryNextAction
  gates: ToolAccessGates
  reasons: ToolAccessReason[]
}

interface BuildToolAccessDecisionInput {
  targetId: string
  kind: ToolAccessPageKind
  toolName?: string
  categoryId: ToolCategoryId
  finalState: ToolAccessFinalState
  nextAction: ToolDiscoveryNextAction
  categoryAllowed: boolean
  categoryEnabled: boolean
  categoryAccessAllowed: boolean
  categoryUnavailableReason: Nullable<ToolCategoryUnavailableReason>
  systemEnabled?: boolean
  pluginBacked: boolean
  visible: boolean
  runtimeAvailable: boolean
  requiresApproval: boolean
  reasons: readonly ToolAccessReason[]
}

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
export type {
  BuildToolAccessDecisionInput,
  ToolAccessDecision,
  ToolAccessFinalState,
  ToolAccessGates,
  ToolAccessLayer,
  ToolAccessPageKind,
  ToolAccessReason,
}
