import { isArray, isEmpty, isPlainObject, toNullable } from '@velaros-ai/core'
import { normalizeUnknownStringArray as readStringArray } from '@velaros-ai/core/utils/unknownJsonRecord'

import { compareStableStrings } from '../residency/determinism'

export const IDEMPOTENT_TOOL_CALLS = new Set([
  'tooling:map',
  'tooling:read',
  'tooling:replace',
  'plan:update',
])

/**
 * 递归把对象键按码元序排好，让"同一份参数、键序不同"算出同一个指纹。
 * 数组保持原序（顺序在工具参数里通常是语义的一部分），标量原样返回。
 */
export function normalizeToolCallFingerprintValue(value: unknown): unknown {
  if (isArray(value)) return value.map(normalizeToolCallFingerprintValue)

  if (!isPlainObject(value)) return value

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareStableStrings(left, right))
      .map(([key, nestedValue]) => [key, normalizeToolCallFingerprintValue(nestedValue)])
  )
}

/**
 * 算出一次工具调用的去重指纹（相同指纹的连续调用会被重复调用过滤器拦下）。
 *
 * 只有 IDEMPOTENT_TOOL_CALLS 里登记的幂等工具才参与去重，其余一律返回 null = 不去重
 * （有副作用的工具重复调用可能是刻意的，不能替模型否决）。`tool_*` 系工具额外把
 * ids/pageIn/pageOut/categoryIds 这几个集合语义字段排序后再比，免得只是顺序不同就算两次不同调用。
 * plan:update 只比 plan/complete_step/lifecycle 三项，取舍见下方块注释。
 */
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
