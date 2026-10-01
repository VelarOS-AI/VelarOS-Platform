declare module 'velaros:files' {
  /**
   * 读写本机上的文本文件。下面这几件事三个方法都成立，各自说明里不再重复：
   * 相对路径、`~` 怎么解析，哪些路径越出了范围，由当前空间决定（环境报告里写着）；越界的直接拒绝。
   * 读出来的是连续的正文，带第一行的行号；改的时候按路径写：整份写进去，或者把一段原文换成新文。读写保留原文件的编码（UTF-8、带 BOM、UTF-16、GB18030）与换行风格，
   * 认不出编码或有非法字节的按二进制处理。写是原子的，失败不会留下半截文件；路径是符号链接时读写它指向的那个文件，链接本身不变。
   * 列目录、搜文本用命令做（`velaros:shell` 的 run：ls、find、`rg -n`）；看图片用 `velaros:images`。
   */

  /**
   * 读文本文件：每个文件交回连续的正文与它第一行的行号（给了 range 就只交那几行）。
   * 图片、PDF 与其他二进制文件、目录、设备文件、超过 20 MB 的文件，都算这个文件失败。
   */
  export function read(input: FileReadInput): Promise<FileReadResult>

  /**
   * 改文件：按路径一步一步写，write 整份写、replace 把一段原文换掉。**优先一次改完**：几个文件、几处改动都放进 steps；先统一核对计划，成功后给一个 changeId。
   * 每个文件在落盘时核对原始版本，单个文件原子替换。落盘途中失败可能已有部分写入，报错会点名已写文件及可用的撤回号，先读现状再处理。
   * 路径是管道、设备、套接字，或文件有多个硬链接时不碰。新内容编不成原编码（孤立代理项、GB18030 表示不了的字符）就整次不写。
   */
  export function edit(input: FileEditInput): Promise<FileEditResult>

  /**
   * 撤回一次 edit：那次改的每个文件回到改动前，那次新建的删掉。逐项原子提交，途中失败会报告已撤回文件，再调用会接着撤；只留最近 50 次改动。撤回重新核验当前空间对原路径的授权，且真实目标必须一致。
   */
  export function undo(input: FileUndoInput): Promise<FileUndoResult>

  /** 一批最多 20 个。一批里前面的文件用掉了预算时，读不下的那几个各自算失败条目——单独放进一次 `read` 就行。 */
  interface FileReadInput {
    files: FileReadItem[]
  }

  /** files 与入参的 files 一一对应；某个文件读不了只有它那一项是失败。 */
  interface FileReadResult {
    files: Array<FileText | FileFailure>
  }

  /**
   * 一次最多 1000 步、20 个文件，先统一规划再逐文件原子提交；规划失败一个都不写，提交途中失败可能已写入部分文件，错误会点名。
   * 同一个文件接连几步时，后一步按前一步改完的内容算（先 write 新建、再 replace 也行）。
   */
  interface FileEditInput {
    steps: FileEditStep[]
  }

  /**
   * files 是这次写到的每个文件，按第一次写到它的顺序。changeId 是这次改动的号，交给 `undo` 整次撤回。
   * undoable 为 false 时这次改动撤不回（有文件改之前超过 2 MB，原文没留下来）。
   * 规划阶段任何一步写不下去就整个抛错、一个文件都不写：error.code 是 `FILES_EDIT_UNRESOLVED`（message 逐条写明第几步、为什么：
   * 原文找不到的带上最像的几行，出现好几处的带上在第几行）或 `FILES_EDIT_DENIED`（越出空间范围，或文件权限不让写）。写到一半出了意外时，message 点名哪几个已经写进去了、怎么撤回。
   */
  interface FileEditResult {
    changeId: string
    undoable: boolean
    files: FileWritten[]
  }

  /** 要撤回的那次改动：edit 结果里的 changeId，原样传。只留最近 50 次。 */
  interface FileUndoInput {
    changeId: string
  }

  /**
   * 撤回一次改动：核对当前路径授权、真实目标和版本后，逐项原子恢复原文或删除那次新建的文件；途中失败报告已撤回项，再调用会接着处理剩余项。
   * 已经撤回过的再撤一次也成功（alreadyUndone 为真，files 为空）。撤回预检发现那之后文件又被改过时整个拒绝（`FILES_UNDO_CONFLICT`），本次一个文件都不动；预检后的竞争或落盘故障可能产生部分撤回，按错误里的实际结果处理。
   */
  interface FileUndoResult {
    changeId: string
    alreadyUndone?: boolean
    files: FileUndone[]
  }

  /**
   * 要读的一个文件。range 只读这几行（末行超过文件行数就读到最后一行）；不给就整个文件。
   * 单个文件最大 20 MB，再大的用命令取片段（`tail -n`、`grep -n`、`sed -n 'a,bp'`）。
   */
  interface FileReadItem {
    path: string
    range?: FileLineRange
  }

  /**
   * 读到的一个文件（或它的那几行）：text 是连续的正文，startLine 是它第一行的行号，totalLines 是整个文件的行数。
   * 换行一律是 `\n`（原文件是 CRLF 的也一样）；读到文件末尾时，文件结尾的换行照原样在 text 里——整份读出来原样 write 回去，不多一行也不少一行。
   * 行号的数法和 `wc -l` 一样：结尾那个换行不算多出一行，空文件是 0 行。
   * text 落在程序的变量里，**不进你的上下文**——要看哪一段就 export default 哪一段。
   */
  interface FileText {
    path: string
    target?: string
    encoding: TextEncoding
    totalLines: number
    startLine: number
    text: string
  }

  /**
   * 一批里某个文件读不了：只有它这一项是失败，其余文件照常；全部失败时整个调用才报错。path 照传入的原样。
   * 它和成功那支**没有判别字段**，用 `'error' in file` 分开（`file.error` 在联合上取不到）。
   */
  interface FileFailure {
    path: string
    error: {
      code: string
      message: string
    }
  }

  /**
   * 改文件的一步，按路径指文件：
   * `write` 把 text 整份写进去（文件不存在就连同上级目录新建；已有的二进制文件拒改）；
   * `replace` 把文件里的一段原文 oldText 换成 newText：oldText 照读到的原文写（空白、引号、换行都要一样），在文件里只能出现一次，出现好几处就多带几行上下文。
   * 换行一律写 `\n`：写回去时按原文件的换行风格存（原来是 CRLF 的还是 CRLF），编码也按原文件的（新文件是 UTF-8）。
   */
  type FileEditStep =
    | { action: 'write'; path: string; text: string }
    | { action: 'replace'; path: string; oldText: string; newText: string }

  /** 写好的一个文件：改完之后的行数。path 是符号链接时，target 是真正被写的那个文件。 */
  interface FileWritten {
    path: string
    target?: string
    created: boolean
    totalLines: number
  }

  /** 撤回的一个文件：restored 是写回了改动前的内容，deleted 是删掉了那次改动新建的文件。 */
  interface FileUndone {
    path: string
    target?: string
    action: 'restored' | 'deleted'
  }

  /** 行号或连续闭区间：`12`、`[12]`、`[40, 60]`，从 1 起，末行不小于首行。 */
  type FileLineRange = number | [number] | [number, number]

  /** 文件在磁盘上的文本编码。utf8-bom、utf16le、utf16be 带 BOM，-nobom 的不带；gb18030 也包括 GBK 与 GB2312 的文件。 */
  type TextEncoding = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be' | 'utf16le-nobom' | 'utf16be-nobom' | 'gb18030'
}
