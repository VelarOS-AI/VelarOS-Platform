/**
 * git 索引的路径清单：解析 `git … -z` 输出的路径，读回事务 metadata 里记下的 intent-to-add 路径。
 */
import { isArray, isString } from '@velaros-ai/core'

/** `git … -z` 的路径输出：每条以 NUL 结尾，切开后去掉末尾空段。 */
export function splitNulTerminatedPaths(output: string): string[] {
  return output.split('\0').filter(Boolean)
}

/** 事务 metadata 里记下的 git 索引路径清单；它随事务状态持久化，读回时只认字符串项。 */
export function metadataPaths(value: unknown): string[] {
  return isArray(value) ? value.filter(isString) : []
}
