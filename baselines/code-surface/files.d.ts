// 本文件由 scripts/code-surface/generate-declarations.mjs 从能力包源码生成，不要手改。
// 模型写 `import { … } from 'velar:files'`：3 个方法、15 个类型。
// 改源码里带 @AgentView 的东西就是改模型可观测面，重算用 `bun run generate:code-surface`。

declare module 'velar:files' {
  /**
   * 读写本机上的文本文件。下面这几件事三个方法都成立，各自说明里不再重复：
   * 相对路径、`~` 怎么解析，哪些路径越出了范围，由当前空间决定（环境报告里写着）；越界的直接拒绝。
   * 读出来的是带行号的行；改的时候按行号改几处，或者整份写。读写保留原文件的编码（UTF-8、带 BOM、UTF-16、GB18030）与换行风格，
   * 认不出编码或有非法字节的按二进制处理。写是原子的，失败不会留下半截文件；路径是符号链接时读写它指向的那个文件，链接本身不变。
   * 哪些文件要先问用户（凭证、系统敏感路径……）也由当前空间决定：读被拒只是那一项失败，写被拒是整批不写。
   * 列目录、搜文本用命令做（`velar:shell` 的 run：ls、find、`rg -n`）；看图片用 `velar:images`。
   */

  /**
   * 代码模版（template.js）：
   *
   * ```js
   * // velar:files 的代码模版：挑一段照着改，import 只写一次。
   * // export default 交出来的东西才进你的上下文；读回来的行只落在程序的变量里。
   * import { edit, read, undo } from 'velar:files'
   *
   * // 带行号地看一段：lines 每项是 [行号, 原文]，排成「行号: 原文」交出去最好读。
   * async function show(path = '~/.zshrc', from = 1, to = 80) {
   *   const [file] = (await read({ files: [{ path, range: [from, to] }] })).files
   *   if ('error' in file) throw new Error(file.error.message)
   *   return { totalLines: file.totalLines, text: file.lines.map(([line, text]) => `${line}: ${text}`).join('\n') }
   * }
   *
   * // 大文件里只捞要的那几行（带行号），不把整份交出去。
   * async function findLines(path = '/var/log/system.log', pattern = /error/i) {
   *   const [log] = (await read({ files: [{ path }] })).files
   *   if ('error' in log) throw new Error(log.error.message)
   *   const hits = log.lines.filter(([, text]) => pattern.test(text))
   *   return { total: hits.length, last: hits.slice(-20).map(([line, text]) => `${line}: ${text}`) }
   * }
   *
   * // 按行号改：先读拿到行号与 version，再把那几行换掉；行号只在那一版上成立，所以一定带上 version。
   * async function replaceLine(path = '~/.zshrc', from = /^export PATH=/, to = 'export PATH="$HOME/bin:$PATH"') {
   *   const [file] = (await read({ files: [{ path }] })).files
   *   if ('error' in file) throw new Error(file.error.message)
   *   const hit = file.lines.find(([, text]) => from.test(text))
   *   if (!hit) return (await edit({ files: [{ path, version: file.version, edits: [{ after: file.totalLines, text: to }] }] })).changeId
   *   return (await edit({ files: [{ path, version: file.version, edits: [{ range: hit[0], text: to }] }] })).changeId
   * }
   *
   * // 几处一起改：行号都按读到的那一版算，不用自己算前面的改动带来的错位；text 为空串就是删掉那几行。
   * async function tidy(path = 'notes.txt') {
   *   const [file] = (await read({ files: [{ path }] })).files
   *   if ('error' in file) throw new Error(file.error.message)
   *   return edit({ files: [{ path, version: file.version, edits: [
   *     { range: [3, 4], text: '' },
   *     { after: 0, text: '# 整理过' },
   *   ] }] })
   * }
   *
   * // 整份写：在程序里算好全文再写回去（结构化的文件这样最稳）。换行写 \n，落盘时照原文件的风格存。
   * async function setJsonKey(path = 'config.json', key = 'debug', value = true) {
   *   const [file] = (await read({ files: [{ path }] })).files
   *   if ('error' in file) throw new Error(file.error.message)
   *   const config = JSON.parse(file.lines.map(([, text]) => text).join('\n'))
   *   config[key] = value
   *   return edit({ files: [{ path, version: file.version, newText: `${JSON.stringify(config, null, 2)}\n` }] })
   * }
   *
   * // 新建文件：给 newText，缺的上级目录会自动建。
   * async function writeScript(path = '~/bin/hello.sh') {
   *   return edit({ files: [{ path, newText: '#!/bin/sh\necho hello\n' }] })
   * }
   *
   * // 几个文件一起改：一批一次成败；写不下去时看 error.code 和 error.message 里逐条列的问题。
   * async function renameEverywhere(paths = ['a.txt', 'b.txt'], from = 'oldName', to = 'newName') {
   *   const { files } = await read({ files: paths.map((path) => ({ path })) })
   *   const changes = files.flatMap((f) => {
   *     if ('error' in f) return []
   *     const edits = f.lines.filter(([, text]) => text.includes(from)).map(([line, text]) => ({ range: line, text: text.replaceAll(from, to) }))
   *     return edits.length ? [{ path: f.path, version: f.version, edits }] : []
   *   })
   *   if (changes.length === 0) return '没有要改的'
   *   try {
   *     const result = await edit({ files: changes })
   *     return { changeId: result.changeId, files: result.files.map((f) => f.path) }
   *   } catch (error) {
   *     return { code: error.code, problems: error.message }
   *   }
   * }
   *
   * // 改坏了就整次撤回：changeId 是 edit 结果里的那个号。
   * async function revert(changeId = 'edit 结果里的 changeId') {
   *   return undo({ changeId })
   * }
   *
   * // 交出答案：export default 后面接你要给自己看的那一点东西。
   * export default await show()
   * ```
   */

  /** 一批最多 20 个。一批里前面的文件用掉了预算时，读不下的那几个各自算失败条目——单独放进一次 `read` 就行。 */
  interface FileReadInput {
    files: FileReadItem[]
  }

  /** files 与入参的 files 一一对应；某个文件读不了只有它那一项是失败。 */
  interface FileReadResult {
    files: Array<FileText | FileFailure>
  }

  /** 一批最多 20 个文件，全成或全不成；同一个文件的几处改动放进同一项的 edits。 */
  interface FileEditInput {
    files: FileEditItem[]
  }

  /**
   * files 与入参的 files 一一对应。changeId 是这次改动的号，交给 `undo` 整次撤回。
   * undoable 为 false 时这次改动撤不回（有文件改之前超过 2 MB，原文没留下来）。
   * 任何一个写不下去就整个抛错、一个文件都不写：error.code 是 `FILES_EDIT_UNRESOLVED`（message 逐条写明第几个文件、为什么，
   * 版本对不上的带上现在的版本）或 `FILES_EDIT_DENIED`（被拒）。写到一半出了意外时，message 点名哪几个已经写进去了、怎么撤回。
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
   * 撤回一次改动：那次改的每个文件回到改动前（新建的删掉），全成或全不成。
   * 已经撤回过的再撤一次也成功（alreadyUndone 为真，files 为空）。那之后文件又被改过时整个拒绝（`FILES_UNDO_CONFLICT`），一个文件都不动。
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
   * 读到的一个文件（或它的那几行）：lines 每项是 [行号, 原文]，原文不带换行符；行号只用来定位，写回去的正文照原文写、不带行号。
   * 行号的数法和 `wc -l` 一样：结尾那个换行不算多出一行。totalLines 是整个文件的行数。
   * version 是整个文件的版本号（不管只读了哪几行）：edit 带上它，就能挡住「读完之后别人又改过」。
   * lines 落在程序的变量里，**不进你的上下文**——要看哪几行就 export default 哪几行。
   */
  interface FileText {
    path: string
    target?: string
    version: string
    encoding: TextEncoding
    totalLines: number
    lines: Array<[number, string]>
  }

  /**
   * 一批里某个文件读不了、写不了：只有它这一项是失败，其余文件照常；全部失败时整个调用才报错。path 照传入的原样。
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
   * 改一个文件，两种改法只用一种：
   * `edits` 按行号改几处（一次最多 1000 处，必须带上 read 给的 `version`，行号只在那一版上成立）；
   * `newText` 整份写进去（文件不存在就连同上级目录新建；已有的二进制文件拒改）。
   * 换行一律写 `\n`：写回去时按原文件的换行风格存（原来是 CRLF 的还是 CRLF），编码也按原文件的（新文件是 UTF-8）。
   * `version` 给了就先核对文件还是那一版，被改过就整批不写，message 里有现在的版本；不给就不核对（只有 newText 可以不给）。
   */
  interface FileEditItem {
    path: string
    version?: string
    edits?: FileLineEdit[]
    newText?: string
  }

  /** 写好的一个文件：新的版本号与行数。path 是符号链接时，target 是真正被写的那个文件。 */
  interface FileWritten {
    path: string
    target?: string
    created: boolean
    version: string
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

  /**
   * 按行号改一处。range 选中的整行换成 text（text 是空串就是删掉这几行）；after 在第几行后面插入 text（0 是插在最前面）。
   * text 是新的几行，行与行之间用 `\n` 分开，结尾不用加 `\n`（加了就多一个空行）。
   * 行号是 `read` 那一版的行号：同一个文件的几处都按那一版算，互相不重叠，不用自己算前面改动带来的错位。
   */
  type FileLineEdit =
    | { range: FileLineRange; text: string }
    | { after: number; text: string }

  /**
   * 读文本文件：每个文件交回带行号的行（给了 range 就只交那几行）和整个文件的版本号。
   * 图片、PDF 与其他二进制文件、目录、设备文件、超过 20 MB 的文件，都算这个文件失败。
   */
  export function read(input: FileReadInput): Promise<FileReadResult>

  /**
   * 改文件：按行号改几处，或者整份写。**优先整批改**：files 里放几个就改几个，整批一次成败，成了给一个 changeId。
   * 等用户确认那段时间里文件被别人改过，整批不写。
   * 路径是管道、设备、套接字，或文件有多个硬链接时不碰。新内容编不成原编码（孤立代理项、GB18030 表示不了的字符）就整批不写。
   */
  export function edit(input: FileEditInput): Promise<FileEditResult>

  /**
   * 撤回一次 edit：那次改的每个文件回到改动前，那次新建的删掉，整次一起。只留最近 50 次改动。
   */
  export function undo(input: FileUndoInput): Promise<FileUndoResult>
}
