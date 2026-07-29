import { normalizePromptFeatures } from '../constants/promptFeatures'
import {
  resolveStoredChatSessionKind,
} from '../constants/typedFieldAsserts'
import { AppError } from '../error'
import { isArray, isBoolean, isPresent, isString } from '../typeGuards.js'
import type { ChatPromptFeatureId, StoredChatSession } from '../types'

function resolveStoredGoalMode(value: unknown): boolean {
  if (!isPresent(value)) return false

  if (!isBoolean(value)) {
    throw new AppError('VALIDATION', `无效的 StoredChatSession.goalMode：${String(value)}`)
  }

  return value
}

function resolveStoredPureChatMode(value: unknown): boolean {
  if (!isPresent(value)) return false

  if (!isBoolean(value)) {
    throw new AppError('VALIDATION', `无效的 StoredChatSession.pureChatMode：${String(value)}`)
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
  const storedPureChatMode = resolveStoredPureChatMode(stored.pureChatMode)
  const rawScope = stored.scope
  const scope = isString(rawScope) && rawScope.trim() ? rawScope.trim() : 'default'
  const pureChatMode = storedPureChatMode

  return {
    kind: resolveStoredChatSessionKind(stored.kind, 'chat', 'StoredChatSession.kind'),
    goalMode: pureChatMode ? false : resolveStoredGoalMode(stored.goalMode),
    promptFeatures: pureChatMode ? [] : resolveStoredPromptFeatures(stored.promptFeatures),
    scope,
    pureChatMode,
  }
}

export { resolveStoredChatSessionFields }
