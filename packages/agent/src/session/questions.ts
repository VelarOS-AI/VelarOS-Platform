import { randomUUID } from 'node:crypto'

import { isArray, isPlainObject, isString } from '@velaros-ai/core'

import type { AgentSessionEventPort } from './event-port'

export interface AgentQuestionRequest {
  readonly id: string
  readonly sessionId: string
  readonly question: string
  readonly options: readonly string[]
  readonly allowCustom: boolean
  readonly createdAt: number
}

export interface AskAgentQuestionInput {
  readonly sessionId: string
  readonly question: string
  readonly options: readonly string[]
  readonly allowCustom?: boolean
}

interface PendingQuestion {
  readonly request: AgentQuestionRequest
  readonly resolve: (answer: string) => void
  readonly reject: (error: Error) => void
}

type QuestionListener = (questions: readonly AgentQuestionRequest[]) => void

/** One durable, session-scoped model-to-user question channel for the TUI. */
export class AgentQuestionService {
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
    if (!question) throw new Error('Question cannot be empty.')
    const options = [...new Set(input.options.map((value) => value.replace(/\s+/gu, ' ').trim()).filter(Boolean))]
    if (options.length < 2 || options.length > 4) throw new Error('A question requires 2 to 4 distinct options.')
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
    if (!pending) throw new Error('Question is no longer pending.')
    const normalized = answer.replace(/\s+/gu, ' ').trim()
    if (!normalized) throw new Error('Answer cannot be empty.')
    if (!pending.request.allowCustom && !pending.request.options.includes(normalized)) {
      throw new Error('Choose one of the listed options.')
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

  public rejectSession(sessionId: string, reason = 'Question cancelled.'): void {
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
        payload: { requestId, reason: 'Agent host restarted before the question was answered.' },
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

function isQuestionRequest(value: unknown): value is AgentQuestionRequest {
  return isRecord(value)
    && isString(value.id)
    && isString(value.sessionId)
    && isString(value.question)
    && isArray(value.options)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value)
}
