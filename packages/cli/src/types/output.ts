/**
 * 输出层的工作类型（包内用，不出包）：造成功信封要的那几样东西。
 * 失败信封的入参就是错误本身，不需要再摆一个形状。
 */

/** 造一条成功结果要的东西：信封的字段加上「打什么文本」的两种选择。 */
export interface VelarosCliSuccessInput {
  /** 哪个命名空间给的；根帮助是 `root`。 */
  namespace: string
  /** 哪个子命令给的。 */
  command: string
  /** 命令执行时的工作目录。 */
  cwd: string
  /** 这次执行花了多少毫秒。 */
  durationMs: number
  /** 子命令自己的结果，原样进信封。 */
  result: unknown
  /** 命令行上带没带 `--json`：带了就打整个信封，没带就打下面的文本。 */
  json: boolean
  /** 不带 `--json` 时要打的文本；不给时打 `result` 的格式化 JSON。 */
  text?: string
  /** 执行成功但结论为否时的退出码（例如产品注入的探针）；不给就是 0。 */
  exitCode?: number
}
