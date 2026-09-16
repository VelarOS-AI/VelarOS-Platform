/**
 * 常量表：`velaros` 命令行的约定值——输出信封的固定字段、错误码与退出码、本包读的环境变量。
 * 不 import 任何东西，随 `@velaros-ai/cli/contracts` 出包；自动化按这里的码判断结果，不按文字。
 */

/** 输出信封的固定字段：读取方按它认这份 JSON 是不是本命令行给的。 */
export const VelarosCliEnvelope = Object.freeze({
  /** 信封的结构版本；字段形状变了先升这里，旧版本的读取方据此拒收。 */
  schemaVersion: 1,
  /** 失败信封的 kind，固定不变；成功信封的 kind 是 `velaros.cli.<命名空间>.<子命令>`。 */
  errorKind: 'velaros.cli.error',
} as const)

/** 命令行自己会给出的错误码：第三方命名空间抛的异常一律收成 `EXECUTION_ERROR`。 */
export const VelarosCliErrorCodes = Object.freeze({
  /** 命令行第一段不是已注册的命名空间。 */
  unknownNamespace: 'UNKNOWN_NAMESPACE',
  /** 命名空间执行时抛了异常，收成这一档，原始文字放在 `message` 里。 */
  executionError: 'EXECUTION_ERROR',
  /** `velaros terminal` 找不到要启动的 Termel 可执行文件。 */
  termelNotInstalled: 'TERMEL_NOT_INSTALLED',
} as const)

/** 退出码：`velaros` 对外承诺的几档结局，脚本与 CI 按它分支。 */
export const VelarosCliExitCodes = Object.freeze({
  /** 正常结束。 */
  ok: 0,
  /** 执行失败：命名空间抛了异常。 */
  failure: 1,
  /** 用法错：未知的命名空间、参数不合法。 */
  usage: 2,
  /** 找不到要启动的命令，沿用 shell 的约定。 */
  commandNotFound: 127,
  /** 子进程被信号杀死时的退出码基数，加上信号号就是退出码（POSIX 惯例）。 */
  signalBase: 128,
} as const)

/** 本包读的环境变量：代码里冒出没登记的名字门禁会拦。 */
export const CliEnvironmentVariables = Object.freeze({
  termelCommand: {
    name: 'VELAROS_TERMEL_COMMAND',
    direction: 'input',
    description: '把 `velaros terminal` 要启动的命令换成别的可执行文件；不设时启动 `termel`。',
  },
} as const)
