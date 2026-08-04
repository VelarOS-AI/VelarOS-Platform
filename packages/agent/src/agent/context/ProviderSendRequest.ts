import type { ModelMessage } from 'ai'

import type { ReasoningLanguagePreference } from '@velaros-ai/agent/protocol'
import { isEmpty, toNullable, toOptional } from '@velaros-ai/core'

import {
  type AgentHistoryToolContext,
  sanitizeHistoryForProvider,
  type SanitizeModelHistoryOptions,
} from '../history'
import { markLatestUserMessagePromptCacheBreakpoint } from '../model'
import { applyReasoningLanguagePreferenceToLatestUserMessage } from '../reasoning-language'

import type { ContextPayloadStore } from './ContextPayloadStore'
import type {
  CompiledProviderRequest,
  CompileProviderRequestInput,
  ProviderRequestCompiler,
} from './ProviderRequestCompiler'
import { buildToolPayloadRefsForProviderMessages } from './ToolPayloadReferencePlanner'
import {
  OversizedUserTextSafetyValveChars,
  UserTextPayloadPlanner,
  type UserTextPayloadReference,
} from './UserTextPayloadPlanner'

export interface CompileProviderSendRequestInput
  extends Omit<CompileProviderRequestInput, 'messages' | 'toolPayloadRefsByToolCallId'> {
  sessionId: string
  rawHistoryMessages: ModelMessage[]
  /** 稳定前缀消息（系统提示词稳定层 + 缓存断点）。逐轮字节不变，账本不摄入它们之外的东西。 */
  leadingMessages?: readonly ModelMessage[]
  phase: 'stream' | 'query'
  turn?: LooseOptional<number>
  payloadStore?: LooseOptional<ContextPayloadStore>
  toolContext?: AgentHistoryToolContext
  reasoningLanguage?: ReasoningLanguagePreference
  sanitizeOptions?: SanitizeModelHistoryOptions
  /** 为 true 时跳过异步 user-text 持久化，主要用于测试。 */
  skipUserTextPersistence?: boolean
  buildToolPayloadRefs?: (
    providerMessages: ModelMessage[]
  ) => Promise<LooseOptional<Record<string, string>>>
}

export interface CompiledProviderSendRequest extends CompiledProviderRequest {
  sanitizedHistoryMessages: ModelMessage[]
  providerMessages: ModelMessage[]
  userTextPayloadRefs: number
}

/**
 * 统一模型请求发送路径：先持久化超大用户文本，再清洗历史消息，再按需构建工具引用，最后编译可发送请求。
 * 调用方不应在此之前重复执行历史清洗或用户文本安全阀逻辑。
 */
export async function compileProviderSendRequest(
  input: CompileProviderSendRequestInput,
  compiler: ProviderRequestCompiler
): Promise<CompiledProviderSendRequest> {
  let userTextPayloadRefs: UserTextPayloadReference[] = []
  const mergedSanitizeOptions: SanitizeModelHistoryOptions = {
    stripProviderSpecificMetadata: true,
    ...(input.sanitizeOptions ?? {}),
  }

  if (input.payloadStore && !input.skipUserTextPersistence) {
    const planner = new UserTextPayloadPlanner(input.payloadStore)
    const persisted = await planner.persistOversizedUserTexts({
      sessionId: input.sessionId,
      messages: input.rawHistoryMessages,
      thresholdChars: OversizedUserTextSafetyValveChars,
    })
    userTextPayloadRefs = persisted.references
    mergedSanitizeOptions.userTextPayloadRefs = userTextPayloadRefs
  }
  if (input.payloadStore) {
    const toolPayloadRefs = await buildToolPayloadRefsForProviderMessages({
      sessionId: input.sessionId,
      messages: input.rawHistoryMessages,
      store: input.payloadStore,
    })
    if (!isEmpty(Object.keys(toolPayloadRefs))) {
      mergedSanitizeOptions.toolResultPayloadRefs = toolPayloadRefs
    }
  }

  const sanitizedHistoryMessages = sanitizeHistoryForProvider(
    input.rawHistoryMessages,
    input.phase,
    toNullable(input.turn),
    mergedSanitizeOptions
  )
  const leadingMessages = input.leadingMessages ?? []
  const providerMessages = markLatestUserMessagePromptCacheBreakpoint(
    applyReasoningLanguagePreferenceToLatestUserMessage(
      [...leadingMessages, ...sanitizedHistoryMessages],
      input.reasoningLanguage ?? 'auto'
    )
  )
  const toolPayloadRefsResult = input.buildToolPayloadRefs
    ? await input.buildToolPayloadRefs(providerMessages)
    : undefined
  const toolPayloadRefsByToolCallId = toOptional(toolPayloadRefsResult)

  const compiled = compiler.compileWithReclaim({
    ...input,
    messages: providerMessages,
    toolPayloadRefsByToolCallId,
    toolNameAliases:
      input.toolNameAliases ?? input.toolContext?.getCurrentVisibleToolTransportNames?.(),
  })

  return {
    ...compiled,
    sanitizedHistoryMessages,
    providerMessages: compiled.messages,
    userTextPayloadRefs: userTextPayloadRefs.length,
  }
}
