// 域：会话账本的 JSONL 磁盘形状（宪章 §6「会话账本的数据契约进 kernel-protocol，实现不进核」）。
//
// 每会话单文件 append-only 账本，一行一条 {@link SessionEntry}（JSON）。本文件只管**字节 ↔ entry**
// 的纯转换与崩溃安全读取：
//   - 规范序列化（键序稳定）——让「写盘→重读」逐字节可比，是存储级验证 harness 的地基；
//   - 尾行损坏容忍——最后一行半截（崩溃在 write 中途）时截断到最后完整行并告警；中段损坏不容忍（抛错）。
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import { isArray, isEmpty, isRecord } from '@velaros-ai/core'

import { type SessionEntry, SessionEntrySchema } from '../../protocol'
import { truncateJsonlToLineCount } from '../jsonl-file'

/** 账本行分隔符：始终以 `\n` 结尾写入，便于崩溃时区分「完整行」与「半截尾行」。 */
export const LEDGER_LINE_SEPARATOR = '\n'

/** 读取账本的结果：解析出的 entry 序列 + 是否发生过尾行截断修复。 */
export interface LedgerReadResult {
  entries: SessionEntry[]
  /** 是否检测到并跳过了半截尾行（调用方据此决定是否回写修复）。 */
  truncatedTail: boolean
}

/** 规范 JSON 序列化：递归按键名排序，保证同一 entry 落盘字节稳定（跨进程、跨重放一致）。 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

/** 把一条 entry 序列化成账本行（含行尾分隔符）。 */
export function serializeLedgerLine(entry: SessionEntry): string {
  return `${canonicalJsonStringify(entry)}${LEDGER_LINE_SEPARATOR}`
}

/**
 * 崩溃安全读取账本文件。
 *
 * 不存在 → 空账本。存在 → 逐行解析：首个解析失败的行若是**最后一行**，判为半截尾行，截断并标记
 * `truncatedTail`；若出现在中段，判为不可容忍的损坏，抛错（宪章 §6 只承诺尾行容忍）。
 */
export async function readLedgerFile(path: string): Promise<LedgerReadResult> {
  if (!existsSync(path)) return { entries: [], truncatedTail: false }

  const raw = await readFile(path, 'utf-8')
  return parseLedgerText(raw, path)
}

/** {@link readLedgerFile} 的纯文本内核，抽出便于单点复用与推理。 */
export function parseLedgerText(raw: string, path: string): LedgerReadResult {
  const lines = raw.split(LEDGER_LINE_SEPARATOR)
  // 以分隔符结尾时最后一段是空串，非账本行；去掉尾部空串再逐行解析。
  while (!isEmpty(lines) && isEmpty(lines[lines.length - 1])) lines.pop()

  const entries: SessionEntry[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = tryParseEntryLine(lines[index])
    if (parsed) {
      entries.push(parsed)
      continue
    }
    const isLastLine = index === lines.length - 1
    if (isLastLine) return { entries, truncatedTail: true }
    throw new Error(
      `session ledger corrupted at interior line ${index + 1} of ${lines.length} (${path})`
    )
  }
  return { entries, truncatedTail: false }
}

/** 解析单行为 entry；不可解析或不满足 schema 时返回 null，由调用方按尾行/中段区分处理。 */
function tryParseEntryLine(line: string): Nullable<SessionEntry> {
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    return null // arch-guard:silent-catch-ok 半截/非法行由调用方按位置判尾行容忍或中段抛错，此处只做「不可解析」信号
  }
  const parsed = SessionEntrySchema.safeParse(json)
  return parsed.success ? parsed.data : null
}

/**
 * 把账本文件截断到「前 `entryCount` 条完整行」的字节边界（保名薄包装，行为逐字节等价于共享原语）。
 *
 * 一条账本行 = 一条 entry，故 entry 数 = JSONL 行数；本函数直接转发到跨领地共享的
 * {@link truncateJsonlToLineCount}（`ftruncate` + `fsync`，只缩短不重写已提交前缀）。保留此名与签名是因为
 * 会话账本域的调用点（`SessionLedger` hydrate / 影子镜像 crash residue 回收 / sidecar 缺失迁移）沿用 entry 语义。
 */
export function truncateLedgerToEntryCount(path: string, entryCount: number): Promise<boolean> {
  return truncateJsonlToLineCount(path, entryCount)
}

/** 递归排序对象键，数组保序，标量原样返回。 */
function sortValue(value: unknown): unknown {
  if (isArray(value)) return value.map(sortValue)
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) sorted[key] = sortValue(value[key])
    return sorted
  }
  return value
}
