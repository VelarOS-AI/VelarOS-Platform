/**
 * 常量表：跨工具共享的审批操作身份，与模型能挑的 shell 种类词表。不 import 任何东西，浏览器和渲染进程都能用（从 `@velaros-ai/shell-command/contracts` 取）。
 */

/**
 * 危险命令审批的操作身份种类。system:run、project:run、演练沙箱里的 run 用同一个种类和同一套参数（去掉首尾空白的命令、工作目录、前台还是后台），
 * 用户在一个工具里拒绝过的命令，换个工具入口不会被再问一次、也绕不过去。
 */
export const ShellCommandOperationKind = 'shell-command' as const

/**
 * 模型能为一条命令挑的 shell 种类，封闭词表，全仓唯一权威。system:run、project:run、project:sandbox 的 `shell` 字段枚举都取它，
 * 所以同一个模型在任何机器上看到的取值都一样；本机真正有哪几个、哪个是默认由环境报告给出，填了没有的那个由宿主在执行之前拒绝。
 *
 * 判定（只读与危险）不分种类：它同时认这五种语法（POSIX/Git Bash 的 `rm -rf`、cmd 的 `rd /s`、PowerShell 的 `Remove-Item -Recurse`），
 * 是并集不是按种类挑一套，所以挑哪一种都不会让判定变松。往这张表里加新种类的规矩见 `utils/command-policy.ts` 的开头。
 */
export const ShellCommandKinds = Object.freeze(['git-bash', 'pwsh', 'powershell', 'cmd', 'posix'] as const)

/** 一条命令可以挑的 shell 种类。 */
export type ShellCommandKind = (typeof ShellCommandKinds)[number]
