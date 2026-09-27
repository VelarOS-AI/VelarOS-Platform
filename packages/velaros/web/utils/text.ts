/** 正文：把页面的 innerText 收拾干净、按字符切段，以及报错里怎么说一段时长。 */

import { clampToCodePointBoundary } from '@velaros-ai/core'

import type { WebTextSlice } from '../types/page.js'

/**
 * 把页面的 innerText 收拾成正文：换行统一成 \n；行内连续空白（含不换行空格、全角空格、制表符）并成一个空格，行首尾去掉空白；
 * 连着的空行只留一行，所以段落之间正好空一行；整段去掉首尾空白。
 */
export function readableText(raw: string): string {
  return raw
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/gu, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

/**
 * 从 offset 起切最多 maxChars 个字符。切口不劈开代理对：起点落在一对中间就往前收一格，终点落在一对中间就往前退一格，
 * 但每段至少前进一个字，接着读永远不会原地打转。交回这一段、实际起点与下一段的起点（读到头了是 null）；offset 超出全文交回空的一段。
 */
export function textSlice(text: string, offset: number, maxChars: number): WebTextSlice {
  const start = clampToCodePointBoundary(text, Math.min(offset, text.length), 'backward')
  let end = clampToCodePointBoundary(text, Math.min(start + maxChars, text.length), 'backward')
  if (end <= start && start < text.length)
    end = clampToCodePointBoundary(text, start + 1, 'forward')
  return { text: text.slice(start, end), start, nextOffset: end < text.length ? end : null }
}

/** 报错里怎么说一段时长：整小时说几小时，整分钟说几分钟，别的说几秒（最多带一位小数）。 */
export function durationText(ms: number): string {
  const seconds = Math.round(ms / 100) / 10
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600} 小时`
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} 分钟`
  return `${seconds} 秒`
}
