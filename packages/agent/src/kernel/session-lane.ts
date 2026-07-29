import { isPresent } from '@velaros-ai/core'
export type KernelInputDelivery = 'queue' | 'steer'
export type KernelInputRole = 'user' | 'system' | 'assistant' | 'tool'
export type KernelInputStatus = 'admitted' | 'promoted' | 'cancelled'

export interface AdmitKernelSessionInput {
  id?: string
  sessionId: string
  role?: KernelInputRole
  content: string
  delivery?: KernelInputDelivery
  createdAt?: number
  metadata?: Record<string, unknown>
}

export interface KernelAdmittedInput {
  id: string
  sessionId: string
  seq: number
  role: KernelInputRole
  content: string
  delivery: KernelInputDelivery
  status: KernelInputStatus
  createdAt: number
  promotedAt?: number
  cancelledAt?: number
  metadata?: Record<string, unknown>
}

export type KernelSessionDrainMode = 'run' | 'wake'

export interface KernelSessionDrainTarget {
  sessionId: string
  mode: KernelSessionDrainMode
  seq?: number
}

export interface PromoteKernelInputOptions {
  cutoffSeq?: number
  inputId?: string
}

export type KernelSessionDrainRunner = (target: KernelSessionDrainTarget) => Promise<void> | void
export type KernelSessionInputStoreResult<T> = T | Promise<T>

export interface KernelSessionInputSnapshot {
  inputs: KernelAdmittedInput[]
}

export interface KernelSessionInputSnapshotPersistence {
  loadSnapshot(): KernelSessionInputStoreResult<LooseOptional<KernelSessionInputSnapshot>>
  saveSnapshot(snapshot: KernelSessionInputSnapshot): KernelSessionInputStoreResult<void>
}

export interface KernelSessionInputStore {
  admit(input: AdmitKernelSessionInput): KernelSessionInputStoreResult<KernelAdmittedInput>
  list(sessionId: string): KernelSessionInputStoreResult<KernelAdmittedInput[]>
  countPending(sessionId: string): KernelSessionInputStoreResult<number>
  promoteSteers(
    sessionId: string,
    options?: PromoteKernelInputOptions
  ): KernelSessionInputStoreResult<KernelAdmittedInput[]>
  promoteNextQueued(sessionId: string): KernelSessionInputStoreResult<Nullable<KernelAdmittedInput>>
  cancel(sessionId: string, inputId?: string): KernelSessionInputStoreResult<number>
  dropSession(sessionId: string): KernelSessionInputStoreResult<number>
}

function cloneInput(input: KernelAdmittedInput): KernelAdmittedInput {
  const cloned: KernelAdmittedInput = { ...input }
  if (input.metadata) cloned.metadata = { ...input.metadata }
  return cloned
}

function isSameAdmission(
  existing: KernelAdmittedInput,
  input: AdmitKernelSessionInput,
  role: KernelInputRole,
  delivery: KernelInputDelivery
): boolean {
  return (
    existing.sessionId === input.sessionId &&
    existing.role === role &&
    existing.content === input.content &&
    existing.delivery === delivery
  )
}

function assertInputContent(input: AdmitKernelSessionInput): void {
  if (!input.sessionId.trim()) {
    throw new Error('Kernel session input requires a sessionId')
  }
  if (!input.content.trim()) {
    throw new Error('Kernel session input requires non-empty content')
  }
}

function cloneSnapshot(
  snapshot?: LooseOptional<KernelSessionInputSnapshot>
): KernelSessionInputSnapshot {
  return {
    inputs: (snapshot?.inputs ?? []).map(cloneInput),
  }
}

function sortInputs(inputs: KernelAdmittedInput[]): KernelAdmittedInput[] {
  return inputs.sort((left, right) => {
    const sessionOrder = left.sessionId.localeCompare(right.sessionId)
    if (sessionOrder !== 0) return sessionOrder
    return left.seq - right.seq
  })
}

export class InMemoryKernelSessionInputStore implements KernelSessionInputStore {
  private readonly inputsBySession = new Map<string, KernelAdmittedInput[]>()
  private readonly seqBySession = new Map<string, number>()

  public constructor(snapshot?: LooseOptional<KernelSessionInputSnapshot>) {
    const seenIds = new Set<string>()
    for (const input of cloneSnapshot(snapshot).inputs) {
      const sessionInputs = this.inputsBySession.get(input.sessionId) ?? []
      if (seenIds.has(input.id)) {
        throw new Error(`Kernel session input "${input.id}" is duplicated in snapshot`)
      }
      seenIds.add(input.id)
      sessionInputs.push(input)
      this.inputsBySession.set(input.sessionId, sessionInputs)
      this.seqBySession.set(
        input.sessionId,
        Math.max(this.seqBySession.get(input.sessionId) ?? 0, input.seq)
      )
    }

    for (const inputs of this.inputsBySession.values()) {
      inputs.sort((left, right) => left.seq - right.seq)
    }
  }

  public admit(input: AdmitKernelSessionInput): KernelAdmittedInput {
    assertInputContent(input)

    const role = input.role ?? 'user'
    const delivery = input.delivery ?? 'queue'
    if (input.id) {
      const existing = this.findInputById(input.id)
      if (existing) {
        if (isSameAdmission(existing, input, role, delivery)) return cloneInput(existing)
        throw new Error(`Kernel session input "${input.id}" is already admitted`)
      }
    }

    const seq = (this.seqBySession.get(input.sessionId) ?? 0) + 1
    const id = input.id ?? `${input.sessionId}:input:${seq}`
    if (this.findInputById(id)) {
      throw new Error(`Kernel session input "${id}" is already admitted`)
    }
    const sessionInputs = this.inputsBySession.get(input.sessionId) ?? []

    const admitted: KernelAdmittedInput = {
      id,
      sessionId: input.sessionId,
      seq,
      role,
      content: input.content,
      delivery,
      status: 'admitted',
      createdAt: input.createdAt ?? Date.now(),
    }
    if (isPresent(input.metadata)) {
      admitted.metadata = { ...input.metadata }
    }

    sessionInputs.push(admitted)
    this.inputsBySession.set(input.sessionId, sessionInputs)
    this.seqBySession.set(input.sessionId, seq)

    return cloneInput(admitted)
  }

  private findInputById(id: string): Nullable<KernelAdmittedInput> {
    for (const inputs of this.inputsBySession.values()) {
      const input = inputs.find((candidate) => candidate.id === id)
      if (input) return input
    }
    return null
  }

  public list(sessionId: string): KernelAdmittedInput[] {
    return (this.inputsBySession.get(sessionId) ?? []).map(cloneInput)
  }

  public countPending(sessionId: string): number {
    return (this.inputsBySession.get(sessionId) ?? []).filter(
      (input) => input.status === 'admitted'
    ).length
  }

  public promoteSteers(
    sessionId: string,
    options: PromoteKernelInputOptions = {}
  ): KernelAdmittedInput[] {
    const promotedAt = Date.now()
    const sessionInputs = this.inputsBySession.get(sessionId) ?? []
    const promoted: KernelAdmittedInput[] = []

    for (const input of sessionInputs) {
      if (input.status !== 'admitted' || input.delivery !== 'steer') {
        continue
      }
      if (isPresent(options.inputId) && input.id !== options.inputId) {
        continue
      }
      if (isPresent(options.cutoffSeq) && input.seq > options.cutoffSeq) {
        continue
      }
      input.status = 'promoted'
      input.promotedAt = promotedAt
      promoted.push(cloneInput(input))
    }

    return promoted
  }

  public promoteNextQueued(sessionId: string): Nullable<KernelAdmittedInput> {
    const sessionInputs = this.inputsBySession.get(sessionId) ?? []
    const input = sessionInputs.find(
      (candidate) => candidate.status === 'admitted' && candidate.delivery === 'queue'
    )
    if (!input) return null

    input.status = 'promoted'
    input.promotedAt = Date.now()
    return cloneInput(input)
  }

  public cancel(sessionId: string, inputId?: string): number {
    const sessionInputs = this.inputsBySession.get(sessionId) ?? []
    const cancelledAt = Date.now()
    let cancelled = 0

    for (const input of sessionInputs) {
      // 指定 inputId 的安全吊销允许撤回刚刚 promote、但尚未被下一轮消费的输入；
      // 未指定 id 的普通 cancel 仍只影响排队中的 admitted 输入。
      const canCancel =
        input.status === 'admitted' || (isPresent(inputId) && input.status === 'promoted')
      if (!canCancel) {
        continue
      }
      if (isPresent(inputId) && input.id !== inputId) {
        continue
      }
      input.status = 'cancelled'
      input.cancelledAt = cancelledAt
      cancelled += 1
    }

    return cancelled
  }

  public dropSession(sessionId: string): number {
    const existing = this.inputsBySession.get(sessionId) ?? []
    this.inputsBySession.delete(sessionId)
    this.seqBySession.delete(sessionId)
    return existing.length
  }

  public snapshot(): KernelSessionInputSnapshot {
    return {
      inputs: sortInputs(
        [...this.inputsBySession.values()].flatMap((inputs) => inputs.map(cloneInput))
      ),
    }
  }
}

export class PersistentKernelSessionInputStore implements KernelSessionInputStore {
  private delegatePromise: Nullable<Promise<InMemoryKernelSessionInputStore>> = null
  private mutationChain: Promise<void> = Promise.resolve()

  public constructor(private readonly persistence: KernelSessionInputSnapshotPersistence) {}

  public admit(input: AdmitKernelSessionInput): Promise<KernelAdmittedInput> {
    return this.mutate((store) => store.admit(input))
  }

  public list(sessionId: string): Promise<KernelAdmittedInput[]> {
    return this.read((store) => store.list(sessionId))
  }

  public countPending(sessionId: string): Promise<number> {
    return this.read((store) => store.countPending(sessionId))
  }

  public promoteSteers(
    sessionId: string,
    options: PromoteKernelInputOptions = {}
  ): Promise<KernelAdmittedInput[]> {
    return this.mutate((store) => store.promoteSteers(sessionId, options))
  }

  public promoteNextQueued(sessionId: string): Promise<Nullable<KernelAdmittedInput>> {
    return this.mutate((store) => store.promoteNextQueued(sessionId))
  }

  public cancel(sessionId: string, inputId?: string): Promise<number> {
    return this.mutate((store) => store.cancel(sessionId, inputId))
  }

  public dropSession(sessionId: string): Promise<number> {
    return this.mutate((store) => store.dropSession(sessionId))
  }

  private delegate(): Promise<InMemoryKernelSessionInputStore> {
    if (!this.delegatePromise) {
      this.delegatePromise = Promise.resolve(this.persistence.loadSnapshot()).then(
        (snapshot) => new InMemoryKernelSessionInputStore(snapshot)
      )
    }
    return this.delegatePromise
  }

  private async read<T>(operation: (store: InMemoryKernelSessionInputStore) => T): Promise<T> {
    await this.mutationChain
    return operation(await this.delegate())
  }

  private mutate<T>(operation: (store: InMemoryKernelSessionInputStore) => T): Promise<T> {
    const next = this.mutationChain.then(async () => {
      const store = await this.delegate()
      const result = operation(store)
      await this.persistence.saveSnapshot(store.snapshot())
      return result
    })
    this.mutationChain = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }
}

interface KernelSessionRunDeferred {
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
}

interface KernelSessionRunWaiter {
  deferred: KernelSessionRunDeferred
  rejectWhenSuppressed: boolean
}

interface KernelSessionRunDemand {
  mode: KernelSessionDrainMode
  drain: KernelSessionDrainRunner
  waiters: KernelSessionRunWaiter[]
  seq?: number
}

interface KernelSessionRunEntry {
  current: KernelSessionRunDemand
  idle: KernelSessionRunDeferred
  pending?: KernelSessionRunDemand
  interruptSeq?: number
  stopping: boolean
}

type KernelSessionDemandSettlement =
  | { status: 'resolved' }
  | { status: 'rejected'; error: unknown }

const KernelSessionDemandResolved: KernelSessionDemandSettlement = { status: 'resolved' }

export class KernelSessionRunInterruptedError extends Error {
  public constructor() {
    super('Kernel session run interrupted before it acquired ownership')
    this.name = 'KernelSessionRunInterruptedError'
  }
}

function createRunDeferred(): KernelSessionRunDeferred {
  let resolve!: KernelSessionRunDeferred['resolve']
  let reject!: KernelSessionRunDeferred['reject']
  const promise = new Promise<void>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

function maxSeq(left: number | undefined, right: number | undefined): number | undefined {
  if (!isPresent(left)) return right
  if (!isPresent(right)) return left
  return Math.max(left, right)
}

function createDrainTarget(
  sessionId: string,
  demand: KernelSessionRunDemand
): KernelSessionDrainTarget {
  const target: KernelSessionDrainTarget = {
    sessionId,
    mode: demand.mode,
  }
  if (isPresent(demand.seq)) {
    target.seq = demand.seq
  }
  return target
}

function createDemand(
  mode: KernelSessionDrainMode,
  drain: KernelSessionDrainRunner,
  seq?: number
): { demand: KernelSessionRunDemand; waiter: KernelSessionRunDeferred } {
  const waiter = createRunDeferred()
  const demand: KernelSessionRunDemand = {
    mode,
    drain,
    waiters: [
      {
        deferred: waiter,
        rejectWhenSuppressed: mode === 'run',
      },
    ],
  }
  if (isPresent(seq)) {
    demand.seq = seq
  }
  return { demand, waiter }
}

export class KernelSessionRunCoordinator {
  private readonly entries = new Map<string, KernelSessionRunEntry>()
  private readonly interruptSeqBySession = new Map<string, number>()

  public isRunning(sessionId: string): boolean {
    return this.entries.has(sessionId)
  }

  public wake(
    sessionId: string,
    drain: KernelSessionDrainRunner,
    seq?: number
  ): Promise<void> {
    const { demand, waiter } = createDemand('wake', drain, seq)
    if (!this.isAfterInterrupt(sessionId, seq)) {
      waiter.resolve()
      return waiter.promise
    }

    const entry = this.entries.get(sessionId)
    if (!entry) {
      this.start(sessionId, {
        current: demand,
        idle: createRunDeferred(),
        stopping: false,
      })
      return waiter.promise
    }

    if (!this.acceptsWake(entry, seq)) {
      waiter.resolve()
      return waiter.promise
    }

    entry.pending = this.coalesce(entry.pending, demand)
    return waiter.promise
  }

  public run(sessionId: string, drain: KernelSessionDrainRunner): Promise<void> {
    const { demand, waiter } = createDemand('run', drain)
    const entry = this.entries.get(sessionId)
    if (!entry) {
      this.start(sessionId, {
        current: demand,
        idle: createRunDeferred(),
        stopping: false,
      })
      return waiter.promise
    }

    if (entry.stopping) return entry.idle.promise.then(() => this.run(sessionId, drain))

    if (entry.current.mode === 'run') {
      entry.current.waiters.push({
        deferred: waiter,
        rejectWhenSuppressed: true,
      })
      return waiter.promise
    }

    entry.pending = this.coalesce(entry.pending, demand)
    return waiter.promise
  }

  public awaitIdle(sessionId: string): Promise<void> {
    return this.entries.get(sessionId)?.idle.promise ?? Promise.resolve()
  }

  public interrupt(sessionId: string, seq?: number): void {
    const latestInterruptSeq = this.interruptSeqBySession.get(sessionId)
    if (isPresent(seq)) {
      if (isPresent(latestInterruptSeq) && seq <= latestInterruptSeq) return
      this.interruptSeqBySession.set(sessionId, seq)
    }

    const entry = this.entries.get(sessionId)
    if (!entry) return

    entry.stopping = true
    entry.interruptSeq = maxSeq(entry.interruptSeq, seq)
    this.suppressPendingAtOrBefore(entry, seq)
  }

  private start(sessionId: string, entry: KernelSessionRunEntry): void {
    this.entries.set(sessionId, entry)
    const demand = entry.current
    Promise.resolve()
      .then(() => demand.drain(createDrainTarget(sessionId, demand)))
      .then(
        () => this.settle(sessionId, entry, demand, KernelSessionDemandResolved),
        (error: unknown) => this.settle(sessionId, entry, demand, {
          status: 'rejected',
          error,
        })
      )
  }

  private settle(
    sessionId: string,
    entry: KernelSessionRunEntry,
    demand: KernelSessionRunDemand,
    settlement: KernelSessionDemandSettlement
  ): void {
    this.settleDemand(demand, settlement)
    if (this.entries.get(sessionId) !== entry) return

    const pending = entry.pending
    if (pending && this.shouldRunPending(entry, pending)) {
      entry.pending = undefined
      entry.current = pending
      entry.stopping = false
      this.start(sessionId, entry)
      return
    }

    if (pending) {
      this.settleSuppressedDemand(pending)
      entry.pending = undefined
    }
    this.entries.delete(sessionId)
    entry.idle.resolve()
  }

  private shouldRunPending(
    entry: KernelSessionRunEntry,
    pending: KernelSessionRunDemand
  ): boolean {
    if (!entry.stopping) return true
    if (pending.mode === 'run') return true
    return (
      isPresent(entry.interruptSeq) &&
      isPresent(pending.seq) &&
      pending.seq > entry.interruptSeq
    )
  }

  private settleDemand(
    demand: KernelSessionRunDemand,
    settlement: KernelSessionDemandSettlement
  ): void {
    for (const waiter of demand.waiters) {
      if (settlement.status === 'resolved') {
        waiter.deferred.resolve()
      } else {
        waiter.deferred.reject(settlement.error)
      }
    }
  }

  private settleSuppressedDemand(demand: KernelSessionRunDemand): void {
    const interrupted = new KernelSessionRunInterruptedError()
    for (const waiter of demand.waiters) {
      if (waiter.rejectWhenSuppressed) {
        waiter.deferred.reject(interrupted)
      } else {
        waiter.deferred.resolve()
      }
    }
  }

  private coalesce(
    left: KernelSessionRunDemand | undefined,
    right: KernelSessionRunDemand
  ): KernelSessionRunDemand {
    if (!left) return right

    const waiters = [...left.waiters, ...right.waiters]
    if (left.mode === 'run' || right.mode === 'run') {
      const dominant = right.mode === 'run' ? right : left
      return {
        mode: 'run',
        drain: dominant.drain,
        waiters,
      }
    }

    const coalesced: KernelSessionRunDemand = {
      mode: 'wake',
      drain: right.drain,
      waiters,
    }
    const seq = maxSeq(left.seq, right.seq)
    if (isPresent(seq)) {
      coalesced.seq = seq
    }
    return coalesced
  }

  private acceptsWake(entry: KernelSessionRunEntry, seq: number | undefined): boolean {
    return (
      !entry.stopping ||
      (isPresent(entry.interruptSeq) && isPresent(seq) && seq > entry.interruptSeq)
    )
  }

  private isAfterInterrupt(sessionId: string, seq: number | undefined): boolean {
    const latest = this.interruptSeqBySession.get(sessionId)
    return !isPresent(latest) || (isPresent(seq) && seq > latest)
  }

  private suppressPendingAtOrBefore(
    entry: KernelSessionRunEntry,
    seq: number | undefined
  ): void {
    const pending = entry.pending
    if (!pending) return
    if (
      pending.mode === 'wake' &&
      isPresent(seq) &&
      isPresent(pending.seq) &&
      pending.seq > seq
    ) return

    entry.pending = undefined
    this.settleSuppressedDemand(pending)
  }
}
