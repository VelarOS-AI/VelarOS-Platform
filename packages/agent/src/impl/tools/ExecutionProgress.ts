import { isArray, isEmpty, isPlainObject, isString,Log } from '@velaros-ai/core'

/**
 * 执行进展账本：按「资源 + 失败条件」认出没有新证据的重试。
 *
 * 由 `KernelToolLoopGuard` 在循环里持有一份，随那条循环存活；账目只在内存里，按插入序裁到 128 条。
 * 它只给恢复建议，从不阻断调用——判不出结论时返回 undefined，正常探索照跑。
 */
export interface ExecutionProgressApi {
  /**
   * 记一次工具结果。
   *
   * 成功且产出与上次不同（指纹变了）时，把同一资源上的失败计数清掉——模型看到了新状态，重试不算空转。
   * 失败时按「工具 + 资源 + 失败条件 + 版本」累计；同一条连续到第 3 次仍是同样的失败，返回一句给模型看的
   * 换路建议，否则返回 undefined。
   */
  record(input: {
    toolName: string
    args: Record<string, unknown>
    error?: string
    result: unknown
  }): string | undefined
}

export class ExecutionProgress implements ExecutionProgressApi {
  private readonly episodes = new Map<string, number>()
  private readonly observations = new Map<string, string>()

  public record(input: {
    toolName: string
    args: Record<string, unknown>
    error?: string
    result: unknown
  }): string | undefined {
    const resources = resourceKeys(input.args)
    const scope = !isEmpty(resources)
      ? JSON.stringify(resources)
      : fingerprint([input.toolName, input.args])
    if (!scope) return undefined
    if (!input.error) {
      const evidence = fingerprint(input.result)
      const key = fingerprint([input.toolName, input.args])
      if (!evidence || !key) return undefined
      if (this.observations.get(key) !== evidence) {
        this.observations.set(key, evidence)
        for (const episode of this.episodes.keys()) {
          const targets = JSON.parse(episode) as [string, string, string]
          if (targets[1] === scope) this.episodes.delete(episode)
        }
      }
      trim(this.observations)
      return undefined
    }
    const record =
      input.result && isPlainObject(input.result)
        ? (input.result)
        : {}
    const details =
      record.details && isPlainObject(record.details)
        ? (record.details)
        : {}
    const condition = String(details.reason ?? record.code ?? record.error ?? input.error)
    const revision = JSON.stringify(
      details.actualRevision ??
        details.currentRevision ??
        input.args.baseRevision ??
        input.args.baseRevisions ??
        ''
    )
    const key = JSON.stringify([input.toolName, scope, `${condition}:${revision}`])
    const attempts = (this.episodes.get(key) ?? 0) + 1
    this.episodes.set(key, attempts)
    trim(this.episodes)
    if (attempts < 3) return undefined
    return `同一个对象、同一种失败原因已经连续 ${attempts} 次没有新证据。先查清具体是哪个前置条件不满足，或者换一条修复路径；只需要改一个字段时用失败回执里的参数复用，不必重填正文。`
  }
}
function trim<T>(map: Map<string, T>): void {
  while (map.size > 128) map.delete(map.keys().next().value!)
}
function resourceKeys(args: Record<string, unknown>): string[] {
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
function fingerprint(value: unknown): string | undefined {
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
