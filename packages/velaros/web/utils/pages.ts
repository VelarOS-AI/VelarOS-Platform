/**
 * 和宿主的页面打交道时的两件小事：等一件事时随时能撒手（取消、到点），关页面时不让宿主的错盖掉这次调用的结局。
 */

import { Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { WebPage } from '../contract/requires.js'

const log = Log.tag('velaros:web')

/**
 * 等一件事做完；signal 先触发就不等了，以它的原因失败。
 * 被撒手的那件事之后再成功或失败都没人等了，它的拒绝已经在这里接住，不会变成没人处理的拒绝。
 */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abandon = (): void => reject(signal.reason)
    if (signal.aborted) abandon()
    else signal.addEventListener('abort', abandon, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', abandon)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abandon)
        reject(error)
      }
    )
  })
}

/** 关一页：宿主的 close 抛了只记一笔，不让它盖掉这次调用真正的结局。 */
export function closePage(page: WebPage): void {
  try {
    page.close()
  } catch (error) {
    log.warn('closing a hidden page failed', { error: AppError.getMessage(error) })
  }
}

/** 等宿主开页面时撒了手，它之后才开出来的那一页也要关掉，不留一个看不见的窗口；开失败了就什么也不用做。 */
export function closeWhenOpened(opening: Promise<WebPage>): void {
  void opening.then(closePage, (error: unknown) => {
    log.debug('an abandoned hidden page never opened', { error: AppError.getMessage(error) })
  })
}

/** 页面是不是正在跳走（主框架有一次导航在进行）：宿主给了 loading 才问它，没给或问出错都当作没在跳。 */
export function isNavigating(page: WebPage): boolean {
  try {
    return !!page.loading?.()
  } catch (error) {
    log.debug('asking whether a hidden page is loading failed', {
      error: AppError.getMessage(error),
    })
    return false
  }
}

/** 文档是不是 PDF：浏览器自带的 PDF 阅读器打开的页面，正文里一个字也读不出来。 */
export function isPdfDocument(contentType: string): boolean {
  return /^application\/pdf\b/iu.test(contentType.trim())
}

/**
 * 文档是不是纯文本文件（源码、Markdown、YAML、JSON 这类）：浏览器把文字原样摆进一个 pre，空白就是内容。
 * 按媒体类型认，不看参数：text/ 下除了 HTML 与 XML 的都算，另加 JSON 与 JavaScript。
 */
export function isPlainTextDocument(contentType: string): boolean {
  const type = contentType
    .trim()
    .toLowerCase()
    .replace(/\s*;.*$/su, '')
  if (type === 'text/html' || type === 'text/xml' || type.endsWith('+xml')) return false
  return (
    type.startsWith('text/') ||
    type === 'application/json' ||
    type.endsWith('+json') ||
    /^application\/(?:x-)?(?:java|ecma)script$/u.test(type)
  )
}
