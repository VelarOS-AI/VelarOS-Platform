import { isArray, isEmpty, isPlainObject, toNullable } from '@velaros-ai/core'
import { normalizeUnknownStringArray as readStringArray } from '@velaros-ai/core/utils/unknownJsonRecord'

import { compareStableStrings } from '../residency/determinism'

export const IDEMPOTENT_TOOL_CALLS = new Set([
  'tooling:map',
  'tooling:read',
  'tooling:replace',
  'plan:update',
])

export function normalizeToolCallFingerprintValue(value: unknown): unknown {
  if (isArray(value)) return value.map(normalizeToolCallFingerprintValue)

  if (!isPlainObject(value)) return value

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareStableStrings(left, right))
      .map(([key, nestedValue]) => [key, normalizeToolCallFingerprintValue(nestedValue)])
  )
}

export function buildToolFingerprint(
  toolName: string,
  args: Record<string, unknown>
): LooseOptional<string> {
  if (!IDEMPOTENT_TOOL_CALLS.has(toolName)) return null

  if (toolName.startsWith('tool_')) {
    const normalized = normalizeToolCallFingerprintValue(args) as Record<string, unknown>
    for (const key of ['ids', 'pageIn', 'pageOut', 'categoryIds']) {
      const values = readStringArray(args[key])
      if (!isEmpty(values)) {
        normalized[key] = values.sort()
      }
    }
    return JSON.stringify(normalized)
  }

  // plan:update 指纹必须含语义修饰字段:只看 plan 会把「同计划 + lifecycle:completed 收尾」
  // 「同计划 + complete_step 完成某步」误判成重复提交而拦截——自动过滤器不得静默否决
  // 显式收尾/完成意图(真机踩过:收尾调用被拦成"重复计划")。explanation 是纯注释,刻意排除,
  // 保证"只换说明的刷屏重复"仍会被拦。
  if (toolName === 'plan:update') return JSON.stringify(
      normalizeToolCallFingerprintValue({
        plan: toNullable(args.plan),
        complete_step: toNullable(args.complete_step),
        lifecycle: toNullable(args.lifecycle),
      })
    )
  return JSON.stringify(normalizeToolCallFingerprintValue(args))
}
