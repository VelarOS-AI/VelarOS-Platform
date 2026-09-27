/**
 * 页面脚本交回的值收成工作类型：页面是别人的，它可能改过全局对象、让脚本交回奇怪的东西；
 * 形状不对的条目丢掉，缺的字段按空算，交回的根本不是对象时当作什么都没抓到。操作只和收过的打交道。
 */

import { isArray, isBoolean, isFiniteNumber, isPlainObject, isString } from '@velaros-ai/core'

import type { WebRawHit, WebReadableScan, WebSearchScan, WebSettleProbe } from '../types/page.js'

/** 取一个字符串字段；不是字符串按空字符串算。 */
function textField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return isString(value) ? value : ''
}

/** 收结果页脚本交回的值：hits 里只留带字符串链接的条目，text 与 noResults 缺了按空与假算。 */
export function searchScanOf(value: unknown): WebSearchScan {
  if (!isPlainObject(value)) return { hits: [], text: '', noResults: false }
  const hits: WebRawHit[] = []
  for (const hit of isArray(value.hits) ? value.hits : []) {
    if (!isPlainObject(hit) || !isString(hit.href)) continue
    hits.push({
      title: textField(hit, 'title'),
      href: hit.href,
      snippet: textField(hit, 'snippet'),
    })
  }
  return {
    hits,
    text: textField(value, 'text'),
    noResults: isBoolean(value.noResults) && value.noResults,
  }
}

/** 收等渲染时看的那一眼：readyState 不是字符串按还在加载算，长度不是有限数按 0 算。 */
export function settleProbeOf(value: unknown): WebSettleProbe {
  if (!isPlainObject(value)) return { ready: 'loading', length: 0 }
  return {
    ready: isString(value.ready) ? value.ready : 'loading',
    length: isFiniteNumber(value.length) ? value.length : 0,
  }
}

/** 收读正文的脚本交回的值：标题、正文、媒体类型缺了都按空字符串算。 */
export function readableScanOf(value: unknown): WebReadableScan {
  if (!isPlainObject(value)) return { title: '', text: '', contentType: '' }
  return {
    title: textField(value, 'title').trim(),
    text: textField(value, 'text'),
    contentType: textField(value, 'contentType'),
  }
}
