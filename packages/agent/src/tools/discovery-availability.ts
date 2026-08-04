import type { ToolCategoryId, ToolOsState } from '@velaros-ai/agent/protocol'

import type { ToolCategoryUnavailableReason } from './access-policy'

const ToolDiscoveryAvailabilityValues = [
  'visible',
  'loadable',
  'requires_approval',
  'requires_user_action',
  'unavailable',
] as const

type ToolDiscoveryAvailability = (typeof ToolDiscoveryAvailabilityValues)[number]
type ToolDiscoverySchemaState = 'visible' | 'hidden' | 'not_applicable'
type ToolDiscoveryNextAction =
  | 'call_tool'
  | 'describe'
  | 'replace_page'
  | 'request_approval'
  | 'request_user_action'
  | 'none'

interface ToolDiscoveryCategoryAvailabilityInput {
  categoryId: ToolCategoryId
  categoryEnabled: boolean
  categoryAllowed: boolean
  categoryAccessAllowed: boolean
  categoryUnavailableReason: Nullable<ToolCategoryUnavailableReason>
  pluginBacked: boolean
  hasRuntimeAvailableTool: boolean
  requiresApproval: boolean
}

interface ToolDiscoveryToolAvailabilityInput extends ToolDiscoveryCategoryAvailabilityInput {
  toolName?: string
  systemEnabled: boolean
  visible: boolean
  runtimeAvailable: boolean
}

function blockedCategoryAvailability(
  _reason: Nullable<ToolCategoryUnavailableReason>
): ToolDiscoveryAvailability {
  return 'unavailable'
}

function categoryIsLoadable(_categoryId: ToolCategoryId): boolean {
  return true
}

function resolveCapabilityDiscoveryAvailability(
  input: ToolDiscoveryCategoryAvailabilityInput
): ToolDiscoveryAvailability {
  if (!input.categoryAllowed) return 'unavailable'
  if (!input.categoryAccessAllowed) return blockedCategoryAvailability(input.categoryUnavailableReason)
  if (input.categoryEnabled) return 'visible'
  if (!input.hasRuntimeAvailableTool) return 'unavailable'
  if (categoryIsLoadable(input.categoryId)) return input.requiresApproval ? 'requires_approval' : 'loadable'
  if (input.pluginBacked) return input.requiresApproval ? 'requires_approval' : 'loadable'
  return 'unavailable'
}

function resolveToolDiscoveryAvailability(
  input: ToolDiscoveryToolAvailabilityInput
): ToolDiscoveryAvailability {
  if (!input.categoryAllowed || !input.systemEnabled) return 'unavailable'
  if (!input.categoryAccessAllowed) return blockedCategoryAvailability(input.categoryUnavailableReason)
  if (input.visible) return 'visible'
  if (input.categoryEnabled && input.runtimeAvailable) return 'loadable'
  if (categoryIsLoadable(input.categoryId) && input.runtimeAvailable) return input.requiresApproval ? 'requires_approval' : 'loadable'
  if (input.pluginBacked && input.runtimeAvailable) return input.requiresApproval ? 'requires_approval' : 'loadable'
  return 'unavailable'
}

function schemaStateForDiscoveryAvailability(
  availability: ToolDiscoveryAvailability
): ToolDiscoverySchemaState {
  void availability
  // 具体工具页描述已注册工具，故系统内部存在权威输入契约；
  // 主模型路径仍只看页摘要，真实 schema 在 page-in 后的下一轮暴露。
  return 'visible'
}

function nextActionForDiscoveryAvailability(
  availability: ToolDiscoveryAvailability
): ToolDiscoveryNextAction {
  switch (availability) {
    case 'visible':
      return 'call_tool'
    case 'loadable':
      return 'replace_page'
    case 'requires_approval':
      return 'request_approval'
    case 'requires_user_action':
      return 'request_user_action'
    case 'unavailable':
      return 'none'
  }
}

function toolOsStateForDiscoveryAvailability(
  availability: ToolDiscoveryAvailability
): ToolOsState {
  switch (availability) {
    case 'visible':
      return 'resident'
    case 'loadable':
    case 'requires_approval':
      return 'loadable'
    case 'requires_user_action':
      return 'needs_setup'
    case 'unavailable':
      return 'unavailable'
  }
}

export {
  nextActionForDiscoveryAvailability,
  resolveCapabilityDiscoveryAvailability,
  resolveToolDiscoveryAvailability,
  schemaStateForDiscoveryAvailability,
  ToolDiscoveryAvailabilityValues,
  toolOsStateForDiscoveryAvailability,
}
export type {
  ToolDiscoveryAvailability,
  ToolDiscoveryCategoryAvailabilityInput,
  ToolDiscoveryNextAction,
  ToolDiscoverySchemaState,
  ToolDiscoveryToolAvailabilityInput,
}
