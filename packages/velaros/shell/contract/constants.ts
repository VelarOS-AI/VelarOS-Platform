/**
 * 常量表：跨入口共享的审批操作身份、模型能挑的 shell 种类词表、`velaros:shell` 对外承诺的上限，
 * 以及本机宿主（`./local` 入口）的错误码与它读写的环境变量。
 * 不 import 任何东西，浏览器和渲染进程都能用（从 `@velaros-ai/velaros/shell/contracts` 取）。
 */

/**
 * 危险命令审批的操作身份种类。`velaros:shell` 的 run、演练沙箱里的 run、项目空间的 run 用同一个种类和同一套参数
 * （去掉首尾空白的命令、工作目录、前台还是后台），用户在一个入口拒绝过的命令，换个入口不会被再问一次、也绕不过去。
 */
export const ShellCommandOperationKind = 'shell-command' as const

/**
 * 模型能为一条命令挑的 shell 种类，封闭词表，全仓唯一权威。所有跑命令的入口的 `shell` 字段都取它，
 * 所以同一个模型在任何机器上看到的取值都一样；本机真正有哪几个、哪个是默认由环境报告给出，填了没有的那个由宿主在执行之前拒绝。
 *
 * 判定（只读与危险）不分种类：它同时认这五种语法（POSIX/Git Bash 的 `rm -rf`、cmd 的 `rd /s`、PowerShell 的 `Remove-Item -Recurse`），
 * 是并集不是按种类挑一套，所以挑哪一种都不会让判定变松。往这张表里加新种类的规矩见 `utils/command-policy.ts` 的开头。
 */
export const ShellCommandKinds = Object.freeze([
  'git-bash',
  'pwsh',
  'powershell',
  'cmd',
  'posix',
] as const)

/** @AgentView 一条命令可以挑的 shell 种类。Windows 按 Git Bash、PowerShell 7、Windows PowerShell、CMD 的顺序挑默认的那个。 */
export type ShellCommandKind = (typeof ShellCommandKinds)[number]

/**
 * `velaros:shell` 对外承诺的上限。操作方法自己钳（超了按上限跑，钳而不拒），声明里的数字与这里一致由验收核对。
 * 宿主自己的缺省（不给超时用多久）不在这里，在宿主那一侧。
 */
export const ShellLimits = Object.freeze({
  /** 命令诊断摘录保留的 stdout 或 stderr 字符数；超出时保留首尾并明确省略。 */
  diagnosticChars: 1600,
  /** run 的超时最多给多少毫秒。 */
  timeoutMs: 600_000,
  /**
   * 一条命令的 stdout、stderr，与一条后台任务的输出，各最多留多少字符。**只为守住内存**：完整输出由程序筛选，
   * 有界诊断另外交付，所以这里按「宿主与隔离进程装得下」算；超出只留末尾（失败现场在尾部）。
   */
  outputChars: 5_000_000,
})

/**
 * 本机宿主对外承诺的专属错误码，调用方按码分支，码本身是契约的一部分，不得改名。
 * 失败关闭是默认姿态：拿不到安全的执行条件时拒绝执行，不降级成裸进程、不静默跳过。
 * 其余失败用通用 `AppError` 码：挑了本机没有的 shell 是 `VALIDATION`，后台任务不属于当前会话是 `PERMISSION`，
 * 任务或进程不存在是 `NOT_FOUND`，平台不支持或平台命令本身失败是 `PLATFORM`。
 */
export const ShellErrorCodes = Object.freeze({
  /** 找不到任何能用的命令 shell。Windows 上建议装 Git for Windows 后刷新命令环境。 */
  shellUnavailable: 'SHELL_UNAVAILABLE',
  /** 要受约束地跑命令，这台宿主却没有可用的约束后端：拒绝执行，不退回裸进程。 */
  processConfinementUnavailable: 'SHELL_CONFINEMENT_UNAVAILABLE',
} as const)

/**
 * 本机宿主读写的全部环境变量。环境变量也是注入：宿主设什么、本单元读什么，都在这张表里，别处不许再冒出新的变量名。
 *
 * - `input`：宿主可以设、本单元读取的配置。
 * - `marker`：本单元写进子进程环境的标记，子进程里的脚本可以读，宿主不要设。
 */
export const ShellEnvironmentVariables = Object.freeze({
  shellPath: {
    name: 'VELAROS_SHELL_PATH',
    direction: 'input',
    description:
      'Windows 上指定用哪个 shell 的完整路径；子进程环境里也会写上实际使用的 shell 路径。',
  },
  gitBash: {
    name: 'VELAROS_GIT_BASH',
    direction: 'input',
    description: 'Windows 上 Git Bash 的 bash.exe 路径，优先于自动查找。',
  },
  processHost: {
    name: 'VELAROS_PROCESS_HOST',
    direction: 'input',
    description: 'Windows 原生进程宿主的路径，优先于随包发布的那一份。',
  },
  shellKind: {
    name: 'VELAROS_SHELL_KIND',
    direction: 'marker',
    description: '子进程所在 shell 的种类。',
  },
  shellReadiness: {
    name: 'VELAROS_SHELL_READINESS',
    direction: 'marker',
    description: 'shell 只是检测到（detected）还是已经通过自检（ready）。',
  },
  shellVersion: {
    name: 'VELAROS_SHELL_VERSION',
    direction: 'marker',
    description: '自检读到的 shell 版本。',
  },
} as const)
