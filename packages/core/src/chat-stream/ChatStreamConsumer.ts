import type { ChatStreamEvent } from '../types'

import { type ChatStreamProtocol,chatStreamProtocol } from './ChatStreamProtocol'
import type {
  ChatStreamLifecyclePhase,
  ChatStreamLogEntry,
  ChatStreamTerminationReason,
} from './types'

/**
 * 渲染进程消费侧：IPC 流生命周期、`applied sequence` 去重、后台待处理队列。
 * 不存快照日志（主进程侧 {@link ChatStreamSessionLog} 负责）。
 */
export class ChatStreamConsumer {
  readonly sessionId: string

  private phase: ChatStreamLifecyclePhase
  private terminationReason: Nullable<ChatStreamTerminationReason> = null
  private appliedSequence = 0
  private pendingEntries: ChatStreamLogEntry[] = []
  private readonly protocol: ChatStreamProtocol

  constructor(
    sessionId: string,
    options: { initialPhase?: ChatStreamLifecyclePhase; protocol?: ChatStreamProtocol } = {}
  ) {
    this.sessionId = sessionId
    this.phase = options.initialPhase ?? 'idle'
    this.protocol = options.protocol ?? chatStreamProtocol
  }

  get lifecyclePhase(): ChatStreamLifecyclePhase {
    return this.phase
  }

  get isActive(): boolean {
    return this.phase === 'streaming'
  }

  get wasUserAborted(): boolean {
    return this.terminationReason === 'user_abort'
  }

  /** True when a disconnect/reconnect may revive streaming UI for this session. */
  get mayRecoverFromDisconnect(): boolean {
    return !this.wasUserAborted && this.phase !== 'terminal'
  }

  get latestAppliedSequence(): number {
    return this.appliedSequence
  }

  public activate(): void {
    if (this.wasUserAborted) return

    this.phase = 'streaming'
  }

  public prepareForStreamStart(): void {
    this.pendingEntries = []
    this.appliedSequence = 0
    this.phase = 'streaming'
    this.terminationReason = null
  }

  public markUserAborted(): void {
    this.phase = 'terminal'
    this.terminationReason = 'user_abort'
  }

  public markTerminal(reason: Exclude<ChatStreamTerminationReason, 'user_abort'> = 'completed'): void {
    if (this.wasUserAborted) return

    this.phase = 'terminal'
    this.terminationReason = reason
  }

  public resetToIdle(): void {
    this.phase = 'idle'
    this.pendingEntries = []
    this.terminationReason = null
  }

  public acceptAppliedSequence(sequence?: number): boolean {
    if (!Number.isFinite(sequence)) return true

    const next = Math.floor(sequence as number)
    if (next <= this.appliedSequence) return false

    this.appliedSequence = next
    return true
  }

  /**
   * 终止事件序号 `sequence` 之前是否还有未应用的增量（appliedSequence < sequence-1）。
   *
   * delta 与 end/done 走两条独立 IPC 通道、共用同一单调序号；终止事件可能抢先于
   * 最后几段文本 delta 到达。出现缺口时应延迟收尾，等尾部 delta 补齐再 finalize，
   * 否则尾部内容会被当作"非 streaming 的迟到输入"丢弃（永久截断）。
   */
  public hasSequenceGapBefore(sequence?: number): boolean {
    if (!Number.isFinite(sequence)) return false
    return this.appliedSequence < Math.floor(sequence as number) - 1
  }

  public enqueuePendingDelta(sequence: number, text: string): void {
    this.pendingEntries.push({ kind: 'delta', sequence, text })
  }

  public enqueuePendingEvent(sequence: number, event: ChatStreamEvent): void {
    this.pendingEntries.push({ kind: 'event', sequence, event })
    if (this.protocol.isTerminalEvent(event)) {
      this.markTerminal(event.type === 'error' ? 'failed' : 'completed')
    }
  }

  public drainPending(): ChatStreamLogEntry[] {
    const pending = this.pendingEntries
    this.pendingEntries = []
    return pending
  }
}
