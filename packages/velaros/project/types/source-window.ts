/** 正文里的一个物理行：行号、在原文里的起点、正文终点（不含换行符）、终点（含换行符）与行文本。 */
export interface ProjectSourceLine {
  line: number
  start: number
  bodyEnd: number
  end: number
  text: string
}

/** 交给模型之前的源码窗口：整行，带着签发 fileRef 要用的源码快照引用；签好之后写成模型面的 `ProjectWindow`。 */
export interface ProjectSourceWindow {
  kind: 'project-source-window'
  path: string
  revision?: string
  /** 源码快照的引用（source:…）：签发 fileRef 时凭它核对，交出去之前去掉。 */
  viewSource?: string
  fileRef?: string
  lines: Array<[number, string]>
  totalLines?: number
  editable?: false
  note?: string
  /** 签发不了编辑引用的原因（比如文件超过可编辑的大小），写进窗口的 note。 */
  referenceUnavailable?: string
  /**
   * 结尾换行之后那个零宽的行在内核里的行号：内核按换行切，它算一行；模型面照 `wc -l` 数，它不算。
   * 签发覆盖时它照样算进去（在文件末尾插入要它），交给模型之前从 lines 里去掉。
   */
  trailingLine?: number
}
