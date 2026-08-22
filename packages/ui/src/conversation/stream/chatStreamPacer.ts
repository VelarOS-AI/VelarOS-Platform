/**
 * 聊天流式起搏器：单个会话使用一条动画帧链，并在块级串行门控。
 *
 * 后端会把思考、工具与正文按令牌交错下发。起搏器策略：
 *
 *  - **思考、正文、工具与结构事件全部归并成同一条先进先出块队列**：每帧只渲染队首块，
 *    思考与正文都按字符预算逐帧吐字、工具/结构事件逐帧应用一个；队首吐空且后面有更新块时出队。
 *    思考也进入同一队列，去重后入块，不再为每个令牌立即应用全量更新。这会消除思考流与正文
 *    并发抢渲染所造成的卡顿与闪现；代价是思考与正文按到达
 *    顺序串行逐帧吐（模型通常先想后写，因此基本是先把思考打完再打正文）。
 *  - 队首块若仍是最后一个块（还在持续接收），就保持直播逐帧吐。
 *  - 文本按真实经过时间累计字符额度；积压只温和提高每秒速率，不能放大单帧吐字量。
 *    长帧恢复时也有严格单帧上限，不会为了“追赶”突然冒出一整段。
 *  - **正常结束时平滑收尾**：先挂起为 `pendingTerminal`，等队列积压逐帧吐完后才完成，避免正文
 *    一次性闪现；错误、中止和等待等其他终止或交互事件仍会立即排空应用。
 */
import { resolveStreamPaceBudget, type StreamPaceTuning } from './streamPaceBudget'

import type { ChatStreamEvent } from '#contracts'
import { isEmpty, isPresent } from '#internal/runtime'

export interface FrameLeasePort {
  cancel(): boolean
}

export interface FrameTimerPort {
  nextFrame(
    callback: FrameRequestCallback,
    options?: { label?: string; signal?: AbortSignal }
  ): FrameLeasePort
}

const ImmediateStreamStateKinds = new Set([
  'aborted',
  'awaiting-confirmation',
  'awaiting-input',
  'error',
  'retrying-turn',
])

/** 需要绕过起搏、立即排空并应用的终止/交互类事件。 */
export function shouldApplyStreamEventImmediately(event: ChatStreamEvent): boolean {
  switch (event.type) {
    case 'end':
    case 'error':
      return true
    case 'debug':
      return event.payload.kind === 'turn-context'
    case 'state':
      return ImmediateStreamStateKinds.has(event.payload.kind)
    case 'notice':
      return event.kind === 'user-action-card'
    default:
      return false
  }
}

interface PacerTextBlock {
  kind: 'text'
  key: string
  /** 块起始 sequence，用于跨通道按全局序插入。 */
  seq: number
  /** 是否已开始渲染（已开始的块不可被后到的更小 seq 块插队到前面）。 */
  started?: boolean
  /** 尚未吐出的文本。 */
  pendingChars: string
}

interface PacerReasoningBlock {
  kind: 'reasoning'
  key: string
  seq: number
  started?: boolean
  reasoningId: string
  /** 尚未吐出的思考文本（增量去重在 state.reasoningRawText 完成）。 */
  pendingChars: string
}

interface PacerEventBlock<TEvent extends ChatStreamEvent> {
  kind: 'event'
  key: string
  seq: number
  started?: boolean
  events: TEvent[]
}

type PacerBlock<TEvent extends ChatStreamEvent> =
  PacerTextBlock | PacerReasoningBlock | PacerEventBlock<TEvent>

interface PacerSessionState<TEvent extends ChatStreamEvent> {
  blocks: Array<PacerBlock<TEvent>>
  frame: Nullable<FrameLeasePort>
  /** 平滑收尾：挂起的终止事件（done/end）；积压逐帧吐完后才应用（finalize），避免一次性闪现。 */
  pendingTerminals: TEvent[]
  /** reasoning 不进 FIFO、立即应用；这里按 id 记录已登记原文用于增量去重。 */
  reasoningRawText: Map<string, string>
  /** 上一帧时间；空闲时重置，防止把后台停顿累计成下一次突发额度。 */
  lastFrameTimeMs: Nullable<number>
  /** 不足一个字符的额度跨帧结转；上限由 tuning.maxCharsPerFrame 约束。 */
  charCredit: number
}

/** 干净收尾事件（end / done）——平滑吐完积压后再 finalize，而非立即强排空。 */
function isSmoothDrainTerminalEvent(event: ChatStreamEvent): boolean {
  return event.type === 'end' || (event.type === 'state' && event.payload.kind === 'done')
}

export interface ChatStreamPacerOptions<TEvent extends ChatStreamEvent> {
  timers: FrameTimerPort
  tuning?: StreamPaceTuning
  /** 把一段正文增量应用到 session（htmlArtifact 感知）。 */
  applyTextChunk: (sessionId: string, text: string) => void
  applyDeferredLiveEvent: (sessionId: string, event: TEvent) => void
  applyImmediateLiveEvent: (sessionId: string, event: TEvent) => void
  applyCachedEvent: (sessionId: string, event: TEvent) => void
  /** 直写正文：追加进 pending 缓冲并立即释放（awaiting 态用）。 */
  appendImmediateText: (sessionId: string, text: string) => void
  isSessionStreaming: (sessionId: string) => boolean
  /**
   * 思考增量去重：给定同 id 已登记原文与本次到达原文，返回需追加的增量文本。
   * 由宿主注入（desktop 侧对应 state 层 `getReasoningAppendText`），使起搏器保持纯净、
   * 不反依 desktop 状态半壁。
   */
  getReasoningAppendText: (previousRawText: string, incomingRawText: string) => string
}

function isToolEvent(
  event: ChatStreamEvent
): event is Extract<ChatStreamEvent, { payload: { toolCallId: string } }> {
  return (
    event.type === 'tool-call' ||
    event.type === 'tool-progress' ||
    event.type === 'tool-metadata' ||
    event.type === 'tool-result'
  )
}

function blockPendingCharCount(block: PacerBlock<ChatStreamEvent>): number {
  return block.kind === 'event' ? 0 : block.pendingChars.length
}

function blockIsDrained(block: PacerBlock<ChatStreamEvent>): boolean {
  return block.kind === 'event' ? isEmpty(block.events) : isEmpty(block.pendingChars)
}

export class ChatStreamPacer<TEvent extends ChatStreamEvent = ChatStreamEvent> {
  private readonly sessions = new Map<string, PacerSessionState<TEvent>>()

  constructor(private readonly options: ChatStreamPacerOptions<TEvent>) {}

  /** live 正文增量入块。 */
  public enqueueText(sessionId: string, sequence: number, text: string): void {
    if (!text) return

    const state = this.getSessionState(sessionId)
    const last = state.blocks.at(-1)
    if (last?.kind === 'text') {
      last.pendingChars += text
    } else {
      this.insertBlock(state, {
        kind: 'text',
        key: `text:${sequence}`,
        seq: sequence,
        pendingChars: text,
      })
    }
    this.scheduleSession(sessionId, state)
  }

  /** live 结构事件入块（终止类平滑收尾 / 立即应用）。 */
  public enqueueLiveEvent(sessionId: string, sequence: number, event: TEvent): void {
    // 干净收尾（end/done）：挂起，等队列里积压的 tool/text 逐帧吐完再 finalize，
    // 而非立即强排空导致正文一次性闪现。
    if (isSmoothDrainTerminalEvent(event)) {
      const state = this.getSessionState(sessionId)
      state.pendingTerminals.push(event)
      this.scheduleSession(sessionId, state)
      return
    }

    // error / aborted / awaiting-* / notice / turn-context 仍需立即处理。
    if (shouldApplyStreamEventImmediately(event)) {
      this.applyImmediateEvent(sessionId, event)
      return
    }

    const state = this.getSessionState(sessionId)

    if (event.type === 'reasoning') {
      // 思考也进 FIFO，与正文/工具按到达顺序串行逐帧吐字：先按 id 去重只取增量，
      // 再并入队列（同 id 续接到末尾的思考块），消除"思考每 token 立即全量 apply"
      // 与被起搏的正文并发抢渲染导致的卡顿/闪现。
      const previousRaw = state.reasoningRawText.get(event.payload.id) ?? ''
      const appendText = this.options.getReasoningAppendText(previousRaw, event.payload.text)
      if (!appendText) return

      state.reasoningRawText.set(event.payload.id, previousRaw + appendText)
      const reasoningKey = `reasoning:${event.payload.id}`
      const last = state.blocks.at(-1)
      if (last?.kind === 'reasoning' && last.key === reasoningKey) {
        last.pendingChars += appendText
      } else {
        this.insertBlock(state, {
          kind: 'reasoning',
          key: reasoningKey,
          seq: sequence,
          reasoningId: event.payload.id,
          pendingChars: appendText,
        })
      }
      this.scheduleSession(sessionId, state)
      return
    }

    if (isToolEvent(event)) {
      const toolKey = `tool:${event.payload.toolCallId}`
      const last = state.blocks.at(-1)
      if (last?.kind === 'event' && last.key === toolKey) {
        last.events.push(event)
      } else {
        this.insertBlock(state, {
          kind: 'event',
          key: toolKey,
          seq: sequence,
          events: [event],
        })
      }
      this.scheduleSession(sessionId, state)
      return
    }

    // 其它结构事件（worker-thread / notice / debug / 非终止 state）各自成块。
    this.insertBlock(state, {
      kind: 'event',
      key: `event:${sequence}`,
      seq: sequence,
      events: [event],
    })
    this.scheduleSession(sessionId, state)
  }

  /**
   * 按全局 sequence 把新块插到正确位置：永不插到正在渲染的队首之前，
   * 在未开始渲染的尾部区间里保持 seq 升序，消除两条 IPC 通道抖动导致的块错序。
   */
  private insertBlock(state: PacerSessionState<TEvent>, block: PacerBlock<TEvent>): void {
    const lowerBound = state.blocks[0]?.started ? 1 : 0
    let index = state.blocks.length
    while (index > lowerBound && state.blocks[index - 1].seq > block.seq) index -= 1
    if (index < lowerBound) index = lowerBound
    state.blocks.splice(index, 0, block)
  }

  public clearSession(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (!state) return

    state.frame?.cancel()
    this.sessions.delete(sessionId)
  }

  /**
   * 单一顺序权威——绕过起搏节奏的直写统一入口。
   *
   * awaiting / 已停会话的事件与正文不进帧队列，但仍必须排在起搏器现有积压之后：先
   * flushImmediate 把 backlog 按全局序排空（无积压时为空操作），再落本次直写。由此
   * 「listen 分类 → pacer 执行」成为唯一写入序，杜绝起搏帧与直写并发抢渲染的错位。
   */
  public applyCachedInOrder(sessionId: string, event: TEvent): void {
    this.flushImmediate(sessionId)
    this.options.applyCachedEvent(sessionId, event)
  }

  public appendTextInOrder(sessionId: string, text: string): void {
    this.flushImmediate(sessionId)
    this.options.appendImmediateText(sessionId, text)
  }

  /** 立即按序排空全部块并应用（中断 / 持久化收尾用）。 */
  public flushImmediate(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (!state) return

    state.frame?.cancel()
    state.frame = null
    this.flushAllBlocks(sessionId, state)
    this.sessions.delete(sessionId)
  }

  private applyImmediateEvent(sessionId: string, event: TEvent): void {
    const state = this.sessions.get(sessionId)
    if (state) {
      state.frame?.cancel()
      state.frame = null
      this.flushAllBlocks(sessionId, state)
    }

    this.options.applyImmediateLiveEvent(sessionId, event)
    this.clearSession(sessionId)
  }

  private emitBlockChunk(
    sessionId: string,
    block: PacerTextBlock | PacerReasoningBlock,
    maxChars: number
  ): number {
    const emit = block.pendingChars.slice(0, Math.max(1, maxChars))
    if (!emit) return 0
    block.pendingChars = block.pendingChars.slice(emit.length)

    if (block.kind === 'text') {
      this.options.applyTextChunk(sessionId, emit)
    } else {
      this.options.applyDeferredLiveEvent(sessionId, {
        type: 'reasoning',
        payload: { id: block.reasoningId, text: emit },
      } as TEvent)
    }

    return emit.length
  }

  private flushAllBlocks(sessionId: string, state: PacerSessionState<TEvent>): void {
    const streaming = this.options.isSessionStreaming(sessionId)

    for (const block of state.blocks) {
      if (block.kind === 'text') {
        if (block.pendingChars) this.options.applyTextChunk(sessionId, block.pendingChars)
        block.pendingChars = ''
        continue
      }

      if (block.kind === 'reasoning') {
        if (block.pendingChars) {
          const event = {
            type: 'reasoning',
            payload: { id: block.reasoningId, text: block.pendingChars },
          } as TEvent
          if (streaming) this.options.applyDeferredLiveEvent(sessionId, event)
          else this.options.applyCachedEvent(sessionId, event)
        }
        block.pendingChars = ''
        continue
      }

      while (!isEmpty(block.events)) {
        const event = block.events.shift()
        if (!event) continue
        if (streaming) this.options.applyDeferredLiveEvent(sessionId, event)
        else this.options.applyCachedEvent(sessionId, event)
      }
    }

    state.blocks = []
  }

  private flushSession(sessionId: string, frameTimeMs: number): void {
    const state = this.sessions.get(sessionId)
    if (!state) return

    state.frame = null

    if (!this.options.isSessionStreaming(sessionId)) {
      // 会话已被外部收尾（如中断）：排空并丢弃挂起的终止事件（已由别处 finalize）。
      this.flushAllBlocks(sessionId, state)
      this.clearSession(sessionId)
      return
    }

    // 平滑收尾中（已收到 end/done）：连最后一个吐空的块也出队，直至队列排空再 finalize。
    const draining = !isEmpty(state.pendingTerminals)
    while (state.blocks.length > (draining ? 0 : 1) && blockIsDrained(state.blocks[0])) {
      state.blocks.shift()
    }

    if (isEmpty(state.blocks)) {
      // 积压逐帧吐完 → 此刻才应用挂起的终止事件（finalize），正文不再一次性闪现。
      this.applyPendingTerminals(sessionId, state)
      this.sessions.delete(sessionId)
      return
    }

    const backlogChars = state.blocks.reduce((sum, block) => sum + blockPendingCharCount(block), 0)
    const backlogEvents = state.blocks.reduce(
      (sum, block) => sum + (block.kind === 'event' ? block.events.length : 0),
      0
    )
    const elapsedMs = isPresent(state.lastFrameTimeMs)
      ? Math.max(0, frameTimeMs - state.lastFrameTimeMs)
      : undefined
    state.lastFrameTimeMs = frameTimeMs
    const budget = resolveStreamPaceBudget({ backlogChars, backlogEvents }, this.options.tuning, {
      elapsedMs,
      carriedCharCredit: state.charCredit,
    })
    state.charCredit = budget.availableCharCredit

    const front = state.blocks[0]
    front.started = true
    if (front.kind === 'event') {
      let applied = 0
      while (applied < budget.eventBudget && !isEmpty(front.events)) {
        const event = front.events.shift()
        if (event) {
          this.options.applyDeferredLiveEvent(sessionId, event)
          applied += 1
        }
      }
    } else if (budget.charBudget > 0) {
      const emittedChars = this.emitBlockChunk(sessionId, front, budget.charBudget)
      state.charCredit = Math.max(0, state.charCredit - emittedChars)
    }

    // 队首已收尾且吐空则出队。
    if (state.blocks.length > 1 && blockIsDrained(state.blocks[0])) {
      state.blocks.shift()
    }

    this.rescheduleIfPending(sessionId, state)
  }

  private rescheduleIfPending(sessionId: string, state: PacerSessionState<TEvent>): void {
    const hasPending = state.blocks.some(
      (block) =>
        blockPendingCharCount(block) > 0 || (block.kind === 'event' && !isEmpty(block.events))
    )
    // 平滑收尾中即使队首已吐空也要继续排帧，下一帧出队收尾块并应用终止事件。
    if (hasPending || !isEmpty(state.pendingTerminals)) {
      this.scheduleSession(sessionId, state)
      return
    }

    // 仍有一个直播中的空队首块时保留 state（供后续增量并入），但不空转排帧。
    state.lastFrameTimeMs = null
    state.charCredit = 0
    if (isEmpty(state.blocks)) this.sessions.delete(sessionId)
  }

  private getSessionState(sessionId: string): PacerSessionState<TEvent> {
    let state = this.sessions.get(sessionId)
    if (!state) {
      state = {
        blocks: [],
        frame: null,
        pendingTerminals: [],
        reasoningRawText: new Map(),
        lastFrameTimeMs: null,
        charCredit: 0,
      }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  private applyPendingTerminals(sessionId: string, state: PacerSessionState<TEvent>): void {
    while (!isEmpty(state.pendingTerminals)) {
      const terminal = state.pendingTerminals.shift()
      if (terminal) this.options.applyImmediateLiveEvent(sessionId, terminal)
    }
  }

  private scheduleSession(sessionId: string, state: PacerSessionState<TEvent>): void {
    if (isPresent(state.frame)) return

    state.frame = this.options.timers.nextFrame(
      (frameTimeMs) => this.flushSession(sessionId, frameTimeMs),
      {
        label: `stream.pace.flush:${sessionId}`,
      }
    )
  }
}
