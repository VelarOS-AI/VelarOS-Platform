// 域：后台任务（子 Agent / 长命令等）的**生命周期账本 + 输出缓冲**，以及它们回灌给回合上下文的
// `task.lifecycle` delta 源。
//
// ## ① 生命周期状态机
// `running → completed | failed | cancelled`，**终态不可再迁移**（`requireRunning` 撞终态抛
// `CONFLICT` 并把 `jobStatus` 放进 context 供调用方结构化判定）。终态任务不立即删除：它们还要被
// `wait_background_jobs` / `read_background_job_output` 读到。回收由**两条独立闸**共同负责——
// TTL（`terminalJobTtlMs`，**负值刻意合法 = 永不按时间清理**）与条数上限（`terminalJobLimit`）。
// 只有 TTL 会让"一次跑很多短任务"撑爆内存；只有条数上限会让"一个终态任务留一整天"。两条都要。
//
// ## ② 输出缓冲：两级存储 + 一个易错的偏移量
// 内存环形缓冲（`outputByJob` + `outputBaseOffsetByJob`）保最近 `outputMaxChars` 字符；宿主注入
// `outputStore` 时输出同时落盘，任务收尾后**释放内存副本**（`releaseCachedOutputIfArtifactBacked`）。
// **`baseOffset` 是已丢弃的字符数，不是数组下标**：读取时必须 `slice(offset - baseOffset)`，
// 把这里写成 `slice(offset)` 会在缓冲发生过截断后返回错位的内容——而且只在长输出任务上才复现。
// 消费式读取（`consume: true`）推进 `outputReadOffsetByJob` 实现增量读；快照式读取不推进。
// 两种模式共用一个函数正是为了保证"增量与快照看到的是同一份内容"。
//
// ## ③ 并发与时序
// `waitForSession` 把等待者挂进 `waiters` 集合，任何状态迁移后 `notifyWaiters` 全量重扫。
// 注册后**必须立刻自查一次**（`check()`）：任务可能在 await 之前就已收敛，漏掉这次自查等待者会
// 永远挂着。超时可选——缺席 = 无限等，是刻意的（见 `normalizeWaitTimeoutMs` 的判据）。
//
// ## ④ 取消的传递性
// 取消一个会话要连带取消它派生出的整棵任务树（子 Agent 会以父任务 id 或父会话 id 再起任务），
// 故走 `collectLineageClosure` 的不动点闭包而不是一趟 filter。判据见该方法。
//
import {
  isEmpty,
  isFiniteNumber,
  isPositiveNumber,
  isPresent,
  optionalWhen,
  toOptional,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'
import type { CapabilityScopeId, TurnContextDeltaSource } from '@velaros-ai/core/types'
import { type TimerLease, TimerScope } from '@velaros-ai/core/utils/TimerScope'
import { type TurnContextAppendHub, TurnContextSessionLedgers } from '@velaros-ai/core/utils/TurnContextLedger'

import { compareStableStrings } from '../agent/context/residency/determinism'

export type KernelBackgroundJobStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface StartKernelBackgroundJobInput {
  sessionId: string
  parentSessionId?: string
  kind: string
  label: string
  id?: string
  startedAt?: number
  onCancel?: (job: KernelBackgroundJob) => void
}

export interface KernelBackgroundJobManagerOptions {
  now?: () => number
  stalledAfterMs?: number
  terminalJobTtlMs?: number
  terminalJobLimit?: number
  outputMaxChars?: number
  outputStore?: KernelBackgroundJobOutputStore
  onTerminal?: (job: KernelBackgroundJob) => void
  /** task.lifecycle 可见 delta 的写入广播总线（每宿主一个实例，由宿主装配注入）；缺省则不通知 renderer。 */
  turnContextAppendHub?: TurnContextAppendHub
}

export interface KernelBackgroundJob {
  id: string
  sessionId: string
  parentSessionId?: string
  kind: string
  label: string
  status: KernelBackgroundJobStatus
  startedAt: number
  lastVisibleOutputAt: number
  stalledWarningQueued: boolean
  completedAt?: number
  result?: string
  error?: string
}

export interface KernelBackgroundJobOutputSnapshot {
  id: string
  sessionId: string
  parentSessionId?: string
  kind: string
  label: string
  status: KernelBackgroundJobStatus
  truncated?: boolean
  omittedChars?: number
  artifactError?: string
  output: string
}

export interface KernelBackgroundJobStoredOutput {
  output: string
  chars: number
  nextOffset: number
}

export interface KernelBackgroundJobOutputStore {
  append(input: {
    jobId: string
    sessionId: string
    parentSessionId?: string
    chunk: string
  }): void
  read(input: { jobId: string; offset: number }): Nullable<KernelBackgroundJobStoredOutput>
  readAll(input: { jobId: string }): Nullable<KernelBackgroundJobStoredOutput>
  dropJob(jobId: string): void
  dropSession(sessionId: string): void
}

export interface WaitForKernelBackgroundJobsInput {
  jobIds?: readonly string[]
  timeoutMs?: number
}

function cloneJob(job: KernelBackgroundJob): KernelBackgroundJob {
  return { ...job }
}

const DefaultOutputMaxChars = 64 * 1024
const DefaultTerminalJobTtlMs = 10 * 60 * 1_000
const DefaultTerminalJobLimit = 200

function assertNonBlank(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new AppError('VALIDATION', `Kernel background job requires ${label}`, undefined, { label })
  }
  return trimmed
}

class KernelBackgroundJobManager {
  private readonly jobs = new Map<string, KernelBackgroundJob>()
  private readonly outputByJob = new Map<string, string>()
  private readonly outputBaseOffsetByJob = new Map<string, number>()
  private readonly outputReadOffsetByJob = new Map<string, number>()
  private readonly outputStoreErrorByJob = new Map<string, string>()
  private readonly outputStoreDisabledJobs = new Set<string>()
  private readonly cancelHandlerByJob = new Map<string, (job: KernelBackgroundJob) => void>()
  private readonly turnContextLedgers: TurnContextSessionLedgers
  private readonly waiters = new Set<() => void>()
  private readonly timers = new TimerScope({ name: 'KernelBackgroundJobManager' })
  private readonly now: () => number
  private readonly stalledAfterMs: number
  private readonly terminalJobTtlMs: number
  private readonly terminalJobLimit: number
  private readonly outputMaxChars: number
  private readonly outputStore: LooseOptional<KernelBackgroundJobOutputStore>
  private readonly onTerminal: LooseOptional<(job: KernelBackgroundJob) => void>
  private nextId = 1

  constructor(options: KernelBackgroundJobManagerOptions = {}) {
    this.turnContextLedgers = new TurnContextSessionLedgers('task.lifecycle', {
      appendHub: options.turnContextAppendHub,
    })
    this.now = options.now ?? (() => Date.now())
    this.stalledAfterMs = Math.max(0, Math.floor(options.stalledAfterMs ?? 0))
    this.terminalJobTtlMs = normalizeTerminalJobTtlMs(options.terminalJobTtlMs)
    this.terminalJobLimit = normalizeTerminalJobLimit(options.terminalJobLimit)
    this.outputMaxChars = normalizeOutputMaxChars(options.outputMaxChars)
    this.outputStore = options.outputStore
    this.onTerminal = options.onTerminal
  }

  public start(input: StartKernelBackgroundJobInput): KernelBackgroundJob {
    this.pruneTerminalJobs()
    const sessionId = assertNonBlank(input.sessionId, 'sessionId')
    const parentSessionId = trimOptional(input.parentSessionId)
    const kind = assertNonBlank(input.kind, 'kind')
    const label = assertNonBlank(input.label, 'label')
    const id = input.id ?? `${sessionId}:background:${this.nextId}`
    this.nextId += 1
    const startedAt = input.startedAt ?? this.now()

    if (this.jobs.has(id)) {
      throw new AppError('INVARIANT', `Kernel background job "${id}" already exists`, undefined, { jobId: id })
    }

    const job: KernelBackgroundJob = {
      id,
      sessionId,
      parentSessionId,
      kind,
      label,
      status: 'running',
      startedAt,
      lastVisibleOutputAt: startedAt,
      stalledWarningQueued: false,
    }
    this.jobs.set(id, job)
    if (input.onCancel) {
      this.cancelHandlerByJob.set(id, input.onCancel)
    }
    return cloneJob(job)
  }

  public runningForSession(sessionId: string): KernelBackgroundJob[] {
    return [...this.jobs.values()]
      .filter((job) => job.sessionId === sessionId && job.status === 'running')
      .map(cloneJob)
  }

  public recordVisibleOutput(id: string, input: { at?: number } = {}): KernelBackgroundJob {
    const job = this.requireRunning(id)
    job.lastVisibleOutputAt = input.at ?? this.now()
    return cloneJob(job)
  }

  public appendOutput(
    id: string,
    output: string,
    input: { at?: number } = {}
  ): KernelBackgroundJob {
    const job = this.requireJob(id)
    if (!isEmpty(output)) {
      this.appendOutputChunk(id, output)
    }
    if (job.status === 'running') {
      job.lastVisibleOutputAt = input.at ?? this.now()
    }
    return cloneJob(job)
  }

  public readOutputForSession(
    sessionId: string,
    id: string
  ): Nullable<KernelBackgroundJobOutputSnapshot> {
    return this.outputForSession(sessionId, id, { consume: true })
  }

  public snapshotOutputForSession(
    sessionId: string,
    id: string
  ): Nullable<KernelBackgroundJobOutputSnapshot> {
    return this.outputForSession(sessionId, id, { consume: false })
  }

  public async waitForSession(
    sessionId: string,
    input: WaitForKernelBackgroundJobsInput = {}
  ): Promise<KernelBackgroundJobOutputSnapshot[]> {
    const normalizedSessionId = assertNonBlank(sessionId, 'sessionId')
    const jobIds = this.selectWaitJobIds(normalizedSessionId, input.jobIds)
    if (isEmpty(jobIds)) return []

    const timeoutMs = normalizeWaitTimeoutMs(input.timeoutMs)
    if (jobIds.every((id) => !this.isJobRunningForSession(normalizedSessionId, id))) return this.snapshotSelectedJobs(normalizedSessionId, jobIds)
    if (timeoutMs === 0) return this.snapshotSelectedJobs(normalizedSessionId, jobIds)

    await new Promise<void>((resolve) => {
      let timer: Nullable<TimerLease> = null
      const done = () => {
        timer?.cancel()
        this.waiters.delete(check)
        resolve()
      }
      const check = () => {
        if (jobIds.some((id) => this.isJobRunningForSession(normalizedSessionId, id))) return
        done()
      }
      this.waiters.add(check)
      if (isPresent(timeoutMs)) {
        timer = this.timers.after(timeoutMs, done, { label: 'waitForSession', unref: true })
      }
      check()
    })

    return this.snapshotSelectedJobs(normalizedSessionId, jobIds)
  }

  public recordStalledJobs(input: { sessionId?: string; now?: number } = {}): number {
    if (this.stalledAfterMs <= 0) return 0

    const sessionId = input.sessionId?.trim()
    const now = input.now ?? this.now()
    let queued = 0

    for (const job of this.jobs.values()) {
      if (job.status !== 'running') continue
      if (sessionId && job.sessionId !== sessionId) continue
      if (job.stalledWarningQueued) continue
      if (now - job.lastVisibleOutputAt < this.stalledAfterMs) continue

      job.stalledWarningQueued = true
      this.turnContextLedgers.append(job.sessionId, {
        occurredAt: now,
        label: `${job.label} 疑似停滞`,
        summaryText: `后台任务「${job.label}」疑似停滞：已 ${formatDuration(this.stalledAfterMs)} 无可见输出。`,
        inspect: { tool: 'read_background_job_output', argsHint: { job_id: job.id } },
      })
      queued += 1
    }

    return queued
  }

  public complete(id: string, input: { result?: string } = {}): KernelBackgroundJob {
    return this.finish(id, 'completed', { result: input.result })
  }

  public fail(id: string, input: { error?: string } = {}): KernelBackgroundJob {
    return this.finish(id, 'failed', { error: input.error })
  }

  public cancelSession(sessionId: string): number {
    const now = this.now()
    const closure = this.collectLineageClosure(
      assertNonBlank(sessionId, 'sessionId'),
      (job) => job.status === 'running'
    )
    for (const job of closure.jobs) {
      this.cancelJob(job, now)
    }
    const cancelledCount = closure.jobs.length
    if (cancelledCount > 0) {
      this.notifyWaiters()
      this.pruneTerminalJobs()
    }
    return cancelledCount
  }

  public cancelForSession(sessionId: string, id: string): Nullable<KernelBackgroundJob> {
    const normalizedSessionId = assertNonBlank(sessionId, 'sessionId')
    const normalizedId = assertNonBlank(id, 'jobId')
    const job = this.jobs.get(normalizedId)
    if (!job || job.sessionId !== normalizedSessionId) return null
    if (job.status !== 'running') return cloneJob(job)

    this.cancelJob(job, this.now())
    this.notifyWaiters()
    const cancelled = cloneJob(job)
    this.pruneTerminalJobs()
    return cancelled
  }

  /**
   * 环境回合上下文 source adapter：delta=任务完成/失败（finish 时定稿），
   * anchors=当前运行中任务；peek 同步纯内存。
   *
   * `scopes` 由宿主装配显式注入（本包不认识产品空间词表）：后台任务与空间无关，
   * 宿主应把「声明了 task.lifecycle 的全部空间」传进来。**必填**——曾因空间化重构
   * 把常量数组降级成 `[]`，让 FanIn gate2（`source.scopes.includes(space)`）恒 false，
   * 整条 task delta 通道静默失联；留成可选参数就是把同一个坑再挖一遍。
   */
  public createTurnContextSource(
    scopes: readonly CapabilityScopeId[],
  ): TurnContextDeltaSource {
    if (isEmpty(scopes))
      throw new AppError(
        'VALIDATION',
        'task.lifecycle turn-context source requires at least one capability scope'
      )

    return {
      id: 'task.lifecycle',
      scopes: [...scopes],
      peekCached: (input) => {
        const running = [...this.jobs.values()].filter(
          (job) => job.sessionId === input.sessionId && job.status === 'running',
        )
        const labels = running.slice(0, 3).map((job) => job.label)
        const extra = running.length > labels.length ? ` 等 ${running.length} 个` : ''

        return {
          ...this.turnContextLedgers.peek(input.sessionId, input),
          anchors: isEmpty(running)
            ? []
            : [
                {
                  sourceId: 'task.lifecycle',
                  key: 'running-jobs',
                  text: `后台任务运行中：${labels.join('、')}${extra}`,
                },
              ],
        }
      },
    }
  }

  public dropSession(sessionId: string): number {
    const normalizedSessionId = assertNonBlank(sessionId, 'sessionId')
    const closure = this.collectLineageClosure(normalizedSessionId, () => true)
    const droppedIds = new Set(closure.jobs.map((job) => job.id))
    const pending = closure.sessionKeys

    for (const jobId of droppedIds) {
      this.dropJobState(jobId)
    }
    for (const sessionKey of pending) {
      this.turnContextLedgers.clearSession(sessionKey)
    }
    this.outputStore?.dropSession(normalizedSessionId)
    if (droppedIds.size > 0) this.notifyWaiters()
    return droppedIds.size
  }

  public pruneTerminalJobs(input: { now?: number } = {}): number {
    const now = input.now ?? this.now()
    const droppedIds = new Set<string>()

    for (const job of this.jobs.values()) {
      if (this.shouldPruneTerminalJob(job, now)) {
        droppedIds.add(job.id)
      }
    }

    const remainingTerminalJobs = [...this.jobs.values()]
      .filter((job) => job.status !== 'running' && !droppedIds.has(job.id))
      .sort(compareTerminalJobs)
    const overflow = remainingTerminalJobs.length - this.terminalJobLimit
    if (overflow > 0) {
      for (const job of remainingTerminalJobs.slice(0, overflow)) {
        droppedIds.add(job.id)
      }
    }

    for (const jobId of droppedIds) {
      this.dropJobState(jobId)
    }
    if (droppedIds.size > 0) this.notifyWaiters()
    return droppedIds.size
  }

  private finish(
    id: string,
    status: Exclude<KernelBackgroundJobStatus, 'running' | 'cancelled'>,
    input: {
      result?: string
      error?: string
    }
  ): KernelBackgroundJob {
    const job = this.requireRunning(id)
    job.status = status
    job.completedAt = this.now()
    if (input.result?.trim()) {
      job.result = input.result.trim()
    }
    if (input.error?.trim()) {
      job.error = input.error.trim()
    }
    this.appendTerminalOutput(job.id, job.result ?? job.error)
    this.releaseCachedOutputIfArtifactBacked(job.id)

    const outcome = status === 'completed' ? '完成' : '失败'
    const detail = (status === 'completed' ? job.result : job.error)?.trim()
    this.turnContextLedgers.append(job.sessionId, {
      occurredAt: job.completedAt,
      label: `${job.label} ${outcome}`,
      summaryText: `后台任务「${job.label}」已${outcome}${
        detail ? `：${detail.length > 120 ? `${detail.slice(0, 120)}…` : detail}` : '。'
      }`,
      inspect: { tool: 'read_background_job_output', argsHint: { job_id: job.id } },
    })
    this.cancelHandlerByJob.delete(job.id)
    this.notifyWaiters()
    const finished = cloneJob(job)
    this.notifyTerminal(finished)
    this.pruneTerminalJobs()
    return finished
  }

  private notifyTerminal(job: KernelBackgroundJob): void {
    if (!this.onTerminal) return

    try {
      this.onTerminal(cloneJob(job))
    } catch (error) {
      logRuntime.tag('KernelBackgroundJobManager').warn('background job terminal listener failed', {
        jobId: job.id,
        error,
      })
    }
  }

  private cancelJob(job: KernelBackgroundJob, now: number): void {
    job.status = 'cancelled'
    job.completedAt = now
    this.invokeCancelHandler(job)
    this.cancelHandlerByJob.delete(job.id)
    this.turnContextLedgers.append(job.sessionId, {
      occurredAt: now,
      label: `${job.label} 已取消`,
      summaryText: `后台任务「${job.label}」已被取消。`,
    })
  }

  private invokeCancelHandler(job: KernelBackgroundJob): void {
    const handler = this.cancelHandlerByJob.get(job.id)
    if (!handler) return

    try {
      handler(cloneJob(job))
    } catch (error) {
      logRuntime.tag('KernelBackgroundJobManager').warn('background job cancel handler failed', {
        jobId: job.id,
        error,
      })
    }
  }

  private selectWaitJobIds(
    sessionId: string,
    requestedJobIds: readonly string[] | undefined
  ): string[] {
    const normalizedIds = (requestedJobIds ?? []).map((id) => id.trim()).filter(Boolean)
    if (!isEmpty(normalizedIds)) return [...new Set(normalizedIds)].filter((id) => this.jobs.get(id)?.sessionId === sessionId)

    return [...this.jobs.values()]
      .filter((job) => job.sessionId === sessionId && job.status === 'running')
      .map((job) => job.id)
  }

  private isJobRunningForSession(sessionId: string, id: string): boolean {
    const job = this.jobs.get(id)
    return isPresent(job) && job.sessionId === sessionId && job.status === 'running'
  }

  private snapshotSelectedJobs(
    sessionId: string,
    jobIds: readonly string[]
  ): KernelBackgroundJobOutputSnapshot[] {
    return jobIds
      .map((id) => this.snapshotOutputForSession(sessionId, id))
      .filter(isPresent)
  }

  private notifyWaiters(): void {
    for (const waiter of this.waiters) {
      waiter()
    }
  }

  private appendTerminalOutput(id: string, output: LooseOptional<string>): void {
    const terminalOutput = output?.trim()
    if (!terminalOutput) return

    const existing = this.outputByJob.get(id) ?? ''
    const separator = existing && !existing.endsWith('\n') ? '\n' : ''
    this.appendOutputChunk(id, `${separator}${terminalOutput}`)
  }

  private appendOutputChunk(id: string, chunk: string): void {
    this.appendOutputStoreChunk(id, chunk)

    const existing = this.outputByJob.get(id) ?? ''
    const combined = `${existing}${chunk}`
    if (combined.length <= this.outputMaxChars) {
      this.outputByJob.set(id, combined)
      return
    }

    const droppedChars = combined.length - this.outputMaxChars
    const baseOffset = this.outputBaseOffsetByJob.get(id) ?? 0
    this.outputBaseOffsetByJob.set(id, baseOffset + droppedChars)
    this.outputByJob.set(id, combined.slice(droppedChars))
  }

  private appendOutputStoreChunk(id: string, chunk: string): void {
    if (!this.outputStore || this.outputStoreDisabledJobs.has(id)) return

    const job = this.requireJob(id)
    try {
      this.outputStore.append({
        jobId: id,
        sessionId: job.sessionId,
        parentSessionId: job.parentSessionId,
        chunk,
      })
    } catch (error) {
      this.outputStoreDisabledJobs.add(id)
      this.outputStoreErrorByJob.set(id, AppError.getMessage(error))
      logRuntime.tag('KernelBackgroundJobManager').warn('background job output artifact write failed', {
        jobId: id,
        error,
      })
    }
  }

  private releaseCachedOutputIfArtifactBacked(id: string): void {
    if (!this.outputStore || this.outputStoreDisabledJobs.has(id)) return
    if (!this.outputStore.readAll({ jobId: id })) return

    this.outputByJob.delete(id)
    this.outputBaseOffsetByJob.delete(id)
  }

  private shouldPruneTerminalJob(job: KernelBackgroundJob, now: number): boolean {
    if (job.status === 'running') return false
    if (this.terminalJobTtlMs < 0) return false

    const completedAt = job.completedAt ?? job.startedAt
    return now - completedAt >= this.terminalJobTtlMs
  }

  private dropJobState(id: string): void {
    this.jobs.delete(id)
    this.outputByJob.delete(id)
    this.outputBaseOffsetByJob.delete(id)
    this.outputReadOffsetByJob.delete(id)
    this.outputStoreErrorByJob.delete(id)
    this.outputStoreDisabledJobs.delete(id)
    this.cancelHandlerByJob.delete(id)
    this.outputStore?.dropJob(id)
  }

  private requireRunning(id: string): KernelBackgroundJob {
    const job = this.requireJob(id)
    if (job.status !== 'running') {
      // context.jobStatus 是**结构化契约**：调用方（SubAgentDispatcher.failSubAgentBackgroundJob）要区分
      // 「任务已被取消所以收尾更新无意义」与真失败，必须读 code+context，不许回去 sniff message 文案。
      throw new AppError(
        'CONFLICT',
        `Kernel background job "${id}" is already ${job.status}`,
        undefined,
        { jobId: id, jobStatus: job.status }
      )
    }
    return job
  }

  private requireJob(id: string): KernelBackgroundJob {
    const job = this.jobs.get(id)
    if (!job) {
      throw new AppError('NOT_FOUND', `Kernel background job "${id}" does not exist`, undefined, {
        jobId: id,
      })
    }
    return job
  }

  private outputForSession(
    sessionId: string,
    id: string,
    input: { consume: boolean }
  ): Nullable<KernelBackgroundJobOutputSnapshot> {
    const normalizedSessionId = sessionId.trim()
    if (!normalizedSessionId) return null

    const job = this.jobs.get(id)
    if (!job || job.sessionId !== normalizedSessionId) return null

    const output = this.readOutputForJob(id, input)
    const artifactError = this.outputStoreErrorByJob.get(id)

    const snapshot: KernelBackgroundJobOutputSnapshot = {
      id: job.id,
      sessionId: job.sessionId,
      kind: job.kind,
      label: job.label,
      status: job.status,
      output: appendArtifactError(output.output, artifactError),
    }
    if (output.truncated) {
      snapshot.truncated = true
      snapshot.omittedChars = output.omittedChars
    }
    if (artifactError) {
      snapshot.artifactError = artifactError
    }
    if (job.parentSessionId) {
      snapshot.parentSessionId = job.parentSessionId
    }
    return snapshot
  }

  private readOutputForJob(
    id: string,
    input: { consume: boolean }
  ): { output: string; truncated: boolean; omittedChars?: number } {
    if (this.outputStore && !this.outputStoreDisabledJobs.has(id)) {
      const offset = input.consume ? this.outputReadOffsetByJob.get(id) ?? 0 : 0
      const stored = input.consume
        ? this.outputStore.read({ jobId: id, offset })
        : this.outputStore.readAll({ jobId: id })
      if (stored) {
        if (input.consume) {
          this.outputReadOffsetByJob.set(id, stored.nextOffset)
        }
        return { output: stored.output, truncated: false }
      }
    }

    const fullOutput = this.outputByJob.get(id) ?? ''
    const baseOffset = this.outputBaseOffsetByJob.get(id) ?? 0
    const totalLength = baseOffset + fullOutput.length
    const offset = input.consume
      ? Math.max(this.outputReadOffsetByJob.get(id) ?? baseOffset, baseOffset)
      : baseOffset
    const output = fullOutput.slice(offset - baseOffset)
    if (input.consume) {
      this.outputReadOffsetByJob.set(id, totalLength)
    }

    return {
      output,
      truncated: baseOffset > 0,
      omittedChars: optionalWhen(isPositiveNumber, baseOffset),
    }
  }

  /**
   * 谱系传递闭包：从一个 sessionId 出发，把它、它派生的任务、以及那些任务自己的子会话全收进来。
   *
   * **为什么必须迭代到不动点**：子 Agent 会以「父任务 id」或「父会话 id」作 parentSessionId 再起任务，
   * 深度不定。一趟 filter 只抓得到直接子代，孙代会漏 → 取消父会话时孙任务变孤儿常驻（用户看到
   * 「已取消」而输出还在涨）。每轮把新命中的 `job.id` 与 `job.sessionId` 一并加进种子集，直到不再新增。
   * 终止性：`visited` 单调增长且上界 = jobs 总数。
   *
   * cancel 与 drop 共用本闭包，只在 `accept` 上分叉（cancel 只动 running、drop 动全部）——两个遍历
   * 此前是逐字复制的两份，改一份忘另一份就会长出「取消收干净了但 drop 漏孙代」的偏斜。
   */
  private collectLineageClosure(
    seedSessionId: string,
    accept: (job: KernelBackgroundJob) => boolean
  ): { jobs: KernelBackgroundJob[]; sessionKeys: Set<string> } {
    const sessionKeys = new Set([seedSessionId])
    const visited = new Set<string>()
    const jobs: KernelBackgroundJob[] = []

    for (;;) {
      const batch = [...this.jobs.values()].filter(
        (job) => !visited.has(job.id) && accept(job) && this.matchesCancelLineage(job, sessionKeys)
      )
      if (isEmpty(batch)) return { jobs, sessionKeys }

      for (const job of batch) {
        visited.add(job.id)
        jobs.push(job)
        sessionKeys.add(job.id)
        sessionKeys.add(job.sessionId)
      }
    }
  }

  private matchesCancelLineage(job: KernelBackgroundJob, pending: ReadonlySet<string>): boolean {
    if (pending.has(job.id)) return true
    if (pending.has(job.sessionId)) return true
    return isPresent(job.parentSessionId) && pending.has(job.parentSessionId)
  }
}

class InMemoryKernelBackgroundJobOutputStore implements KernelBackgroundJobOutputStore {
  private readonly outputs = new Map<string, string>()
  private readonly sessionByJob = new Map<
    string,
    { sessionId: string; parentSessionId?: string }
  >()

  public append(input: {
    jobId: string
    sessionId: string
    parentSessionId?: string
    chunk: string
  }): void {
    const existing = this.outputs.get(input.jobId) ?? ''
    this.outputs.set(input.jobId, `${existing}${input.chunk}`)
    this.sessionByJob.set(input.jobId, {
      sessionId: input.sessionId,
      parentSessionId: input.parentSessionId,
    })
  }

  public read(input: { jobId: string; offset: number }): Nullable<KernelBackgroundJobStoredOutput> {
    if (!this.outputs.has(input.jobId)) return null

    const output = this.outputs.get(input.jobId) ?? ''

    const offset = normalizeReadOffset(input.offset, output.length)
    return {
      output: output.slice(offset),
      chars: output.length,
      nextOffset: output.length,
    }
  }

  public readAll(input: { jobId: string }): Nullable<KernelBackgroundJobStoredOutput> {
    return this.read({ jobId: input.jobId, offset: 0 })
  }

  public dropJob(jobId: string): void {
    this.outputs.delete(jobId)
    this.sessionByJob.delete(jobId)
  }

  public dropSession(sessionId: string): void {
    for (const [jobId, owner] of this.sessionByJob.entries()) {
      if (owner.sessionId !== sessionId && owner.parentSessionId !== sessionId) continue
      this.dropJob(jobId)
    }
  }
}


function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1_000))
  return `${seconds}s`
}

/** 收进来什么缺席形态都行，出去只有一种：省略位的 `undefined`（§1.5 边界归一一次）。 */
function trimOptional(value: LooseOptional<string>): string | undefined {
  const trimmed = value?.trim()
  return toOptional(trimmed)
}

function normalizeReadOffset(offset: number, length: number): number {
  if (!isFiniteNumber(offset)) return 0
  return Math.max(0, Math.min(Math.floor(offset), length))
}

/** 输出缓冲上限：非有限或非正一律回落缺省（0 会让整条输出链恒空，属坏配置不是合法配置）。 */
function normalizeOutputMaxChars(maxChars: LooseOptional<number>): number {
  if (!isFiniteNumber(maxChars) || maxChars <= 0) return DefaultOutputMaxChars
  return Math.floor(maxChars)
}

/** 终态任务保留时长：**负值刻意合法**（= 永不按 TTL 清理，见 shouldPruneTerminalJob）。 */
function normalizeTerminalJobTtlMs(ttlMs: LooseOptional<number>): number {
  if (!isFiniteNumber(ttlMs)) return DefaultTerminalJobTtlMs
  return Math.floor(ttlMs)
}

function normalizeTerminalJobLimit(limit: LooseOptional<number>): number {
  if (!isFiniteNumber(limit)) return DefaultTerminalJobLimit
  return Math.max(0, Math.floor(limit))
}

function compareTerminalJobs(left: KernelBackgroundJob, right: KernelBackgroundJob): number {
  const completedOrder =
    (left.completedAt ?? left.startedAt) - (right.completedAt ?? right.startedAt)
  if (completedOrder !== 0) return completedOrder
  return compareStableStrings(left.id, right.id)
}

/**
 * wait 超时：**缺席与非有限值语义相反**，不可合并——缺席 = 无限等（等到任务真的收敛），
 * 非有限（NaN/Infinity）= 立即返回快照（0），因为那是调用方传了坏值，无限等会挂死父 Agent。
 */
function normalizeWaitTimeoutMs(timeoutMs: LooseOptional<number>): LooseOptional<number> {
  if (!isPresent(timeoutMs)) return undefined
  if (!isFiniteNumber(timeoutMs)) return 0
  return Math.max(0, Math.floor(timeoutMs))
}

function appendArtifactError(output: string, error: LooseOptional<string>): string {
  const normalizedError = error?.trim()
  if (!normalizedError) return output

  const separator = output && !output.endsWith('\n') ? '\n' : ''
  return `${output}${separator}job artifact incomplete: ${normalizedError}`
}

export { InMemoryKernelBackgroundJobOutputStore, KernelBackgroundJobManager }
