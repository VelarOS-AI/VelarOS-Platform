import { isPlainObject } from '@velaros-ai/core'

import { BrowserViewNotAttachedReason } from '../contract/constants.js'

/**
 * 判定一个未知 catch 值是否就是「视图没接上」。
 *
 * 只认 `context.reason`，不认文案：文案是给人看的，会被翻译、会被润色；
 * 靠文案匹配的门会在某次文案微调后**静默失效**，而失效表现恰恰是模型重新陷入死循环。
 */
export function isBrowserViewNotAttachedError(error: unknown): boolean {
  if (!isPlainObject(error)) return false
  const context = error.context
  if (!isPlainObject(context)) return false
  return context.reason === BrowserViewNotAttachedReason
}
