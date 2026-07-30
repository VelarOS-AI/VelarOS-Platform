// 域：通用 JSONL（一行一条 JSON）磁盘文件的**崩溃安全读写原语**——跨领地共享件。
//
// 会话账本（`session-store/ledger-file.ts`）与执行观测旁账本（`observability/{execution-ledger-file,prompt-audit}`）
// 都是「每记录一行、以 `\n` 结尾、append-only」的 JSONL 文件；崩溃在 write 中途会留半截尾行。本文件抽出**与
// 领地无关**的三件事：
//   - `completeLineByteLength`：算「前 N 条完整行」的字节偏移（第 N 个 `\n` 之后）；
//   - `truncateJsonlToLineCount`：`ftruncate` 到该偏移 + `fsync`——**只缩短文件、绝不重写已提交前缀字节**；
//   - `parseJsonlWithTailTolerance`：**尾行容忍 / 中段不容忍**的逐行解析（下面的判据段）。
//
// 铁律（宪章 §1 数据根单写者 + P1-3）：修复损坏尾行必须走 `ftruncate`，不能「读全量 → writeFile 整文件重写」——
// 后者崩在重写中途会抹掉已 fsync 的完整后缀字节。此件即三处（会话账本 hydrate / span 账本 open / prompt 审计
// open）共用的单源原语；`session-store` 侧的 `truncateLedgerToEntryCount` 是它的保名薄包装（entry=line）。
//
// **为什么尾行容忍、中段不容忍**（三个账本一致的判据，改一处就必须改三处，所以只有一处）：
// append-only + 每条 fsync 的写模型下，**唯一**可能出现半截行的位置就是文件末尾（崩在最后一次 write 中途）。
// 中段出现坏行说明发生的不是「崩溃」而是外部篡改 / 文件系统损坏 / 违反单写者假设的并发交错——那三种情况下
// 「跳过坏行继续读」会把一份**已经不可信**的历史当成真历史喂给上层，比直接炸更坏（失败方向安全，§2.4）。
import { existsSync } from 'node:fs'
import { open, readFile } from 'node:fs/promises'

import { isEmpty, isNull } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

/** JSONL 行分隔符的字节值(`\n` = 0x0A)；用于字节级偏移计算(canonical JSON 内部的换行已转义成 `\\n`，不会撞到)。 */
const LINE_FEED_BYTE = 0x0a

/** JSONL 行分隔符：写入恒以此结尾，便于崩溃时区分「完整行」与「半截尾行」。 */
export const JSONL_LINE_SEPARATOR = '\n'

/** 逐行解析结果：解析出的记录序列 + 是否检测到并跳过了半截尾行。 */
export interface JsonlParseResult<T> {
  records: T[]
  /** 调用方据此决定是否 `truncateJsonlToLineCount` 回写修复。 */
  truncatedTail: boolean
}

/**
 * 尾行容忍的 JSONL 逐行解析（三个账本的**单源**实现；判据见文件头）。
 *
 * `parseLine` 返回 null 即「本行不可解析或不满足 schema」；该信号出现在最后一行判为半截尾行
 * （返回 `truncatedTail: true`，已解析的前缀照常返回），出现在中段抛 `INVARIANT`。
 * 尾部空串（以分隔符结尾时 split 产生）先剔除，不算账本行。
 */
export function parseJsonlWithTailTolerance<T>(input: {
  raw: string
  path: string
  /** 中段损坏错误消息里的账本名（如 `session ledger` / `execution span ledger`）。 */
  ledgerLabel: string
  parseLine: (line: string) => Nullable<T>
}): JsonlParseResult<T> {
  const lines = input.raw.split(JSONL_LINE_SEPARATOR)
  while (!isEmpty(lines) && isEmpty(lines[lines.length - 1])) lines.pop()

  const records: T[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = input.parseLine(lines[index])
    if (isNull(parsed)) {
      if (index === lines.length - 1) return { records, truncatedTail: true }
      throw new AppError(
        'INVARIANT',
        `${input.ledgerLabel} corrupted at interior line ${index + 1} of ${lines.length} (${input.path})`,
        undefined,
        { path: input.path, line: index + 1, lineCount: lines.length }
      )
    }
    records.push(parsed)
  }
  return { records, truncatedTail: false }
}

/**
 * 「前 N 条完整行」的字节长度：扫描第 N 个 `\n` 字节所在位置 + 1（含该换行符）。
 *
 * N ≤ 0 返回 0（截空）；完整行不足 N 条返回 null（无法定位，调用方按需回落）。字节级扫描保证多字节 UTF-8
 * 内容也能算出**精确截断偏移**（记录内部的换行在 canonical JSON 里已转义成 `\\n`，不会误计）。
 */
export function completeLineByteLength(buffer: Buffer, lineCount: number): Nullable<number> {
  if (lineCount <= 0) return 0
  let seen = 0
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] !== LINE_FEED_BYTE) continue
    seen += 1
    if (seen === lineCount) return i + 1
  }
  return null
}

/**
 * 把 JSONL 文件截断到「前 `lineCount` 条完整行」的字节边界（`ftruncate` + `fsync`）。
 *
 * 崩溃安全的尾部修复原语（宪章 §1 数据根单写者 + P1-3）：**只缩短文件、绝不重写已提交的前缀字节**——
 * 与「读全量 → `writeFile` 整文件重写」相反，后者崩在重写中途会抹掉已 fsync 的完整后缀。用途同源多处：
 *   - 会话账本 `SessionLedger` 开档尾行修复（截掉半截尾行）；
 *   - 影子镜像 crash residue 回收 / sidecar 缺失迁移（经 `truncateLedgerToEntryCount` 保名包装）；
 *   - 执行 span 账本 / prompt 审计侧信道开档尾行修复（截掉损坏尾行，不重写已提交前缀）。
 *
 * 文件不存在、或完整行不足 `lineCount` 条(目标偏移 = 文件长度或更长)时为 no-op；仅当存在**多余字节**
 * (残留完整行 / 半截尾行)时才 truncate。返回是否真的截断过。
 */
export async function truncateJsonlToLineCount(path: string, lineCount: number): Promise<boolean> {
  if (!existsSync(path)) return false
  const buffer = await readFile(path)
  const offset = completeLineByteLength(buffer, lineCount)
  // 完整行不足 lineCount（offset=null）：无法把文件"补长"，留给上层按各自分支处理。
  if (isNull(offset)) return false
  if (offset >= buffer.length) return false // 已恰好对齐（含末尾换行），无多余字节
  const handle = await open(path, 'r+')
  try {
    await handle.truncate(offset)
    await handle.sync() // fsync：截断落盘，崩溃安全
  } finally {
    await handle.close()
  }
  return true
}
