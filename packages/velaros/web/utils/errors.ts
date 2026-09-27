/**
 * 读网页失败时抛的带专属码的错误。message 是写给模型看的：哪个网址、为什么、接下来能怎么办——程序只看得到 code 与 message。
 */

import { AppError } from '@velaros-ai/core/error'

import { WebErrorCodes } from '../contract/constants.js'

import { durationText } from './text.js'
import { WebTuning } from './tuning.js'

/** 宿主报加载出错：网页打不开，带上宿主的原话。 */
export function loadFailedError(url: string, message: string): AppError {
  return new AppError(WebErrorCodes.pageUnreachable, `打不开 ${url}：${message}`)
}

/** 到了时限还什么都没加载出来：也算打不开。 */
export function nothingLoadedError(url: string): AppError {
  return new AppError(
    WebErrorCodes.pageUnreachable,
    `打不开 ${url}：${durationText(WebTuning.read.loadTimeoutMs)}没加载出内容`
  )
}

/** 打开的是 PDF：浏览器的 PDF 阅读器里读不出文字，说清楚怎么换条路读。 */
export function pdfPageError(url: string): AppError {
  return new AppError(
    WebErrorCodes.pageUnreadable,
    `${url} 是 PDF，不是网页，read 读不成文字；要读就先下载下来（比如用命令 curl -L -o 文件名 '${url}'），再用读 PDF 的能力读`
  )
}

/** 读正文的页面脚本没跑成：网页打开了，却读不成文字。 */
export function unreadablePageError(url: string, message: string): AppError {
  return new AppError(
    WebErrorCodes.pageUnreadable,
    `${url} 打开了，但读正文的脚本没跑成：${message}`
  )
}
