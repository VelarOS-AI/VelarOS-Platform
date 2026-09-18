/**
 * 常量表：跨入口共享的审批操作身份、模型能挑的 shell 种类词表，与 `velar:shell` 对外承诺的上限。
 * 不 import 任何东西，浏览器和渲染进程都能用（从 `@velaros-ai/velar/shell/contracts` 取）。
 */

/**
 * 危险命令审批的操作身份种类。`velar:shell` 的 run、演练沙箱里的 run、项目空间的 run 用同一个种类和同一套参数
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
export const ShellCommandKinds = Object.freeze(['git-bash', 'pwsh', 'powershell', 'cmd', 'posix'] as const)

/** @AgentView 一条命令可以挑的 shell 种类。Windows 按 Git Bash、PowerShell 7、Windows PowerShell、CMD 的顺序挑默认的那个。 */
export type ShellCommandKind = (typeof ShellCommandKinds)[number]

/**
 * `velar:shell` 对外承诺的上限。操作方法自己钳（超了按上限跑，钳而不拒），声明里的数字与这里一致由验收核对。
 * 宿主自己的缺省（不给超时用多久、不给条数列几条）不在这里，在宿主那一侧。
 */
export const ShellLimits = Object.freeze({
  /** run 的超时最多给多少毫秒。 */
  timeoutMs: 600_000,
  /** run 的 stdout、stderr 各最多返回多少字符。 */
  outputChars: 50_000,
  /** listTasks 一次最多列多少条。 */
  taskListItems: 100,
})
