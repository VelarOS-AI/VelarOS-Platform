import { isArray, isBoolean, isNonBlankString, isPresent, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import {
  isExecutionModeActive,
  resolveExecutionModes,
  stripExecutionModePromptFeatures,
} from '../execution-modes'
import { normalizePromptFeatures } from '../protocol/constants/promptFeatures'
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

/**
 * 从磁盘 JSON 恢复 session 级强类型字段：缺省用默认，存在但非法则抛 VALIDATION。
 *
 * **存量会话的模式轴迁移就发生在这里**：拆轴前的会话盘上没有 `executionModes`，只有
 * `promptFeatures: ['plan']` 与 `goalMode: true` 两种旧形态。读入时折算成模式轴、并把模式 id
 * 从能力轴剥掉——不写回磁盘（读时迁移），下一次保存自然带上新字段，中途降级回旧版也仍能读。
 */
function resolveStoredChatSessionFields(stored: Partial<StoredChatSession>) {
  const pureChatMode = resolveStoredBoolean(
    stored.pureChatMode,
    'StoredChatSession.pureChatMode'
  )
  const scope = isNonBlankString(stored.scope) ? stored.scope.trim() : 'default'
  const storedPromptFeatures = resolveStoredPromptFeatures(stored.promptFeatures)
  // 纯聊天会话两根轴恒空，因此**不读** goalMode——保持拆轴前的短路顺序。
  // 反过来写（先校验再判 pureChat）会让一条 pureChat 会话因为一格用不到的坏布尔而加载失败。
  const executionModes = pureChatMode
    ? []
    : resolveExecutionModes({
        executionModes: isArray(stored.executionModes) ? stored.executionModes : [],
        promptFeatures: storedPromptFeatures,
        // 旧形态布尔：坏值仍按 VALIDATION 抛，不静默当 false。
        goalMode: resolveStoredBoolean(stored.goalMode, 'StoredChatSession.goalMode'),
      })

  return {
    executionModes,
    goalMode: isExecutionModeActive('goal', executionModes),
    promptFeatures: pureChatMode ? [] : stripExecutionModePromptFeatures(storedPromptFeatures),
    scope,
    pureChatMode,
  }
}

export { resolveStoredChatSessionFields }
