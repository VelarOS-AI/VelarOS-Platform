/**
 * 平台数据（可移植）：shell 种类、运行平台、命令启动规格、路径分隔符、目录符号链接类型、编辑器命令定义、后台启动参数，以及本包读的环境变量表。
 * 不 import 任何东西、不用 Node 专属类型；整个文件就是 `./contracts` 入口，浏览器也能用。带进程环境变量类型的选项在 `options.ts`。
 */

// ── 平台与 shell ────────────────────────────────────────────────

/** 运行平台，取值同 Node 的 `process.platform`。 */
export type RuntimePlatform = 'aix' | 'android' | 'darwin' | 'freebsd' | 'haiku' | 'linux' | 'openbsd' | 'sunos' | 'win32' | 'cygwin' | 'netbsd'

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

// ── 环境变量 ────────────────────────────────────────────────────

/** 本包读的全部环境变量：宿主设什么、本包读什么，都在这张表里，别处不许再冒出新的变量名。 */
const PlatformEnvironmentVariables = Object.freeze({
  shellPath: {
    name: 'VELAROS_SHELL_PATH',
    direction: 'input',
    description: 'Windows 上指定用哪个 shell 的完整路径；子进程环境里也会写上实际使用的 shell 路径。',
  },
  gitBash: {
    name: 'VELAROS_GIT_BASH',
    direction: 'input',
    description: 'Windows 上 Git Bash 的 bash.exe 路径，优先于自动查找。',
  },
  sharedDataRoot: {
    name: 'VELAROS_SHARED_DATA_ROOT',
    direction: 'input',
    description: 'VelarOS 产品家族共享数据的根目录，覆盖按平台算出的默认位置。',
  },
} as const)

/** 环境变量表里的一项。 */
type PlatformEnvironmentVariable = (typeof PlatformEnvironmentVariables)[keyof typeof PlatformEnvironmentVariables]

export { PlatformEnvironmentVariables }
export type { PlatformEnvironmentVariable }
