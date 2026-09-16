import { isFunction, isObject, isString } from '@velaros-ai/core'

import type { AgentModHookMatcher } from '../../types/agent.js'
import type { AgentModHookContext, AgentModSeamRegistration } from '../../types/mods.js'
import { AgentTuning } from '../tuning'

/**
 * 给一次钩子调用配一份上下文：告诉钩子自己是谁（modId / hookId）、正挂在哪个事件上，
 * 以及这次调用的中止信号——超时的时候派发器会 abort 它，钩子据此收手。
 * 每次派发现建一份，不复用。
 */
export function createHookContext(
  entry: AgentModSeamRegistration,
  signal: AbortSignal
): AgentModHookContext {
  return {
    modId: entry.modId,
    hookId: entry.id,
    event: entry.event,
    signal,
  }
}

export const DefaultHookTimeoutMs: number = AgentTuning.mods.defaultHookTimeoutMs

export const MinimumHookTimeoutMs: number = AgentTuning.mods.minimumHookTimeoutMs

export const MaximumHookTimeoutMs: number = AgentTuning.mods.maximumHookTimeoutMs

/** 把 catch 到的任意异常折成一句可写进诊断的人话：Error 取 message，其余原样字符串化，绝不再抛。 */
export function readErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 判一个值能不能 `await`：是对象且带可调用的 `then`。
 * 按鸭子类型认而不是 `instanceof Promise`——mod 钩子来自第三方代码，可能跑在另一个 realm、或返回自家的 thenable，
 * 用 `instanceof` 会把这些当同步值处理，于是异步钩子的超时与中止全都落不到实处。
 */
export function isThenable(value: unknown): value is Promise<unknown> {
  return isObject(value) && isFunction(Reflect.get(value, 'then'))
}

/**
 * 定一次钩子调用的超时毫秒数：缺席或非有限数取 `DefaultHookTimeoutMs`，其余截断取整后夹进 `[100, 30_000]`。
 * **钳制不拒绝**：mod 自己写的超时值再离谱也不让它把派发器卡死——上界拦住"我要等五分钟"，
 * 下界拦住 0 / 负数那种一注册就必然超时、等于把钩子关掉的写法。
 */
export function resolveHookTimeoutMs(value?: number): number {
  if (!Number.isFinite(value)) return DefaultHookTimeoutMs
  return Math.max(MinimumHookTimeoutMs, Math.min(MaximumHookTimeoutMs, Math.trunc(value!)))
}

/**
 * matcher 单个字段的匹配判据：清单缺席（未声明这一维）一律为真——不筛这一维，不是"筛掉全部"；
 * 清单在时，`value` 必须是字符串**且**逐字命中清单里某一项才为真。
 * 事件上取不到这个字段（undefined、或类型不对）时判假，即 fail-closed：宁可这次钩子不触发，
 * 也不在一个字段读不出来的事件上贸然执行第三方代码。
 */
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
