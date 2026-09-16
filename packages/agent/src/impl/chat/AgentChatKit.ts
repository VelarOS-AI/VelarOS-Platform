// 渲染侧聊天工具集：把 utils 里跟「一条会话怎么显示」有关的纯函数收成一件能力。
// 整条引用链不碰 Node 内置模块，渲染进程可以直接加载（`./chat` 入口）。
import type { ActiveContextArtifact, ActiveContextUpsertInput, ChatPromptFeatureId, ChatSendRequest, ContextUsageEstimate, ExecutionModeId, StreamAssistantGeneratedFilePayload, StreamAssistantSourcePayload } from '../../types/agent'
import type { ResolvedChatSendRequestOptions } from '../../types/chat'
import type { ContextUsageWindow, EstimateContextUsageOptions } from '../../types/context'
import type { InlineReasoningSegment, InlineReasoningTagSplitState, ProviderStreamPart } from '../../types/loop'
import type { ExecutionModeDescriptor, GoalDockViewModel, GoalLifecycleAction, GoalLifecycleStatus, TurnContextBlockInput } from '../../types/runner'
import type { SerializationHints } from '../../types/tools'
import { resolveChatSendRequestOptions } from '../../utils/chat/resolve-chat-send-request'
import { normalizeSessionLineageId, normalizeSessionLineageIdList } from '../../utils/chat/session-lineage'
import { extractSessionSearchTerms, normalizeSessionSearchText } from '../../utils/chat/session-search-text'
import { estimateContextUsage, resolveContextUsageWindow } from '../../utils/context/context-usage'
import { isExecutionModeActive, listExecutionModes, normalizeExecutionModes, resolveExecutionModes, stripExecutionModePromptFeatures } from '../../utils/runner/execution-mode-registry'
import { buildGoalDockViewModel, findCurrentGoalArtifact, getGoalLifecycleStatus, goalLifecycleToUpsertInput, isGoalArtifact } from '../../utils/runner/goal-lifecycle-projection'
import { formatTurnContextOmittedNote, renderTurnContextBlock, stripTurnContextBlocks } from '../../utils/runner/turn-context-format'
import { readGeneratedFilePayload, readSourcePayload } from '../../utils/stream/generated-artifacts'
import { createInlineReasoningTagSplitState, flushInlineReasoningTagTail, splitInlineReasoningTagDelta } from '../../utils/stream/inline-reasoning-tags'
import { compactToolInputForModel, compactToolResultForDisplay, deserializeSerializedToolResult, serializeToolResultForModel, serializeToolResultForRecall } from '../../utils/tools/tool-result-serialization'

/**
 * 渲染进程用的聊天工具集：执行模式、上下文用量、回合上下文块、目标停靠区、会话搜索、
 * 发送请求解析、工具结果展示压缩、内联思考标签与生成产物读取。
 *
 * 一份全局实例，没有任何状态——每个方法都是纯函数，同样的入参永远得到同样的结果。
 */
export interface AgentChatKitApi {
  /** 列出全部执行模式描述（顺序固定，供界面渲染开关）。 */
  listExecutionModes(): readonly ExecutionModeDescriptor[]
  /** 把任意来源的模式列表归一成合法模式 id 数组；不认识的项丢掉。 */
  normalizeExecutionModes(values?: readonly unknown[]): ExecutionModeId[]
  /** 从一次发送请求的提示词特性里解出这一轮生效的执行模式。 */
  resolveExecutionModes(source: {
  executionModes?: LooseOptional<readonly unknown[]>
  promptFeatures?: LooseOptional<readonly ChatPromptFeatureId[]>
  goalMode?: unknown
}): ExecutionModeId[]
  /** 判断某个执行模式在这一轮是否生效。 */
  isExecutionModeActive(id: ExecutionModeId, modes?: readonly ExecutionModeId[]): boolean
  /** 从提示词特性列表里摘掉执行模式那几项，留下其余特性。 */
  stripExecutionModePromptFeatures(features?: readonly ChatPromptFeatureId[]): ChatPromptFeatureId[]
  /** 估算一条会话当前占了模型可用窗口的多少（界面容量条按它显示）。 */
  estimateContextUsage(model: string, systemPrompt: string, history: unknown, options?: EstimateContextUsageOptions): ContextUsageEstimate
  /** 解出这一轮按哪个窗口算占用：模型窗口与治理窗口取小。 */
  resolveContextUsageWindow(options: Pick<
    EstimateContextUsageOptions,
    'contextWindow' | 'reservedOutputTokens' | 'safetyMarginPercent'
  >): ContextUsageWindow
  /** 把一批环境变化渲染成投给模型的回合上下文块；没内容时返回 null。 */
  renderTurnContextBlock(input: TurnContextBlockInput): Nullable<string>
  /** 渲染「还有几条没投」的省略说明。 */
  formatTurnContextOmittedNote(count: number): string
  /** 从正文里摘掉回合上下文块，得到用户真正写的那段文字。 */
  stripTurnContextBlocks(text: string): string
  /** 判断一条活动上下文产物是不是目标。 */
  isGoalArtifact(artifact: ActiveContextArtifact): boolean
  /** 读目标产物的生命周期状态。 */
  getGoalLifecycleStatus(artifact: ActiveContextArtifact): GoalLifecycleStatus
  /** 从一批产物里挑出当前目标；没有就返回 null。 */
  findCurrentGoalArtifact(artifacts: readonly ActiveContextArtifact[]): Nullable<ActiveContextArtifact>
  /** 把一次目标生命周期动作折成写入产物要的入参。 */
  goalLifecycleToUpsertInput(artifact: ActiveContextArtifact, action: GoalLifecycleAction, now?: number): ActiveContextUpsertInput
  /** 把目标产物投影成界面目标停靠区的视图模型。 */
  buildGoalDockViewModel(artifact: ActiveContextArtifact): Nullable<GoalDockViewModel>
  /** 把会话搜索文本归一（大小写、空白、全半角）后再比较。 */
  normalizeSessionSearchText(value: string): string
  /** 把一句搜索词切成检索用的词条。 */
  extractSessionSearchTerms(query: string, maxTerms?: 12): string[]
  /** 把一次发送请求解析成运行时要的选项（作用域、模式、提示词特性）。 */
  resolveChatSendRequestOptions(request: ChatSendRequest): ResolvedChatSendRequestOptions
  /** 归一一个会话谱系 id；空串与非法值返回 null。 */
  normalizeSessionLineageId(value: LooseOptional<string>): string
  /** 归一一串会话谱系 id，去重并丢掉非法项。 */
  normalizeSessionLineageIdList(values: LooseOptional<ReadonlyArray<LooseOptional<string>>>, fallback?: LooseOptional<string>): string[]
  /** 把工具结果压成界面展示用的紧凑形态。 */
  compactToolResultForDisplay(result: unknown): unknown
  /** 把工具入参压成回灌给模型时用的紧凑形态。 */
  compactToolInputForModel(input: Record<string, unknown>, toolCallId?: string): Record<string, unknown>
  /** 把工具结果序列化成召回时能原样读回的文本。 */
  serializeToolResultForRecall(result: unknown): string
  /** 把工具结果序列化成投给模型的文本，超长按上限截断。 */
  serializeToolResultForModel(result: unknown, hints?: SerializationHints): string
  /** 把序列化过的工具结果读回成对象。 */
  deserializeSerializedToolResult(serialized: string): unknown
  /** 开一份内联思考标签的切分状态（一条流一份）。 */
  createInlineReasoningSplitState(): InlineReasoningTagSplitState
  /** 把一段流增量切成正文与思考两路；跨片的标签由状态接住。 */
  splitInlineReasoning(state: InlineReasoningTagSplitState, text: string): InlineReasoningSegment[]
  /** 流结束时把状态里剩下的尾巴吐出来。 */
  flushInlineReasoning(state: InlineReasoningTagSplitState): InlineReasoningSegment[]
  /** 从一条工具结果里读出生成文件的载荷；不是生成产物就返回 null。 */
  readGeneratedFilePayload(part: ProviderStreamPart): Nullable<StreamAssistantGeneratedFilePayload>
  /** 从一条工具结果里读出源码载荷；没有就返回 null。 */
  readSourcePayload(part: ProviderStreamPart): Nullable<StreamAssistantSourcePayload>
}

/** 方法逐个转调 utils 里的纯函数；这里只负责把它们收成一件对外能力。 */
class AgentChatKit implements AgentChatKitApi {
  public listExecutionModes(): readonly ExecutionModeDescriptor[] {
    return listExecutionModes()
  }

  public normalizeExecutionModes(values?: readonly unknown[]): ExecutionModeId[] {
    return normalizeExecutionModes(values)
  }

  public resolveExecutionModes(source: {
  executionModes?: LooseOptional<readonly unknown[]>
  promptFeatures?: LooseOptional<readonly ChatPromptFeatureId[]>
  goalMode?: unknown
}): ExecutionModeId[] {
    return resolveExecutionModes(source)
  }

  public isExecutionModeActive(id: ExecutionModeId, modes?: readonly ExecutionModeId[]): boolean {
    return isExecutionModeActive(id, modes)
  }

  public stripExecutionModePromptFeatures(features?: readonly ChatPromptFeatureId[]): ChatPromptFeatureId[] {
    return stripExecutionModePromptFeatures(features)
  }

  public estimateContextUsage(model: string, systemPrompt: string, history: unknown, options?: EstimateContextUsageOptions): ContextUsageEstimate {
    return estimateContextUsage(model, systemPrompt, history, options)
  }

  public resolveContextUsageWindow(options: Pick<
    EstimateContextUsageOptions,
    'contextWindow' | 'reservedOutputTokens' | 'safetyMarginPercent'
  >): ContextUsageWindow {
    return resolveContextUsageWindow(options)
  }

  public renderTurnContextBlock(input: TurnContextBlockInput): Nullable<string> {
    return renderTurnContextBlock(input)
  }

  public formatTurnContextOmittedNote(count: number): string {
    return formatTurnContextOmittedNote(count)
  }

  public stripTurnContextBlocks(text: string): string {
    return stripTurnContextBlocks(text)
  }

  public isGoalArtifact(artifact: ActiveContextArtifact): boolean {
    return isGoalArtifact(artifact)
  }

  public getGoalLifecycleStatus(artifact: ActiveContextArtifact): GoalLifecycleStatus {
    return getGoalLifecycleStatus(artifact)
  }

  public findCurrentGoalArtifact(artifacts: readonly ActiveContextArtifact[]): Nullable<ActiveContextArtifact> {
    return findCurrentGoalArtifact(artifacts)
  }

  public goalLifecycleToUpsertInput(artifact: ActiveContextArtifact, action: GoalLifecycleAction, now?: number): ActiveContextUpsertInput {
    return goalLifecycleToUpsertInput(artifact, action, now)
  }

  public buildGoalDockViewModel(artifact: ActiveContextArtifact): Nullable<GoalDockViewModel> {
    return buildGoalDockViewModel(artifact)
  }

  public normalizeSessionSearchText(value: string): string {
    return normalizeSessionSearchText(value)
  }

  public extractSessionSearchTerms(query: string, maxTerms?: 12): string[] {
    return extractSessionSearchTerms(query, maxTerms)
  }

  public resolveChatSendRequestOptions(request: ChatSendRequest): ResolvedChatSendRequestOptions {
    return resolveChatSendRequestOptions(request)
  }

  public normalizeSessionLineageId(value: LooseOptional<string>): string {
    return normalizeSessionLineageId(value)
  }

  public normalizeSessionLineageIdList(values: LooseOptional<ReadonlyArray<LooseOptional<string>>>, fallback?: LooseOptional<string>): string[] {
    return normalizeSessionLineageIdList(values, fallback)
  }

  public compactToolResultForDisplay(result: unknown): unknown {
    return compactToolResultForDisplay(result)
  }

  public compactToolInputForModel(input: Record<string, unknown>, toolCallId?: string): Record<string, unknown> {
    return compactToolInputForModel(input, toolCallId)
  }

  public serializeToolResultForRecall(result: unknown): string {
    return serializeToolResultForRecall(result)
  }

  public serializeToolResultForModel(result: unknown, hints?: SerializationHints): string {
    return serializeToolResultForModel(result, hints)
  }

  public deserializeSerializedToolResult(serialized: string): unknown {
    return deserializeSerializedToolResult(serialized)
  }

  public createInlineReasoningSplitState(): InlineReasoningTagSplitState {
    return createInlineReasoningTagSplitState()
  }

  public splitInlineReasoning(state: InlineReasoningTagSplitState, text: string): InlineReasoningSegment[] {
    return splitInlineReasoningTagDelta(state, text)
  }

  public flushInlineReasoning(state: InlineReasoningTagSplitState): InlineReasoningSegment[] {
    return flushInlineReasoningTagTail(state)
  }

  public readGeneratedFilePayload(part: ProviderStreamPart): Nullable<StreamAssistantGeneratedFilePayload> {
    return readGeneratedFilePayload(part)
  }

  public readSourcePayload(part: ProviderStreamPart): Nullable<StreamAssistantSourcePayload> {
    return readSourcePayload(part)
  }
}

/** 渲染进程用的聊天工具集（无状态，进程内共用一份）。 */
export const agentChat: AgentChatKitApi = new AgentChatKit()
