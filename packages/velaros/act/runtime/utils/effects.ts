import { isObject, isPlainObject, isString } from '@velaros-ai/core'

/**
 * 失败时「一处都没写」的约定标记：领域在写入之前失败时在错误上标出——`effect: 'none'`（命令、存储），
 * 或放在 details / context 里的 `executionOutcome: 'not-applied'`（项目、文件、沙箱）。沿着 cause 往里找，
 * 外层包装过的错误照样认得；某一层已经给出别的结论（效果未知、已部分写入）就以它为准，不再往里找。
 */
export function isFailureWithoutEffect(error: unknown): boolean {
  const seen = new Set<unknown>()
  for (
    let current: unknown = error;
    isObject(current) && !seen.has(current);
    current = (current as { cause?: unknown }).cause
  ) {
    seen.add(current)
    const { effect, details, context } = current as {
      effect?: unknown
      details?: unknown
      context?: unknown
    }
    if (isString(effect)) return effect === 'none'
    for (const fields of [details, context])
      if (isPlainObject(fields) && isString(fields.executionOutcome))
        return fields.executionOutcome === 'not-applied'
  }
  return false
}
