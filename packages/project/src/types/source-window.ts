export interface ProjectSourceLine { line: number; start: number; bodyEnd: number; end: number; text: string }

export interface ProjectSourceFragment { line: number; columns: [number, number]; text: string }

export interface ProjectSourceWindow {
  kind: 'project-source-window'
  path: string
  revision?: string
  viewSource?: string
  fileRef?: string
  lines: Array<[number, string]>
  fragments?: ProjectSourceFragment[]
  /**
   * 结尾换行之后那个零宽的行在内核里的行号：内核按换行切，它算一行；模型面照 `wc -l` 数，它不算。
   * 签发覆盖时它照样算进去（在文件末尾插入要它），交给模型之前从 lines 里去掉。
   */
  trailingLine?: number
  [key: string]: unknown
}
