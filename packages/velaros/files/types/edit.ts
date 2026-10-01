/**
 * 写与撤回的工作数据：一个文件在这次改动里的底稿与定下来的写入计划、计划时的印记、整批写不下去时交给模型的问题清单，以及留着能撤回的改动。
 * 只放类型；公开签名不引用它们，所以不出包。
 */

import type { FileLocation } from './files.js'
import type { FileTextContent } from './text.js'

/** 一处写不下去的问题：step 是 steps 里第几步（从 0 起），整个文件的问题记在第一次碰到它的那一步上。 */
export interface FileEditProblem {
  step: number
  path: string
  reason: 'invalid' | 'denied' | 'stale'
  message: string
}

/** 文件的印记：修改时间与大小。写之前再 stat 一次，印记没变的大文件不用重读核版本。 */
export interface FileStamp {
  mtimeMs: number
  size: number
}

/**
 * 一个文件在这次改动里的底稿：step 是第一次碰到它的那一步，original 是改之前读进来的样子（不存在为 null），
 * stamp 是那时的印记；content 是按前面几步改到现在的正文（还没写过的新文件为 null），eol 是新写的换行用哪种。
 */
export interface FileEditDraft {
  step: number
  location: FileLocation
  original: Nullable<FileTextContent>
  stamp: Nullable<FileStamp>
  content: Nullable<string>
  eol: '\n' | '\r\n'
}

/**
 * 一个文件定下来的写入计划。step 是第一次碰到它的那一步；path 是空间给模型看的路径，target 是解开符号链接后真正要写的文件，
 * baseVersion 与 stamp 是计划时文件的版本和印记（不存在为 null），写之前再核一次。要写的字节在计划时就按原编码编好，编不成的在计划期就成了问题。
 * previous 是改动前的原始字节：文件不超过 `FileLimits.undoBytes` 时留着（撤回靠它），新建的为 null，更大的缺席（这次改动撤不回）。
 */
export interface FileEditPlan {
  step: number
  path: string
  target: string
  linked: boolean
  created: boolean
  previous?: LooseOptional<Buffer>
  /** 本次提交必须核对的原始字节；与长期撤回缓存的大小上限无关。 */
  baseBytes: Nullable<Buffer>
  bytes: Buffer
  totalLines: number
  baseVersion: Nullable<string>
  stamp: Nullable<FileStamp>
}

/**
 * 一次改动里的一个文件：改动前的原始字节（新建的为 null，原文太大没留下来的缺席），以及改动后它的版本——撤回前核对文件还是这一版。
 */
export interface FileChangeEntry {
  path: string
  target: string
  linked: boolean
  before?: LooseOptional<Buffer>
  after: string
}

/** 留着的一次改动：每个文件改动前后的样子、原文占了多少字节、撤不撤得回、撤回过没有。 */
export interface FileChangeRecord {
  changeId: string
  entries: FileChangeEntry[]
  bytes: number
  undoable: boolean
  undone: boolean
}
