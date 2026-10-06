/** exec 入口的最小入参合同。 */
export interface NativeExecutionInput {
  /** 原样执行的 JavaScript ESM 源码。 */
  readonly code: string
}
