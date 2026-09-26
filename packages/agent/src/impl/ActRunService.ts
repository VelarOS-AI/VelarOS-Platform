import { Log } from '@velaros-ai/core'
import { isEmpty, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ActRunServiceOptions } from '../contract/requires.js'
import type {
  ActAnswer,
  ActEvent,
  ActInput,
  ActInteraction,
  ActRunEvent,
  ActRunSnapshot,
} from '../types/act.js'
import type { ActPendingInteraction } from '../types/runtime.js'
import { boundedModelOperation } from '../utils/model-stream.js'
import { AgentTuning } from '../utils/tuning.js'

import type { ActLoopApi } from './ActLoop.js'
import { ActLoop } from './ActLoop.js'

/** 持久运行管理，宿主不再自行维护平行状态机。 */
export interface ActRunServiceApi {
  /** 领运行权并推进输入；input 表示持久接纳，input-applied 绑定实际请求，input-retained 表示结束时仍未消费。消费方关闭迭代时收束执行。 */
  submit(input: string | ActInput, signal?: AbortSignal): AsyncIterable<ActRunEvent>
  /** 归档并在下一轮递交运行中补充，抢占尚未派发的模型响应。 */
  steer(input: string | ActInput): Promise<void>
  /** 创建可由宿主回答的交互，取消会拒绝等待。 */
  request(
    kind: ActInteraction['kind'],
    message: string,
    signal: AbortSignal,
    detail?: unknown
  ): Promise<unknown>
  /** 只回答当前运行的一次交互，重复或陈旧回答拒绝。 */
  answer(answer: ActAnswer): Promise<void>
  /** 获取当前或重启恢复的运行状态。 */
  inspect(): Promise<ActRunSnapshot>
  /** 按持久序号分页读取事件。 */
  events(after?: number, limit?: number): Promise<readonly ActEvent[]>
  /** 取消当前运行及其交互。 */
  cancel(): void
  /** 取消并等待所有运行收束。 */
  close(): Promise<void>
}

/** 同一会话的运行、输入和交互使用现有上下文存储记录真实生命周期。 */
class ActRunService implements ActRunServiceApi {
  private loop?: ActLoopApi
  private active?: Promise<void>
  private controller?: AbortController
  private turnController = new AbortController()
  private runId = ''
  private status: ActRunSnapshot['status'] = 'idle'
  private closed = false
  private readonly pending = new Map<string, ActPendingInteraction>()
  private readonly inputs: Array<Extract<ActRunEvent, { type: 'input' }>> = []
  private prepared: Array<Extract<ActRunEvent, { type: 'input' }>> = []
  private readonly unapplied = new Map<string, Extract<ActRunEvent, { type: 'input' }>>()
  private readonly outbox: ActRunEvent[] = []
  private readonly wake = new Set<() => void>()
  private writes: Promise<void> = Promise.resolve()
  private inputWrites: Promise<void> = Promise.resolve()
  private steering = 0
  public constructor(private readonly options: ActRunServiceOptions) {}

  public async *submit(input: string | ActInput, signal?: AbortSignal): AsyncIterable<ActRunEvent> {
    if (this.closed || this.active) throw new AppError('CLOSED', '会话已关闭或已有活动运行')
    this.inputs.length = 0
    this.prepared = []
    this.unapplied.clear()
    this.runId = crypto.randomUUID()
    this.status = 'idle'
    this.controller = new AbortController()
    this.turnController = new AbortController()
    const combined = AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])])
    let restored = false
    this.loop = new ActLoop({
      ...this.options,
      control: {
        runId: this.runId,
        pending: () => !isEmpty(this.inputs) || this.steering > 0,
        turnSignal: () => this.turnController.signal,
        beforeTurn: async (turnSignal) => {
          await this.inputWrites
          turnSignal.throwIfAborted()
          if (!restored) {
            const state = await this.options.storage.load(this.options.sessionId)
            const applied = new Set(
              (state?.records ?? [])
                .filter((r) => r.title?.startsWith('act:input-applied:'))
                .map((r) => r.title.slice('act:input-applied:'.length))
            )
            const events: ActRunEvent[] = []
            for (const record of state?.records ?? [])
              if (record.title === 'act:event') {
                const event = JSON.parse(
                  (await this.options.storage.get(this.options.sessionId, record.objectId))!
                ) as ActRunEvent
                events.push(event)
                if (event.type === 'input-applied') applied.add(event.ref.id)
              }
            for (const event of events)
              if (
                event.type === 'input' &&
                !(event.source === 'submit' && event.runId === this.runId) &&
                !applied.has(event.ref.id) &&
                !this.inputs.some((item) => item.ref.id === event.ref.id)
              ) {
                this.inputs.push(event)
                this.unapplied.set(event.ref.id, event)
              }
            restored = true
          }
          this.turnController = new AbortController()
          this.prepared = [...this.inputs]
          for (const { ref } of this.prepared)
            if (
              !(await this.options.view.inspect())?.goals.some(
                (goal) => goal.id === ref.id && goal.sessionId === ref.sessionId
              )
            )
              await this.options.view.appendGoal(ref, turnSignal)
        },
        applied: async (turnId, turnSignal) => {
          turnSignal.throwIfAborted()
          for (const input of this.prepared) {
            await this.emit({
              type: 'input-applied',
              runId: this.runId,
              ref: input.ref,
              inputId: input.inputId,
              turnId,
            })
            const index = this.inputs.findIndex((item) => item.ref.id === input.ref.id)
            if (index >= 0) this.inputs.splice(index, 1)
          }
          this.prepared = []
        },
      },
    })
    const run = this.loop
    let finished = false
    this.active = (async () => {
      try {
        let terminal: Optional<ActRunEvent>
        for await (const event of run.submit(input, combined)) {
          if (
            event.type === 'state' &&
            ['completed', 'cancelled', 'failed', 'context_blocked'].includes(event.status)
          ) {
            this.status = event.status
            terminal = event
          } else await this.emit(event)
        }
        // 只有执行、租约和帧收尾全部完成后，才向消费者提交终态。
        await this.retainInputs()
        if (terminal) await this.emit(terminal)
      } catch (error) {
        this.status = 'failed'
        try {
          await this.retainInputs()
          await this.emit({ type: 'error', runId: this.runId, message: String(error) })
          await this.emit({ type: 'state', runId: this.runId, status: 'failed' })
        } catch {
          Log.tag('ActRuntime').debug(
            'ActRunService 已进入异常处理或降级分支'
          ) /* 存储故障不能掩盖最初的失败；仍由消费方收到异常。 */
        }
        throw error
      } finally {
        await this.inputWrites
        for (const item of this.pending.values())
          item.reject(new AppError('CLOSED', '运行已经结束'))
        this.pending.clear()
        finished = true
        this.notify()
      }
    })()
    // 消费方以外的事件（交互、运行中输入）也能唤醒同一个流。
    void this.active.catch(() => {
      finished = true
      this.notify()
    })
    try {
      while (!finished || !isEmpty(this.outbox)) {
        if (!isEmpty(this.outbox)) {
          yield this.outbox.shift()!
          continue
        }
        await new Promise<void>((resolve) => this.wake.add(resolve))
      }
      await this.active
    } finally {
      this.cancel()
      await this.active.catch(() => {
        Log.tag('ActRuntime').debug('ActRunService 已进入异常处理或降级分支')
      })
      this.active = undefined
      this.loop = undefined
      this.controller = undefined
      this.outbox.length = 0
    }
  }
  public async steer(input: string | ActInput): Promise<void> {
    if (
      !this.active ||
      !this.controller ||
      this.controller.signal.aborted ||
      ['completed', 'cancelled', 'failed', 'context_blocked'].includes(this.status)
    )
      throw new AppError('UNAVAILABLE', '没有可接收引导的活动运行')
    const signal = this.controller.signal
    const value = isString(input) ? { text: input } : input
    if (!value.text && !value.files?.length && !value.images?.length)
      throw new AppError('VALIDATION', '输入不能为空')
    this.steering++
    this.turnController.abort(new AppError('CANCELLED', '新的用户输入已到达'))
    const write = this.inputWrites.then(async () => {
      signal.throwIfAborted()
      const record = await this.options.context.ingest(
        { text: value.text ?? '[用户图片输入]', files: value.files },
        signal
      )
      for (const image of value.images ?? [])
        await this.options.context.append(
          {
            kind: 'audit',
            title: 'user:image',
            body: JSON.stringify({ ...image, origin: 'user' }),
            sources: [record.ref],
          },
          signal
        )
      // 输入在持久化接受之前使旧验收失效；与完成 CAS 竞争失败时明确拒绝本次引导。
      if (this.status !== 'idle') await this.options.view.appendGoal(record.ref, signal)
      const receipt: Extract<ActRunEvent, { type: 'input' }> = {
        type: 'input',
        runId: this.runId,
        ref: record.ref,
        inputId: value.inputId,
        source: 'steer',
      }
      await this.emit(receipt)
      this.inputs.push(receipt)
    })
    this.inputWrites = write
      .catch((error) => this.controller?.abort(error))
      .finally(() => {
        this.steering--
      })
    await write
  }
  public async request(
    kind: ActInteraction['kind'],
    message: string,
    signal: AbortSignal,
    detail?: unknown
  ): Promise<unknown> {
    if (!this.active || !this.controller || this.controller.signal.aborted)
      throw new AppError('UNAVAILABLE', '交互需要活动运行')
    signal.throwIfAborted()
    const request: ActInteraction = {
      id: crypto.randomUUID(),
      runId: this.runId,
      kind,
      message,
      detail,
    }
    let resolve!: (value: unknown) => void
    let reject!: (reason: unknown) => void
    const value = new Promise<unknown>((yes, no) => {
      resolve = yes
      reject = no
    })
    this.pending.set(request.id, { request, resolve, reject })
    const waiting = boundedModelOperation(value, AbortSignal.any([signal, this.controller.signal]))
    void waiting.catch(() => {
      Log.tag('ActRuntime').debug('ActRunService 已进入异常处理或降级分支')
    })
    try {
      await this.emit({ type: 'interaction', runId: this.runId, request })
      return await waiting
    } finally {
      this.pending.delete(request.id)
      await this.saveState()
    }
  }
  public async answer(answer: ActAnswer): Promise<void> {
    const item = this.pending.get(answer.id)
    if (
      !item ||
      answer.runId !== this.runId ||
      item.request.runId !== answer.runId ||
      this.controller?.signal.aborted
    )
      throw new AppError('CONFLICT', '交互回答已过期或不属于当前运行')
    this.pending.delete(answer.id)
    try {
      await this.emit({ type: 'answer', runId: this.runId, id: answer.id })
      item.resolve(answer.value)
    } catch (error) {
      item.reject(error)
      throw error
    }
  }
  public async inspect(): Promise<ActRunSnapshot> {
    if (this.active) return this.snapshot()
    const snapshot = await this.options.storage.load(this.options.sessionId)
    const record = snapshot?.records.findLast((item) => item.title === 'act:state')
    if (!record) return this.snapshot()
    const value = JSON.parse(
      (await this.options.storage.get(this.options.sessionId, record.objectId))!
    ) as ActRunSnapshot
    if (['thinking', 'executing'].includes(value.status) || !isEmpty(value.pending))
      return { ...value, status: 'interrupted', pending: [] }
    // 旧版本记下的 needs_reconcile 已经没有这一态：那一轮没做完就停了
    return (value.status as string) === 'needs_reconcile' ? { ...value, status: 'failed' } : value
  }
  public async events(after = 0, limit = AgentTuning.eventPage): Promise<readonly ActEvent[]> {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000
    )
      throw new AppError('VALIDATION', '事件分页范围无效')
    const records = ((await this.options.storage.load(this.options.sessionId))?.records ?? [])
      .filter((item) => item.sequence > after && item.title === 'act:event')
      .slice(0, limit)
    return Promise.all(
      records.map(async (record) => {
        const event = JSON.parse(
          (await this.options.storage.get(this.options.sessionId, record.objectId))!
        ) as ActRunEvent
        return {
          sequence: record.sequence,
          sessionId: this.options.sessionId,
          runId: event.runId,
          event,
        }
      })
    )
  }
  public cancel(): void {
    this.controller?.abort()
    this.loop?.cancel()
    for (const item of this.pending.values()) item.reject(new AppError('CANCELLED', '运行已取消'))
    this.notify()
  }
  public async close(): Promise<void> {
    this.closed = true
    this.cancel()
    await this.active?.catch(() => {
      Log.tag('ActRuntime').debug('ActRunService 已进入异常处理或降级分支')
    })
    await this.writes
  }
  private snapshot(): ActRunSnapshot {
    return {
      id: this.runId,
      sessionId: this.options.sessionId,
      status: this.status,
      pending: [...this.pending.values()].map((item) => item.request),
    }
  }
  private async saveState(): Promise<void> {
    await this.options.context.append({
      kind: 'audit',
      title: 'act:state',
      body: JSON.stringify(this.snapshot()),
    })
  }
  /** 结束前等待输入落盘，并逐条交出仍可恢复的输入身份。 */
  private async retainInputs(): Promise<void> {
    await this.inputWrites
    for (const input of this.unapplied.values())
      await this.emit({
        type: 'input-retained',
        runId: this.runId,
        ref: input.ref,
        inputId: input.inputId,
      })
  }
  private async emit(event: ActRunEvent): Promise<void> {
    if (event.type === 'text' || event.type === 'reasoning' || event.type === 'program') {
      this.outbox.push(event)
      this.notify()
      return
    }
    const write = this.writes.then(async () => {
      if (event.type === 'state') this.status = event.status
      if (event.type === 'interaction') this.status = 'waiting'
      if (event.type === 'answer') this.status = 'executing'
      await this.options.context.append({
        kind: 'audit',
        title: 'act:event',
        body: JSON.stringify(event),
      })
      if (event.type === 'input') this.unapplied.set(event.ref.id, event)
      if (event.type === 'input-applied') this.unapplied.delete(event.ref.id)
      await this.saveState()
      this.outbox.push(event)
      this.notify()
    })
    this.writes = write.catch(() => {
      Log.tag('ActRuntime').debug('ActRunService 已进入异常处理或降级分支')
    })
    await write
  }
  private notify(): void {
    for (const wake of this.wake) wake()
    this.wake.clear()
  }
}
/** 装配唯一 Act 运行服务，底层循环及上下文由同一组端口兑现。 */
export function createActRunService(options: ActRunServiceOptions): ActRunServiceApi {
  return new ActRunService(options)
}
