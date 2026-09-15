/**
 * 常量表：跨工具共享的审批操作身份。不 import 任何东西，浏览器和渲染进程都能用（从 `@velaros-ai/shell-command/contracts` 取）。
 */

/**
 * 危险命令审批的操作身份种类。system:run、project:run、演练沙箱里的 run 用同一个种类和同一套参数（去掉首尾空白的命令、工作目录、前台还是后台），
 * 用户在一个工具里拒绝过的命令，换个工具入口不会被再问一次、也绕不过去。
 */
export const ShellCommandOperationKind = 'shell-command' as const
