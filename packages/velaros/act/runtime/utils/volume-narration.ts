import type { ContextRef } from '@velaros-ai/context'
import { isArray, isPlainObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ModelResponseFormat } from '@velaros-ai/kernel'

import { ContextPatchLimits } from '../../system/contract/constants.js'
import type { ContextMaintenanceSnapshot, ContextPatch } from '../../system/types/maintenance.js'

/** 摘要格式只投影已生成的卷叙事合同，版本与引用由宿主绑定。 */
export function volumeNarrationFormat(
  schema: Readonly<Record<string, unknown>>
): ModelResponseFormat {
  const definitions = schema.definitions as Readonly<Record<string, Record<string, unknown>>>
  const root = definitions[(schema.$ref as string).split('/').at(-1)!]!
  const volume = expandSchema((root.properties as Record<string, unknown>).volume, definitions) as {
    properties: Record<string, unknown>
    required: string[]
  }
  const fields = ['summary', 'unresolved', 'negativeAttempts']
  return {
    type: 'json',
    name: 'volume_narrative',
    description: '已封历史的事实摘要、未解事项与失败尝试',
    schema: {
      ...volume,
      properties: Object.fromEntries(fields.map((key) => [key, volume.properties[key]])),
      required: volume.required.filter((key) => fields.includes(key)),
    },
  }
}

/** 仅展开生成合同可达的本地引用，不向供应商发送无关分区的 schema。 */
function expandSchema(value: unknown, definitions: Readonly<Record<string, unknown>>): unknown {
  if (isArray(value)) return value.map((item) => expandSchema(item, definitions))
  if (!isPlainObject(value)) return value
  if (isString(value.$ref))
    return expandSchema(definitions[value.$ref.split('/').at(-1)!], definitions)
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, expandSchema(item, definitions)])
  )
}

/** 自动叙事只生成卷内容；既有未解事项继续保留，原始输入与当前状态不由这条路径改写。 */
export function volumeNarrationPatch(
  snapshot: ContextMaintenanceSnapshot,
  value: unknown,
  evidence: readonly ContextRef[]
): ContextPatch {
  if (
    !isPlainObject(value) ||
    Object.keys(value).some(
      (key) => !['summary', 'unresolved', 'negativeAttempts'].includes(key)
    ) ||
    !isString(value.summary) ||
    !value.summary.trim() ||
    value.summary.length > ContextPatchLimits.summaryChars ||
    !isArray(value.unresolved) ||
    !isArray(value.negativeAttempts) ||
    [value.unresolved, value.negativeAttempts].some(
      (items) =>
        items.length > ContextPatchLimits.unresolved ||
        items.some((item) => !isString(item) || item.length > ContextPatchLimits.unresolvedChars)
    )
  )
    throw new AppError('VALIDATION', '自动卷叙事格式或大小无效')
  const unresolved = [
    ...new Set([...snapshot.ledgers.unresolved, ...(value.unresolved as string[])]),
  ]
  if (unresolved.length > ContextPatchLimits.unresolved)
    throw new AppError('LIMIT', '自动卷叙事的未解事项超限，需要逐项整理')
  return {
    baseRevision: snapshot.baseRevision,
    summary: value.summary,
    unresolved,
    volume: {
      summary: value.summary,
      unresolved,
      negativeAttempts: value.negativeAttempts as string[],
      evidence,
    },
  }
}
