// 本文件由 scripts/code-surface/generate-declarations.mjs 从能力包源码生成，不要手改。
// 模型写 `import { … } from 'velar:system'`：6 个方法、40 个类型。
// 改源码里带 @AgentView 的东西就是改模型可观测面，重算用 `bun run generate:code-surface`。

declare module 'velar:system' {
  /**
   * 下面这几件事**三个方法都成立**，各自说明里不再重复：
   * 路径按用户输入规整，`~` 展开到家目录，相对路径相对默认工作目录。
   * **位置一律按字符算，没有行的概念**——offset 与 range 都是字符下标。
   * 读写保留原文件的编码（UTF-8、带 BOM、UTF-16、GB18030），认不出编码或有非法字节的按二进制处理。
   * 写是原子替换（先写临时文件、fsync 再换上去，权限位原样保留），失败不会留下半截文件。
   * 碰凭证文件（私钥、云凭证、口令库）与系统敏感路径前先向用户确认，被拒就不动。
   */

  /**
   * 下面这几件事**四个方法都成立**，各自说明里不再重复：
   * 路径按用户输入规整，`~` 展开到家目录，相对路径相对默认工作目录。
   * 命令按策略分类，要确认的在执行之前问用户；被拒时命令一个进程都没起。
   */

  /**
   * 代码模版（templates/system.js）：
   *
   * ```js
   * // velar:system 的代码模版：挑一段照着改，import 只写一次。
   * // export default 交出来的东西才进你的上下文；能力的返回值只落在程序的变量里。
   * import { edit, listTasks, read, run, view } from 'velar:system'
   *
   * // 读一个不知道多大的文件：先看大小，再决定交出多少。
   * async function readUnknownSize(path = '~/project/README.md') {
   *   const [file] = (await read({ files: [{ path }] })).files
   *   if ('error' in file) throw new Error(file.error.message)
   *   return file.content.length <= 20000
   *     ? file.content
   *     : { chars: file.content.length, head: file.content.slice(0, 4000) }
   * }
   *
   * // 大日志里只捞错误行，不把整份交出去。
   * async function findErrors(path = '~/build.log') {
   *   const [log] = (await read({ files: [{ path }] })).files
   *   if ('error' in log) throw new Error(log.error.message)
   *   const errors = log.content.split('\n').filter((line) => line.includes('ERROR'))
   *   return { total: errors.length, last: errors.slice(-20) }
   * }
   *
   * // 一批文件只看开头。
   * async function headsOf(paths = ['~/project/a.ts', '~/project/b.ts']) {
   *   const { files } = await read({ files: paths.map((path) => ({ path })) })
   *   return files.map((f) => ('error' in f ? { path: f.path, error: f.error.message } : { path: f.path, head: f.content.slice(0, 300) }))
   * }
   *
   * // 改文件：在程序里把内容改好，带着 read 给的 version 整份写回去——中间被人改过就不写。
   * async function replaceInFile(path = '~/project/config.json', from = '"debug": false', to = '"debug": true') {
   *   const [file] = (await read({ files: [{ path }] })).files
   *   if ('error' in file) throw new Error(file.error.message)
   *   const next = file.content.replace(from, to)
   *   if (next === file.content) throw new Error(`没找到要改的那一处：${from}`)
   *   return (await edit({ files: [{ path, newText: next, version: file.version }] })).files
   * }
   *
   * // 看图：在范围内原样给你，大图会压小；结果里 sent 比原图小就说明压过。
   * // 图不在返回值里，跟在结果后面给你看，只留到你下一次调用——一次看一张，看完先把要点写下来。
   * async function lookAt(path = '~/Desktop/screen.png') {
   *   const [image] = (await view({ files: [{ path }] })).files
   *   return image
   * }
   *
   * // 压小之后看不清的地方，用 region 单独要那一块（按原图像素算）；原图尺寸在上一次 view 的结果里。
   * async function zoomTopRight(path = '~/Desktop/screen.png', width = 3840, height = 2160) {
   *   const region = { x: Math.floor(width / 2), y: 0, width: Math.ceil(width / 2), height: Math.ceil(height / 2) }
   *   return (await view({ files: [{ path, region }] })).files
   * }
   *
   * // 跑命令，按退出码判断，只交出结论。
   * async function runTests(cwd = '~/project') {
   *   const result = await run({ command: 'npm test', cwd })
   *   return result.exitCode === 0 ? '全部通过' : { exitCode: result.exitCode, tail: result.stdout.slice(-3000) }
   * }
   *
   * // 起一个长时间跑的服务，之后按 taskId 查它跑到哪了。
   * async function startServer(cwd = '~/project') {
   *   const started = await run({ command: 'npm run dev', cwd, background: true })
   *   const taskId = started.backgroundProcess?.taskId
   *   return taskId ? await listTasks({ taskId }) : started
   * }
   *
   * // 交出答案：export default 后面接你要给自己看的那一点东西。
   * export default await readUnknownSize()
   * ```
   */

  const TextEncodings: readonly ['utf8', 'utf8-bom', 'utf16le', 'utf16be', 'utf16le-nobom', 'utf16be-nobom', 'gb18030']

  /**
   * 一批最多 20 项，每个文件整份读回来。单个文件最大 20 MB，再大的用 `run` 取片段（`tail -n`、`grep`、`sed -n 'a,bp'`）。
   * 一批里前面的文件用掉了预算时，读不下的那几个各自算失败条目——单独放进一次 `read` 就行。
   */
  type SystemReadInput = {
    files: SystemReadFileInput[]
  }

  /** files 与入参的 files 一一对应；某个文件读不了只有它那一项是失败。 */
  interface SystemReadResult {
    files: Array<SystemReadFileResult | SystemFileFailure>
  }

  /** 一批最多 10 张。 */
  type SystemViewInput = {
    files: SystemViewFileInput[]
  }

  /**
   * files 与入参的 files 一一对应。**图片本身不在这里**：调用 view 就把图交给你了，
   * 程序跑完之后按顺序放在结果后面，每张前面有一行说明是哪个文件。
   */
  interface SystemViewResult {
    files: Array<SystemViewFileResult | SystemFileFailure>
  }

  /** 一批最多 20 项，全成或全不成。 */
  type SystemEditInput = {
    files: SystemEditFileInput[]
  }

  /**
   * files 与入参的 files 一一对应。任何一个写不下去就整个报错、一个文件都不写，
   * 错误的 cause.details.problems 逐条给出是第几个文件、为什么。
   */
  interface SystemEditResult {
    files: SystemEditFileResult[]
  }

  /**
   * 不传 cwd 用宿主给的默认目录，不传 shell 用环境报告里的默认 shell。
   */
  type SystemRunInput = {
    command: string
    cwd?: string
    shell?: SystemShellKind
    timeoutMs?: number
    background?: boolean
    interactive?: boolean
    maxOutputChars?: number
  }

  /** 要了 interactive 却没拿到控制台时，note 说明怎么把命令改成不用输入的写法。 */
  interface SystemRunResult extends SystemCommandResult {
    note?: string
  }

  /** 刷新之后的 shell 环境：`shell` 是重新选定的那个默认 shell 的可执行文件路径，`runtime` 是它的完整描述。 */
  interface SystemShellEnvironmentRefreshResult {
    shell: string
    variableCount: number
    refreshedAt: number
    runtime?: SystemShellDescriptor
    /** 刷新之后本机可用的全部 shell，按挑选优先顺序，第一个就是 `runtime` 那个默认的。刚装上的 shell 在这里就看得到，不必等下一个回合的环境报告。 */
    shells?: SystemShellDescriptor[]
    /** 这次选定的 shell 环境的版本号；变了说明之前缓存的 shell 选择已作废。 */
    revision?: string
    /** Windows 上重读用户与系统环境变量失败时的原因；成功或不是 Windows 时没有。 */
    reason?: string
  }

  /** 给 taskId 就精确查那一条，limit 不再起作用；不传 limit 默认列 50 条。 */
  type SystemListTasksInput = {
    limit?: number
    onlyRunning?: boolean
    taskId?: string
  }

  /** 后台任务表：最新启动的在前，count 是这次列出了几条。 */
  type SystemListTasksResult = {
    count: number
    tasks: SystemBackgroundTaskRecord[]
  }

  /** 整个文件读回来。给 version 就读改动前留下的那个版本；只有本次运行里 edit 留下的几份还在，找不到算这个文件失败。 */
  interface SystemReadFileInput {
    path: string
    version?: string
  }

  /**
   * content 是整个文件的原文，换行风格原样保留。它**落在程序的变量里，不进你的上下文**——
   * 要看哪一段就 export default 哪一段；不知道文件多大，先看 `content.length` 再决定。
   * version 是这份内容的版本号，回写时带上它就能挡住「读完之后别人又改过」。
   */
  interface SystemReadFileResult {
    path: string
    version: string
    content: string
    encoding: TextEncoding
  }

  /**
   * 一批里某个文件读不了或看不了：只有它这一项是失败，其余文件照常返回；全部失败时整个调用才报错。path 照传入的原样。
   * 它和成功那支**没有判别字段**，用 `'error' in file` 分开（`file.error` 在联合上取不到）。
   */
  interface SystemFileFailure {
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
  interface SystemViewFileInput {
    path: string
    region?: SystemImageRegion
  }

  /** width、height 是原图的尺寸；sent 是实际给你看的尺寸，比原图（或 region）小就说明压过。 */
  interface SystemViewFileResult {
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
   * `version` 是 `read` 返回的版本号，给了就先核对文件现在还是这个版本，被改过就整批不写并给出当前版本；不给就不核对。
   * 想安全地改一个文件，就把 `read` 拿到的 `version` 原样带回来。
   * 单个文件最大 20 MB；更大的用 `run` 就地改（`sed -i`、`awk`）。超过 2 MB 的能写，但不留回滚版本。
   */
  interface SystemEditFileInput {
    path: string
    newText?: string
    restore?: string
    version?: string
  }

  /** 一个文件写完的结果，按 action 分辨是哪一种。 */
  type SystemEditFileResult = SystemEditWrittenResult | SystemEditRestoredResult

  /** 实际选中的命令语言。Windows 按 Git Bash、PowerShell 7、Windows PowerShell、CMD 的顺序挑选。 */
  type SystemShellKind = 'git-bash' | 'pwsh' | 'powershell' | 'cmd' | 'posix'

  /**
   * `success` 只看退出码为 0 且没有超时、没有被取消——命令自己失败不算这次调用失败。
   * `outputWindow` 一定给出；`outputContinuation` 只在宿主留了会话终端日志（`logPath`）时才有。
   */
  interface SystemCommandResult {
    command: string
    cwd: string
    exitCode: number | null
    signal: string | null
    stdout: string
    stderr: string
    logPath?: string
    durationMs: number
    timedOut: boolean
    aborted: boolean
    truncated: boolean
    capture?: SystemCommandOutputCapture
    shell?: SystemShellDescriptor
    cleanupIncomplete?: boolean
    ownership?: SystemProcessOwnership
    outputWindow?: SystemCommandOutputWindow
    outputContinuation?: SystemCommandOutputContinuation
    success: boolean
    confinement?: SystemProcessConfinementEvidence
    backgroundProcess?: SystemBackgroundProcessInfo
    verification: SystemVerificationSummary
  }

  /** `readiness` 为 `detected` 表示只发现了可执行文件，`ready` 表示已通过启动、版本与 UTF-8 自检。 */
  interface SystemShellDescriptor {
    kind: SystemShellKind
    name: string
    shellPath: string
    args: string[]
    readiness: 'detected' | 'ready'
    version: string | null
    recommendation: SystemShellRecommendation | null
  }

  /**
   * 一条后台任务：`id` 就是 run 返回的 `taskId`。
   * 终止命令三档（普通、强制、兜底）是给 run 直接执行的现成命令。
   */
  interface SystemBackgroundTaskRecord {
    exitCode?: number | null | undefined
    signal?: string | null | undefined
    finishedAt?: number
    cleanupIncomplete?: boolean
    id: string
    runId: string
    sessionId: string | null
    command: string
    cwd: string
    pid: number
    logPath: string | null
    ports: number[]
    reason: string | null
    terminateCommand: string | null
    forceTerminateCommand: string | null
    fallbackTerminateCommand: string | null
    requested: boolean
    autoStarted: boolean
    startedAt: number
    updatedAt: number
    status: SystemBackgroundTaskStatus
    /** 这条任务输出的末尾 4000 字符。 */
    recentOutput: string | null
    /** 交互式任务的控制台；不是交互式任务时缺席。 */
    console?: SystemConsoleSessionInfo
  }

  /** 一种磁盘文本编码，取值见常量表 `TextEncodings`。 */
  type TextEncoding = (typeof TextEncodings)[number]

  /** 图上的一块，按原图的像素算。 */
  interface SystemImageRegion {
    x: number
    y: number
    width: number
    height: number
  }

  /** previousVersion 是改动前留下的版本，能拿去 `restore`；新建的文件、或者原文件超过 2 MB（不留版本）时为 null。path 是解析后的绝对路径，它是符号链接时 target 是真正被写的那个文件。 */
  interface SystemEditWrittenResult {
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
  interface SystemEditRestoredResult {
    path: string
    target?: string
    action: 'restored'
    version: string
    previousVersion: string | null
    bytes: number
    totalChars: number
  }

  /** 各项字节数都按解码后的 UTF-8 文本算。 */
  interface SystemCommandOutputCapture {
    status: 'complete' | 'truncated' | 'failed'
    encoding: 'utf-8'
    totalBytes: number
    storedBytes: number
    omittedBytes: number
    decodeErrors: number
    error?: string
  }

  /** 子进程树由谁负责在父进程退出时清理，以及实际能不能做到。 */
  interface SystemProcessOwnership {
    backend: 'windows-job' | 'process-tree'
    parentDeathCleanup: boolean
    reason: string
  }

  /** 输出窗口留的是完整输出的末尾，不是开头。 */
  interface SystemCommandOutputWindow {
    retained: 'tail'
    /** false 表示完整输出更长；不影响已返回的这段末尾的真实性。 */
    complete: boolean
    /** 进程结束后窗口的末端就是完整输出的末端。 */
    endPreserved: true
  }

  /** 输出被截断时去哪里找完整内容：它在会话的终端日志里，不是一个能直接读的文件。 */
  interface SystemCommandOutputContinuation {
    kind: 'session-terminal-log'
    query: string
    tool: 'context:recall'
    args: { query: string; kind: 'terminal' }
  }

  /** 这次进程启动真实生效的约束，不是请求的那个。 */
  interface SystemProcessConfinementEvidence {
    mode: SystemProcessConfinementMode
    enforcement: SystemProcessConfinementEnforcement
    backend: SystemProcessConfinementBackend
    reason: string
    /** 受约束模式下真实批准的写根；`danger-full-access` 为空表示不采用 allowlist。 */
    writableRoots: string[]
  }

  /** 命令进了后台时的回执；`autoStarted` 表示不是调用方要的后台，是按命令本身判出来自动转的。 */
  interface SystemBackgroundProcessInfo {
    taskId: string | null
    sessionId: string | null
    pid: number | null
    logPath: string | null
    ports: number[]
    reason: string | null
    terminateCommand: string | null
    forceTerminateCommand: string | null
    fallbackTerminateCommand: string | null
    requested: boolean
    autoStarted: boolean
    /** 交互式任务的控制台：命令正在等用户输入，用户在聊天里的控制台卡片里打字。不是交互式任务时缺席。 */
    console?: SystemConsoleSessionInfo
    /** 把这个 taskId 交给 listTasks 就查得到这条任务的状态。 */
    statusContinuation?: {
      tool: 'listTasks'
      args: { taskId: string }
    }
  }

  /** 成功命令的 stdout / stderr 不会被当作 issue；失败、超时、取消时把输出末尾摘进 issues。 */
  interface SystemVerificationSummary {
    kind: 'build' | 'lint' | 'test' | 'typecheck' | 'unknown'
    status: 'aborted' | 'failed' | 'passed' | 'timed-out' | 'unknown'
    issues: string[]
  }

  /** 当前机器缺少推荐的 shell 时给用户的安装建议。 */
  interface SystemShellRecommendation {
    code: 'INSTALL_GIT_BASH'
    message: string
    url: string
  }

  /** 后台任务状态；进程是否真的还在，拿不准时报 `unknown` 而不是猜。 */
  type SystemBackgroundTaskStatus = 'running' | 'exited' | 'unknown'

  /** 一个交互式任务的控制台。 */
  interface SystemConsoleSessionInfo {
    /** 和 `backgroundProcess.taskId` 是同一个。 */
    taskId: string
    /** 管道下没有回显，只读 tty 的密码提示可能根本不出现。 */
    channel: SystemConsoleChannel
    /** 进程退出后为 false。 */
    acceptsInput: boolean
    /** 一句话说明：任务正在控制台里等用户，别再等这次调用的输出。 */
    note: string
  }

  /** 命令在操作系统进程层实际采用的文件副作用边界。 */
  type SystemProcessConfinementMode =
    | 'read-only'
    | 'workspace-write'
    | 'danger-full-access'

  /** 约束强度；`partial` 不等于 `full`，别把它当成绝对边界。 */
  type SystemProcessConfinementEnforcement = 'none' | 'partial' | 'full'

  /** 实际承担约束的后端：macOS 是 Seatbelt，Linux 是 bubblewrap，`host` 表示宿主注入的实现。 */
  type SystemProcessConfinementBackend =
    | 'none'
    | 'bubblewrap'
    | 'seatbelt'
    | 'host'

  /** 控制台后面接的是什么：真正的终端（宿主提供 PTY，有回显和终端尺寸）还是一根保持打开的 stdin 管道。 */
  type SystemConsoleChannel = 'pty' | 'pipe'

  /**
     * 读文本文件。
     * 每个文件从 offset 起最多 maxChars 个字符，两个都不传就一次读到上限；不切开代理对。路径是符号链接时读它指向的文件。
     * 图片要改用 view；PDF 与其他文档、其他二进制文件、目录、设备文件、超过 20 MB 的文件，都算这个文件失败。
     */
    export function read(input: SystemReadInput): Promise<SystemReadResult>

  /**
     * 看图片：整张图交给模型，效果和用户上传一样。
     * 只认 PNG、JPEG、GIF、WebP，单张最大 5 MB；PDF 与其他文档、文本文件、其他二进制文件、目录、设备文件、超过 20 MB 的文件，都算这个文件失败。
     */
    export function view(input: SystemViewInput): Promise<SystemViewResult>

  /**
     * 写文件。**优先用批量事务**：files 里放几个就改几个，整批是一次事务、一次审批、一个撤销点。
     * 要用户确认而被拒时是**整批不写**；等用户确认那段时间里文件被别人改过，同样整批不写。
     * 路径先解开符号链接：判重、审批、写入都按它指向的那个文件，链接本身不会被换成普通文件。路径是管道、设备、套接字，或文件有多个硬链接时不碰。
     * edits 写进去的文本跟着原文的换行风格走（CRLF 文件里的裸 LF 换成 CRLF），newText 整个写入原样写。新文本编不成原编码（孤立代理项、GB18030 表示不了的字符）就整批不写。
     * 写的过程中出错时前面的文件已经落盘，错误的 context.applied 里点名是哪几个，这时不能整批重发。
     */
    export function edit(input: SystemEditInput): Promise<SystemEditResult>

  /**
     * 跑一条命令。background 或 interactive 的命令立刻返回，之后用 listTasks 看它跑到哪了；interactive 一定跑在后台，它要开着等用户在控制台里输入。
     * 要确认的命令先问过用户才跑；危险命令每次都由用户亲自裁决。换个 shell 写也照样问——判定认全部五种 shell 的语法。
     * shell 只能填本机有的那几个，填了没有的在执行之前就被拒，一个进程都不起。
     */
    export function run(input: SystemRunInput): Promise<SystemRunResult>

  /**
     * 重新选定本机能用的 shell 并读一遍它的环境变量；Windows 上还会重读用户与系统环境变量写回本进程，没成功时结果的 reason 说明原因。
     * 只改本进程的环境，不动用户的 shell 配置文件，也不装任何东西：刷过一次还缺的命令就是没装。
     */
    export function refreshEnvironment(): Promise<SystemShellEnvironmentRefreshResult>

  /**
     * 列出 run 起在后台的任务，最新的在前。宿主按会话隔离时只看得到本会话起的那些。
     * 要停掉一条，用 run 执行它条目里的 terminateCommand 或 forceTerminateCommand，别自己拼 pid。
     */
    export function listTasks(input: SystemListTasksInput): Promise<SystemListTasksResult>
}
