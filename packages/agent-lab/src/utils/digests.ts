/**
 * 内容摘要：归档的三个 digest 与认证报告的自摘要都走这里，取的都是规范 JSON 的 sha256。
 */
import { createHash } from 'node:crypto'

import { canonicalJson } from './canonical-json.js'

/** 取一个值的 sha256（十六进制）：先做规范 JSON，键序与区域设置都不影响结果。 */
export function sha256Json(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}
