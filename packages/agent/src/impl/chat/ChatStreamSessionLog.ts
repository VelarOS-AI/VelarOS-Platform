
import type { ChatStreamDeltaEnvelope, ChatStreamEvent, ChatStreamEventEnvelope, ChatStreamSnapshot } from '../../types/agent.js'
import type { ChatStreamLogEntry } from '../../types/chat.js'
import { AgentTuning } from '../../utils/tuning'

import { type ChatStreamProtocol,chatStreamProtocol } from './ChatStreamProtocol'

/**
 * 主进程侧一条会话流的只追加日志：每投出一段增量或一条事件，就按单调递增的序号留一份，
 * 供渲染进程断线重连后按「我已经收到第几号」取增量快照补齐。
 *
 * 一条会话一个实例，随会话建、随会话弃，只在主进程内存里，超过容量从最早的条目开始丢。
 * 它只管「记了什么、记到第几号、通道关没关」；渲染进程那半边的生命周期与待处理队列在
 * `ChatStreamConsumer` 里，两者不共享状态。实现是 `ChatStreamSessionLog`。
 */
export interface ChatStreamSessionLogApi {
  /** 这份日志属于哪条会话；建实例时定死，投出去的每个信封都盖上它。 */
  readonly sessionId: string
  /** 通道还开着没有：收到终止事件前一直是 true，收到后永久变 false，直到 `restart()`。 */
  readonly isOpen: boolean
  /** 目前发出去的最大序号；渲染进程拿它和自己已应用的序号比，判断有没有落下的。 */
  readonly latestSequence: number
  /** 新一轮开流：重开通道并清空已存条目，但序号接着往下发，不从头开始。 */
  restart(): void
  /** 记一段文本增量并分配下一个序号，返回要投给渲染进程的信封；超容量时挤掉最早的条目。 */
  appendDelta(text: string): ChatStreamDeltaEnvelope
  /**
   * 记一条流事件并分配下一个序号，返回要投出去的信封；是终止事件就顺手关掉通道。
   * `reachedTerminal` 只在这一次调用把通道从开变关时为 true，用来保证收尾动作只做一次。
   */
  appendEvent(event: ChatStreamEvent): {
    /** 要投给渲染进程的事件信封，带 sessionId 与本次分配到的序号。 */
    envelope: ChatStreamEventEnvelope
    /** 是不是这一条把通道关上的；重复的终止事件只有第一条为 true。 */
    reachedTerminal: boolean
  }
  /** 取一份增量快照：只含序号大于 `afterSequence` 的条目，缺省 0 表示从头给。断线重连补齐用。 */
  snapshot(afterSequence?: number): ChatStreamSnapshot
}

export class ChatStreamSessionLog implements ChatStreamSessionLogApi {
  /** 没给上限时一条会话流留多少条，值在 `AgentTuning.stream.sessionLogCapacity`。 */
  private static readonly DefaultLogCapacity = AgentTuning.stream.sessionLogCapacity

  readonly sessionId: string

  private open = true
  private entries: ChatStreamLogEntry[] = []
  private appendSequence = 0
  private readonly maxEntries: number
  private readonly protocol: ChatStreamProtocol

  constructor(
    sessionId: string,
    options: {
      carrySequence?: number
      maxEntries?: number
      protocol?: ChatStreamProtocol
    } = {}
  ) {
    this.sessionId = sessionId
    this.appendSequence = options.carrySequence ?? 0
    this.maxEntries = options.maxEntries ?? ChatStreamSessionLog.DefaultLogCapacity
    this.protocol = options.protocol ?? chatStreamProtocol
  }

  get isOpen(): boolean {
    return this.open
  }

  get latestSequence(): number {
    return this.appendSequence
  }

  public restart(): void {
    this.open = true
    this.entries = []
  }

  public appendDelta(text: string): ChatStreamDeltaEnvelope {
    const sequence = this.nextSequence()
    this.entries = this.trim([...this.entries, { kind: 'delta', sequence, text }])

    return {
      sourceSessionId: this.sessionId,
      text,
      sequence,
    }
  }

  public appendEvent(event: ChatStreamEvent): {
    envelope: ChatStreamEventEnvelope
    reachedTerminal: boolean
  } {
    const wasOpen = this.open
    const sequence = this.nextSequence()
    this.entries = this.trim([...this.entries, { kind: 'event', sequence, event }])
    this.closeIfTerminal(event)

    return {
      envelope: {
        sourceSessionId: this.sessionId,
        event,
        sequence,
      },
      reachedTerminal: wasOpen && !this.open,
    }
  }

  public snapshot(afterSequence = 0): ChatStreamSnapshot {
    return {
      sourceSessionId: this.sessionId,
      isStreaming: this.open,
      latestSequence: this.appendSequence,
      items: this.entries.filter((entry) => entry.sequence > afterSequence),
    }
  }

  private nextSequence(): number {
    this.appendSequence += 1
    return this.appendSequence
  }

  private trim(entries: ChatStreamLogEntry[]): ChatStreamLogEntry[] {
    if (entries.length <= this.maxEntries) return entries

    return entries.slice(entries.length - this.maxEntries)
  }

  private closeIfTerminal(event: ChatStreamEvent): void {
    if (this.open && this.protocol.isTerminalEvent(event)) {
      this.open = false
    }
  }
}
