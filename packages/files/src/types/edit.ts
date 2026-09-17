/**
 * 写的工作数据：一个文件定下来的写入计划、计划时的印记、改动前留下的版本，以及整批写不下去时交给模型的问题清单。
 * 只放类型；公开签名不引用它们，所以不出包。
 */

/** 一处写不下去的问题：file 是 files 里第几个（从 0 起）；文件被改过时 currentVersion 是它现在的版本。 */
export interface FileEditProblem {
  file: number
  path: string
  reason: 'invalid' | 'denied' | 'stale'
  message: string
  currentVersion?: string
}

/** 文件的印记：修改时间与大小。写之前再 stat 一次，印记没变的大文件不用重读核版本。 */
export interface FileStamp {
  mtimeMs: number
  size: number
}

/** 文件改动前留下的一个版本：版本号是内容的哈希，buffer 是当时的原始字节。 */
export interface FileSnapshot {
  version: string
  buffer: Buffer
  savedAt: number
}

/**
 * 一个文件定下来的写入计划：回滚，或整个写入。path 是空间给模型看的路径，target 是解开符号链接后真正要写的文件，
 * baseVersion 与 stamp 是计划时文件的版本和印记（不存在为 null），写之前再核一次。要写的字节在计划时就按原编码编好，编不成的在计划期就成了问题；
 * 回滚带回滚后正文的字符数，整个写入时 previous 只在文件不超过留版本的上限时保留。第一段只做计划，第二段照计划写。
 */
export type FileEditPlan =
  | { kind: 'restore'; index: number; path: string; target: string; current: Nullable<Buffer>; bytes: Buffer; version: string; totalChars: number; baseVersion: Nullable<string>; stamp: Nullable<FileStamp> }
  | { kind: 'write'; index: number; path: string; target: string; created: boolean; previous: Nullable<Buffer>; bytes: Buffer; totalChars: number; baseVersion: Nullable<string>; stamp: Nullable<FileStamp> }
