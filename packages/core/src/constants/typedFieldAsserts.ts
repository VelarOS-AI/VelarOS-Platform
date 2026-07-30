import { AppError } from '../error'
import { isArray, isPresent, isString } from '../typeGuards'
import type { RunProfileId, RunProfileSelectionId, ToolSurfaceProfileId } from '../types'
import type { ChatPromptFeatureId } from '../types/agent'
import type { ReasoningLevel, ThinkingDepth } from '../types/team'
import { isBlank } from '../utils/string'

/** 磁盘 session kind：前端只保留普通聊天会话。 */
export type StoredChatSessionKind = 'chat'

interface TypedEnumAsserts<T extends string> {
  values: readonly T[]
  is: (value: unknown) => value is T
  assert: (value: unknown, field?: string) => T
  parseOptional: (value: unknown, field?: string) => T | undefined
  resolve: (value: unknown, fallback: T, field?: string) => T
}

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

const StoredChatSessionKindValues = ['chat'] as const satisfies readonly StoredChatSessionKind[]
const storedChatSessionKindField = createTypedEnumAsserts(
  StoredChatSessionKindValues,
  'sessionKind'
)

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
  is: isStoredChatSessionKind,
  assert: assertStoredChatSessionKind,
  parseOptional: parseOptionalStoredChatSessionKind,
  resolve: resolveStoredChatSessionKind,
} = storedChatSessionKindField

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
  assertStoredChatSessionKind,
  assertThinkingDepth,
  assertToolSurfaceProfileId,
  createTypedEnumAsserts,
  isReasoningLevel,
  isRunProfileId,
  isRunProfileSelectionId,
  isStoredChatSessionKind,
  isThinkingDepth,
  isToolSurfaceProfileId,
  parseOptionalReasoningLevel,
  parseOptionalRunProfileId,
  parseOptionalRunProfileSelectionId,
  parseOptionalStoredChatSessionKind,
  parseOptionalThinkingDepth,
  parseOptionalToolSurfaceProfileId,
  reasoningLevelToThinkingDepth,
  ReasoningLevelValues,
  resolveReasoningLevel,
  resolveRunProfileId,
  resolveRunProfileSelectionId,
  resolveStoredChatSessionKind,
  resolveThinkingDepth,
  resolveToolSurfaceProfileId,
  RunProfileIdValues,
  RunProfileSelectionIdValues,
  StoredChatSessionKindValues,
  ThinkingDepthValues,
  ToolSurfaceProfileIdValues,
}

export type { TypedEnumAsserts }
