import { isArray, isEmpty, isPlainObject, toNullable } from '@velaros-ai/core'
import { normalizeUnknownStringArray as readStringArray } from '@velaros-ai/core/utils/unknownJsonRecord'

import { compareStableStrings } from '../agent/context/residency/determinism'

const IDEMPOTENT_TOOL_CALLS = new Set([
  'tooling:map',
  'tooling:read',
  'tooling:replace',
  'plan:update',
])

function normalizeToolCallFingerprintValue(value: unknown): unknown {
  if (isArray(value)) return value.map(normalizeToolCallFingerprintValue)

  if (!isPlainObject(value)) return value

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareStableStrings(left, right))
      .map(([key, nestedValue]) => [key, normalizeToolCallFingerprintValue(nestedValue)])
  )
}

function buildToolFingerprint(
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

/**
 * CodingToolCallDeduper — 拦截幂等工具的“重复刷屏”行为。
 *
 * 背景：模型有时会连续多次发出完全相同的 tooling:replace/read/map / plan:update，
 * 既浪费 token 又会让用户看到大段重复输出。这里基于规范化后的入参指纹来：
 *  - 命中相同 fingerprint：返回提示文案，由调用方写入工具结果替代真正的执行；
 * 这里刻意只判断“完全相同的调用是否刚执行过”，不根据能力授权状态推断工具页是否驻留。
 * 能力已授权与具体工具 schema 已进入本轮 tools 是两个独立状态；后者只能由
 * ToolSpaceReplace 按当前驻留信息处理。
 *
 * fingerprint 规范化通过 `normalizeToolCallFingerprintValue` 对对象 key 排序，
 * 保证模型用不同 key 顺序生成的参数仍可命中同一指纹。
 */
class CodingToolCallDeduper {
  private readonly lastIdempotentToolCallFingerprints = new Map<string, string>()

  public recordIdempotentToolCall(toolName: string, args: Record<string, unknown>): void {
    const fingerprint = buildToolFingerprint(toolName, args)
    if (!fingerprint) return

    this.lastIdempotentToolCallFingerprints.set(toolName, fingerprint)
  }

  public getRepeatedIdempotentToolCallMessage(
    toolName: string,
    args: Record<string, unknown>
  ): LooseOptional<string> {
    const fingerprint = buildToolFingerprint(toolName, args)
    if (!fingerprint || this.lastIdempotentToolCallFingerprints.get(toolName) !== fingerprint) return null

    switch (toolName) {
      case 'plan:update': {
        return [
        '已拦截重复计划更新：当前计划内容与刚才完全相同。',
        '不要继续重复 plan:update；请直接调用实际执行工具推进任务，或在无法推进时说明阻塞点并询问用户。',
      ].join('\n')
      }
      default: {
        return [
      '已拦截重复工具空间操作：相同的工具页请求刚才已经处理过。',
      `不要继续重复 ${toolName}；若工具页已换入，请等待下一轮按 AI SDK 暴露的真实工具 schema 调用，或继续下一步。`,
    ].join('\n')
      }
    }
  }

}

export { buildToolFingerprint,CodingToolCallDeduper }
