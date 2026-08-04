import type {
  ChatStreamDeltaEnvelope,
  ChatStreamEvent,
  ChatStreamEventEnvelope,
  ChatStreamSnapshot,
} from '@velaros-ai/agent/protocol'

import { type ChatStreamProtocol,chatStreamProtocol } from './ChatStreamProtocol'
import type { ChatStreamLogEntry } from './types'

const DEFAULT_LOG_CAPACITY = 10_000

/**
 * 主进程快照专用：仅追加会话日志 + 追加序号。
 * 不含渲染进程消费侧生命周期 / 待处理队列 / 已应用游标。
 */
export class ChatStreamSessionLog {
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
    this.maxEntries = options.maxEntries ?? DEFAULT_LOG_CAPACITY
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
