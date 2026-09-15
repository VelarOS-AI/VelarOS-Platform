// 执行模式轴的纯解析面（无 loop / 无 Node.js 依赖）从这里导出，供渲染层通过
// `@velaros-ai/agent/chat` 子路径消费，避免渲染代码导入包含运行时能力的包根。
export type {
  ContextUsageEstimate,
  ContextUsageWindow,
  EstimateContextUsageOptions,
} from '../agent/context/contextUsage'
export {
  ContextUsageCompactionPercent,
  ContextUsageHighWatermarkPercent,
  ContextUsagePayloadCompactionChars,
  ContextUsageSemanticPreSummaryPercent,
  countContextMediaParts,
  estimateContextUsage,
  estimateContextValueChars,
  resolveContextUsageWindow,
} from '../agent/context/contextUsage'
export type { TurnContextBlockInput } from '../agent/run-context/TurnContextFormat'
export {
  formatTurnContextOmittedNote,
  renderTurnContextBlock,
  stripTurnContextBlocks,
  TurnContextBlockCloseTag,
  TurnContextBlockOpenTag,
  TurnContextMidRunNoteLead,
} from '../agent/run-context/TurnContextFormat'
export type {
  GoalDockAction,
  GoalDockPrimaryAction,
  GoalDockTone,
  GoalDockViewModel,
  GoalLifecycleAction,
  GoalLifecycleStatus,
} from '../agent/runner/GoalLifecycleProjection'
export {
  buildGoalDockViewModel,
  findCurrentGoalArtifact,
  getGoalLifecycleStatus,
  GoalArtifactId,
  goalLifecycleToUpsertInput,
  isGoalArtifact,
} from '../agent/runner/GoalLifecycleProjection'
export {
  isExecutionModeActive,
  normalizeExecutionModes,
  resolveExecutionModes,
  stripExecutionModePromptFeatures,
} from '../execution-modes/ExecutionModeRegistry'
export type { ExecutionModeId } from '../protocol/types/agent'
export type { SerializationHints } from '../tools/toolResultSerialization'
export {
  compactToolInputForModel,
  compactToolResultForDisplay,
  deserializeSerializedToolResult,
  extractSerializationHintsFromToolInput,
  ModelToolResultMaxSerializedLength,
  serializeToolResultForModel,
  serializeToolResultForRecall,
} from '../tools/toolResultSerialization'
export { ChatMessageHelper, ChatMessageHelper as ChatMessages } from './messages'
export type { ResolvedChatSendRequestOptions } from './resolveChatSendRequest'
export { resolveChatSendRequestOptions } from './resolveChatSendRequest'
export { resolveStoredChatSessionFields } from './resolveStoredChatSession'
export { normalizeSessionLineageId, normalizeSessionLineageIdList } from './sessionLineage'
export { extractSessionSearchTerms, normalizeSessionSearchText } from './sessionSearchText'
export { ChatStreamConsumer } from './stream/ChatStreamConsumer'
export { ChatStreamProtocol,chatStreamProtocol } from './stream/ChatStreamProtocol'
export { ChatStreamSessionLog } from './stream/ChatStreamSessionLog'
export type {
  AgentBridgeDispatch,
  AgentBridgeOutput,
  ChatStreamLifecyclePhase,
  ChatStreamLogEntry,
  ChatStreamTerminationReason,
  StreamObservabilityEntry,
  TerminalRuntimeExecutionAction,
} from './stream/types'
