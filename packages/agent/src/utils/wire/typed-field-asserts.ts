import { isArray, isPresent, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { isBlank } from '@velaros-ai/core/utils/string'

import type { ChatPromptFeatureId } from '../../types/agent'
import type { ReasoningLevel, RunProfileId, RunProfileSelectionId,ThinkingDepth, ToolSurfaceProfileId } from '../../types/agent.js'
import type { TypedEnumAsserts } from '../../types/runner.js'

/**
 * 为一组字面量枚举值造一套四件校验器：`is`（类型守卫，非字符串或不在集合内为假）、
 * `assert`（不合法就抛 `VALIDATION` AppError，文案为「无效的 <字段名>：<原值>」）、
 * `parseOptional`（值缺席返回 undefined，存在则走 assert）、`resolve`（缺席落到 fallback，存在但非法仍抛）。
 * `defaultFieldName` 只用于错误文案，每个方法都能在调用点传 `field` 覆盖它，好让嵌套字段报出完整路径。
 * 注意 `resolve` 的 fallback 不做校验，由调用方保证它本身合法。
 */
function createTypedEnumAsserts<const T extends string>(
  values: readonly T[],
  defaultFieldName: string
): TypedEnumAsserts<T> {
  const allowed = new Set<string>(values)

  function is(value: unknown): value is T {
    return isString(value) && allowed.has(value)
  }

  function assert(value: unknown, field = defaultFieldName): T {
    if (is(value)) return value

    throw new AppError('VALIDATION', `无效的 ${field}：${String(value)}`)
  }

  function parseOptional(value: unknown, field = defaultFieldName): T | undefined {
    if (!isPresent(value)) return undefined

    return assert(value, field)
  }

  function resolve(value: unknown, fallback: T, field = defaultFieldName): T {
    return parseOptional(value, field) ?? fallback
  }

  return { values, is, assert, parseOptional, resolve }
}

const ThinkingDepthValues = ['fast', 'balanced', 'deep'] as const satisfies readonly ThinkingDepth[]
const thinkingDepthField = createTypedEnumAsserts(ThinkingDepthValues, 'thinkingDepth')

const ReasoningLevelValues = ['off', 'low', 'medium', 'high', 'ultra'] as const satisfies readonly ReasoningLevel[]
const reasoningLevelField = createTypedEnumAsserts(ReasoningLevelValues, 'reasoningLevel')

/** 把 Composer 的 5 档思考力度映射到团队 3 档 ThinkingDepth（用于 prompt 段/编码追踪等既有运行时消费方）。 */
function reasoningLevelToThinkingDepth(level?: LooseOptional<ReasoningLevel>): ThinkingDepth {
  switch (level) {
    case 'off':
    case 'low':
      return 'fast'
    case 'high':
    case 'ultra':
      return 'deep'
    default:
      return 'balanced'
  }
}

const RunProfileIdValues = ['compact', 'balanced', 'expanded'] as const satisfies readonly RunProfileId[]
const runProfileIdField = createTypedEnumAsserts(RunProfileIdValues, 'runProfile')

const RunProfileSelectionIdValues = [
  'auto',
  ...RunProfileIdValues,
] as const satisfies readonly RunProfileSelectionId[]
const runProfileSelectionIdField = createTypedEnumAsserts(
  RunProfileSelectionIdValues,
  'runProfile'
)

const ToolSurfaceProfileIdValues = ['preset', 'guided', 'direct', 'expert'] as const satisfies readonly ToolSurfaceProfileId[]
const toolSurfaceProfileIdField = createTypedEnumAsserts(
  ToolSurfaceProfileIdValues,
  'toolSurfaceProfile'
)

const {
  is: isThinkingDepth,
  assert: assertThinkingDepth,
  parseOptional: parseOptionalThinkingDepth,
  resolve: resolveThinkingDepth,
} = thinkingDepthField

const {
  is: isReasoningLevel,
  assert: assertReasoningLevel,
  parseOptional: parseOptionalReasoningLevel,
  resolve: resolveReasoningLevel,
} = reasoningLevelField

const {
  is: isRunProfileId,
  assert: assertRunProfileId,
  parseOptional: parseOptionalRunProfileId,
  resolve: resolveRunProfileId,
} = runProfileIdField

const {
  is: isRunProfileSelectionId,
  assert: assertRunProfileSelectionId,
  parseOptional: parseOptionalRunProfileSelectionId,
  resolve: resolveRunProfileSelectionId,
} = runProfileSelectionIdField

const {
  is: isToolSurfaceProfileId,
  assert: assertToolSurfaceProfileId,
  parseOptional: parseOptionalToolSurfaceProfileId,
  resolve: resolveToolSurfaceProfileId,
} = toolSurfaceProfileIdField

/** 校验 prompt feature 数组元素为非空字符串；未知 id 由上层 feature manifest 再过滤。 */
function assertChatPromptFeatureIds(
  value: unknown,
  field = 'promptFeatures'
): ChatPromptFeatureId[] {
  if (!isPresent(value)) return []

  if (!isArray(value)) {
    throw new AppError('VALIDATION', `无效的 ${field}：必须是数组`)
  }

  return value.map((entry, index) => {
    if (!isString(entry) || isBlank(entry)) {
      throw new AppError('VALIDATION', `无效的 ${field}[${index}]：${String(entry)}`)
    }

    return entry as ChatPromptFeatureId
  })
}

export {
  assertChatPromptFeatureIds,
  assertReasoningLevel,
  assertRunProfileId,
  assertRunProfileSelectionId,
  assertThinkingDepth,
  assertToolSurfaceProfileId,
  createTypedEnumAsserts,
  isReasoningLevel,
  isRunProfileId,
  isRunProfileSelectionId,
  isThinkingDepth,
  isToolSurfaceProfileId,
  parseOptionalReasoningLevel,
  parseOptionalRunProfileId,
  parseOptionalRunProfileSelectionId,
  parseOptionalThinkingDepth,
  parseOptionalToolSurfaceProfileId,
  reasoningLevelToThinkingDepth,
  ReasoningLevelValues,
  resolveReasoningLevel,
  resolveRunProfileId,
  resolveRunProfileSelectionId,
  resolveThinkingDepth,
  resolveToolSurfaceProfileId,
  RunProfileIdValues,
  RunProfileSelectionIdValues,
  ThinkingDepthValues,
  ToolSurfaceProfileIdValues,
}

