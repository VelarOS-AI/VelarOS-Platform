// 本文件由 scripts/code-surface/generate-declarations.mjs 从能力包源码生成，不要手改。
// 模型写 `import { … } from 'velar:files'`：3 个方法、17 个类型。
// 改源码里带 @AgentView 的东西就是改模型可观测面，重算用 `bun run generate:code-surface`。

declare module 'velar:files' {
  /**
   * 读文本、看图片、写文件。下面这几件事三个方法都成立，各自说明里不再重复：
   * 相对路径、`~` 怎么解析，哪些路径越出了范围，由当前空间决定（环境报告里写着根目录）；越界的直接拒绝。
   * 读写保留原文件的编码（UTF-8、带 BOM、UTF-16、GB18030），认不出编码或有非法字节的按二进制处理。
   * 写是原子的，失败不会留下半截文件；路径是符号链接时读写它指向的那个文件，链接本身不变。
   * 哪些文件要先问用户（凭证、系统敏感路径……）也由当前空间决定：读被拒只是那一项失败，写被拒是整批不写。
   * 列目录、搜文本用命令做（`velar:shell` 的 run：ls、find、rg）。
   */

  /**
   * 代码模版（templates/files.js）：
   *
   * ```js
   * // velar:files 的代码模版：挑一段照着改，import 只写一次。
   * // export default 交出来的东西才进你的上下文；读回来的正文只落在程序的变量里。
   * import { edit, read, view } from 'velar:files'
   *
   * // 读一个不知道多大的文件：先看大小，再决定交出多少。
   * async function readUnknownSize(path = 'README.md') {
   *   const [file] = (await read({ files: [{ path }] })).files
   *   if ('error' in file) throw new Error(file.error.message)
   *   return file.content.length <= 20000
   *     ? file.content
   *     : { chars: file.content.length, head: file.content.slice(0, 4000) }
   * }
   *
   * // 大日志里只捞错误行，不把整份交出去。
   * async function findErrors(path = 'build.log') {
   *   const [log] = (await read({ files: [{ path }] })).files
   *   if ('error' in log) throw new Error(log.error.message)
   *   const errors = log.content.split('\n').filter((line) => line.includes('ERROR'))
   *   return { total: errors.length, last: errors.slice(-20) }
   * }
   *
   * // 一批文件只看开头；读不了的那一项单独是失败，别的照常。
   * async function headsOf(paths = ['src/a.ts', 'src/b.ts']) {
   *   const { files } = await read({ files: paths.map((path) => ({ path })) })
   *   return files.map((f) => ('error' in f ? { path: f.path, error: f.error.message } : { path: f.path, head: f.content.slice(0, 300) }))
   * }
   *
   * // 改文件：在程序里把内容改好，带着 read 给的 version 整份写回去——中间被人改过就不写。
   * async function replaceInFile(path = 'config.json', from = '"debug": false', to = '"debug": true') {
   *   const [file] = (await read({ files: [{ path }] })).files
   *   if ('error' in file) throw new Error(file.error.message)
   *   const next = file.content.replace(from, to)
   *   if (next === file.content) throw new Error(`没找到要改的那一处：${from}`)
   *   return (await edit({ files: [{ path, newText: next, version: file.version }] })).files
   * }
   *
   * // 几个文件一起改：一批一次成败；写不下去时看 error.code 和 error.message 里逐条列的问题。
   * async function renameEverywhere(paths = ['src/a.ts', 'src/b.ts'], from = 'oldName', to = 'newName') {
   *   const { files } = await read({ files: paths.map((path) => ({ path })) })
   *   const changes = files.flatMap((f) => ('error' in f || !f.content.includes(from) ? [] : [{ path: f.path, newText: f.content.replaceAll(from, to), version: f.version }]))
   *   if (changes.length === 0) return '没有要改的'
   *   try {
   *     return (await edit({ files: changes })).files.map((f) => f.path)
   *   } catch (error) {
   *     return { code: error.code, problems: error.message }
   *   }
   * }
   *
   * // 改坏了就回滚：edit 回执里的 previousVersion 就是改动前的那一版。
   * async function undo(path = 'config.json', previousVersion = 'edit 回执里的 previousVersion') {
   *   return (await edit({ files: [{ path, restore: previousVersion }] })).files
   * }
   *
   * // 看图：在范围内原样给你，大图会压小；结果里 sent 比原图小就说明压过。
   * // 图不在返回值里，跟在结果后面给你看，只给你看一次：你一回应就撤掉，要再看就再调一次 view。
   * async function lookAt(path = 'screen.png') {
   *   const [image] = (await view({ files: [{ path }] })).files
   *   return image
   * }
   *
   * // 压小之后看不清的地方，用 region 单独要那一块（按原图像素算）；原图尺寸在上一次 view 的结果里。
   * async function zoomTopRight(path = 'screen.png', width = 3840, height = 2160) {
   *   const region = { x: Math.floor(width / 2), y: 0, width: Math.ceil(width / 2), height: Math.ceil(height / 2) }
   *   return (await view({ files: [{ path, region }] })).files
   * }
   *
   * // 交出答案：export default 后面接你要给自己看的那一点东西。
   * export default await readUnknownSize()
   * ```
   */

  const TextEncodings: readonly ['utf8', 'utf8-bom', 'utf16le', 'utf16be', 'utf16le-nobom', 'utf16be-nobom', 'gb18030']

  /**
   * 一批最多 20 项，每个文件整份读回来。单个文件最大 20 MB，再大的用命令取片段（`tail -n`、`grep`、`sed -n 'a,bp'`）。
   * 一批里前面的文件用掉了预算时，读不下的那几个各自算失败条目——单独放进一次 `read` 就行。
   */
  interface FileReadInput {
    files: FileReadItem[]
  }

  /** files 与入参的 files 一一对应；某个文件读不了只有它那一项是失败。 */
  interface FileReadResult {
    files: Array<FileTextResult | FileFailure>
  }

  /** 一批最多 10 张。 */
  interface FileViewInput {
    files: FileViewItem[]
  }

  /**
   * files 与入参的 files 一一对应。**图片本身不在这里**：调用 view 就把图交给你了，
   * 程序跑完之后按顺序放在结果后面，每张前面有一行说明是哪个文件。
   * 图**只给你看一次**：你一回应它就撤出上下文（那行说明还在），要再看就再调一次 view。
   */
  interface FileViewResult {
    files: Array<FileImageResult | FileFailure>
  }

  /** 一批最多 20 项，全成或全不成。 */
  interface FileEditInput {
    files: FileEditItem[]
  }

  /**
   * files 与入参的 files 一一对应。任何一个写不下去就整个抛错、一个文件都不写：
   * error.code 是 `FILES_EDIT_UNRESOLVED`（message 逐条写明第几个文件、为什么，版本对不上的带上现在的版本）
   * 或 `FILES_EDIT_DENIED`（被拒）。写到一半出了意外时，message 点名哪几个已经写进去了。
   */
  interface FileEditResult {
    files: FileEditItemResult[]
  }

  /** 整个文件读回来。给 version 就读改动前留下的那个版本；只有本次运行里 edit 留下的几份还在，找不到算这个文件失败。 */
  interface FileReadItem {
    path: string
    version?: string
  }

  /**
   * content 是整个文件的原文，换行风格原样保留。它**落在程序的变量里，不进你的上下文**——
   * 要看哪一段就 export default 哪一段；不知道文件多大，先看 `content.length` 再决定。
   * version 是这份内容的版本号，回写时带上它就能挡住「读完之后别人又改过」。
   */
  interface FileTextResult {
    path: string
    version: string
    content: string
    encoding: TextEncoding
  }

  /**
   * 一批里某个文件读不了或看不了：只有它这一项是失败，其余文件照常返回；全部失败时整个调用才报错。path 照传入的原样。
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
   * 一张图片。给 region 就只看那一块（按原图像素算，超出图的部分会收进来）。
   * 大图会被压小再给你；压完看不清的地方，拿 region 把那一块单独要来看。
   */
  interface FileViewItem {
    path: string
    region?: FileImageRegion
  }

  /** width、height 是原图的尺寸；sent 是实际给你看的尺寸，比原图（或 region）小就说明压过。 */
  interface FileImageResult {
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
   * 两种改法只用一种：`newText` 当整个文件写进去（不存在就连同上级目录新建，已有的二进制文件拒改），
   * `restore` 回到改动前留下的那个版本。
   * 改一小段也是给整份 `newText`——先 `read` 拿到 `content`，在程序里算出新内容再写回来。
   * **正文不经模型的上下文**，所以整份写和改一处一样便宜；`content.replace(...)` 比任何编辑协议都准。
   * newText 原样写进去，换行风格由你决定（read 回来的 content 保留了原文的换行，照着改就不会变）。
   * `version` 是 `read` 返回的版本号，给了就先核对文件现在还是这个版本，被改过就整批不写并给出当前版本；不给就不核对。
   * 想安全地改一个文件，就把 `read` 拿到的 `version` 原样带回来。
   * 单个文件最大 20 MB；更大的用命令就地改（`sed -i`、`awk`）。超过 2 MB 的能写，但不留回滚版本。
   */
  interface FileEditItem {
    path: string
    newText?: string
    restore?: string
    version?: string
  }

  /** 一个文件写完的结果，按 action 分辨是哪一种。 */
  type FileEditItemResult = FileWrittenResult | FileRestoredResult

  /** 一种磁盘文本编码，取值见常量表 `TextEncodings`。 */
  type TextEncoding = (typeof TextEncodings)[number]

  /** 图上的一块，按原图的像素算。 */
  interface FileImageRegion {
    x: number
    y: number
    width: number
    height: number
  }

  /** previousVersion 是改动前留下的版本，能拿去 `restore`；新建的文件、或者原文件超过 2 MB（不留版本）时为 null。path 是符号链接时，target 是真正被写的那个文件。 */
  interface FileWrittenResult {
    path: string
    target?: string
    action: 'written'
    created: boolean
    version: string
    previousVersion: string | null
    bytes: number
    totalChars: number
  }

  /** 文件回到 version 那个版本；回滚前的内容留成 previousVersion，回滚本身也能再回滚。 */
  interface FileRestoredResult {
    path: string
    target?: string
    action: 'restored'
    version: string
    previousVersion: string | null
    bytes: number
    totalChars: number
  }

  /**
     * 读文本文件，每个文件整份读回来。
     * 图片要改用 view；PDF 与其他文档、其他二进制文件、目录、设备文件、超过 20 MB 的文件，都算这个文件失败。
     */
    export function read(input: FileReadInput): Promise<FileReadResult>

  /**
     * 看图片：整张图交给模型，效果和用户上传一样。
     * 只认 PNG、JPEG、GIF、WebP；交给你的图长边不超过 2000 px、base64 后不超过 5 MB，超了先压。
     * PDF 与其他文档、文本文件、其他二进制文件、目录、设备文件、超过 20 MB 的文件，都算这个文件失败。
     */
    export function view(input: FileViewInput): Promise<FileViewResult>

  /**
     * 写文件。**优先整批写**：files 里放几个就改几个，整批一次成败。
     * 等用户确认那段时间里文件被别人改过，整批不写。
     * 路径是管道、设备、套接字，或文件有多个硬链接时不碰。新文本编不成原编码（孤立代理项、GB18030 表示不了的字符）就整批不写。
     */
    export function edit(input: FileEditInput): Promise<FileEditResult>
}
