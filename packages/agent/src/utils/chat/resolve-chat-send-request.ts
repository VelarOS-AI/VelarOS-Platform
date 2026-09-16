import { isNonBlankString, isTrue } from '@velaros-ai/core'

import type { CapabilityScopeId, ChatSendRequest, RunProfileSelectionId } from '../../types/agent.js'
import type { ResolvedChatSendRequestOptions } from '../../types/chat.js'
import {
  isExecutionModeActive,
  resolveExecutionModes,
  stripExecutionModePromptFeatures,
} from '../runner/execution-mode-registry'
import {
  assertChatPromptFeatureIds,
  isThinkingDepth,
  parseOptionalReasoningLevel,
  resolveRunProfileSelectionId,
} from '../wire/typed-field-asserts'

const DefaultRunProfileSelectionId: RunProfileSelectionId = 'auto'

function resolveRequestScope(request: ChatSendRequest): CapabilityScopeId {
  return isNonBlankString(request.scope) ? request.scope.trim() : 'default'
}

/** 解析 chat:send 可选强类型字段：缺省走默认，存在但非法则抛 VALIDATION。 */
function resolveChatSendRequestOptions(request: ChatSendRequest): ResolvedChatSendRequestOptions {
  const scope = resolveRequestScope(request)
  // pureChatMode 与 scope 解耦：只取宿主请求的显式字段，不根据具体 scope 类型推断。
  const requestedPromptFeatures = assertChatPromptFeatureIds(
    request.promptFeatures,
    'ChatSendRequest.promptFeatures'
  )
  const pureChatMode = isTrue(request.pureChatMode)
  // 拆轴口：先把两种形态折进模式轴，再从能力轴上剥掉模式 id——顺序不可颠倒，
  // 先剥后折会把「旧宿主只传了 promptFeatures:['plan']」这一路的计划模式直接扔掉。
  const executionModes = pureChatMode
    ? []
    : resolveExecutionModes({
        executionModes: request.executionModes,
        promptFeatures: requestedPromptFeatures,
        goalMode: request.goalMode,
      })

  return {
    runProfile: resolveRunProfileSelectionId(
      request.runProfile,
      DefaultRunProfileSelectionId,
      'ChatSendRequest.runProfile'
    ),
    // legacy thinkingDepth 已被 reasoningLevel 取代：宽松解析，非法值忽略而不抛错。
    thinkingDepth: isThinkingDepth(request.thinkingDepth) ? request.thinkingDepth : undefined,
    reasoningLevel: parseOptionalReasoningLevel(request.reasoningLevel),
    promptFeatures: pureChatMode ? [] : stripExecutionModePromptFeatures(requestedPromptFeatures),
    executionModes,
    scope,
    goalMode: isExecutionModeActive('goal', executionModes),
    pureChatMode,
  }
}

export { resolveChatSendRequestOptions }
