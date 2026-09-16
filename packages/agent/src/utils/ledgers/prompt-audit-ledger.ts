// PromptAuditLedger 用到的纯函数（不碰实例状态）。
import { isArray, isFiniteNumber, isPlainObject, isString } from '@velaros-ai/core'

import type { PromptAuditRecord } from '../../types/ledgers.js'
import type { PromptAuditReadResult } from '../../types/ledgers.js'

import { JSONL_LINE_SEPARATOR, parseJsonlWithTailTolerance } from './jsonl-file'
import { canonicalJsonStringify } from './ledger-file'

/** 解析一行提示词审计记录；半截或非法行返回 null 交调用方判断。 */
export function tryParsePromptAuditLine(line: string): Nullable<PromptAuditRecord> {
  try {
    const json = JSON.parse(line) as unknown
    return isValidPromptAuditRecord(json) ? json : null
  } catch {
    return null // arch-guard:silent-catch-ok 半截/非法行由调用方按位置判尾行容忍或中段抛错
  }
}

/** 判断一条 JSON 是不是完整的提示词审计记录。 */
export function isValidPromptAuditRecord(value: unknown): value is PromptAuditRecord {
  if (!isPlainObject(value)) return false
  return (
    isFiniteNumber(value.capturedAt) &&
    isString(value.sessionId) &&
    isString(value.runId) &&
    isString(value.systemPrompt) &&
    isArray(value.promptSegments)
  )
}

/** 序列化一条审计记录成 JSONL 行（规范键序 + 行尾分隔符）。 */
export function serializePromptAuditLine(record: PromptAuditRecord): string {
  return `${canonicalJsonStringify(record)}${JSONL_LINE_SEPARATOR}`
}

/** {@link readPromptAuditFile} 的纯文本内核，供 harness 断言单点复用。 */
export function parsePromptAuditText(raw: string, path: string): PromptAuditReadResult {
  return parseJsonlWithTailTolerance({
    raw,
    path,
    ledgerLabel: 'prompt audit ledger',
    parseLine: tryParsePromptAuditLine,
  })
}
