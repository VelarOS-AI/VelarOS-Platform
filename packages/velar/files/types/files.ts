/**
 * 可移植数据：`velar:files` 的入参与写、撤回的结果（读的结果带文本编码，在 `text.ts`），以及空间端口定位出来的路径。
 * 只从常量表 import type，不带函数、不用 Node 类型，浏览器和渲染进程都能用；从 `@velaros-ai/velar/files/contracts` 取。
 */

// ── 读 ──────────────────────────────────────────────────────────

/** @AgentView 行号或连续闭区间：`12`、`[12]`、`[40, 60]`，从 1 起，末行不小于首行。 */
export type FileLineRange = number | [number] | [number, number]

/**
 * @AgentView
 * 要读的一个文件。range 只读这几行（末行超过文件行数就读到最后一行）；不给就整个文件。
 * 单个文件最大 20 MB，再大的用命令取片段（`tail -n`、`grep -n`、`sed -n 'a,bp'`）。
 */
export interface FileReadItem {
  path: string
  range?: FileLineRange
}

/** @AgentView 一批最多 20 个。一批里前面的文件用掉了预算时，读不下的那几个各自算失败条目——单独放进一次 `read` 就行。 */
export interface FileReadInput {
  files: FileReadItem[]
}

/**
 * @AgentView
 * 一批里某个文件读不了、写不了：只有它这一项是失败，其余文件照常；全部失败时整个调用才报错。path 照传入的原样。
 * 它和成功那支**没有判别字段**，用 `'error' in file` 分开（`file.error` 在联合上取不到）。
 */
export interface FileFailure {
  path: string
  error: {
    code: string
    message: string
  }
}

// ── 写 ──────────────────────────────────────────────────────────

/**
 * @AgentView
 * 按行号改一处。range 选中的整行换成 text（text 是空串就是删掉这几行）；after 在第几行后面插入 text（0 是插在最前面）。
 * text 是新的几行，行与行之间用 `\n` 分开，结尾不用加 `\n`（加了就多一个空行）。
 * 行号是 `read` 那一版的行号：同一个文件的几处都按那一版算，互相不重叠，不用自己算前面改动带来的错位。
 */
export type FileLineEdit =
  | { range: FileLineRange; text: string }
  | { after: number; text: string }

/**
 * @AgentView
 * 改一个文件，两种改法只用一种：
 * `edits` 按行号改几处（一次最多 1000 处，必须带上 read 给的 `version`，行号只在那一版上成立）；
 * `newText` 整份写进去（文件不存在就连同上级目录新建；已有的二进制文件拒改）。
 * 换行一律写 `\n`：写回去时按原文件的换行风格存（原来是 CRLF 的还是 CRLF），编码也按原文件的（新文件是 UTF-8）。
 * `version` 给了就先核对文件还是那一版，被改过就整批不写，message 里有现在的版本；不给就不核对（只有 newText 可以不给）。
 */
export interface FileEditItem {
  path: string
  version?: string
  edits?: FileLineEdit[]
  newText?: string
}

/** @AgentView 一批最多 20 个文件，全成或全不成；同一个文件的几处改动放进同一项的 edits。 */
export interface FileEditInput {
  files: FileEditItem[]
}

/** @AgentView 写好的一个文件：新的版本号与行数。path 是符号链接时，target 是真正被写的那个文件。 */
export interface FileWritten {
  path: string
  target?: string
  created: boolean
  version: string
  totalLines: number
}

/**
 * @AgentView
 * files 与入参的 files 一一对应。changeId 是这次改动的号，交给 `undo` 整次撤回。
 * undoable 为 false 时这次改动撤不回（有文件改之前超过 2 MB，原文没留下来）。
 * 任何一个写不下去就整个抛错、一个文件都不写：error.code 是 `FILES_EDIT_UNRESOLVED`（message 逐条写明第几个文件、为什么，
 * 版本对不上的带上现在的版本）或 `FILES_EDIT_DENIED`（越出空间范围，或文件权限不让写）。写到一半出了意外时，message 点名哪几个已经写进去了、怎么撤回。
 */
export interface FileEditResult {
  changeId: string
  undoable: boolean
  files: FileWritten[]
}

// ── 撤回 ────────────────────────────────────────────────────────

/** @AgentView 要撤回的那次改动：edit 结果里的 changeId，原样传。只留最近 50 次。 */
export interface FileUndoInput {
  changeId: string
}

/** @AgentView 撤回的一个文件：restored 是写回了改动前的内容，deleted 是删掉了那次改动新建的文件。 */
export interface FileUndone {
  path: string
  target?: string
  action: 'restored' | 'deleted'
}

/**
 * @AgentView
 * 撤回一次改动：那次改的每个文件回到改动前（新建的删掉），全成或全不成。
 * 已经撤回过的再撤一次也成功（alreadyUndone 为真，files 为空）。那之后文件又被改过时整个拒绝（`FILES_UNDO_CONFLICT`），一个文件都不动。
 */
export interface FileUndoResult {
  changeId: string
  alreadyUndone?: boolean
  files: FileUndone[]
}

// ── 空间端口定位出来的路径 ──────────────────────────────────────

/** 空间端口把模型给的路径定下来的结果。 */
export interface FileLocation {
  /** 给模型看的写法：回执与报错里用它。 */
  path: string
  /** 解开符号链接之后真正读写的文件（绝对路径）；审查、判重、落盘都对它。 */
  target: string
  /** path 经过了符号链接（target 与字面路径不同）：回执里把 target 也交出去。 */
  linked: boolean
}
