import { isArray, isEmpty, isObject } from '@velaros-ai/core'
import type { ChatPromptFeatureId, ToolCategoryId } from '@velaros-ai/core/types'
import { normalizeUnknownStringArray as readStringArray } from '@velaros-ai/core/utils/unknownJsonRecord'

import { compareStableStrings } from '../agent/context/residency/determinism'
import {
  defaultRuntimePromptFeaturePolicy,
  type RuntimePromptFeaturePolicy,
} from '../tools/prompt-feature-policy'

const IDEMPOTENT_TOOL_CALLS = new Set([
  'tool_map',
  'tool_read',
  'tool_replace',
  'update_plan',
])

interface CodingToolCallDeduperOptions {
  getEnabledToolCategories: () => ReadonlySet<ToolCategoryId>
  getEnabledPromptFeatures: () => ReadonlySet<ChatPromptFeatureId>
  getSessionApprovedToolCategories: () => ReadonlySet<ToolCategoryId>
  promptFeaturePolicy?: RuntimePromptFeaturePolicy
}

function normalizeToolCallFingerprintValue(value: unknown): unknown {
  if (isArray(value)) return value.map(normalizeToolCallFingerprintValue)

  if (!value || !isObject(value)) return value

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
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

  // update_plan 指纹必须含语义修饰字段:只看 plan 会把「同计划 + lifecycle:completed 收尾」
  // 「同计划 + complete_step 完成某步」误判成重复提交而拦截——自动过滤器不得静默否决
  // 显式收尾/完成意图(真机踩过:收尾调用被拦成"重复计划")。explanation 是纯注释,刻意排除,
  // 保证"只换说明的刷屏重复"仍会被拦。
  if (toolName === 'update_plan') return JSON.stringify(
      normalizeToolCallFingerprintValue({
        plan: args.plan ?? null,
        complete_step: args.complete_step ?? null,
        lifecycle: args.lifecycle ?? null,
      })
    )
  return JSON.stringify(normalizeToolCallFingerprintValue(args))
}

/**
 * ToolCallDeduper — 拦截幂等工具的“重复刷屏”行为。
 *
 * 背景：模型有时会连续多次发出完全相同的 tool_replace/read/map / update_plan，
 * 既浪费 token 又会让用户看到大段重复输出。这里基于规范化后的入参指纹来：
 *  - 命中相同 fingerprint：返回提示文案，由调用方写入工具结果替代真正的执行；
 *  - tool_replace 还会判断本次申请的能力是否其实已经开启（包含 office 的会话级授权），
 *    若已开启则返回 “redundant feature” 文案，引导模型直接调用具体工具。
 *
 * fingerprint 规范化通过 `normalizeToolCallFingerprintValue` 对对象 key 排序，
 * 保证模型用不同 key 顺序生成的参数仍可命中同一指纹。
 */
class ToolCallDeduper {
  private readonly lastIdempotentToolCallFingerprints = new Map<string, string>()
  private readonly promptFeaturePolicy: RuntimePromptFeaturePolicy

  constructor(private readonly options: CodingToolCallDeduperOptions) {
    this.promptFeaturePolicy = options.promptFeaturePolicy ?? defaultRuntimePromptFeaturePolicy
  }

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
      case 'update_plan': {
        return [
        '已拦截重复计划更新：当前计划内容与刚才完全相同。',
        '不要继续重复 update_plan；请直接调用实际执行工具推进任务，或在无法推进时说明阻塞点并询问用户。',
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

  public getRedundantPromptFeatureMessage(
    toolName: string,
    args: Record<string, unknown>
  ): LooseOptional<string> {
    if (toolName !== 'tool_replace') return null

    const requestedPromptFeatures = this.promptFeaturePolicy.normalize(
      readStringArray(args.pageIn)
        .filter((id) => id.startsWith('plugin:'))
        .map((id) => id.slice('plugin:'.length)) as ChatPromptFeatureId[]
    )
    const requestedCategories = [
      ...new Set([
        ...(readStringArray(args.pageIn)
          .filter((id) => id.startsWith('capability:'))
          .map((id) => id.slice('capability:'.length)) as ToolCategoryId[]),
        ...this.promptFeaturePolicy.getCategoriesForFeatures(requestedPromptFeatures),
      ]),
    ]
    const requestedCategoryPromptFeatures = requestedPromptFeatures.length
      ? []
      : this.promptFeaturePolicy.getFeaturesForCategories(requestedCategories)
    const requestedFeatures = this.promptFeaturePolicy.normalize([
      ...requestedPromptFeatures,
      ...requestedCategoryPromptFeatures,
    ])

    if (isEmpty(requestedCategories) && isEmpty(requestedFeatures)) return null

    const enabledToolCategories = this.options.getEnabledToolCategories()
    const enabledPromptFeatures = this.options.getEnabledPromptFeatures()
    const sessionApprovedToolCategories = this.options.getSessionApprovedToolCategories()
    const hasMissingCategory = requestedCategories.some(
      (categoryId) => !enabledToolCategories.has(categoryId)
    )
    const hasMissingFeature = requestedFeatures.some(
      (feature) => !enabledPromptFeatures.has(feature)
    )

    if (hasMissingCategory || hasMissingFeature) return null

    const requestsOfficeApproval =
      requestedCategories.includes('office') ||
      requestedFeatures.some((feature) => this.promptFeaturePolicy.isOfficeFeature(feature))
    if (requestsOfficeApproval && !sessionApprovedToolCategories.has('office')) return null

    return [
      '请求的工具分类或用户已手动开启的插件已经可用，无需重复加载。',
      '请直接调用已开放的具体工具继续执行；例如 Office Word 任务应调用 create_word_document。',
    ].join('\n')
  }
}

export { buildToolFingerprint,ToolCallDeduper }
export type { CodingToolCallDeduperOptions }
export { ToolCallDeduper as CodingToolCallDeduper }
export { buildToolFingerprint as buildIdempotentToolCallFingerprint }
