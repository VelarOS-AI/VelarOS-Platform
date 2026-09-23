/** 元素目标的归一：模型给的字符串或定位线索，变成端口认的那一份 `BrowserElementTargetHint`。 */

import { isString, toNullable } from '@velaros-ai/core'

import type {
  BrowserElementTargetHint,
  BrowserTarget,
  BrowserTargetHint,
} from '../types/browser.js'

/** 字符串以 @ 开头当 ref（inspect、标注截图给的），其余当 CSS selector；定位线索逐字段补齐成端口的形状。 */
export function toElementTarget(target: BrowserTarget): BrowserElementTargetHint {
  if (isString(target)) {
    const value = target.trim()
    const isRef = value.startsWith('@')
    return {
      ref: isRef ? value : null,
      css: isRef ? null : value,
      role: null,
      text: null,
      name: null,
      attributes: {},
    }
  }
  return fromTargetHint(target)
}

/** 定位线索补齐成端口的形状：没给的字段写成 null，frame 只在给了时带上。 */
function fromTargetHint(target: BrowserTargetHint): BrowserElementTargetHint {
  const normalized: BrowserElementTargetHint = {
    ref: toNullable(target.ref),
    css: toNullable(target.css),
    role: toNullable(target.role),
    text: toNullable(target.text),
    name: toNullable(target.name),
    attributes: target.attributes ?? {},
  }
  if (target.frame) {
    normalized.frame = {
      css: toNullable(target.frame.css),
      name: toNullable(target.frame.name),
      title: toNullable(target.frame.title),
      url: toNullable(target.frame.url),
    }
  }
  return normalized
}
