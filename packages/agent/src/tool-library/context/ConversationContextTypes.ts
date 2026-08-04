import type {
  ChatContextReadEvidenceRequest,
  ChatContextReadEvidenceResult,
  ChatContextReadToolPayloadRequest,
  ChatContextRetrievedPayload,
  ChatContextRetrievePayloadRequest,
  ChatContextSearchConversationHistoryRequest,
  ChatContextSearchConversationHistoryResult,
  ChatContextSearchTerminalOutputRequest,
  ChatContextSearchTerminalOutputResult,
} from '@velaros-ai/agent/protocol'

/** 工具按需读取已压缩会话上下文的最小 API。 */
export interface ToolConversationContextApi {
  retrieveContextPayload: (
    input: ChatContextRetrievePayloadRequest
  ) => Promise<ChatContextRetrievedPayload>
  searchConversationHistory: (
    input: ChatContextSearchConversationHistoryRequest
  ) => Promise<ChatContextSearchConversationHistoryResult>
  readEvidence: (input: ChatContextReadEvidenceRequest) => Promise<ChatContextReadEvidenceResult>
  readToolPayload: (
    input: ChatContextReadToolPayloadRequest
  ) => Promise<ChatContextRetrievedPayload>
  searchTerminalOutput: (
    input: ChatContextSearchTerminalOutputRequest
  ) => Promise<ChatContextSearchTerminalOutputResult>
}
