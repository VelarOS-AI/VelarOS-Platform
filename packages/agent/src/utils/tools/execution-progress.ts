// ExecutionProgress 用到的纯函数（不碰实例状态）。
import { isArray, isPlainObject, isString,Log } from '@velaros-ai/core'

/** 把进度表裁到 128 条以内，最早进来的先丢。 */
export function trim<T>(map: Map<string, T>): void {
  while (map.size > 128) map.delete(map.keys().next().value!)
}

/** 从工具入参里挑出 path / resourceId / url 这几类资源标识，最多 100 个、最深 4 层。 */
export function resourceKeys(args: Record<string, unknown>): string[] {
  const paths = new Set<string>()
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || paths.size >= 100) return
    if (isArray(value)) {
      value.slice(0, 100).forEach((item) => visit(item, depth + 1))
      return
    }
    if (!isPlainObject(value)) return
    for (const [key, nested] of Object.entries(value)) {
      if (['path', 'resourceId', 'url'].includes(key) && isString(nested))
        paths.add(nested)
      else if (key === 'paths' && isArray(nested))
        nested.slice(0, 100).forEach((path) => {
          if (isString(path)) paths.add(path)
        })
      else if (['edits', 'operations', 'files'].includes(key)) visit(nested, depth + 1)
    }
  }
  visit(args, 0)
  return [...paths].sort()
}

// 仅用于有界的恢复建议去重；不作为文件版本、权限或写入幂等依据。
/** 给一条记录算指纹：忽略时长与时间戳这些每次都变的字段，序列化不了就返回 undefined。 */
export function fingerprint(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value, (key, item) =>
      ['durationMs', 'startedAt', 'finishedAt', 'timestamp'].includes(key) ? undefined : item
    )
    if (!text) return undefined
    let hash = 2166136261
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
    return `${text.length}:${hash >>> 0}`
  } catch { Log.tag('ContextProjection').debug('跳过无法解析或序列化的记录，保持原文与召回入口')

    return undefined
  }
}
