import type { ContextRef, ContextState } from '../types/context.js'
/** 创建尚未有记录的会话。 */
export function emptyContextState(): ContextState {
  return { version: 0, records: [], workingSet: { revision: 0, cursor: 0, items: [] } }
}
/** 按引用身份比较，避免对象引用导致重复。 */
export function sameContextRef(a: ContextRef, b: ContextRef): boolean {
  return a.sessionId === b.sessionId && a.id === b.id
}
/** 生成带稳定错误码的异常。 */
export function contextFailure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}
/** 核对非负整数范围，拒绝 NaN 与负数。 */
export function boundedInteger(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw contextFailure('INVALID_RANGE', '上下文范围必须是上限内的非负整数。')
  return value
}
