import { randomUUID } from 'node:crypto'

import { isString } from '@velaros-ai/core'

import type { AgentSessionEventPort } from '../../contract/requires.js'
import type { AgentQuestionRequest, AskAgentQuestionInput, PendingQuestion, QuestionListener } from '../../types/product-session.js'
import { isQuestionRequest, isRecord } from '../../utils/product-session/agent-question-service'

/**
 * 模型向用户提问的通道：`ask` 返回的 Promise 一直挂着，直到用户在界面上选了答案（`resolve`）或这个会话被取消（`rejectSession`）。
 * 待答问题只在内存里（进程重启就没了），问答过程同时写进会话事件流，所以重启后可以靠 `recoverUnresolvedRequests` 把悬空的问题补一条拒绝事件收尾。
 *
 * 实现是 `AgentQuestionService`，产品侧会话层持一份；订阅者拿到的永远是全量待答列表快照。
 */
export interface AgentQuestionServiceApi {
  /** 当前所有还没答的问题，按提问时间从早到晚排序；界面按这个顺序渲染。 */
  listPending(): readonly AgentQuestionRequest[]
  /** 订阅待答问题列表：订阅时立刻回调一次当前快照，之后每次增删都回调。返回的函数用来退订。 */
  subscribe(listener: QuestionListener): () => void
  /** 提一个问题并等用户回答：问题文本压掉多余空白后不能为空，去重后的选项必须是 2 到 4 个，否则同步抛错。返回的 Promise 在用户作答时以答案字符串兑现，会话被取消时以 `Error` 拒绝。 */
  ask(input: AskAgentQuestionInput): Promise<string>
  /** 用一个答案结掉某个待答问题：问题已经不在待答表里、答案为空、或问题不允许自由作答而答案不在选项里，都抛错。成功时追加 `question.resolved` 事件并返回规范化后的答案。 */
  resolve(requestId: string, answer: string): string
  /** 取消这个会话上所有待答问题：逐条追加 `question.rejected` 事件，并让对应的 `ask` Promise 以 `reason` 拒绝。`reason` 会被用户看到。 */
  rejectSession(sessionId: string, reason?: string): void
  /** 进程重启后收尾：扫会话事件流，给提过但没有结果的问题各补一条 `question.rejected`，返回补了几条。事件 id 固定带 `:recovery` 后缀，重复调用不会重复补。 */
  recoverUnresolvedRequests(sessionId: string): number
}

export class AgentQuestionService implements AgentQuestionServiceApi {
  private readonly pending = new Map<string, PendingQuestion>()
  private readonly listeners = new Set<QuestionListener>()

  public constructor(private readonly sessions: AgentSessionEventPort) {}

  public listPending(): readonly AgentQuestionRequest[] {
    return [...this.pending.values()]
      .map((entry) => entry.request)
      .sort((left, right) => left.createdAt - right.createdAt)
  }

  public subscribe(listener: QuestionListener): () => void {
    this.listeners.add(listener)
    listener(this.listPending())
    return () => this.listeners.delete(listener)
  }

  public ask(input: AskAgentQuestionInput): Promise<string> {
    const question = input.question.replace(/\s+/gu, ' ').trim()
    if (!question) throw new Error('问题文本不能为空：压掉多余空白后至少要留下一句用户能看懂的问话。')
    const options = [...new Set(input.options.map((value) => value.replace(/\s+/gu, ' ').trim()).filter(Boolean))]
    if (options.length < 2 || options.length > 4) throw new Error(`一个问题需要 2 到 4 个互不重复的选项，去重后只剩 ${options.length} 个：少于 2 个用户无从选择，多于 4 个界面放不下。`)
    const request: AgentQuestionRequest = Object.freeze({
      id: randomUUID(),
      sessionId: input.sessionId,
      question: Array.from(question).slice(0, 500).join(''),
      options: Object.freeze(options.map((value) => Array.from(value).slice(0, 120).join(''))),
      allowCustom: input.allowCustom ?? true,
      createdAt: Date.now(),
    })
    this.sessions.appendEvent(request.sessionId, {
      eventId: `question-requested:${request.id}`,
      type: 'question.requested',
      payload: request,
      createdAt: request.createdAt,
    })
    return new Promise<string>((resolve, reject) => {
      this.pending.set(request.id, { request, resolve, reject })
      this.emit()
    })
  }

  public resolve(requestId: string, answer: string): string {
    const pending = this.pending.get(requestId)
    if (!pending) throw new Error('这个问题已经不在待答列表里了：它可能已经被回答过，也可能随着会话取消一起收尾了。')
    const normalized = answer.replace(/\s+/gu, ' ').trim()
    if (!normalized) throw new Error('答案不能为空：压掉多余空白后至少要留下内容。')
    if (!pending.request.allowCustom && !pending.request.options.includes(normalized)) {
      throw new Error('这个问题不接受自由作答，只能从列出的选项里原样挑一个。')
    }
    this.sessions.appendEvent(pending.request.sessionId, {
      eventId: `question-resolved:${requestId}`,
      type: 'question.resolved',
      payload: { requestId, answer: normalized },
    })
    this.pending.delete(requestId)
    pending.resolve(normalized)
    this.emit()
    return normalized
  }

  public rejectSession(sessionId: string, reason = '提问已取消：会话被取消，这个问题不再等待回答。'): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.request.sessionId !== sessionId) continue
      this.sessions.appendEvent(sessionId, {
        eventId: `question-rejected:${pending.request.id}`,
        type: 'question.rejected',
        payload: { requestId: pending.request.id, reason },
      })
      this.pending.delete(pending.request.id)
      pending.reject(new Error(reason))
    }
    this.emit()
  }

  public recoverUnresolvedRequests(sessionId: string): number {
    const requested = new Map<string, AgentQuestionRequest>()
    const resolved = new Set<string>()
    for (const event of this.sessions.readEvents(sessionId)) {
      if (event.type === 'question.requested' && isQuestionRequest(event.payload)) {
        requested.set(event.payload.id, event.payload)
      }
      if ((event.type === 'question.resolved' || event.type === 'question.rejected') && isRecord(event.payload)) {
        if (isString(event.payload.requestId)) resolved.add(event.payload.requestId)
      }
    }
    let recovered = 0
    for (const requestId of requested.keys()) {
      if (resolved.has(requestId)) continue
      this.sessions.appendEvent(sessionId, {
        eventId: `question-rejected:${requestId}:recovery`,
        type: 'question.rejected',
        payload: { requestId, reason: '宿主在这个问题被回答之前重启了，该提问已作废收尾。' },
      })
      recovered += 1
    }
    return recovered
  }

  private emit(): void {
    const snapshot = this.listPending()
    for (const listener of this.listeners) listener(snapshot)
  }
}

/** 建一台产品会话的提问服务。 */
export function createAgentQuestionService(sessions: AgentSessionEventPort): AgentQuestionServiceApi {
  return new AgentQuestionService(sessions)
}
