import { createContextRuntime } from '@velaros-ai/context'
import { Log } from '@velaros-ai/core'
import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { AgentSupervisorOptions } from '../contract/requires.js'
import type { ActInput, ActRunEvent } from '../types/act.js'
import type { AgentJob, AgentResume, AgentStart } from '../types/delegation.js'
import type { ActiveAgentJob } from '../types/runtime.js'
import { appendChildEvent } from '../utils/delegation.js'
import { boundedModelOperation } from '../utils/model-stream.js'

/** 并发子运行的唯一调度面，父身份必须由宿主提供。 */
export interface AgentSupervisorApi {
  /** 父运行是否仍有活动子任务。 */
  pending(parent: string): boolean
  /** 等待新的子任务交互或收束，不调用模型轮询。 */
  waitAny(parent: string, signal: AbortSignal): Promise<void>
  /** 派发并立即返回句柄，输入及状态先持久化。 */
  start(parent: string, input: AgentStart, signal: AbortSignal): Promise<AgentJob>
  /** 续跑同一会话，沿用材料、授权配置和已计费预算。 */
  resume(parent: string, id: string, input: AgentResume, signal: AbortSignal): Promise<AgentJob>
  /** 读取子任务状态，重启后未完成的运行标为中断。 */
  status(parent: string, id: string): Promise<AgentJob>
  /** 等待子任务提问或真实终态；等待者取消只退出等待。 */
  wait(parent: string, id: string, signal: AbortSignal): Promise<AgentJob>
  /** 回答当前子运行的指定请求；陈旧、重复、跨父任务回答拒绝。 */
  reply(parent: string, id: string, requestId: string, value: unknown): Promise<void>
  /** 向活动子运行发送新输入。 */
  send(parent: string, id: string, input: ActInput | string): Promise<void>
  /** 取消指定子运行并等待收束。 */
  cancel(parent: string, id: string): Promise<AgentJob>
  /** 父运行取消或结束时收束其全部子运行。 */
  cancelParent(parent: string): Promise<void>
  /** 停机时收束全部运行。 */
  close(): Promise<void>
}

/** 同一工厂和存储上的子运行调度；资源冲突在实际启动之前拒绝。 */
class AgentSupervisor implements AgentSupervisorApi {
  private readonly active = new Map<string, ActiveAgentJob>()
  private readonly failures = new Map<string, { parent: string; error: unknown }>()
  private readonly revisions = new Map<string, number>()
  private readonly seen = new Map<string, number>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private gate: Promise<unknown> = Promise.resolve()
  private closed = false
  public constructor(private readonly options: AgentSupervisorOptions) {
    for (const v of [options.concurrency, options.maxChildren])
      if (!Number.isSafeInteger(v) || v < 1)
        throw new AppError('VALIDATION', '子任务配额必须为正整数')
  }
  public pending(parent: string): boolean {
    return (
      [...this.active.values()].some((x) => x.job.parentSessionId === parent) ||
      [...this.failures.values()].some((x) => x.parent === parent)
    )
  }
  public async waitAny(parent: string, signal: AbortSignal): Promise<void> {
    const failure = [...this.failures.values()].find((x) => x.parent === parent)
    if (failure) throw failure.error
    const revision = this.revisions.get(parent) ?? 0
    if (revision === (this.seen.get(parent) ?? 0) && this.pending(parent))
      await this.waitChange(parent, revision, signal)
    this.seen.set(parent, this.revisions.get(parent) ?? 0)
    const next = [...this.failures.values()].find((x) => x.parent === parent)
    if (next) throw next.error
  }
  public async start(parent: string, input: AgentStart, signal: AbortSignal): Promise<AgentJob> {
    return this.lock(async () => {
      signal.throwIfAborted()
      const profile = input.profile?.trim()
      if (!input.task?.trim() || !profile)
        throw new AppError('VALIDATION', '子任务需要目标与宿主配置')
      const snapshot = await this.options.storage.load(parent)
      const count = new Set(
        snapshot?.records
          .filter(
            (r) =>
              r.title?.startsWith('act:child:') &&
              r.sequence > (snapshot?.task?.startedSequence ?? 0)
          )
          .map((r) => r.title)
      ).size
      if (count >= this.options.maxChildren) throw new AppError('LIMIT', '父任务子会话额度耗尽')
      const id = crypto.randomUUID()
      const job: AgentJob = {
        id,
        parentSessionId: parent,
        sessionId: `agent:${parent}:${id}`,
        profile,
        status: 'running',
      }
      if (snapshot?.task) Object.assign(job, { parentTaskId: snapshot.task.id })
      this.assertAvailable(job)
      await this.save(job)
      this.launch(job, input.task, input, signal)
      return job
    })
  }
  public async resume(
    parent: string,
    id: string,
    input: AgentResume,
    signal: AbortSignal
  ): Promise<AgentJob> {
    return this.lock(async () => {
      signal.throwIfAborted()
      if (!input.input?.trim()) throw new AppError('VALIDATION', '续跑需要输入')
      const prior = await this.status(parent, id)
      if (prior.parentTaskId !== (await this.options.storage.load(parent))?.task?.id)
        throw new AppError('CONFLICT', '子任务属于先前逻辑任务，不能隐式续跑')
      const {
        error: _error,
        result: _result,
        delivery: _delivery,
        pending: _pending,
        ...rest
      } = prior
      const job: AgentJob = { ...rest, status: 'running', profile: input.profile ?? prior.profile }
      this.assertAvailable(job)
      await this.save(job)
      this.failures.delete(id)
      this.launch(
        job,
        input.input,
        { task: input.input, profile: job.profile, materials: input.materials },
        signal
      )
      return job
    })
  }
  public async status(parent: string, id: string): Promise<AgentJob> {
    const live = this.active.get(id)
    if (live) {
      if (live.job.parentSessionId !== parent)
        throw new AppError('PERMISSION', '子运行不属于当前父任务')
      return structuredClone(live.job)
    }
    const snapshot = await this.options.storage.load(parent)
    const record = snapshot?.records.findLast((r) => r.title === `act:child:${id}`)
    if (!record) throw new AppError('NOT_FOUND', '子运行不存在或不在当前范围')
    const job = JSON.parse((await this.options.storage.get(parent, record.objectId))!) as AgentJob
    return job.status === 'running' || job.status === 'waiting'
      ? { ...job, status: 'interrupted' }
      : job
  }
  public async wait(parent: string, id: string, signal: AbortSignal): Promise<AgentJob> {
    await this.status(parent, id)
    const live = this.active.get(id)
    const failure = this.failures.get(id)
    if (failure?.parent === parent) throw failure.error
    while (live && this.active.has(id) && !live.job.pending?.length) {
      const revision = this.revisions.get(parent) ?? 0
      await this.waitChange(parent, revision, signal)
      const failed = this.failures.get(id)
      if (failed) throw failed.error
    }
    signal.throwIfAborted()
    return this.status(parent, id)
  }
  public async reply(parent: string, id: string, requestId: string, value: unknown): Promise<void> {
    await this.status(parent, id)
    const live = this.active.get(id)
    const request = live?.job.pending?.find((item) => item.id === requestId)
    if (!live?.session || !request)
      throw new AppError('CONFLICT', '子运行请求已结束、被回答或需要中断恢复')
    await live.session.answer({ id: request.id, runId: request.runId, value })
    // 等到原事件流把回答持久化到父任务，随后 wait 不会再次返回同一请求。
    while (this.active.has(id) && live.job.pending?.some((item) => item.id === requestId))
      await this.waitChange(parent, this.revisions.get(parent) ?? 0, live.controller.signal)
  }
  public async send(parent: string, id: string, input: ActInput | string): Promise<void> {
    await this.status(parent, id)
    const live = this.active.get(id)
    if (!live?.session) throw new AppError('UNAVAILABLE', '子运行尚未就绪或已经结束')
    await live.session.steer(input)
  }
  public async cancel(parent: string, id: string): Promise<AgentJob> {
    await this.status(parent, id)
    const live = this.active.get(id)
    if (live) {
      live.controller.abort()
      live.session?.cancel()
      await live.promise
    }
    return this.status(parent, id)
  }
  public async cancelParent(parent: string): Promise<void> {
    await Promise.allSettled(
      [...this.active.values()]
        .filter((x) => x.job.parentSessionId === parent)
        .map((x) => this.cancel(parent, x.job.id))
    )
    const failures = [...this.failures.values()]
      .filter((x) => x.parent === parent)
      .map((x) => x.error)
    if (!isEmpty(failures))
      throw new AggregateError(failures, `子运行收尾失败：${failures.map(String).join('; ')}`)
  }
  public async close(): Promise<void> {
    this.closed = true
    await this.gate
    await Promise.allSettled(
      [...this.active.values()].map((x) => this.cancel(x.job.parentSessionId, x.job.id))
    )
    const failures = [...this.failures.values()].map((x) => x.error)
    if (!isEmpty(failures))
      throw new AggregateError(failures, `子运行收尾失败：${failures.map(String).join('; ')}`)
  }
  private assertAvailable(job: AgentJob): void {
    if (this.closed || this.active.size >= this.options.concurrency || this.active.has(job.id))
      throw new AppError('CONFLICT', '子运行并发额度耗尽或重复激活')
  }
  private launch(
    job: AgentJob,
    input: string,
    request: Optional<AgentStart>,
    signal: AbortSignal
  ): void {
    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const live: ActiveAgentJob = { job, controller, promise: Promise.resolve() }
    this.active.set(job.id, live)
    live.promise = (async () => {
      const context = createContextRuntime({
        sessionId: job.parentSessionId,
        storage: this.options.storage,
      })
      const events: ActRunEvent[] = []
      let omittedEvents = 0
      try {
        live.session = await this.options.open(job, request, controller.signal)
        controller.signal.throwIfAborted()
        for await (const event of live.session.submit(input, controller.signal)) {
          if (event.type === 'interaction') {
            live.job = {
              ...live.job,
              status: 'waiting',
              pending: [...(live.job.pending ?? []), event.request],
            }
            await this.save(live.job)
            this.notify(job.parentSessionId)
          } else if (event.type === 'answer') {
            live.job = {
              ...live.job,
              status: 'running',
              pending: live.job.pending?.filter((item) => item.id !== event.id) ?? [],
            }
            await this.save(live.job)
            this.notify(job.parentSessionId)
          }
          // 正文与最终验收进入摘要引用；完整逐事件历史已由子 ActRunService 持久化。
          if (
            event.type === 'accepted' ||
            event.type === 'verification' ||
            event.type === 'error' ||
            event.type === 'stalled' ||
            event.type === 'state'
          )
            omittedEvents += appendChildEvent(events, event)
        }
        const state = events.findLast((e) => e.type === 'state')
        const status = state?.type === 'state' ? state.status : 'failed'
        live.job = {
          ...job,
          status:
            status === 'completed'
              ? 'completed'
              : status === 'waiting'
                ? 'waiting'
                : status === 'cancelled'
                  ? 'cancelled'
                  : status === 'needs_reconcile'
                    ? 'needs_reconcile'
                    : 'failed',
        }
      } catch (error) {
        live.job = {
          ...job,
          status: controller.signal.aborted ? 'cancelled' : 'failed',
          error: String(error),
        }
      }
      {
        try {
          await live.session?.close()
          const result = await context.append({
            kind: 'note',
            title: 'act:child-result',
            body: JSON.stringify({
              job: live.job,
              events,
              omittedEvents,
              eventSource: { sessionId: job.sessionId, after: 0 },
            }),
          })
          live.job = { ...live.job, result: result.ref }
          if (this.options.deliver)
            Object.assign(live.job, { delivery: await this.options.deliver(live.job, result.ref) })
          await this.save(live.job)
        } catch (error) {
          this.failures.set(job.id, { parent: job.parentSessionId, error })
          throw error
        } finally {
          signal.removeEventListener('abort', abort)
          this.active.delete(job.id)
          this.notify(job.parentSessionId)
        }
      }
    })()
    // 调度器保存失败也被 wait/close 观察，避免进程级未处理拒绝。
    void live.promise.catch(() => {
      Log.tag('ActRuntime').debug('AgentSupervisor 已进入异常处理或降级分支')
    })
  }
  private notify(parent: string): void {
    this.revisions.set(parent, (this.revisions.get(parent) ?? 0) + 1)
    for (const listener of this.listeners.get(parent) ?? []) listener()
  }
  private async waitChange(parent: string, revision: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    let wake!: () => void
    const changed = new Promise<void>((resolve) => {
      wake = resolve
    })
    const listeners = this.listeners.get(parent) ?? new Set<() => void>()
    listeners.add(wake)
    this.listeners.set(parent, listeners)
    try {
      if ((this.revisions.get(parent) ?? 0) !== revision) return
      await boundedModelOperation(changed, signal)
    } finally {
      listeners.delete(wake)
      if (!listeners.size) this.listeners.delete(parent)
    }
  }
  private async save(job: AgentJob): Promise<void> {
    await createContextRuntime({
      sessionId: job.parentSessionId,
      storage: this.options.storage,
    }).append({ kind: 'audit', title: `act:child:${job.id}`, body: JSON.stringify(job) })
  }
  private async lock<T>(run: () => Promise<T>): Promise<T> {
    const value = this.gate.then(run)
    this.gate = value.catch(() => {
      Log.tag('ActRuntime').debug('AgentSupervisor 已进入异常处理或降级分支')
    })
    return value
  }
}
/** 配置有界子任务调度，执行工厂由上层注入。 */
export function createAgentSupervisor(options: AgentSupervisorOptions): AgentSupervisorApi {
  return new AgentSupervisor(options)
}
