/**
 * git 索引的路径清单：解析 `git … -z` 输出的路径，读回事务 metadata 里记下的 intent-to-add 路径。
 */
import { isArray, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

/** 查 intent-to-add 的 cached diff 视图：路径相对工作区且以 NUL 分隔，不认重命名。 */
export const IntentToAddProbeArgs = [
  'diff',
  '--cached',
  '--name-only',
  '-z',
  '--relative',
  '--no-renames',
] as const

/** `git … -z` 的路径输出：每条以 NUL 结尾，切开后去掉末尾空段。 */
export function splitNulTerminatedPaths(output: string): string[] {
  return output.split('\0').filter(Boolean)
}

/**
 * 两份 cached 视图只有 ITA 的可见性不同，差集就是当前仍为 intent-to-add 的路径。
 * 真实暂存的新文件（含空文件）在两边都显示，已提交未改文件在两边都不显示，均不得撤销。
 * 显式给出实验性可见性选项；Git 不再支持时让命令失败，不能把默认行为当作所有权证明。
 */
export function selectIntentToAddPaths(
  files: readonly string[],
  visible: string,
  invisible: string
): string[] {
  if ([visible, invisible].some((output) => output && !output.endsWith('\0')))
    throw new AppError('PROTOCOL', 'Git 索引路径输出缺少 NUL 边界')
  const shownWhenVisible = new Set(splitNulTerminatedPaths(visible))
  const shownWhenInvisible = new Set(splitNulTerminatedPaths(invisible))
  return files.filter((file) => shownWhenVisible.has(file) && !shownWhenInvisible.has(file))
}

/** 事务 metadata 里记下的 git 索引路径清单；它随事务状态持久化，读回时只认字符串项。 */
export function metadataPaths(value: unknown): string[] {
  return isArray(value) ? value.filter(isString) : []
}
