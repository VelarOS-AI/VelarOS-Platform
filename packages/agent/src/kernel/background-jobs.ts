import { isEmpty, isPresent, toOptional } from '@velaros-ai/core'
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
    throw new Error(`Kernel background job requires ${label}`)
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
    const outputMaxChars = options.outputMaxChars ?? DefaultOutputMaxChars
    this.outputMaxChars =
      Number.isFinite(outputMaxChars) && outputMaxChars > 0
        ? Math.floor(outputMaxChars)
        : DefaultOutputMaxChars
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
      throw new Error(`Kernel background job "${id}" already exists`)
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
    const chunk = output.toString()
    if (!isEmpty(chunk)) {
      this.appendOutputChunk(id, chunk)
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
    const pending = new Set([assertNonBlank(sessionId, 'sessionId')])
    const cancelledIds = new Set<string>()
    let cancelledCount = 0

    while (true) {
      const batch = [...this.jobs.values()].filter(
        (job) =>
          job.status === 'running' &&
          !cancelledIds.has(job.id) &&
          this.matchesCancelLineage(job, pending)
      )
      if (isEmpty(batch)) break

      for (const job of batch) {
        this.cancelJob(job, now)
        cancelledIds.add(job.id)
        pending.add(job.id)
        pending.add(job.sessionId)
        cancelledCount += 1
      }
    }
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
      throw new Error('task.lifecycle turn-context source requires at least one capability scope')

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
    const pending = new Set([normalizedSessionId])
    const droppedIds = new Set<string>()

    while (true) {
      const batch = [...this.jobs.values()].filter(
        (job) => !droppedIds.has(job.id) && this.matchesCancelLineage(job, pending)
      )
      if (isEmpty(batch)) break

      for (const job of batch) {
        droppedIds.add(job.id)
        pending.add(job.id)
        pending.add(job.sessionId)
      }
    }

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

  private appendTerminalOutput(id: string, output: string | undefined): void {
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
      this.outputStoreErrorByJob.set(id, getErrorMessage(error))
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
      throw new Error(`Kernel background job "${id}" is already ${job.status}`)
    }
    return job
  }

  private requireJob(id: string): KernelBackgroundJob {
    const job = this.jobs.get(id)
    if (!job) {
      throw new Error(`Kernel background job "${id}" does not exist`)
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
      omittedChars: baseOffset > 0 ? baseOffset : undefined,
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

  public get(jobId: string): Nullable<KernelBackgroundJobStoredOutput> {
    return this.readAll({ jobId })
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

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return toOptional(trimmed)
}

function normalizeReadOffset(offset: number, length: number): number {
  if (!Number.isFinite(offset)) return 0
  return Math.max(0, Math.min(Math.floor(offset), length))
}

function normalizeTerminalJobTtlMs(ttlMs: number | undefined): number {
  if (!isPresent(ttlMs)) return DefaultTerminalJobTtlMs
  if (!Number.isFinite(ttlMs)) return DefaultTerminalJobTtlMs
  return Math.floor(ttlMs)
}

function normalizeTerminalJobLimit(limit: number | undefined): number {
  if (!isPresent(limit)) return DefaultTerminalJobLimit
  if (!Number.isFinite(limit)) return DefaultTerminalJobLimit
  return Math.max(0, Math.floor(limit))
}

function compareTerminalJobs(left: KernelBackgroundJob, right: KernelBackgroundJob): number {
  const completedOrder =
    (left.completedAt ?? left.startedAt) - (right.completedAt ?? right.startedAt)
  if (completedOrder !== 0) return completedOrder
  return compareStableStrings(left.id, right.id)
}

function normalizeWaitTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (!isPresent(timeoutMs)) return undefined
  if (!Number.isFinite(timeoutMs)) return 0
  return Math.max(0, Math.floor(timeoutMs))
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function appendArtifactError(output: string, error: LooseOptional<string>): string {
  const normalizedError = error?.trim()
  if (!normalizedError) return output

  const separator = output && !output.endsWith('\n') ? '\n' : ''
  return `${output}${separator}job artifact incomplete: ${normalizedError}`
}

export { InMemoryKernelBackgroundJobOutputStore, KernelBackgroundJobManager }
