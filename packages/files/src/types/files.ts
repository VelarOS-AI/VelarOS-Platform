/**
 * 可移植数据：`velar:files` 的入参与结果（读的结果带文本编码，在 `text.ts`），以及空间端口定位出来的路径。
 * 只从常量表 import type，不带函数、不用 Node 类型，浏览器和渲染进程都能用；从 `@velaros-ai/files/contracts` 取。
 */

// ── 读 ──────────────────────────────────────────────────────────

/** @AgentView 整个文件读回来。给 version 就读改动前留下的那个版本；只有本次运行里 edit 留下的几份还在，找不到算这个文件失败。 */
export interface FileReadItem {
  path: string
  version?: string
}

/**
 * @AgentView
 * 一批最多 20 项，每个文件整份读回来。单个文件最大 20 MB，再大的用命令取片段（`tail -n`、`grep`、`sed -n 'a,bp'`）。
 * 一批里前面的文件用掉了预算时，读不下的那几个各自算失败条目——单独放进一次 `read` 就行。
 */
export interface FileReadInput {
  files: FileReadItem[]
}

/**
 * @AgentView
 * 一批里某个文件读不了或看不了：只有它这一项是失败，其余文件照常返回；全部失败时整个调用才报错。path 照传入的原样。
 * 它和成功那支**没有判别字段**，用 `'error' in file` 分开（`file.error` 在联合上取不到）。
 */
export interface FileFailure {
  path: string
  error: {
    code: string
    message: string
  }
}

// ── 看 ──────────────────────────────────────────────────────────

/** @AgentView 图上的一块，按原图的像素算。 */
export interface FileImageRegion {
  x: number
  y: number
  width: number
  height: number
}

/**
 * @AgentView
 * 一张图片。给 region 就只看那一块（按原图像素算，超出图的部分会收进来）。
 * 大图会被压小再给你；压完看不清的地方，拿 region 把那一块单独要来看。
 */
export interface FileViewItem {
  path: string
  region?: FileImageRegion
}

/** @AgentView 一批最多 10 张。 */
export interface FileViewInput {
  files: FileViewItem[]
}

/** @AgentView width、height 是原图的尺寸；sent 是实际给你看的尺寸，比原图（或 region）小就说明压过。 */
export interface FileImageResult {
  path: string
  mediaType: string
  width: number
  height: number
  sent: {
    width: number
    height: number
  }
}

/**
 * @AgentView
 * files 与入参的 files 一一对应。**图片本身不在这里**：调用 view 就把图交给你了，
 * 程序跑完之后按顺序放在结果后面，每张前面有一行说明是哪个文件。
 * 图**只给你看一次**：你一回应它就撤出上下文（那行说明还在），要再看就再调一次 view。
 */
export interface FileViewResult {
  files: Array<FileImageResult | FileFailure>
}

// ── 写 ──────────────────────────────────────────────────────────

/**
 * @AgentView
 * 两种改法只用一种：`newText` 当整个文件写进去（不存在就连同上级目录新建，已有的二进制文件拒改），
 * `restore` 回到改动前留下的那个版本。
 *
 * 改一小段也是给整份 `newText`——先 `read` 拿到 `content`，在程序里算出新内容再写回来。
 * **正文不经模型的上下文**，所以整份写和改一处一样便宜；`content.replace(...)` 比任何编辑协议都准。
 * newText 原样写进去，换行风格由你决定（read 回来的 content 保留了原文的换行，照着改就不会变）。
 *
 * `version` 是 `read` 返回的版本号，给了就先核对文件现在还是这个版本，被改过就整批不写并给出当前版本；不给就不核对。
 * 想安全地改一个文件，就把 `read` 拿到的 `version` 原样带回来。
 *
 * 单个文件最大 20 MB；更大的用命令就地改（`sed -i`、`awk`）。超过 2 MB 的能写，但不留回滚版本。
 */
export interface FileEditItem {
  path: string
  newText?: string
  restore?: string
  version?: string
}

/** @AgentView 一批最多 20 项，全成或全不成。 */
export interface FileEditInput {
  files: FileEditItem[]
}

/** @AgentView previousVersion 是改动前留下的版本，能拿去 `restore`；新建的文件、或者原文件超过 2 MB（不留版本）时为 null。path 是符号链接时，target 是真正被写的那个文件。 */
export interface FileWrittenResult {
  path: string
  target?: string
  action: 'written'
  created: boolean
  version: string
  previousVersion: Nullable<string>
  bytes: number
  totalChars: number
}

/** @AgentView 文件回到 version 那个版本；回滚前的内容留成 previousVersion，回滚本身也能再回滚。 */
export interface FileRestoredResult {
  path: string
  target?: string
  action: 'restored'
  version: string
  previousVersion: Nullable<string>
  bytes: number
  totalChars: number
}

/** @AgentView 一个文件写完的结果，按 action 分辨是哪一种。 */
export type FileEditItemResult = FileWrittenResult | FileRestoredResult

/**
 * @AgentView
 * files 与入参的 files 一一对应。任何一个写不下去就整个抛错、一个文件都不写：
 * error.code 是 `FILES_EDIT_UNRESOLVED`（message 逐条写明第几个文件、为什么，版本对不上的带上现在的版本）
 * 或 `FILES_EDIT_DENIED`（被拒）。写到一半出了意外时，message 点名哪几个已经写进去了。
 */
export interface FileEditResult {
  files: FileEditItemResult[]
}

// ── 空间端口定位出来的路径 ──────────────────────────────────────

/** 空间端口把模型给的路径定下来的结果。 */
export interface FileLocation {
  /** 回执与报错里给模型看的写法（系统空间是绝对路径，项目空间可以是相对项目根的路径）。 */
  path: string
  /** 解开符号链接后真正要读写的绝对路径。 */
  target: string
  /** 路径本身是符号链接（或经过符号链接）：回执里会点名真正被写的是哪个文件。 */
  linked: boolean
}
