import type { SerializedError } from '../error'
import type {
  AgentEvent,
  ChatStreamEvent,
  StreamDebugPayload,
  StreamReasoningPayload,
  StreamStatePayload,
  StreamToolCallPayload,
  StreamToolMetadataPayload,
  StreamToolProgressPayload,
  StreamToolResultPayload,
} from '../types'
import {
  ALL_STREAM_RUNTIME_STATE_KINDS,
  STREAM_FAILURE_RUNTIME_STATE_KINDS,
  type StreamDonePayload,
  type StreamErrorPayload,
  type StreamFailureRuntimeStateKind,
  type StreamStateKind,
  TERMINAL_STREAM_RUNTIME_STATE_KINDS,
  type TerminalStreamRuntimeStateKind,
} from '../types/chatRuntime'
import { toOptional } from '../utils/nullish.js'

import type {
  AgentBridgeDispatch,
  AgentBridgeOutput,
  StreamObservabilityEntry,
  TerminalRuntimeExecutionAction,
} from './types'

/**
 * Chat stream 协议：终态判定、runtime 物化、AgentEvent → IPC 翻译。
 * 无 session 状态；有状态的部分见 {@link ChatStreamSessionLog} / {@link ChatStreamConsumer}。
 */
export class ChatStreamProtocol {
  readonly terminalRuntimeKinds = TERMINAL_STREAM_RUNTIME_STATE_KINDS
  readonly failureRuntimeKinds = STREAM_FAILURE_RUNTIME_STATE_KINDS
  readonly allRuntimeKinds = ALL_STREAM_RUNTIME_STATE_KINDS

  public isTerminalRuntimeKind(kind: StreamStateKind): kind is TerminalStreamRuntimeStateKind {
    return (TERMINAL_STREAM_RUNTIME_STATE_KINDS as readonly string[]).includes(kind)
  }

  public isFailureRuntimeKind(kind: StreamStateKind): kind is StreamFailureRuntimeStateKind {
    return (STREAM_FAILURE_RUNTIME_STATE_KINDS as readonly string[]).includes(kind)
  }

  public isDonePayload(payload: StreamStatePayload): payload is StreamDonePayload {
    return payload.kind === 'done'
  }

  public isTerminalEvent(event: ChatStreamEvent): boolean {
    return (
      event.type === 'end' ||
      event.type === 'error' ||
      (event.type === 'state' && this.isTerminalRuntimeKind(event.payload.kind))
    )
  }

  public isCloseMarkerEvent(event: ChatStreamEvent): boolean {
    return event.type === 'end'
  }

  public isFailureAgentEvent(event: AgentEvent): boolean {
    return event.type === 'runtime' && this.isFailureRuntimeKind(event.payload.kind)
  }

  public readTerminalKindFromAgent(event: AgentEvent): Nullable<TerminalStreamRuntimeStateKind> {
    if (event.type !== 'runtime' || !this.isTerminalRuntimeKind(event.payload.kind)) return null

    return event.payload.kind
  }

  public resolveExecutionAction(
    kind: TerminalStreamRuntimeStateKind
  ): TerminalRuntimeExecutionAction {
    switch (kind) {
      case 'done':
        return 'complete'
      case 'aborted':
        return 'abort'
      case 'error':
        return 'fail'
    }
  }

  public materializeRuntimeEvents(
    payload: StreamStatePayload,
    toSerializedError: (payload: StreamErrorPayload) => SerializedError
  ): ChatStreamEvent[] {
    switch (payload.kind) {
      case 'done':
      case 'aborted':
        return [{ type: 'state', payload }, { type: 'end' }]
      case 'error':
        return [{ type: 'error', payload: toSerializedError(payload) }, { type: 'end' }]
      case 'phase':
      case 'context-compaction':
      case 'usage-telemetry':
      case 'context-usage-estimate':
      case 'turn-start':
      case 'turn-end':
      case 'reconnecting':
      case 'retrying-turn':
      case 'awaiting-confirmation':
      case 'awaiting-input':
        return [{ type: 'state', payload }]
      default: {
        throw new Error(`Unhandled stream runtime state kind: ${String(payload)}`)
      }
    }
  }

  /** AgentEvent → IPC 输出 + 可观测性；StreamBridge 唯一入口。 */
  public bridgeAgentEvent(
    event: AgentEvent,
    options: { toSerializedError: (payload: StreamErrorPayload) => SerializedError }
  ): AgentBridgeDispatch {
    const outputs = this.mapAgentEvent(event, options)
    const observability = [
      ...this.readAgentEventObservability(event),
      ...outputs.flatMap((output) =>
        output.kind === 'events'
          ? output.events.flatMap((streamEvent) => this.readStreamEventObservability(streamEvent))
          : []
      ),
    ]

    return { outputs, observability }
  }

  /** AgentEvent → IPC stream 输出。 */
  public mapAgentEvent(
    event: AgentEvent,
    options: { toSerializedError: (payload: StreamErrorPayload) => SerializedError }
  ): AgentBridgeOutput[] {
    switch (event.type) {
      case 'text-delta':
        return [{ kind: 'delta', text: event.text }]
      case 'runtime':
        return [
          {
            kind: 'events',
            events: this.materializeRuntimeEvents(event.payload, options.toSerializedError),
          },
        ]
      case 'turn-context':
      case 'assistant-raw':
        return [{ kind: 'events', events: [{ type: 'debug', payload: event.payload }] }]
      case 'worker-thread':
        return [{ kind: 'events', events: [{ type: 'worker-thread', payload: event.payload }] }]
      case 'reasoning-delta':
        return [
          {
            kind: 'events',
            events: [
              {
                type: 'reasoning',
                payload: { id: event.id, text: event.text } satisfies StreamReasoningPayload,
              },
            ],
          },
        ]
      case 'assistant-generated-file':
        return [
          {
            kind: 'events',
            events: [{ type: 'notice', kind: 'assistant-generated-file', payload: event.payload }],
          },
        ]
      case 'assistant-source':
        return [
          {
            kind: 'events',
            events: [{ type: 'notice', kind: 'assistant-source', payload: event.payload }],
          },
        ]
      case 'tool-start':
        return [
          {
            kind: 'events',
            events: [
              {
                type: 'tool-call',
                payload: {
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  args: event.args,
                  categoryId: event.categoryId,
                } satisfies StreamToolCallPayload,
              },
            ],
          },
        ]
      case 'tool-progress':
        return [
          {
            kind: 'events',
            events: [
              {
                type: 'tool-progress',
                payload: {
                  toolCallId: event.toolCallId,
                  chunk: event.chunk,
                  timestamp: event.timestamp,
                } satisfies StreamToolProgressPayload,
              },
            ],
          },
        ]
      case 'tool-metadata':
        return [
          {
            kind: 'events',
            events: [
              {
                type: 'tool-metadata',
                payload: {
                  toolCallId: event.toolCallId,
                  title: event.title,
                  metadata: event.metadata,
                  timestamp: event.timestamp,
                } satisfies StreamToolMetadataPayload,
              },
            ],
          },
        ]
      case 'tool-done':
        return [
          {
            kind: 'events',
            events: [
              {
                type: 'tool-result',
                payload: {
                  toolCallId: event.toolCallId,
                  result: event.result,
                  error: event.error,
                  effects: event.effects,
                  evidence: event.evidence,
                  modelImage: event.modelImage,
                } satisfies StreamToolResultPayload,
              },
            ],
          },
        ]
      case 'notice':
        return [
          {
            kind: 'events',
            events: [{ type: 'notice', kind: event.kind, payload: event.payload }],
          },
        ]
    }
  }

  public mapExecutionDebug(payload: StreamDebugPayload): ChatStreamEvent[] {
    return [{ type: 'debug', payload }]
  }

  public mapExecutionState(payload: StreamStatePayload): ChatStreamEvent[] {
    return [{ type: 'state', payload }]
  }

  private readAgentEventObservability(event: AgentEvent): StreamObservabilityEntry[] {
    if (event.type !== 'runtime' || event.payload.kind !== 'aborted') return []

    return [
      {
        level: 'info',
        message: 'stream aborted',
        context: {
          code: event.payload.code,
          message: event.payload.message,
          executionId: event.payload.executionId,
        },
      },
    ]
  }

  private readStreamEventObservability(event: ChatStreamEvent): StreamObservabilityEntry[] {
    if (event.type !== 'error') return []

    return [
      {
        level: 'error',
        message: 'stream failed',
        context: {
          code: event.payload.code,
          message: event.payload.message,
          errorContext: toOptional(event.payload.context),
        },
      },
    ]
  }
}

/** 进程内共享的无状态协议实例。 */
export const chatStreamProtocol = new ChatStreamProtocol()
