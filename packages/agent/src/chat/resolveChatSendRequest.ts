import { isNonBlankString, isTrue } from '@velaros-ai/core'

import {
  assertChatPromptFeatureIds,
  isThinkingDepth,
  parseOptionalReasoningLevel,
  resolveRunProfileSelectionId,
} from '../protocol/constants/typedFieldAsserts'
import type { CapabilityScopeId, ChatSendRequest, RunProfileSelectionId } from '../protocol/types'
import type { ReasoningLevel, ThinkingDepth } from '../protocol/types/team'

const DefaultRunProfileSelectionId: RunProfileSelectionId = 'auto'

interface ResolvedChatSendRequestOptions {
  runProfile: RunProfileSelectionId
  /** 用户在前端独立选择的思考深度；与 runProfile 解耦。未指定时为 undefined，由下游回落到 profile 默认。 */
  thinkingDepth?: ThinkingDepth
  /** Composer 思考力度 5 档（off/low/medium/high/ultra）；优先于 thinkingDepth 决定 reasoning 力度。 */
  reasoningLevel?: ReasoningLevel
  promptFeatures: NonNullable<ChatSendRequest['promptFeatures']>
  scope: CapabilityScopeId
  goalMode: boolean
  pureChatMode: boolean
}

function resolveRequestScope(request: ChatSendRequest): CapabilityScopeId {
  return isNonBlankString(request.scope) ? request.scope.trim() : 'default'
}

/** 解析 chat:send 可选强类型字段：缺省走默认，存在但非法则抛 VALIDATION。 */
function resolveChatSendRequestOptions(request: ChatSendRequest): ResolvedChatSendRequestOptions {
  const scope = resolveRequestScope(request)
  // pureChatMode 与 scope 解耦：只取宿主请求的显式字段，不根据具体 scope 类型推断。
  const rawPromptFeatures = assertChatPromptFeatureIds(
    request.promptFeatures,
    'ChatSendRequest.promptFeatures'
  )
  const proposalMode = rawPromptFeatures.includes('proposal')
  const requestedPromptFeatures = proposalMode
    ? rawPromptFeatures.filter((feature) => feature !== 'plan')
    : rawPromptFeatures
  // 方案模式依赖提问、产物和评审工具，不能被仅聊天链路吞掉；方案优先关闭 pure/goal。
  const pureChatMode = isTrue(request.pureChatMode) && !proposalMode

  return {
    runProfile: resolveRunProfileSelectionId(
      request.runProfile,
      DefaultRunProfileSelectionId,
      'ChatSendRequest.runProfile'
    ),
    // legacy thinkingDepth 已被 reasoningLevel 取代：宽松解析，非法值忽略而不抛错。
    thinkingDepth: isThinkingDepth(request.thinkingDepth) ? request.thinkingDepth : undefined,
    reasoningLevel: parseOptionalReasoningLevel(request.reasoningLevel),
    promptFeatures: pureChatMode ? [] : requestedPromptFeatures,
    scope,
    goalMode: pureChatMode || proposalMode ? false : isTrue(request.goalMode),
    pureChatMode,
  }
}

export { resolveChatSendRequestOptions }
export type { ResolvedChatSendRequestOptions }
