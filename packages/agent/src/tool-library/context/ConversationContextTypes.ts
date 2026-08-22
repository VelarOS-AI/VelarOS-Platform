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

export interface ToolConversationHandoffRequest {
  reason: string
}

export interface ToolConversationHandoffResult {
  requested: boolean
  sessionId: string
  reason: string
  unavailableReason?: string
}

/** 工具按需读取已压缩会话上下文的最小 API。 */
export interface ToolConversationContextApi {
  /** 请求宿主向用户展示会话交接批准卡；缺席表示该宿主不支持交接。 */
  requestHandoff?: (
    input: ToolConversationHandoffRequest
  ) => Promise<ToolConversationHandoffResult>
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
