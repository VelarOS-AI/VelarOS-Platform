import { isArray, isBoolean, isNonBlankString, isPresent, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { normalizePromptFeatures } from '../protocol/constants/promptFeatures'
import { resolveStoredChatSessionKind } from '../protocol/constants/typedFieldAsserts'
import type { ChatPromptFeatureId, StoredChatSession } from '../protocol/types'

/** 磁盘布尔开关：缺席按 false，存在但非布尔一律抛 VALIDATION（坏数据不静默当 false）。 */
function resolveStoredBoolean(value: unknown, field: string): boolean {
  if (!isPresent(value)) return false

  if (!isBoolean(value)) {
    throw new AppError('VALIDATION', `无效的 ${field}：${String(value)}`)
  }

  return value
}

// 宽松恢复：feature 清单会随版本演进，磁盘里出现未知 id（升级/降级跨版本）时静默剔除
// 而不是抛错锁死会话加载；非数组一律当作未设置。
function resolveStoredPromptFeatures(value: unknown): ChatPromptFeatureId[] {
  if (!isArray(value)) return []

  return normalizePromptFeatures(value.filter(isString) as ChatPromptFeatureId[])
}

/** 从磁盘 JSON 恢复 session 级强类型字段：缺省用默认，存在但非法则抛 VALIDATION。 */
function resolveStoredChatSessionFields(stored: Partial<StoredChatSession>) {
  const pureChatMode = resolveStoredBoolean(
    stored.pureChatMode,
    'StoredChatSession.pureChatMode'
  )
  const scope = isNonBlankString(stored.scope) ? stored.scope.trim() : 'default'

  return {
    kind: resolveStoredChatSessionKind(stored.kind, 'chat', 'StoredChatSession.kind'),
    goalMode: pureChatMode
      ? false
      : resolveStoredBoolean(stored.goalMode, 'StoredChatSession.goalMode'),
    promptFeatures: pureChatMode ? [] : resolveStoredPromptFeatures(stored.promptFeatures),
    scope,
    pureChatMode,
  }
}

export { resolveStoredChatSessionFields }
