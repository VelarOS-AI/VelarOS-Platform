import { isArray, isEmpty, isPlainObject, isString,Log } from '@velaros-ai/core'

/** 按资源和前置条件识别没有新证据的重试；只给恢复建议，不禁止正常探索。 */
export class ExecutionProgress {
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
    return `The same resource and failure condition persisted for ${attempts} attempts without new evidence. Inspect the specific precondition or choose another repair approach; reuse saved arguments when only a field needs correction.`
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
