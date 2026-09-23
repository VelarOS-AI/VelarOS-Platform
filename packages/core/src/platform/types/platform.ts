/**
 * 平台数据（可移植）：运行平台、shell 种类、命令启动规格、路径分隔符、目录符号链接类型、编辑器命令定义、后台启动参数。
 * 只放类型；带进程环境变量类型的选项在 `options.ts`，常量表在 `contract/constants.ts`。不 import 任何东西、不用 Node 专属类型，整个文件随 `./contracts` 入口出包。
 */

/** 运行平台，取值同 Node 的 `process.platform`。 */
export type RuntimePlatform =
  | 'aix'
  | 'android'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'cygwin'
  | 'netbsd'

/** shell 种类：Windows 按 Git Bash、PowerShell 7、Windows PowerShell、CMD 的顺序挑选，其他平台是 POSIX shell。 */
export type ShellKind = 'git-bash' | 'pwsh' | 'powershell' | 'cmd' | 'posix'

/** 可以直接 spawn 的启动规格：可执行文件与参数；Windows 上 CMD 要自己解析 `/c` 后面的字符串时置 windowsVerbatimArguments。 */
export interface CommandSpec {
  file: string
  args: string[]
  windowsVerbatimArguments?: boolean
}

/** 用哪个编辑器打开路径：macOS 按应用名，其他平台按命令。 */
export interface EditorCommandDefinition {
  darwinApplication?: string
  command?: string
}

/** 在后台启动一条 shell 命令并把输出追加进日志文件时要的参数。 */
export interface BackgroundShellLaunchOptions {
  command: string
  logPath: string
  pidMarker: string
  shellPath: string
}

/** 路径文本里的分隔符。 */
export type PathTextSeparator = '/' | '\\'

/** 目录符号链接的类型：Windows 用 junction，其他平台用 dir。 */
export type DirectorySymlinkType = 'dir' | 'junction'
