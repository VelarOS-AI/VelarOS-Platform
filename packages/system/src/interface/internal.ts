/**
 * 包内部的类接口：每个内部类实现其中一个，接口写清楚这个类负责什么、每个方法做什么。这些接口不出包。
 * 带回调或注入对象的内部选项也在这里：它们传的是行为，不是数据。
 */

import type { ChildProcess } from 'node:child_process'

import type { RefreshedWindowsEnvironment, ResolvedSystemShell, SystemProcessCompletion, SystemProcessConfinementPolicy, SystemShellProbeResult } from '../contract/commands.js'
import type { SystemViewInput, SystemViewResult } from '../contract/files.js'
import type { SystemFileSnapshot } from '../contract/files.js'
import type { SystemEditInput, SystemEditResult, SystemReadInput, SystemReadResult } from '../contract/files.js'
import type { ShellCommandSpecOptions } from '../contract/platform.js'
import type { SystemBackgroundTaskQueryOptions, SystemBackgroundTaskRecord, SystemBackgroundTaskTerminateRequest, SystemBackgroundTaskTerminateResult, SystemCommandResult, SystemEnvironmentCommandAvailability, SystemGlobalSearchOptions, SystemGlobalSearchResult, SystemRunCommandOptions } from '../contract/system.js'

import type { SystemPlatformCompatibilityApi } from './provides.js'
import type { SystemToolContext } from './requires.js'
import type { SystemProcessConfinementProvider } from './requires.js'

// ── 命令执行 ────────────────────────────────────────────────────

/**
 * 命令执行器：把一条命令变成受管子进程跑起来。前台等它结束并采集输出；后台登记成后台任务，之后可查、可停。
 *
 * 实现是 `SystemCommandRunner`，由本地内核创建并持有。它启动过的后台进程归它管，内核释放时一并停掉。
 */
export interface SystemCommandRunnerApi {
  /**
   * 跑一条命令，返回完整结果。
   *
   * 链路：选 shell（给了 nativeCommand 就按原生 argv 执行）→ 加进程约束 → Windows 上包进原生进程宿主 → 启动受管子进程。
   * 前台：有界采集 stdout 与 stderr，超时或取消后在期限内收敛，失败时把输出末尾摘进 verification。
   * 后台（options.background）：进程拉起后登记成后台任务就返回，结果里带任务 id 和终止命令。
   * 命令自己失败（非零退出、超时、取消）不抛错，如实写进结果；找不到能用的 shell、约束后端缺失、进程拉不起来才抛错。
   * @param command 命令文本；给了 options.nativeCommand 时只用来展示
   * @param cwd 已经解析好的绝对工作目录
   */
  run(command: string, cwd: string, options: SystemRunCommandOptions, abortSignal?: AbortSignal): Promise<SystemCommandResult>
  /** 列出后台任务：可按任务 id、会话、命令过滤词、只看运行中来筛，最多 limit 条（默认 50）；状态按受管进程此刻的情况给出。 */
  listTasks(options?: SystemBackgroundTaskQueryOptions): SystemBackgroundTaskRecord[]
  /**
   * 终止一个后台任务，返回终止前后的状态。
   *
   * 先核对任务存在、属于请求里的会话、进程确实是自己启动的那个，再发信号（force 时直接 SIGKILL）并等它在期限内退出。
   * 进程已经不在了不算失败，结果里如实说明；核对不过或期限内没退出时抛错。
   */
  terminateTask(request: SystemBackgroundTaskTerminateRequest): Promise<SystemBackgroundTaskTerminateResult>
  /** 停掉这个执行器启动过、还没退出的全部后台进程。 */
  dispose(): Promise<void>
}

/** 命令执行器的构造参数，由本地内核给。 */
export interface SystemCommandRunnerOptions {
  /** 命令跑在哪个平台上。 */
  platform: NodeJS.Platform
  /** 按这个平台算 shell 参数、终止命令、要不要独立进程组。 */
  platformTools: SystemPlatformCompatibilityApi
  /** 进程约束策略：模式、工作区根、额外写根、是否断网。 */
  confinement: SystemProcessConfinementPolicy
  /** 宿主注入的约束后端；没有内置后端的平台（Windows）靠它，缺了就在受约束模式下失败。 */
  confinementProvider?: SystemProcessConfinementProvider
  /** 选 shell 用。 */
  shells: SystemShellResolverApi
  /** 登记和管理子进程用。 */
  processes: SystemProcessManagerApi
}

// ── 受管子进程 ──────────────────────────────────────────────────

/**
 * 受管子进程登记表：本包启动的每个子进程都在这里登记，从启动、退出、管道排空到有界终止都有人收尾。
 *
 * 实现是 `SystemProcessManager`，整个进程只有一份（`systemProcessManager`），不出包。
 * 已结束的进程保留最多 512 条回执，供后台任务查状态和核对 pid 身份。
 */
export interface SystemProcessManagerApi {
  /**
   * 接管一个刚 spawn 出来的子进程并登记。
   *
   * 之后的超时、取消、退出后的管道排空都有期限：超时或取消先发 SIGTERM，宽限期后补 SIGKILL，终止期限到了还没收尾就标 cleanupIncomplete。
   * POSIX 上直接子进程退出后，会顺手杀掉仍然存活的整个进程组。
   */
  manage(child: ChildProcess, options?: SystemProcessLifecycleOptions): ManagedSystemProcess
  /** 按 pid 找本包登记过的受管进程；没登记过返回 undefined。 */
  find(pid: number): Optional<ManagedSystemProcess>
  /**
   * 取一个 pid 的身份标记，防止 pid 被系统复用后误杀别的进程。
   *
   * 本包登记过的进程返回它的受管身份；其他进程读系统记录的启动时间（Windows 用 PowerShell，其他平台用 ps）。
   * 读不到返回 null，表示身份未知；未知不等于可以动它。
   */
  captureIdentity(pid: number, platform?: NodeJS.Platform): Promise<Nullable<string>>
  /**
   * 判断一个 pid 此刻是不是当初那个进程在跑。
   *
   * 身份对得上且没退出为 running；身份变了或已退出为 exited；没有身份、或根进程已退出而收尾回执还没到，一律 unknown，不猜。
   */
  resolveStatus(pid: number, expectedIdentity: Nullable<string>, platform?: NodeJS.Platform): Promise<'running' | 'exited' | 'unknown'>
  /** 应用退出前调用：给所有还没结束的受管进程发 SIGKILL 并等它们收尾。父进程崩溃时的兜底由 Windows 原生宿主另外保证。 */
  stopAll(): Promise<void>
}

/** 一个受管子进程，由 `SystemProcessManagerApi.manage` 返回。 */
export interface ManagedSystemProcess {
  /** 受管身份，形如 `managed:<uuid>`；后台任务靠它确认进程还是不是自己启动的那个。 */
  identity: string
  /** 被管理的子进程本身。 */
  child: ChildProcess
  /** 进程彻底收尾时兑现，只兑现一次：退出且管道排空，或者期限到了放弃等待。 */
  completion: Promise<SystemProcessCompletion>
  /** 收尾结果；还没收尾时是 null。 */
  result: Nullable<SystemProcessCompletion>
  /** 直接子进程是否已经退出。后代可能还占着管道，这时 result 仍可能是 null。 */
  exited: boolean
  /**
   * 请求终止并等结果：先发给定信号（默认 SIGTERM），宽限期后补 SIGKILL。
   * 返回 true 表示确认已退出且收尾完整；已经退出的进程直接按收尾结果回答。
   */
  stop: (signal?: NodeJS.Signals) => Promise<boolean>
}

/** 受管进程向登记表回报的两个时刻，由登记表在创建受管进程时给。 */
export interface SystemManagedProcessHooks {
  /** 子进程有了 pid（创建时或 spawn 事件时）就回报一次，登记表据此按 pid 登记。 */
  track: (managed: ManagedSystemProcess) => void
  /** 进程收尾后回报，登记表据此清理过多的结束回执。 */
  onFinished: () => void
}

/** 接管子进程时的收尾策略。 */
export interface SystemProcessLifecycleOptions {
  /** 按哪个平台终止进程树；缺省是当前进程的平台。 */
  platform?: NodeJS.Platform
  /** 超时毫秒数，到了就开始终止；不给就不限时。 */
  timeoutMs?: number
  /** 取消信号，触发后开始终止。 */
  abortSignal?: AbortSignal
  /** 直接子进程退出后，等后代放开管道的最长毫秒数，默认 1000。 */
  drainTimeoutMs?: number
  /** 发出终止信号后，补发 SIGKILL 之前的宽限毫秒数，默认 500。 */
  terminateGraceMs?: number
  /** 从开始终止到放弃等待、按 cleanupIncomplete 收尾的最长毫秒数，默认 5000。 */
  terminationDeadlineMs?: number
  /** 自定义终止方式；不给就按平台终止整棵进程树。 */
  terminate?: (signal: NodeJS.Signals) => Promise<boolean>
}

/** 找 Windows 原生进程宿主、把命令包进宿主时的选项。 */
export interface SystemProcessHostOptions {
  /** 按哪个平台判断；只有 Windows 才用原生宿主。 */
  platform?: NodeJS.Platform
  /** 读 VELAROS_PROCESS_HOST 用的环境变量。 */
  env?: NodeJS.ProcessEnv
  /** 显式指定原生宿主的路径，优先于环境变量和默认位置。 */
  hostPath?: string
  /** 子进程要跟随的父进程 pid；缺省是当前进程。 */
  parentPid?: number
  /** 判断文件存在的方式；缺省用真实文件系统，测试时可以换。 */
  isFile?: (path: string) => boolean
}

/** 给命令加进程约束时的选项。 */
export interface SystemProcessConfinementBuildOptions {
  /** 按哪个平台选约束后端：macOS 用 sandbox-exec，Linux 用 bubblewrap。 */
  platform?: NodeJS.Platform
  /** 找约束工具可执行文件用的环境变量。 */
  env?: NodeJS.ProcessEnv
  /** 宿主注入的约束后端，给了就优先用它。 */
  provider?: SystemProcessConfinementProvider
  /** sandbox-exec 的路径，缺省是系统自带的那个。 */
  sandboxExecPath?: string
  /** sandbox-exec 是否可用；缺省按路径探测。 */
  sandboxExecAvailable?: boolean
  /** bubblewrap 的路径，缺省在 PATH 里找。 */
  bubblewrapPath?: string
  /** bubblewrap 是否可用；缺省按路径探测。 */
  bubblewrapAvailable?: boolean
  /** 临时目录，约束里一律允许写它。 */
  tempDir?: string
}

// ── 输出解码 ────────────────────────────────────────────────────

/**
 * 子进程输出的 UTF-8 解码器：分块写入也不会把多字节字符切坏，同时统计非法字节序列；输出里本来就有的替换字符 U+FFFD 不算错。
 *
 * 实现是 `SystemOutputDecoder`，stdout 和 stderr 各用一个。
 */
export interface SystemOutputDecoderApi {
  /** 到目前为止遇到的非法 UTF-8 序列个数。 */
  readonly decodeErrors: number
  /** 写入一块原始输出，返回这块里已经能完整解码的文本；被切断的字符留到下一块再吐。 */
  write(chunk: Buffer): string
  /** 输出结束时调用，吐出剩下的文本；末尾残缺的字符计一次错误。重复调用返回空串。 */
  end(): string
}

// ── shell 选择 ────────────────────────────────────────────

/**
 * shell 选择与自检：在本机找能用的 shell、试跑确认它真能工作、按它的查找规则判断命令在不在、在 Windows 上刷新环境变量。
 *
 * 实现是 `SystemShellResolver`，整个进程只有一份（`systemShellResolver`），不出包。
 * Windows 上按 Git Bash、PowerShell 7、Windows PowerShell、CMD 的顺序找；其他平台用 SHELL。
 */
export interface SystemShellResolverApi {
  /** 只查文件、不试跑，同步返回第一个候选 shell，给界面展示用。一个都找不到时抛 SystemShellUnavailableError。 */
  resolve(options?: ResolveSystemShellOptions): ResolvedSystemShell
  /**
   * 执行命令前用这个：按候选顺序逐个试跑一小段 UTF-8 输出，返回第一个真能工作的 shell，环境变量里标上 ready 和版本。
   * 只有这个自检会换下一个候选；用户的命令只执行一次，不会因为失败换 shell 重跑。全部失败时抛 SystemShellUnavailableError，附上每个候选的原因。
   */
  resolveReady(options?: ResolveSystemShellOptions): Promise<ResolvedSystemShell>
  /** 按这个 shell 自己的查找规则判断一个命令在不在、在哪、是什么（内建命令、批处理、原生程序或脚本）。 */
  resolveCommand(name: string, shell: ResolvedSystemShell): Promise<SystemEnvironmentCommandAvailability>
  /**
   * Windows 上重新读取用户和系统环境变量（用户装完软件不用重启应用），合并 PATH 并展开 %VAR%，返回新环境和它的指纹 revision。
   * 其他平台原样返回；读取失败时 refreshed 为 false 并给出原因。返回的环境里去掉了本包自己写的 VELAROS_SHELL_* 标记。
   */
  refreshWindowsEnvironment(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): Promise<RefreshedWindowsEnvironment>
}

/** 选 shell 时的选项；平台、环境变量、指定的 shell 路径与种类见继承的 `ShellCommandSpecOptions`。 */
export interface ResolveSystemShellOptions extends ShellCommandSpecOptions {
  /** 判断文件存在的方式；缺省用真实文件系统，测试时可以换成假的。 */
  isFile?: (path: string) => boolean
  /** 每个候选试跑的超时毫秒数，默认 2500。 */
  timeoutMs?: number
  /** 自定义就绪自检；缺省让 shell 打印带中文的标记和版本。 */
  probe?: (shell: ResolvedSystemShell, timeoutMs: number) => Promise<SystemShellProbeResult>
}

// ── 文件与搜索 ──────────────────────────────────────────────────

/**
 * 三个文件操作：读文本、看图片与 PDF、写。`system:read`、`system:view`、`system:edit` 各调一个方法；列目录和搜文本由 `system:run` 用系统命令做。
 *
 * 实现是 `SystemFileOperations`，整个进程只有一份（`systemFileOperations`）。路径都按用户输入规整：`~` 展开到家目录，相对路径相对宿主给 system:run 的默认目录（宿主没给就相对家目录）。读凭证文件（私钥、云凭证、口令库）前先向用户确认。
 * 位置一律按字符算，没有行的概念。读写都保留原文件的编码（UTF-8、带 BOM、UTF-16）；写先写临时文件再原子替换；写系统敏感路径前先向用户确认，被拒绝就不动。
 */
export interface SystemFileOperationsApi {
  /**
   * 读文本文件，files 里每项一个，一个文件就一项，一批最多 20 项；返回与 files 一一对应的 files。
   * 每个文件按字符取一段：从 offset 起最多 maxChars 个（默认也是上限 20 万，尽量一次读完），返回这段的原文、它的 range 和内容的版本号，hasMore 时把 range.end 当下一次的 offset；不切开代理对。
   * 一次调用总共最多返回 20 万字符，按顺序分给各文件，分完的文件只带位置不带内容，结果的 note 说明从第几个起。
   * 给 version 就读改动前留下的那个版本，用来召回旧状态；版本只在本次运行的内存里留最近几份，找不到算这个文件失败。
   * 图片算失败并指向 view，PDF 算失败并说明文档不在这里读；其他二进制文件、目录、设备文件、超过 20 MB 的文件也算失败。
   * 某个文件失败只把它那一项换成失败条目，其余文件照常返回；全部失败时整个调用报错。
   */
  read(input: SystemReadInput, ctx: SystemToolContext): Promise<SystemReadResult>
  /**
   * 看图片，files 每项一个，一个文件就一项，一批最多 10 项；返回与 files 一一对应的 files，每张图整张作为模型可见的内容块按同样的顺序放在 modelContent 里交给模型，效果和用户上传一样，每块前面一行文字说明是哪个文件。
   * 只认模型本来就认得的 PNG、JPEG、GIF、WebP，没有字符上限，只有 5 MB 的字节上限，超过算失败让调用方先缩小。
   * PDF 和其他文档不在这里看；文本文件、其他二进制文件、目录、设备文件、超过 20 MB 的文件算失败。某个文件失败只把它那一项换成失败条目，全部失败时整个调用报错。
   */
  view(input: SystemViewInput, ctx: SystemToolContext): Promise<SystemViewResult>
  /**
   * 写文件，files 每项一个，一个文件就一项，一批最多 20 项；返回与 files 一一对应的 files。每项三种改法只用一种：
   * 只给 newText：把它当整个文件写进去，不存在就新建（连同上级目录），存在就覆盖。
   * 给 edits：在 read 读到的范围里改这几处（一次最多 50 处），每处在自己的 range 里改：给 oldText 就只换这段里唯一的那一处，不给就把整段换成 newText，空段就是插入。
   * 每项可以带 read 返回的 version：给了就先核对文件现在还是这个版本，被改过就整批不写，问题里给出当前版本。
   * 一批全成或全不成：先把所有文件所有改动在改动前的原文上定下来，再逐个向用户确认敏感路径，最后按顺序写；定不下来或被拒就整批不写，
   * 抛出的错误 cause.details 里列出每个问题（第几个文件、第几处、原因；多处匹配带锚点，重叠标明另一处），context.executionOutcome 是 not-applied，调用方可以只改出问题的那一处再来一次。
   * 匹配只在各自的 range 里做，不在整个文件里找。
   * 只给 restore：把文件回到那个版本；回滚前的内容也留成一个版本，回滚本身能再回滚。
   * 每次改动前把原内容留成一个版本，结果里给出新版本号和改动前的版本号；改了几处的结果还返回每处新文本前后各 200 字符的小段，盖住所有改动那段不超过 2 万字符时整段也给，不用再读一遍确认。
   * 自动适配文件的换行风格，沿用原编码。写到一半出错原样报错，不标 not-applied，已写的文件在 context.applied 里点名。
   */
  edit(input: SystemEditInput, ctx: SystemToolContext): Promise<SystemEditResult>
}

/**
 * 文件版本历史：每次改动前把原内容留一份，供召回旧状态和回滚。只在内存里，每个文件留最近 10 份，单份不超过 2 MB，总量不超过 64 MB，超了从最早的删起。
 *
 * 实现是 `SystemFileHistory`，文件操作持有一份。
 */
export interface SystemFileHistoryApi {
  /** 留下一个文件此刻的原始字节，返回它的版本号（内容哈希）；同样的内容再留一次不重复占地方。太大留不下时返回 null。 */
  remember(path: string, buffer: Buffer): Nullable<string>
  /** 取某个文件留下的某个版本；没留过或已经被挤掉时返回 null。 */
  recall(path: string, version: string): Nullable<SystemFileSnapshot>
}

/**
 * 全局搜索：在一棵目录树里按路径名或按文件内容找东西，是本地内核 `globalSearch` 的实现，给宿主自己的界面用。
 *
 * 实现是 `SystemGlobalSearch`，由本地内核持有。遍历按名字排序、不跟随符号链接；
 * 跳过隐藏项、依赖和构建目录、gitignore 忽略的条目、macOS 受隐私保护的目录，includeHidden 和 unrestricted 可以放开。
 */
export interface SystemGlobalSearchApi {
  /**
   * 在 rootPath 下搜索。
   * mode 为 paths（默认）时按相对路径匹配（contains、exact 或 fuzzy），可按扩展名和条目类型过滤；
   * mode 为 content 时逐行搜文件内容（字面或正则），跳过大于 1MB 或读不出文本的文件，每个文件最多 maxResultsPerFile 条（默认 5）。
   * 找够 limit 条（默认 60）就停并标 truncated，最深 maxDepth 层（默认 6）。根目录不存在时报 NOT_FOUND。
   */
  search(rootPath: string, options: SystemGlobalSearchOptions, abortSignal?: AbortSignal): Promise<SystemGlobalSearchResult>
}

/**
 * 搜索可见性：遍历时某个条目要不要跳过。实现是 `GitIgnoreSystemSearchPolicy`，全局搜索每次遍历按搜索根新建一个。
 *
 * 在 git 仓库里按从仓库根到条目所在目录的各级 .gitignore 判断；不在仓库里、搜索根本身就被忽略、或者 unrestricted 时，什么都不跳过。
 */
export interface SystemSearchIgnorePolicy {
  /** 这个条目是否被忽略、应该跳过；搜索根本身永远不跳过。 */
  shouldSkip(candidatePath: string, isDirectory: boolean): Promise<boolean>
}
