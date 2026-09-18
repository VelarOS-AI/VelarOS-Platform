/**
 * 条目路径的**全仓唯一判定**：一条记忆的相对路径只能是 `entries/<名>.md`。
 *
 * 为什么要有这道判定：条目 id 形如 `<scopeId>::<相对路径>`，相对路径最终会和作用域根拼起来落到
 * 磁盘上。路径不约束时，`system::../../<任意路径>` 就能读到记忆目录外的文件、归档同样的 id 会
 * 改写它；项目记忆目录按设计跟着 git 走，一个克隆来的仓库自带的索引行也就能把凭据文件链进召回。
 *
 * 因此 id 解析、索引行解析、条目目录扫描**三处共用本文件**：形状不合的一律当作不存在，不读也不写。
 * 判定只算字符串；符号链接由 `MemoryFilesIo.isInsideDirectory` 再解一道（Node 实现落在 `./NodeIo`）。
 */

import { isEmpty } from '@velaros-ai/core'

import { MemoryFilesLayout } from '../../contract/constants.js'

/** 条目目录的缺省名字；后端可由宿主改名，改了之后本判定跟着改名走。 */
export const DefaultMemoryEntriesDirectoryName = MemoryFilesLayout.entriesDirectoryName

/**
 * 一级名字是否安全：不许路径分隔符、空字节与首尾空白，`.` 与 `..` 同样不算名字。
 *
 * 条目目录名、索引文件名这类由宿主配置的单段名字拼进路径之前先过这道。
 */
export function isMemoryFileSegment(segment: string): boolean {
  if (isEmpty(segment) || segment !== segment.trim()) return false
  if (segment === '.' || segment === '..') return false
  return !/[\0/\\]/u.test(segment)
}

/**
 * 相对作用域根的路径是不是一条合法的记忆条目。
 *
 * 合法 = 恰好两段、第一段是条目目录、第二段是 `.md` 文件名（后缀大小写不限，和目录扫描同口径）。
 * 绝对路径、`..`、反斜杠、子目录、空字节一律不合法。
 */
export function isMemoryEntryPath(
  path: string,
  entriesDirectoryName: string = DefaultMemoryEntriesDirectoryName,
): boolean {
  if (!isMemoryFileSegment(entriesDirectoryName)) return false
  if (path !== path.trim()) return false
  const separator = path.indexOf('/')
  if (separator < 0 || path.slice(0, separator) !== entriesDirectoryName) return false
  const name = path.slice(separator + 1)
  if (!isMemoryFileSegment(name)) return false
  return name.length > '.md'.length && /\.md$/iu.test(name)
}

/** 目录扫描用：一个文件名能不能成为条目（拼上条目目录后仍要过 `isMemoryEntryPath`）。 */
export function isMemoryEntryFileName(
  fileName: string,
  entriesDirectoryName: string = DefaultMemoryEntriesDirectoryName,
): boolean {
  return isMemoryEntryPath(`${entriesDirectoryName}/${fileName}`, entriesDirectoryName)
}

/** 把路径规整成统一分隔符、无重复斜杠的形式（内存 IO 与路径判定共用）。 */
export function normalizeMemoryFilePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+/gu, '/')
}
