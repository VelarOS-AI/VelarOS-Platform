/**
 * 可移植数据：`velaros:files` 的入参与写、撤回的结果（读的结果带文本编码，在 `text.ts`），空间端口定位出来的路径，
 * 以及本机全局搜索（给宿主界面用）的输入与输出。
 * 只从常量表 import type，不带函数、不用 Node 类型，浏览器和渲染进程都能用；从 `@velaros-ai/velaros/files/contracts` 取。
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
 * 改文件的一步，按路径指文件：
 * `write` 把 text 整份写进去（文件不存在就连同上级目录新建；已有的二进制文件拒改）；
 * `replace` 把文件里的一段原文 oldText 换成 newText：oldText 照读到的原文写（空白、引号、换行都要一样），在文件里只能出现一次，出现好几处就多带几行上下文。
 * 换行一律写 `\n`：写回去时按原文件的换行风格存（原来是 CRLF 的还是 CRLF），编码也按原文件的（新文件是 UTF-8）。
 */
export type FileEditStep =
  | { action: 'write'; path: string; text: string }
  | { action: 'replace'; path: string; oldText: string; newText: string }

/**
 * @AgentView
 * 一次最多 1000 步、20 个文件，合成一次改动，全成或全不成。
 * 同一个文件接连几步时，后一步按前一步改完的内容算（先 write 新建、再 replace 也行）。
 */
export interface FileEditInput {
  steps: FileEditStep[]
}

/** @AgentView 写好的一个文件：改完之后的行数。path 是符号链接时，target 是真正被写的那个文件。 */
export interface FileWritten {
  path: string
  target?: string
  created: boolean
  totalLines: number
}

/**
 * @AgentView
 * files 是这次写到的每个文件，按第一次写到它的顺序。changeId 是这次改动的号，交给 `undo` 整次撤回。
 * undoable 为 false 时这次改动撤不回（有文件改之前超过 2 MB，原文没留下来）。
 * 任何一步写不下去就整个抛错、一个文件都不写：error.code 是 `FILES_EDIT_UNRESOLVED`（message 逐条写明第几步、为什么：
 * 原文找不到的带上最像的几行，出现好几处的带上在第几行）或 `FILES_EDIT_DENIED`（越出空间范围，或文件权限不让写）。写到一半出了意外时，message 点名哪几个已经写进去了、怎么撤回。
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

// ── 本机全局搜索（`@velaros-ai/velaros/files/local` 的 LocalFileSearch，给宿主界面用；模型列目录、搜文本用命令） ──

/** 搜索命中的一个文件系统条目。 */
export interface FileSearchEntry {
  path: string
  type: 'file' | 'directory'
}

/** 内容搜索命中的一行：定位到文件、行、列，并附一段摘录。 */
export interface FileSearchMatch {
  path: string
  line: number
  column: number
  excerpt: string
}

/** 搜索模式：`paths` 按路径名找条目，`content` 在文件内容里找文本。 */
export type FileSearchMode = 'paths' | 'content'

/** 路径模式下的匹配方式：包含、精确、模糊。 */
export type FileSearchPathMatchMode = 'contains' | 'exact' | 'fuzzy'

/**
 * 系统范围搜索的输入。
 *
 * 未给出的字段一律由实现取默认值：默认根目录、默认条数上限、默认深度上限。
 * `unrestricted` 只表达调用方的意愿，实现仍会跳过受系统保护的目录（见不变量登记）。
 */
export interface FileSearchOptions {
  query: string
  mode?: FileSearchMode
  rootPath?: string
  limit?: number
  maxDepth?: number
  entryTypes?: Array<FileSearchEntry['type']>
  pathMatchMode?: FileSearchPathMatchMode
  extensions?: string[]
  caseSensitive?: boolean
  regex?: boolean
  maxResultsPerFile?: number
  includeHidden?: boolean
  unrestricted?: boolean
}

/**
 * 系统范围搜索的输出。
 *
 * `count` 是本次返回的条数；`truncated` 为 true 表示还有结果没有返回，而不是搜索失败。
 * 路径模式填 `entries`，内容模式填 `matches`，两者不会同时出现。
 */
export interface FileSearchResult {
  mode: FileSearchMode
  rootPath: string
  count: number
  truncated: boolean
  entries?: FileSearchEntry[]
  matches?: FileSearchMatch[]
}
