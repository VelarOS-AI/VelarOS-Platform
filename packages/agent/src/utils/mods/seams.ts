import { isFunction, isObject, isString } from '@velaros-ai/core'

import type { AgentModHookMatcher } from '../../types/agent.js'

export const DefaultHookTimeoutMs = 5_000

export const MinimumHookTimeoutMs = 100

export const MaximumHookTimeoutMs = 30_000

export function readErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function isThenable(value: unknown): value is Promise<unknown> {
  return isObject(value) && isFunction(Reflect.get(value, 'then'))
}

export function resolveHookTimeoutMs(value?: number): number {
  if (!Number.isFinite(value)) return DefaultHookTimeoutMs
  return Math.max(MinimumHookTimeoutMs, Math.min(MaximumHookTimeoutMs, Math.trunc(value!)))
}

export function includesString(values: LooseOptional<readonly string[]>, value: unknown): boolean {
  return !values || (isString(value) && values.includes(value))
}

/** matcher 字段间 AND，列表内 OR；事件缺字段时 fail-closed。 */
export function matchesHook(
  matcher: LooseOptional<AgentModHookMatcher>,
  event: unknown
): boolean {
  if (!matcher) return true
  if (!isObject(event)) return false
  return (
    includesString(matcher.toolNames, Reflect.get(event, 'toolName')) &&
    includesString(matcher.phases, Reflect.get(event, 'phase')) &&
    includesString(matcher.statuses, Reflect.get(event, 'status'))
  )
}
