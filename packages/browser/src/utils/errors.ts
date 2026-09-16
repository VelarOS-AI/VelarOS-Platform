import { isPlainObject } from '@velaros-ai/core'

/**
 * 「内嵌浏览器视图没接上」这一失败态的**跨层标记**——宿主无关，只依赖 core 纯原语。
 *
 * 为什么需要一个标记而不是让各层各自 match 错误文案：这条失败态的**事实**只有运行时知道
 * （等 attach 超时了），而**补救办法**只有宿主壳知道（把会话页调到前台？重开会话？
 * 换外部浏览器承载？）。两边都想说话，就必然出现「运行时给一句放之四海皆准的废话」
 * 或者「宿主靠字符串匹配去猜」。
 *
 * 定下的分工：运行时只陈述事实并打上 {@link BrowserViewNotAttachedReason}；
 * 宿主捕获后翻译成**可执行**指引。文案可以随便改，标记不能——它是接缝。
 */
export const BrowserViewNotAttachedReason = 'browser-view-not-attached' as const

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
