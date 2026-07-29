import type { BrowserActionPolicyConfig } from './types'

export interface BrowserActionPolicyRequest {
  action: string
  aliases?: readonly string[]
  label?: string
}

export type BrowserActionPolicyDecisionKind = 'allow' | 'deny' | 'confirm'

export interface BrowserActionPolicyDecision {
  kind: BrowserActionPolicyDecisionKind
  action: string
  matchedAction: Nullable<string>
  reason: Nullable<string>
}

function normalizePolicyAction(value: LooseOptional<string>): Nullable<string> {
  const normalized = value?.trim().toLowerCase()
  return normalized ? normalized : null
}

function normalizeActionSet(
  values: LooseOptional<readonly string[]>,
): Set<string> {
  const normalized = (values ?? [])
    .map(normalizePolicyAction)
    .filter((value): value is string => value !== null)
  return new Set(normalized)
}

function normalizeRequestActions(
  request: BrowserActionPolicyRequest,
): string[] {
  const seen = new Set<string>()
  const actions = [
    normalizePolicyAction(request.action),
    ...(request.aliases ?? []).map(normalizePolicyAction),
  ].filter((value): value is string => value !== null)

  return actions.filter((action) => {
    if (seen.has(action)) return false
    seen.add(action)
    return true
  })
}

function findPolicyMatch(
  policyActions: Set<string>,
  requestActions: readonly string[],
): Nullable<string> {
  for (const action of requestActions) {
    if (policyActions.has(action)) return action
  }

  if (policyActions.has('*')) return '*'
  return null
}

/**
 * Resolves the host-agnostic policy decision for a browser action.
 *
 * Browser owns its action vocabulary and match precedence. Product hosts only
 * decide how a `confirm` decision is presented and fulfilled.
 */
export function checkBrowserActionPolicy(
  policy: LooseOptional<BrowserActionPolicyConfig>,
  request: BrowserActionPolicyRequest,
): BrowserActionPolicyDecision {
  const requestActions = normalizeRequestActions(request)
  const action = requestActions[0] ?? 'unknown'
  if (!policy)
    return { kind: 'allow', action, matchedAction: null, reason: null }

  const deny = normalizeActionSet(policy.deny)
  const deniedAction = findPolicyMatch(deny, requestActions)
  if (deniedAction)
    return {
      kind: 'deny',
      action,
      matchedAction: deniedAction,
      reason: `浏览器动作被策略拒绝：${action}`,
    }

  const confirm = normalizeActionSet(policy.confirm)
  const confirmedAction = findPolicyMatch(confirm, requestActions)
  if (confirmedAction)
    return {
      kind: 'confirm',
      action,
      matchedAction: confirmedAction,
      reason: `浏览器动作需要用户确认：${action}`,
    }

  const allow = normalizeActionSet(policy.allow)
  const allowedAction = findPolicyMatch(allow, requestActions)
  if (allowedAction || (allow.size === 0 && policy.default !== 'deny'))
    return {
      kind: 'allow',
      action,
      matchedAction: allowedAction,
      reason: null,
    }

  return {
    kind: 'deny',
    action,
    matchedAction: null,
    reason:
      policy.default === 'deny'
        ? `浏览器动作被默认拒绝：${action}`
        : `浏览器动作不在允许列表中：${action}`,
  }
}
