import type { ChatStreamEvent, ChatStreamSnapshotItem } from '@velaros-ai/core/types'

export type ChatStreamLogEntry = ChatStreamSnapshotItem

export type ChatStreamLifecyclePhase = 'idle' | 'streaming' | 'terminal'

/** Renderer IPC consumer termination; `user_abort` blocks reconnect recovery. */
export type ChatStreamTerminationReason = 'user_abort' | 'completed' | 'failed'

export type TerminalRuntimeExecutionAction = 'complete' | 'abort' | 'fail'

export type AgentBridgeOutput =
  | { kind: 'delta'; text: string }
  | { kind: 'events'; events: ChatStreamEvent[] }

/** main StreamBridge 侧结构化日志；由 protocol 从 AgentEvent / ChatStreamEvent 推导。 */
export type StreamObservabilityEntry = {
  level: 'info' | 'error'
  message: string
  context: Record<string, unknown>
}

export type AgentBridgeDispatch = {
  outputs: AgentBridgeOutput[]
  observability: StreamObservabilityEntry[]
}
