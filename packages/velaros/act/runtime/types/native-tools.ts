/** Shell 与 Node 入口使用同一份最小入参合同。 */
export interface NativeExecutionInput {
  /** 原样执行的命令或 JavaScript ESM 源码。 */
  readonly code: string
}
