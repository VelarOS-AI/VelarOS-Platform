/** 页面元素 ref 的分代与解析：这些是纯计算，存表本身在 BrowserTargetRefStore 里。 */

import { AppError } from '@velaros-ai/core/error'

import type { BrowserTargetRefSession } from '../types/session.js'

/** 取一个 ref 的基名（去掉 :g 分代那一段）。 */
export function readBaseRef(normalizedRef: string): string {
  return normalizedRef.replace(/:g[1-9]\d*$/u, '')
}

/** 判断一个字符能不能出现在 ref 里。 */
export function isRefTokenCharacter(value: string): boolean {
  const code = value.charCodeAt(0)
  return (
    value === '@' ||
    value === ':' ||
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  )
}

/** 拼一条「ref 形状不对」的报错。 */
export function invalidRefError(
  sessionId: string,
  ref: string,
  field: 'source' | 'target'
): AppError {
  return new AppError(
    'VALIDATION',
    `浏览器元素 ${field} ref 格式无效：${ref}。请重新调用 browser:inspect_page，并原样使用最新返回的 ref。`,
    undefined,
    { sessionId, field, ref, reason: 'invalid-ref' }
  )
}

/** 拼一条「ref 是旧分代、页面已经重看过」的报错，并告诉模型最新分代是几。 */
export function staleRefError(
  sessionId: string,
  ref: string,
  field: 'source' | 'target',
  latestGeneration?: number
): AppError {
  return new AppError(
    'VALIDATION',
    `浏览器元素 ${field} ref 已失效：${ref}。请重新调用 browser:inspect_page，并原样使用最新返回的 ref。`,
    undefined,
    {
      sessionId,
      field,
      ref,
      reason: 'stale-ref',
      latestGeneration,
    }
  )
}

/** 给一个基名配上分代，拼成完整的 ref。 */
export function scopeRef(baseRef: string, generation: number): string {
  return `${readBaseRef(baseRef)}:g${generation}`
}

/** 在这一次观察的 ref 表里查一个 ref，返回它当时记下的 selector。 */
export function resolveStoredRef(
  normalizedRef: string,
  session: BrowserTargetRefSession
): Nullable<string> {
  if (normalizedRef.includes(':g')) return normalizedRef

  // 兼容首个 observation 的历史裸 ref。generation > 1 时裸 @e1 无法表达
  // 它来自哪次观察，继续解析会把旧目标静默重绑定到新目标，因此必须拒绝。
  return session.generation === 1
    ? scopeRef(normalizedRef, session.generation)
    : null
}
