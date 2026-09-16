import type { SerializedError } from '@velaros-ai/core/error'

import type { AgentEvent, ChatStreamEvent, StreamDebugPayload, StreamDonePayload, StreamErrorPayload, StreamFailureRuntimeStateKind, StreamReasoningPayload, StreamStateKind, StreamStatePayload, StreamToolCallPayload, StreamToolMetadataPayload, StreamToolProgressPayload, StreamToolResultPayload, TerminalStreamRuntimeStateKind } from '../../types/agent'
import type { AgentBridgeDispatch, AgentBridgeOutput, TerminalRuntimeExecutionAction } from '../../types/chat.js'
import { readAgentEventObservability, readStreamEventObservability } from '../../utils/chat/stream-observability'
import { ALL_STREAM_RUNTIME_STATE_KINDS, STREAM_FAILURE_RUNTIME_STATE_KINDS, TERMINAL_STREAM_RUNTIME_STATE_KINDS } from '../../utils/wire/chat-runtime.js'

/**
 * Chat stream 协议面：一套关于「流走到哪儿了」的判定与翻译规则——判终态、把 runtime payload
 * 物化成要投出去的事件、把 AgentEvent 翻成渲染进程收的 IPC 输出。
 *
 * 它不记任何一条会话的状态，所以全进程共用一个实例（`chatStreamProtocol`）即可；
 * 带状态的那半边在 `ChatStreamSessionLog`（主进程侧追加日志）和 `ChatStreamConsumer`
 * （渲染进程侧生命周期）里。实现是 `ChatStreamProtocol`。
 */
export interface ChatStreamProtocolApi {
  /** 会让流收尾的三种 runtime kind（done / aborted / error）；调用方拿它做穷举校验，不要改动内容。 */
  readonly terminalRuntimeKinds: readonly TerminalStreamRuntimeStateKind[]
  /** 算作「这轮失败了」的 runtime kind（error / aborted）；用来抑制重复的 error 广播。 */
  readonly failureRuntimeKinds: readonly StreamFailureRuntimeStateKind[]
  /** 协议认得的全部 runtime kind；契约测试与 bridge 的 exhaustive switch 靠它兜底。 */
  readonly allRuntimeKinds: readonly StreamStateKind[]
  /** 判断某个 runtime kind 是不是终态；返回 true 表示这条之后不会再有同一轮的事件。 */
  isTerminalRuntimeKind(kind: StreamStateKind): kind is TerminalStreamRuntimeStateKind
  /** 判断某个 runtime kind 是不是失败态（error / aborted），用于决定要不要再往上报一次错。 */
  isFailureRuntimeKind(kind: StreamStateKind): kind is StreamFailureRuntimeStateKind
  /** 判断一条 runtime payload 是不是正常收尾的 `done`，收窄成 `StreamDonePayload` 好取里面的结论字段。 */
  isDonePayload(payload: StreamStatePayload): payload is StreamDonePayload
  /** 判断一条 IPC 事件是不是终止事件：`end`、`error`，或者载着终态 kind 的 `state`。 */
  isTerminalEvent(event: ChatStreamEvent): boolean
  /** 判断一条 IPC 事件是不是收口标记 `end`；收到它才算这条流的通道关上了。 */
  isCloseMarkerEvent(event: ChatStreamEvent): boolean
  /** 判断一条 AgentEvent 是不是失败态的 runtime 事件。 */
  isFailureAgentEvent(event: AgentEvent): boolean
  /** 从 AgentEvent 里取终态 kind；不是 runtime 事件、或者不是终态时返回 null。 */
  readTerminalKindFromAgent(event: AgentEvent): Nullable<TerminalStreamRuntimeStateKind>
  /** 把终态 kind 翻成执行侧该做的收尾动作：done→complete、aborted→abort、error→fail。 */
  resolveExecutionAction(kind: TerminalStreamRuntimeStateKind): TerminalRuntimeExecutionAction
  /**
   * 把一条 runtime payload 物化成要按序投出去的 IPC 事件。终态会额外补一条 `end` 收口，
   * `error` 还要先经 `toSerializedError` 把错误压成可跨进程传的形状；遇到不认得的 kind 直接抛错。
   */
  materializeRuntimeEvents(
    payload: StreamStatePayload,
    toSerializedError: (payload: StreamErrorPayload) => SerializedError
  ): ChatStreamEvent[]
  /**
   * StreamBridge 的唯一入口：一条 AgentEvent 进来，出去的是该投的 IPC 输出加上该落的日志条目。
   * 日志既取自 AgentEvent 本身（中止），也取自翻译出来的事件（失败）。
   */
  bridgeAgentEvent(
    event: AgentEvent,
    options: {
      /** 把 error payload 压成可跨进程传输的序列化错误；由持有错误映射表的那一层提供。 */
      toSerializedError: (payload: StreamErrorPayload) => SerializedError
    }
  ): AgentBridgeDispatch
  /**
   * 只做 AgentEvent → IPC 输出的翻译，不带日志。文本增量走 `delta` 通道，其余一律包成 `events`。
   * 这里是 exhaustive switch：AgentEvent 加了新类型而没在这儿接上，编译期就会报。
   */
  mapAgentEvent(
    event: AgentEvent,
    options: {
      /** 把 error payload 压成可跨进程传输的序列化错误；由持有错误映射表的那一层提供。 */
      toSerializedError: (payload: StreamErrorPayload) => SerializedError
    }
  ): AgentBridgeOutput[]
  /** 把执行侧的调试 payload 包成一条 `debug` 事件；只给开发面板看，不进模型历史。 */
  mapExecutionDebug(payload: StreamDebugPayload): ChatStreamEvent[]
  /** 把执行侧直接给出的 runtime payload 包成一条 `state` 事件；不做终态判定，也不补 `end`。 */
  mapExecutionState(payload: StreamStatePayload): ChatStreamEvent[]
}

export class ChatStreamProtocol implements ChatStreamProtocolApi {
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
      case 'input-applied':
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
        throw new Error(`没有处理的流式运行态：${String(payload)}；给 StreamStatePayload 加了新的 kind 之后，这里的分支要同步补上。`)
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
      ...readAgentEventObservability(event),
      ...outputs.flatMap((output) =>
        output.kind === 'events'
          ? output.events.flatMap((streamEvent) => readStreamEventObservability(streamEvent))
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
                  modelImage: event.modelImage,
                  modelContent: event.modelContent,
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
}

/** 进程内共享的无状态协议实例。 */
export const chatStreamProtocol: ChatStreamProtocolApi = new ChatStreamProtocol()
