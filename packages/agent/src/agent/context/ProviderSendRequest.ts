import type { ModelMessage } from 'ai'

import { isEmpty, toNullable } from '@velaros-ai/core'

import { projectTransientRecoveryHistory } from '../../tools/recovery/TransientRecoveryProjection'
import {
  type AgentHistoryToolContext,
  sanitizeHistoryForProvider,
  type SanitizeModelHistoryOptions,
} from '../history'

import { estimateProviderRequestUsage } from './providerRequest/stages/budgetStage'
import type { ContextPayloadStore } from './ContextPayloadStore'
import type {
  CompiledProviderRequest,
  CompileProviderRequestInput,
  ProviderRequestCompiler,
} from './ProviderRequestCompiler'
import { fileContextFor, projectFileContext } from './resources'
import { buildToolPayloadRefsForProviderMessages } from './ToolPayloadReferencePlanner'
import {
  OversizedUserTextSafetyValveChars,
  UserTextPayloadPlanner,
  type UserTextPayloadReference,
} from './UserTextPayloadPlanner'

export interface CompileProviderSendRequestInput
  extends Omit<
    CompileProviderRequestInput,
    'messages' | 'toolPayloadRefsByToolCallId' | 'userTextPayloadRefsByHash'
  > {
  sessionId: string
  rawHistoryMessages: ModelMessage[]
  /** 稳定前缀消息（系统提示词稳定层 + 缓存断点）。逐轮字节不变，账本不摄入它们之外的东西。 */
  leadingMessages?: readonly ModelMessage[]
  phase: 'stream' | 'query'
  turn?: LooseOptional<number>
  payloadStore?: LooseOptional<ContextPayloadStore>
  toolContext?: AgentHistoryToolContext
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
  let storedToolPayloadRefs: Record<string, string> = {}
  const mergedSanitizeOptions: SanitizeModelHistoryOptions = {
    stripProviderSpecificMetadata: true,
    ...(input.sanitizeOptions ?? {}),
  }

  const sanitizedHistoryMessages = sanitizeHistoryForProvider(
    input.rawHistoryMessages,
    input.phase,
    toNullable(input.turn),
    mergedSanitizeOptions
  )
  if (input.payloadStore && !input.skipUserTextPersistence) {
    const planner = new UserTextPayloadPlanner(input.payloadStore)
    const persisted = await planner.persistOversizedUserTexts({
      sessionId: input.sessionId,
      // 先做结构/Unicode 清洗再计算内容哈希，准入期对同一份正文重算时才能稳定命中。
      messages: sanitizedHistoryMessages,
      thresholdChars: OversizedUserTextSafetyValveChars,
    })
    userTextPayloadRefs = persisted.references
  }
  // 生产发送路径会注入 buildToolPayloadRefs，并由工具描述决定 outputInline；此时不能再跑一遍不懂
  // 工具策略的通用规划器，否则会给本应永久内联的结果补上 ref。无宿主回调时才用通用持久化兜底。
  if (input.payloadStore && !input.buildToolPayloadRefs) {
    storedToolPayloadRefs = await buildToolPayloadRefsForProviderMessages({
      sessionId: input.sessionId,
      messages: input.rawHistoryMessages,
      store: input.payloadStore,
    })
  }
  const leadingMessages = input.leadingMessages ?? []
  // 交给编译器的是**未装饰**的历史：prompt-cache 断点每轮换位，贴在这里
  // 会让驻留账本的前缀指纹在每个新用户回合分叉、整本重建（审计 V10/U2/U4）。装饰改由编译器在
  // 投影之后贴（`applySendTransportDecorations`），provider 收到的字节不变。
  const fileContext = input.toolContext ? fileContextFor(input.toolContext) : undefined
  await fileContext?.seedHistory(sanitizedHistoryMessages)
  await fileContext?.prepare()
  const fileViews = fileContext?.currentViews() ?? []
  const measurementInput = { ...input, messages: sanitizedHistoryMessages }
  const fixedEstimate = estimateProviderRequestUsage(measurementInput, [...leadingMessages, ...(input.tailBlocks ?? [])])
  const fileTokenBudget = Math.max(0, Math.min(fixedEstimate.usableContextWindow * 0.15,
    fixedEstimate.usableContextWindow - fixedEstimate.estimatedTokens))
  let fileChars = Math.min(32_000, Math.floor(fileTokenBudget * 3))
  const recoveryHistory = projectTransientRecoveryHistory(sanitizedHistoryMessages)
  let fileProjection = projectFileContext(recoveryHistory, fileViews, fileChars)
  // 与最终发送门共用分词尺；源码预算是总输入容量的一部分，最后仍由编译器统一准入。
  while (fileChars > 0 && estimateProviderRequestUsage(measurementInput,
    [...leadingMessages, ...(input.tailBlocks ?? []), ...fileProjection.tail]).estimatedTokens
      - fixedEstimate.estimatedTokens > fileTokenBudget) {
    fileChars = Math.floor(fileChars / 2)
    fileProjection = projectFileContext(recoveryHistory, fileViews, fileChars)
  }
  const undecoratedMessages = [...leadingMessages, ...fileProjection.history]
  const callbackToolPayloadRefs = input.buildToolPayloadRefs
    ? await input.buildToolPayloadRefs(undecoratedMessages)
    : undefined
  const mergedToolPayloadRefs = {
    ...storedToolPayloadRefs,
    ...(callbackToolPayloadRefs ?? {}),
  }
  const toolPayloadRefsByToolCallId = isEmpty(Object.keys(mergedToolPayloadRefs))
    ? undefined
    : mergedToolPayloadRefs
  const userTextPayloadRefsByHash = Object.fromEntries(
    userTextPayloadRefs.map((reference) => [reference.hash, reference.payloadRef])
  )

  const compileInput = {
    ...input,
    messages: undecoratedMessages,
    tailBlocks: [...(input.tailBlocks ?? []), ...fileProjection.tail],
    applySendTransportDecorations: true,
    toolPayloadRefsByToolCallId,
    userTextPayloadRefsByHash,
    toolNameAliases:
      input.toolNameAliases ?? input.toolContext?.getCurrentVisibleToolTransportNames?.(),
  }
  let compiled = compiler.compileWithReclaim(compileInput)

  // 全部裁剪完成后再签发引用，并按最终字节重新封存 token 估计
  // 与完整性指纹，避免源码授权破坏发送边界快照。
  if (fileContext) compiled = compiler.finalizeProjectedMessages(
    compileInput, compiled, await fileContext.finalizeMessages(compiled.messages)
  )

  return {
    ...compiled,
    sanitizedHistoryMessages,
    providerMessages: compiled.messages,
    userTextPayloadRefs: userTextPayloadRefs.length,
  }
}
