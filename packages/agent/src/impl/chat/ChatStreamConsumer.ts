
import type { ChatStreamEvent } from '../../types/agent.js'
import type { ChatStreamLifecyclePhase, ChatStreamLogEntry, ChatStreamTerminationReason } from '../../types/chat.js'

import { type ChatStreamProtocol,chatStreamProtocol } from './ChatStreamProtocol'

/**
 * 渲染进程消费侧的一条流的账本：记这条会话的流走到哪个生命周期阶段、终止是谁造成的、
 * 已经应用到界面上的序号到哪儿了，以及会话不在前台时先攒着的待处理条目。
 *
 * 一条会话一个实例，随会话建、随会话弃；只在渲染进程内存里，不落盘。
 * 主进程侧那半边（可重放的快照日志）在 `ChatStreamSessionLog` 里，两者不共享状态。
 * 实现是 `ChatStreamConsumer`。
 */
export interface ChatStreamConsumerApi {
  /** 这条流属于哪条会话；建实例时定死，后续所有事件都按它归位。 */
  readonly sessionId: string
  /** 当前生命周期阶段：`idle` 没在跑、`streaming` 正在收、`terminal` 已收尾。 */
  readonly lifecyclePhase: ChatStreamLifecyclePhase
  /** 是否正在流式接收；界面靠它决定要不要显示「正在输出」。 */
  readonly isActive: boolean
  /** 这条流是不是被用户主动打断的；用户打断是终局，任何事件都不能把它重新拉起来。 */
  readonly wasUserAborted: boolean
  /** 断线重连后这条流还有没有可能继续：只要不是用户打断、也没走到终态，就还有。 */
  readonly mayRecoverFromDisconnect: boolean
  /** 已经应用到界面上的最大序号；小于等于它的增量都是重放，要丢掉。 */
  readonly latestAppliedSequence: number
  /** 收到「流还活着」的信号时切回 streaming；用户已经打断过就什么都不做。 */
  activate(): void
  /** 新一轮开流前清场：清空待处理队列、已应用序号归零、阶段切 streaming、终止原因清掉。 */
  prepareForStreamStart(): void
  /** 记下这条流是被用户打断的，并直接落到终态；此后 `markTerminal` / `activate` 都不再生效。 */
  markUserAborted(): void
  /**
   * 把流标成终态并记下原因（缺省 `completed`）。用户打断优先级最高，已经打断过就忽略这次调用，
   * 免得迟到的 end/error 事件把「用户打断」改写成「正常结束」。
   */
  markTerminal(reason?: Exclude<ChatStreamTerminationReason, 'user_abort'>): void
  /** 回到 `idle`：清空待处理队列与终止原因，但保留已应用序号，供会话切走再切回时复用。 */
  resetToIdle(): void
  /**
   * 认领一个增量序号：比已应用的大就往前推游标并返回 true（这条可以应用），
   * 否则返回 false（重放，丢掉）。序号不是有限数时按 true 放行，兼容没带序号的老事件。
   */
  acceptAppliedSequence(sequence?: number): boolean
  /**
   * 终止事件序号 `sequence` 之前是否还有未应用的增量（appliedSequence < sequence-1）。
   *
   * delta 与 end/done 走两条独立 IPC 通道、共用同一单调序号；终止事件可能抢先于
   * 最后几段文本 delta 到达。出现缺口时应延迟收尾，等尾部 delta 补齐再 finalize，
   * 否则尾部内容会被当作"非 streaming 的迟到输入"丢弃（永久截断）。
   */
  hasSequenceGapBefore(sequence?: number): boolean
  /** 把一段还不能立刻应用的文本增量按序号压进待处理队列。 */
  enqueuePendingDelta(sequence: number, text: string): void
  /** 把一条还不能立刻应用的流事件压进待处理队列；是终止事件的话顺手把阶段落到终态。 */
  enqueuePendingEvent(sequence: number, event: ChatStreamEvent): void
  /** 取走并清空待处理队列，按入队顺序返回；调用方负责逐条应用。 */
  drainPending(): ChatStreamLogEntry[]
}

export class ChatStreamConsumer implements ChatStreamConsumerApi {
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
