import type { ActEvent, ActRunEvent } from '@velaros-ai/agent'

import type { ActPresentation, ActRunPresentation } from '../types/presentation.js'

/** 浏览器安全的事件投影接口；历史由持久游标回放，实时预览只在当前投影中存活。 */
export interface ActEventProjectorApi {
  /** 处理单条持久事件；重复游标幂等。 */
  apply(event: ActEvent): ActPresentation
  /** 处理有序实时流；正式正文按回合去重，实时增量不推进持久游标。 */
  applyLive(event: ActRunEvent): ActPresentation
  /** 交付结束时清除全部未接纳预览，保留正式正文；再次消费使用新投影器。 */
  finish(): ActPresentation
  /** 当前不可变展示快照。 */
  snapshot(): ActPresentation
}

/** 展示从事实事件派生，完整接受之前只产生可丢弃预览。 */
class ActEventProjector implements ActEventProjectorApi {
  private sessionId?: string
  private state: ActPresentation = { cursor: 0, runs: {} }
  private readonly ended = new Set<string>()
  private readonly rejected = new Set<string>()
  private readonly turns = new Map<string, Set<string>>()
  private readonly inputs = new Map<
    string,
    Map<
      string,
      { inputId?: string; source?: 'submit' | 'steer'; status: 'accepted' | 'applied' | 'retained' }
    >
  >()
  public apply(record: ActEvent): ActPresentation {
    if (this.sessionId && this.sessionId !== record.sessionId)
      throw new Error('事件投影不能混用会话')
    if (record.runId !== record.event.runId) throw new Error('事件信封与运行身份不一致')
    this.sessionId = record.sessionId
    if (record.sequence <= this.state.cursor) return this.snapshot()
    this.applyLive(record.event)
    this.state = { ...this.state, cursor: record.sequence }
    return this.snapshot()
  }
  public applyLive(event: ActRunEvent): ActPresentation {
    const prior: ActRunPresentation = this.state.runs[event.runId] ?? {
      status: 'idle',
      turn: 0,
      preview: '',
      messages: [],
      errors: [],
      queuedInputIds: [],
      retainedInputIds: [],
    }
    if (this.ended.has(event.runId)) return this.snapshot()
    let run = { ...prior }
    if (event.type === 'turn') {
      const turns = this.turns.get(event.runId) ?? new Set<string>()
      if (turns.has(event.turnId)) return this.snapshot()
      turns.add(event.turnId)
      this.turns.set(event.runId, turns)
      run = { ...run, turn: turns.size, turnId: event.turnId, preview: '' }
    }
    if (
      event.type === 'input' ||
      event.type === 'input-applied' ||
      event.type === 'input-retained'
    ) {
      const inputs =
        this.inputs.get(event.runId) ??
        new Map<
          string,
          {
            inputId?: string
            source?: 'submit' | 'steer'
            status: 'accepted' | 'applied' | 'retained'
          }
        >()
      const key = JSON.stringify([event.ref.sessionId, event.ref.id])
      const previous = inputs.get(key)
      if (event.type === 'input') {
        if (!previous)
          inputs.set(key, { inputId: event.inputId, source: event.source, status: 'accepted' })
      } else if (event.type === 'input-applied')
        inputs.set(key, {
          ...previous,
          inputId: event.inputId ?? previous?.inputId,
          status: 'applied',
        })
      else if (previous?.status !== 'applied')
        inputs.set(key, {
          ...previous,
          inputId: event.inputId ?? previous?.inputId,
          status: 'retained',
        })
      this.inputs.set(event.runId, inputs)
      const values = [...inputs.values()]
      run = {
        ...run,
        queuedInputIds: [
          ...new Set(
            values
              .filter(
                (input) =>
                  input.status === 'retained' ||
                  (input.status === 'accepted' && input.source !== 'submit')
              )
              .flatMap((input) => (input.inputId ? [input.inputId] : []))
          ),
        ],
        retainedInputIds: [
          ...new Set(
            values
              .filter((input) => input.status === 'retained')
              .flatMap((input) => (input.inputId ? [input.inputId] : []))
          ),
        ],
      }
    }
    const turnKey = `${event.runId}:${run.turnId}`
    if (
      event.type === 'text' &&
      run.turnId &&
      !this.rejected.has(turnKey) &&
      !run.messages.some((message) => message.turnId === run.turnId)
    )
      run = { ...run, preview: run.preview + event.text }
    if (
      event.type === 'accepted' &&
      !run.messages.some((message) => message.turnId === event.turnId)
    )
      run = {
        ...run,
        preview: run.turnId === event.turnId ? '' : run.preview,
        messages: [...run.messages, { turnId: event.turnId, text: event.text, ref: event.ref }],
      }
    if (event.type === 'rejected') {
      this.rejected.add(`${event.runId}:${event.turnId}`)
      run = {
        ...run,
        preview: run.turnId === event.turnId ? '' : run.preview,
        errors: [...run.errors, event.message],
      }
    }
    if (event.type === 'error') {
      this.rejected.add(turnKey)
      run = { ...run, preview: '', failure: event.message, errors: [...run.errors, event.message] }
    }
    if (event.type === 'state') {
      const terminal = [
        'completed',
        'cancelled',
        'failed',
        'context_blocked',
        'needs_reconcile',
      ].includes(event.status)
      if (terminal) this.ended.add(event.runId)
      run = { ...run, status: event.status, preview: terminal ? '' : run.preview }
    }
    this.state = { ...this.state, runs: { ...this.state.runs, [event.runId]: run } }
    return this.snapshot()
  }
  public finish(): ActPresentation {
    const runs = { ...this.state.runs }
    for (const [id, run] of Object.entries(runs)) {
      this.ended.add(id)
      runs[id] = { ...run, preview: '' }
    }
    this.state = { ...this.state, runs }
    return this.snapshot()
  }
  public snapshot(): ActPresentation {
    return structuredClone(this.state)
  }
}
/** 创建单会话事件投影；原始日志仍由 ActRunService 拥有。 */
export function createActEventProjector(): ActEventProjectorApi {
  return new ActEventProjector()
}
