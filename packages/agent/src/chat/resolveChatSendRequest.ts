import { isNonBlankString, isTrue } from '@velaros-ai/core'

import {
  isExecutionModeActive,
  resolveExecutionModes,
  stripExecutionModePromptFeatures,
} from '../execution-modes'
import {
  assertChatPromptFeatureIds,
  isThinkingDepth,
  parseOptionalReasoningLevel,
  resolveRunProfileSelectionId,
} from '../protocol/constants/typedFieldAsserts'
import type {
  CapabilityScopeId,
  ChatSendRequest,
  ExecutionModeId,
  RunProfileSelectionId,
} from '../protocol/types'
import type { ReasoningLevel, ThinkingDepth } from '../protocol/types/team'

const DefaultRunProfileSelectionId: RunProfileSelectionId = 'auto'

interface ResolvedChatSendRequestOptions {
  runProfile: RunProfileSelectionId
  /** 用户在前端独立选择的思考深度；与 runProfile 解耦。未指定时为 undefined，由下游回落到 profile 默认。 */
  thinkingDepth?: ThinkingDepth
  /** Composer 思考力度 5 档（off/low/medium/high/ultra）；优先于 thinkingDepth 决定 reasoning 力度。 */
  reasoningLevel?: ReasoningLevel
  /** 能力轴：**只剩能力**，执行模式的旧形态 id 已在此剥除（见 stripExecutionModePromptFeatures）。 */
  promptFeatures: NonNullable<ChatSendRequest['promptFeatures']>
  /** 执行模式轴（权威）：新字段 ∪ 旧形态折算，见 resolveExecutionModes。 */
  executionModes: ExecutionModeId[]
  scope: CapabilityScopeId
  /** 由模式轴派生，保留给尚未改读新轴的下游（goal 生命周期、收尾门、阶段判定）。 */
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
export type { ResolvedChatSendRequestOptions }
