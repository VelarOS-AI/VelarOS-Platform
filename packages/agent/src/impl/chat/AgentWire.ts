// Agent wire 契约的解析与归一：schema 不出包，外面一律经这件能力解析。
import type { AgentCapabilityExecutionChannel, AgentCapabilityExecutionDescriptorV1, AgentCapabilityExecutionEventEnvelopeV1, AgentModManifestParseResult, AgentSurfaceContextSnapshot, ChatMessageConversationKind, ChatMessageConversationSemanticInput, ChatPromptFeatureId, ExternalAgentBridgeClientMessage, ParseAgentModManifestOptions, ReasoningLevel, ThinkingDepth } from '../../types/agent'
import type { AgentCapabilityExecuteEnvelopeV1 } from '../../types/execution'
import { createAgentCapabilityExecutionEventEnvelopeV1, parseAgentCapabilityExecuteEnvelopeV1 } from '../../utils/wire/agent-capability'
import { isConversationTurnInputMessage, isSystemNoticeMessage, resolveChatMessageConversationKind } from '../../utils/wire/conversation-kind'
import { parseExternalAgentBridgeClientMessage } from '../../utils/wire/external-agent-bridge'
import { parseAgentModManifest } from '../../utils/wire/mods'
import { mergeAgentSurfaceSkillSelection, serializeAgentSurfaceContextSnapshot } from '../../utils/wire/product-surface'
import { normalizePromptFeatures } from '../../utils/wire/prompt-features'
import { branchTimelineKey } from '../../utils/wire/storage'
import { assertChatPromptFeatureIds, reasoningLevelToThinkingDepth } from '../../utils/wire/typed-field-asserts'

/**
 * Agent 对外 wire 契约的解析面。
 *
 * zod schema 是包内实现细节、永不出包；跨进程传来的信封、清单与字段一律经这里解析与归一，
 * 解析失败按 `AgentErrorCodes` 抛。无状态，进程内共用一份。
 */
export interface AgentWireApi {
  /** 解析 `velaros.mod.json` 里的 agent 节；形状不对按错误码抛。 */
  parseModManifest(input: unknown, options?: ParseAgentModManifestOptions): AgentModManifestParseResult
  /** 解析 Agent 能力执行信封（v1）。 */
  parseCapabilityExecuteEnvelope(input: unknown): AgentCapabilityExecuteEnvelopeV1
  /** 构造一条 Agent 能力执行事件信封（v1）。 */
  createCapabilityExecutionEventEnvelope(execution: AgentCapabilityExecutionDescriptorV1, channel: AgentCapabilityExecutionChannel, payload: unknown): AgentCapabilityExecutionEventEnvelopeV1
  /** 解析外部 Agent 桥的客户端消息。 */
  parseExternalBridgeClientMessage(value: unknown): ExternalAgentBridgeClientMessage
  /** 把提示词特性列表归一：去重、丢掉不认识的、顺序固定。 */
  normalizePromptFeatures(features?: readonly ChatPromptFeatureId[]): ChatPromptFeatureId[]
  /** 算一条分支时间线的存储键。 */
  branchTimelineKey(branchId: string): string
  /** 把一次技能勾选合并进产品面画像。 */
  mergeSurfaceSkillSelection(selectedSkillIds: readonly string[], defaultSkillIds: readonly string[]): string[]
  /** 把产品面上下文快照序列化成可落盘的形态。 */
  serializeSurfaceContextSnapshot(snapshot?: AgentSurfaceContextSnapshot): string | undefined
  /** 把 Composer 的五档推理力度映射到团队侧的三档思考深度。 */
  reasoningLevelToThinkingDepth(level?: LooseOptional<ReasoningLevel>): ThinkingDepth
  /** 断言一串提示词特性 id 全部合法，不合法按错误码抛。 */
  assertChatPromptFeatureIds(value: unknown, field?: string): ChatPromptFeatureId[]
  /** 判定一条聊天消息属于哪一类对话内容。 */
  resolveMessageConversationKind(message: ChatMessageConversationSemanticInput): ChatMessageConversationKind
  /** 判断一条消息是不是用户这一轮的真实输入。 */
  isConversationTurnInput(message: ChatMessageConversationSemanticInput): boolean
  /** 判断一条消息是不是系统通知（不计入对话正文）。 */
  isSystemNotice(message: ChatMessageConversationSemanticInput): boolean
}

/** 方法逐个转调 utils/wire 里的解析函数；这里只负责把它们收成一件对外能力。 */
class AgentWire implements AgentWireApi {
  public parseModManifest(input: unknown, options?: ParseAgentModManifestOptions): AgentModManifestParseResult {
    return parseAgentModManifest(input, options)
  }

  public parseCapabilityExecuteEnvelope(input: unknown): AgentCapabilityExecuteEnvelopeV1 {
    return parseAgentCapabilityExecuteEnvelopeV1(input)
  }

  public createCapabilityExecutionEventEnvelope(execution: AgentCapabilityExecutionDescriptorV1, channel: AgentCapabilityExecutionChannel, payload: unknown): AgentCapabilityExecutionEventEnvelopeV1 {
    return createAgentCapabilityExecutionEventEnvelopeV1(execution, channel, payload)
  }

  public parseExternalBridgeClientMessage(value: unknown): ExternalAgentBridgeClientMessage {
    return parseExternalAgentBridgeClientMessage(value)
  }

  public normalizePromptFeatures(features?: readonly ChatPromptFeatureId[]): ChatPromptFeatureId[] {
    return normalizePromptFeatures(features)
  }

  public branchTimelineKey(branchId: string): string {
    return branchTimelineKey(branchId)
  }

  public mergeSurfaceSkillSelection(selectedSkillIds: readonly string[], defaultSkillIds: readonly string[]): string[] {
    return mergeAgentSurfaceSkillSelection(selectedSkillIds, defaultSkillIds)
  }

  public serializeSurfaceContextSnapshot(snapshot?: AgentSurfaceContextSnapshot): string | undefined {
    return serializeAgentSurfaceContextSnapshot(snapshot)
  }

  public reasoningLevelToThinkingDepth(level?: LooseOptional<ReasoningLevel>): ThinkingDepth {
    return reasoningLevelToThinkingDepth(level)
  }

  public assertChatPromptFeatureIds(value: unknown, field?: string): ChatPromptFeatureId[] {
    return assertChatPromptFeatureIds(value, field)
  }

  public resolveMessageConversationKind(message: ChatMessageConversationSemanticInput): ChatMessageConversationKind {
    return resolveChatMessageConversationKind(message)
  }

  public isConversationTurnInput(message: ChatMessageConversationSemanticInput): boolean {
    return isConversationTurnInputMessage(message)
  }

  public isSystemNotice(message: ChatMessageConversationSemanticInput): boolean {
    return isSystemNoticeMessage(message)
  }
}

/** Agent wire 契约的解析面（无状态，进程内共用一份）。 */
export const agentWire: AgentWireApi = new AgentWire()
