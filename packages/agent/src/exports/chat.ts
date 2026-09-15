// 执行模式轴的纯解析面（无 loop / 无 Node.js 依赖）从这里导出，供渲染层通过
// `@velaros-ai/agent/chat` 子路径消费，避免渲染代码导入包含运行时能力的包根。
export { ChatMessageHelper, ChatMessageHelper as ChatMessages } from '../impl/chat/ChatMessages'
export { ChatStreamConsumer } from '../impl/chat/ChatStreamConsumer'
export { ChatStreamProtocol,chatStreamProtocol } from '../impl/chat/ChatStreamProtocol'
export { ChatStreamSessionLog } from '../impl/chat/ChatStreamSessionLog'
export type { ExecutionModeId } from '../types/agent'
export type {
  AgentBridgeDispatch,
  AgentBridgeOutput,
  ChatStreamLifecyclePhase,
  ChatStreamLogEntry,
  ChatStreamTerminationReason,
  StreamObservabilityEntry,
  TerminalRuntimeExecutionAction,
} from '../types/chat-stream'
export type { ResolvedChatSendRequestOptions } from '../utils/chat/resolve-chat-send-request'
export { resolveChatSendRequestOptions } from '../utils/chat/resolve-chat-send-request'
export { resolveStoredChatSessionFields } from '../utils/chat/resolve-stored-chat-session'
export {
  normalizeSessionLineageId,
  normalizeSessionLineageIdList,
} from '../utils/chat/session-lineage'
export {
  extractSessionSearchTerms,
  normalizeSessionSearchText,
} from '../utils/chat/session-search-text'
export type {
  ContextUsageEstimate,
  ContextUsageWindow,
  EstimateContextUsageOptions,
} from '../utils/context/context-usage'
export {
  ContextUsageCompactionPercent,
  ContextUsageHighWatermarkPercent,
  ContextUsagePayloadCompactionChars,
  ContextUsageSemanticPreSummaryPercent,
  countContextMediaParts,
  estimateContextUsage,
  estimateContextValueChars,
  resolveContextUsageWindow,
} from '../utils/context/context-usage'
export {
  isExecutionModeActive,
  normalizeExecutionModes,
  resolveExecutionModes,
  stripExecutionModePromptFeatures,
} from '../utils/runner/execution-mode-registry'
export type {
  GoalDockAction,
  GoalDockPrimaryAction,
  GoalDockTone,
  GoalDockViewModel,
  GoalLifecycleAction,
  GoalLifecycleStatus,
} from '../utils/runner/goal-lifecycle-projection'
export {
  buildGoalDockViewModel,
  findCurrentGoalArtifact,
  getGoalLifecycleStatus,
  GoalArtifactId,
  goalLifecycleToUpsertInput,
  isGoalArtifact,
} from '../utils/runner/goal-lifecycle-projection'
export type { TurnContextBlockInput } from '../utils/runner/turn-context-format'
export {
  formatTurnContextOmittedNote,
  renderTurnContextBlock,
  stripTurnContextBlocks,
  TurnContextBlockCloseTag,
  TurnContextBlockOpenTag,
  TurnContextMidRunNoteLead,
} from '../utils/runner/turn-context-format'
export type { SerializationHints } from '../utils/tools/tool-result-serialization'
export {
  compactToolInputForModel,
  compactToolResultForDisplay,
  deserializeSerializedToolResult,
  extractSerializationHintsFromToolInput,
  ModelToolResultMaxSerializedLength,
  serializeToolResultForModel,
  serializeToolResultForRecall,
} from '../utils/tools/tool-result-serialization'
