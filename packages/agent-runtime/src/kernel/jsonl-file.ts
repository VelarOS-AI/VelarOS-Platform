// 域：通用 JSONL（一行一条 JSON）磁盘文件的**崩溃安全尾部截断原语**——跨领地共享件。
//
// 会话账本（`session-store/ledger-file.ts`）与执行观测旁账本（`observability/{ExecutionSpanLedger,prompt-audit}`）
// 都是「每记录一行、以 `\n` 结尾、append-only」的 JSONL 文件；崩溃在 write 中途会留半截尾行。本文件抽出**与
// 领地无关**的两件事：
//   - `completeLineByteLength`：算「前 N 条完整行」的字节偏移（第 N 个 `\n` 之后）；
//   - `truncateJsonlToLineCount`：`ftruncate` 到该偏移 + `fsync`——**只缩短文件、绝不重写已提交前缀字节**。
//
// 铁律（宪章 §1 数据根单写者 + P1-3）：修复损坏尾行必须走 `ftruncate`，不能「读全量 → writeFile 整文件重写」——
// 后者崩在重写中途会抹掉已 fsync 的完整后缀字节。此件即三处（会话账本 hydrate / span 账本 open / prompt 审计
// open）共用的单源原语；`session-store` 侧的 `truncateLedgerToEntryCount` 是它的保名薄包装（entry=line）。
import { existsSync } from 'node:fs'
import { open, readFile } from 'node:fs/promises'

import { isNull } from '@velaros-ai/core'

/** JSONL 行分隔符的字节值(`\n` = 0x0A)；用于字节级偏移计算(canonical JSON 内部的换行已转义成 `\\n`，不会撞到)。 */
const LINE_FEED_BYTE = 0x0a

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
