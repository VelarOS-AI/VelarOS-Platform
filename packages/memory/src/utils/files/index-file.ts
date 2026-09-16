/**
 * 索引文件（`MEMORY.md`）：一行一条记忆。
 *
 * 这是 §九 9.1「索引常驻注入、全文按需读」的落点——召回先在索引行上匹配，命中后才回文件
 * 取全文。索引行因此必须同时满足两件事：机器可稳定解析，人打开就能读懂。选定形状：
 *
 * ```md
 * # Memory index
 * - [记忆名](entries/some-slug.md) — 一句话描述
 * ```
 *
 * 解析同样宽容：破折号可以是 `—`/`–`/`-`/`:`，描述可以缺席，链接可以是裸路径，缩进和
 * 列表符号（`-`/`*`/`+`）随意。用户手动增删一行就是一次合法的记忆编辑。
 *
 * 文件名是 `IndexFile.ts` 而不是 `Index.ts`：同目录已有 barrel `index.ts`，在大小写不敏感的
 * 文件系统上两者会撞成同一个文件。
 */

import { MemoryFilesLayout } from '../../contract/constants'
import type { MemoryIndexEntry, ParseMemoryIndexOptions } from '../../types/files'

import { DefaultMemoryEntriesDirectoryName, isMemoryEntryPath } from './entry-path'

export type { MemoryIndexEntry, ParseMemoryIndexOptions } from '../../types/files'

/** 索引文件名（常量表 MemoryFilesLayout.indexFileName 的别名）。 */
export const MemoryIndexFileName = MemoryFilesLayout.indexFileName

/** 索引文件的一级标题（常量表 MemoryFilesLayout.indexHeading 的别名）。 */
export const MemoryIndexHeading = MemoryFilesLayout.indexHeading


const LinkedLine =
  /^\s*[-*+]\s*\[(?<name>(?:\\.|[^\\\]])*)\]\((?<path>[^)]+)\)\s*(?:[—–:-]\s*(?<description>.*))?$/u
const BareLine =
  /^\s*[-*+]\s*(?<path>\S+\.md)\s*(?:[—–:-]\s*(?<description>.*))?$/u

/**
 * 名字里的 `\`、`[`、`]` 要转义，换行折成空格。
 *
 * 不转义时「[重要] 回复风格」这样的标题写进索引就解析不回来：那一行整条落空，普通召回找不到
 * 这条记忆、每次再写都新建一个文件，下次重写索引时它又被丢掉一次。
 */
function encodeIndexName(name: string): string {
  return name.replaceAll('\n', ' ').trim().replace(/[\\[\]]/gu, (character) => `\\${character}`)
}

/** 把索引行里被转义的标题还原成原文。 */
function decodeIndexName(raw: string): string {
  return raw.replace(/\\(.)/gu, '$1')
}

/**
 * 解析索引文件；非条目行（标题、空行、说明段落）一律忽略。
 *
 * 路径过 `isMemoryEntryPath` 这一道全仓单源判定：索引文件跟着仓库走，一行链接就能指到记忆目录外
 * 去，因此越界的行**跳过并记诊断**，绝不因为「文件里写着」就读它。
 */
export function parseMemoryIndex(
  raw: Nullable<string>,
  options: ParseMemoryIndexOptions = {},
): MemoryIndexEntry[] {
  if (!raw) return []
  const entriesDirectoryName = options.entriesDirectoryName ?? DefaultMemoryEntriesDirectoryName
  const entries: MemoryIndexEntry[] = []
  const seen = new Set<string>()
  for (const line of raw.replaceAll('\r\n', '\n').split('\n')) {
    const match = LinkedLine.exec(line) ?? BareLine.exec(line)
    if (!match?.groups) continue
    const path = match.groups.path.trim()
    if (!path || seen.has(path)) continue
    seen.add(path)
    if (!isMemoryEntryPath(path, entriesDirectoryName)) {
      options.onRejectedPath?.(path)
      continue
    }
    entries.push({
      path,
      name: decodeIndexName(match.groups.name ?? '').trim() || path.replace(/\.md$/iu, ''),
      description: (match.groups.description ?? '').trim(),
    })
  }
  return entries
}

/** 序列化索引文件。顺序即写入顺序（最近 upsert 的排在最后）。 */
export function serializeMemoryIndex(
  entries: readonly MemoryIndexEntry[],
  heading = MemoryIndexHeading,
): string {
  const lines = [heading, '']
  for (const entry of entries) {
    const description = entry.description.replaceAll('\n', ' ').trim()
    const name = encodeIndexName(entry.name)
    lines.push(
      description
        ? `- [${name}](${entry.path}) — ${description}`
        : `- [${name}](${entry.path})`,
    )
  }
  lines.push('')
  return lines.join('\n')
}

/** 以 `path` 为键插入或原地更新一行；新条目追加到末尾。 */
export function upsertMemoryIndexEntry(
  entries: readonly MemoryIndexEntry[],
  entry: MemoryIndexEntry,
): MemoryIndexEntry[] {
  const next = [...entries]
  const index = next.findIndex((candidate) => candidate.path === entry.path)
  if (index >= 0) {
    next[index] = entry
    return next
  }
  next.push(entry)
  return next
}

/** 移除一行（归档时用）。文件本身不删——权威内容永不静默硬删（§九 9.4）。 */
export function removeMemoryIndexEntry(
  entries: readonly MemoryIndexEntry[],
  path: string,
): MemoryIndexEntry[] {
  return entries.filter((entry) => entry.path !== path)
}
