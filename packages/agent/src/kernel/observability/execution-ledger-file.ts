// 域：执行观测账本的 JSONL 磁盘形状（宪章 §14「脊柱 = 会话账本 + 执行账本」的执行账本侧）。
//
// 每 run（或每会话，按宿主装配）单文件 append-only 账本，一行一条 {@link ExecutionSpan}（JSON）。本文件只管
// **字节 ↔ span** 的纯转换与崩溃安全读取，纪律与会话账本 `ledger-file.ts` 一致（键序稳定 + 尾行容忍），
// 但 **独立于会话账本**：观测数据高频、可裁剪、不参与上下文重建，故走旁账本、不挤进会话树的每条 fsync 写路径。
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { type ExecutionSpan, ExecutionSpanSchema } from '../../protocol'
import { canonicalJsonStringify } from '../session-store'

/** 账本行分隔符：始终以 `\n` 结尾写入，便于崩溃时区分「完整行」与「半截尾行」。 */
export const SPAN_LEDGER_LINE_SEPARATOR = '\n'

/** 读取账本的结果：解析出的 span 序列 + 是否发生过尾行截断修复。 */
export interface SpanLedgerReadResult {
  spans: ExecutionSpan[]
  /** 是否检测到并跳过了半截尾行（调用方据此决定是否回写修复）。 */
  truncatedTail: boolean
}

/** 把一条 span 序列化成账本行（含行尾分隔符）。复用会话账本的规范序列化，保证跨账本字节稳定。 */
export function serializeSpanLine(span: ExecutionSpan): string {
  return `${canonicalJsonStringify(span)}${SPAN_LEDGER_LINE_SEPARATOR}`
}

/**
 * 崩溃安全读取执行账本文件。
 *
 * 不存在 → 空账本。存在 → 逐行解析：首个解析失败的行若是**最后一行**，判为半截尾行，截断并标记
 * `truncatedTail`；出现在中段则判为不可容忍的损坏，抛错（与会话账本同纪律，只承诺尾行容忍）。
 */
export async function readSpanLedgerFile(path: string): Promise<SpanLedgerReadResult> {
  if (!existsSync(path)) return { spans: [], truncatedTail: false }

  const raw = await readFile(path, 'utf-8')
  return parseSpanLedgerText(raw, path)
}

/** {@link readSpanLedgerFile} 的纯文本内核，抽出便于单点复用与 harness 断言。 */
export function parseSpanLedgerText(raw: string, path: string): SpanLedgerReadResult {
  const lines = raw.split(SPAN_LEDGER_LINE_SEPARATOR)
  // 以分隔符结尾时最后一段是空串，非账本行；去掉尾部空串再逐行解析。
  while (!isEmpty(lines) && isEmpty(lines[lines.length - 1])) lines.pop()

  const spans: ExecutionSpan[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = tryParseSpanLine(lines[index])
    if (parsed) {
      spans.push(parsed)
      continue
    }
    const isLastLine = index === lines.length - 1
    if (isLastLine) return { spans, truncatedTail: true }
    throw new AppError('INVARIANT', 
      `execution span ledger corrupted at interior line ${index + 1} of ${lines.length} (${path})`
    )
  }
  return { spans, truncatedTail: false }
}

/** 解析单行为 span；不可解析或不满足 schema 时返回 null，由调用方按尾行/中段区分处理。 */
function tryParseSpanLine(line: string): Nullable<ExecutionSpan> {
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    return null // arch-guard:silent-catch-ok 半截/非法行由调用方按位置判尾行容忍或中段抛错，此处只做「不可解析」信号
  }
  const parsed = ExecutionSpanSchema.safeParse(json)
  return parsed.success ? parsed.data : null
}
