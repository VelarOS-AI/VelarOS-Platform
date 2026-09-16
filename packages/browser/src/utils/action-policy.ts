/** 浏览器动作策略：宿主给一张「哪些动作按什么档处理」的表，这里按它给出裁决。 */
import { isNotNull } from '@velaros-ai/core'

import type { BrowserActionPolicyConfig } from '../types/browser'
import type { BrowserActionPolicyDecision, BrowserActionPolicyRequest } from '../types/browser.js'


/** 动作名归一：去空白、转小写；空的当没有。 */
export function normalizePolicyAction(value: LooseOptional<string>): Nullable<string> {
  const normalized = value?.trim().toLowerCase()
  return normalized ? normalized : null
}

/** 把一组动作名归一成集合，顺带去掉空的。 */
export function normalizeActionSet(
  values: LooseOptional<readonly string[]>,
): Set<string> {
  const normalized = (values ?? [])
    .map(normalizePolicyAction)
    .filter((value): value is string => isNotNull(value))
  return new Set(normalized)
}

/** 把一次请求里的动作名（含别名）归一成一组。 */
export function normalizeRequestActions(
  request: BrowserActionPolicyRequest,
): string[] {
  const seen = new Set<string>()
  const actions = [
    normalizePolicyAction(request.action),
    ...(request.aliases ?? []).map(normalizePolicyAction),
  ].filter((value): value is string => isNotNull(value))

  return actions.filter((action) => {
    if (seen.has(action)) return false
    seen.add(action)
    return true
  })
}

/** 在策略表里找第一条命中这次请求的规则。 */
export function findPolicyMatch(
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
 * Browser owns its action vocabulary and match precedence. The decision closed
 * set is `allow` / `deny` only — the `confirm` tier was removed (2026-08-06):
 * no product host ever populated `policy.confirm`, so it was a fully wired
 * dead configuration tier that never actually triggered.
 */
/** 按宿主给的策略表裁决一次浏览器动作：放行、要审批还是直接拒绝。 */
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
