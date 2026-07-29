import { isFunction, isObject,isPresent } from '../typeGuards.js'
type TimerScopeKind = 'animation-frame' | 'interval' | 'timeout'

type TimerCallback = () => void
type AnimationFrameCallback = (time: number) => void

interface TimerHost {
  setTimeout(callback: TimerCallback, delayMs: number): unknown
  clearTimeout(handle: unknown): void
  setInterval(callback: TimerCallback, delayMs: number): unknown
  clearInterval(handle: unknown): void
  requestAnimationFrame?: (callback: AnimationFrameCallback) => number
  cancelAnimationFrame?: (handle: number) => void
}

interface TimerScopeOptions {
  host?: Partial<TimerHost>
  name?: string
}

interface TimerTaskOptions {
  label?: string
  signal?: AbortSignal
  unref?: boolean
}

interface TimerTimeoutOptions extends TimerTaskOptions {
  timeoutMessage?: string
}

interface TimerLease {
  readonly active: boolean
  readonly id: number
  readonly kind: TimerScopeKind
  readonly label?: string
  cancel(): boolean
  dispose(): void
}

type DebouncedTimerCallback<Args extends unknown[]> = ((...args: Args) => void) & {
  readonly pending: boolean
  cancel(): boolean
  dispose(): void
  flush(): void
}

interface TimerRecord {
  abortCleanup?: () => void
  cancelNative: () => void
  kind: TimerScopeKind
  label?: string
}

interface NativeTimerWithUnref {
  unref?: () => void
}

function getDefaultTimerHost(): TimerHost {
  const runtime = globalThis as typeof globalThis & Partial<TimerHost>
  return {
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) =>
      globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
    setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
    clearInterval: (handle) =>
      globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
    requestAnimationFrame: runtime.requestAnimationFrame?.bind(globalThis),
    cancelAnimationFrame: runtime.cancelAnimationFrame?.bind(globalThis),
  }
}

function readHostMethod<Host extends object, Key extends keyof Host>(
  host: Host,
  key: Key
): Host[Key] {
  const value = host[key]
  return isFunction(value) ? value.bind(host) : value
}

function buildTimerHost(override?: Partial<TimerHost>): TimerHost {
  const defaults = getDefaultTimerHost()
  const source: Partial<TimerHost> = override ?? {}
  const hasOverride = (key: keyof TimerHost): boolean => !!source[key]

  return {
    setTimeout:
      hasOverride('setTimeout')
        ? (readHostMethod(source, 'setTimeout') ?? defaults.setTimeout)
        : defaults.setTimeout,
    clearTimeout:
      hasOverride('clearTimeout')
        ? (readHostMethod(source, 'clearTimeout') ?? defaults.clearTimeout)
        : defaults.clearTimeout,
    setInterval:
      hasOverride('setInterval')
        ? (readHostMethod(source, 'setInterval') ?? defaults.setInterval)
        : defaults.setInterval,
    clearInterval:
      hasOverride('clearInterval')
        ? (readHostMethod(source, 'clearInterval') ?? defaults.clearInterval)
        : defaults.clearInterval,
    requestAnimationFrame:
      hasOverride('requestAnimationFrame')
        ? readHostMethod(source, 'requestAnimationFrame')
        : defaults.requestAnimationFrame,
    cancelAnimationFrame:
      hasOverride('cancelAnimationFrame')
        ? readHostMethod(source, 'cancelAnimationFrame')
        : defaults.cancelAnimationFrame,
  }
}

function normalizeDelay(delayMs: number): number {
  return Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0
}

function maybeUnref(handle: unknown, enabled?: boolean): void {
  if (!enabled || !isPresent(handle) || !isObject(handle)) return

  const timer = handle as NativeTimerWithUnref
  timer.unref?.()
}

function createNamedError(message: string, name: string): Error {
  const runtime = globalThis as typeof globalThis & {
    DOMException?: new (message?: string, name?: string) => Error
  }
  if (runtime.DOMException) return new runtime.DOMException(message, name)

  const error = new Error(message)
  error.name = name
  return error
}

function createAbortError(): Error {
  return createNamedError('计时任务已被中止。', 'AbortError')
}

function createTimeoutError(timeoutMs: number, message?: string): Error {
  return createNamedError(
    message ?? `任务已超过 ${normalizeDelay(timeoutMs)}ms 超时。`,
    'TimeoutError'
  )
}

/** 按生命周期作用域托管延迟、重复任务、下一帧任务和超时控制。 */
class TimerScope {
  private readonly childScopes = new Set<TimerScope>()
  private readonly disposeController = new AbortController()
  private readonly host: TimerHost
  private readonly name: string
  private readonly records = new Map<number, TimerRecord>()
  private disposed = false
  private nextId = 1
  private parent?: TimerScope

  /** 创建临时作用域执行一次可取消延迟，结束后自动释放。 */
  public static async sleep(delayMs: number, options: TimerTaskOptions = {}): Promise<void> {
    const scope = new TimerScope({ name: options.label ?? 'TimerScope.sleep' })
    try {
      await scope.sleep(delayMs, options)
    } finally {
      scope.dispose()
    }
  }

  constructor(options: TimerScopeOptions = {}) {
    this.host = buildTimerHost(options.host)
    this.name = options.name ?? 'TimerScope'
  }

  /** 返回作用域是否已经释放。 */
  get isDisposed(): boolean {
    return this.disposed
  }

  /** 返回当前作用域里仍存活的计时任务数量。 */
  get size(): number {
    return this.records.size
  }

  /** 创建子作用域；父作用域释放时会自动释放全部子作用域。 */
  public child(name?: string): TimerScope {
    this.assertActive()
    const scope = new TimerScope({
      host: this.host,
      name: name ? `${this.name}.${name}` : `${this.name}.child`,
    })
    scope.parent = this
    this.childScopes.add(scope)
    return scope
  }

  /** 在指定延迟后执行一次任务，并返回可取消 lease。 */
  public after(
    delayMs: number,
    callback: TimerCallback,
    options: TimerTaskOptions = {}
  ): TimerLease {
    this.assertActive()
    const id = this.createId()
    const nativeHandle = this.host.setTimeout(() => {
      const record = this.takeRecord(id)
      if (!record) return

      record.abortCleanup?.()
      callback()
    }, normalizeDelay(delayMs))

    maybeUnref(nativeHandle, options.unref)
    return this.track(id, 'timeout', () => this.host.clearTimeout(nativeHandle), options)
  }

  /** 按固定间隔重复执行任务，并返回可取消 lease。 */
  public every(
    intervalMs: number,
    callback: TimerCallback,
    options: TimerTaskOptions = {}
  ): TimerLease {
    this.assertActive()
    const id = this.createId()
    const nativeHandle = this.host.setInterval(callback, normalizeDelay(intervalMs))

    maybeUnref(nativeHandle, options.unref)
    return this.track(id, 'interval', () => this.host.clearInterval(nativeHandle), options)
  }

  /** 在下一帧执行任务；只使用原生 requestAnimationFrame，不做 timeout 模拟。 */
  public nextFrame(callback: AnimationFrameCallback, options: TimerTaskOptions = {}): TimerLease {
    this.assertActive()
    this.assertAnimationFrameSupport()
    const id = this.createId()
    const nativeHandle = this.host.requestAnimationFrame?.((time) => {
      const record = this.takeRecord(id)
      if (!record) return

      record.abortCleanup?.()
      callback(time)
    })

    return this.track(
      id,
      'animation-frame',
      () => this.host.cancelAnimationFrame?.(Number(nativeHandle)),
      options
    )
  }

  /** 返回一个跟随作用域释放或 AbortSignal 中止的延迟 Promise。 */
  public sleep(delayMs: number, options: TimerTaskOptions = {}): Promise<void> {
    this.assertActive()
    if (options.signal?.aborted) return Promise.reject(createAbortError())

    return new Promise((resolve, reject) => {
      let settled = false
      let lease: Nullable<TimerLease> = null
      const cleanup = (): void => {
        this.disposeController.signal.removeEventListener('abort', abort)
        options.signal?.removeEventListener('abort', abort)
      }
      const abort = (): void => {
        if (settled) return

        settled = true
        lease?.cancel()
        cleanup()
        reject(createAbortError())
      }

      this.disposeController.signal.addEventListener('abort', abort, { once: true })
      options.signal?.addEventListener('abort', abort, { once: true })
      lease = this.after(
        delayMs,
        () => {
          if (settled) return

          settled = true
          cleanup()
          resolve()
        },
        {
          ...options,
          signal: undefined,
        }
      )
    })
  }

  /** 为异步任务创建独立超时信号，超时、外部中止或作用域释放都会结束等待方。 */
  public async withTimeout<T>(
    timeoutMs: number,
    task: (signal: AbortSignal) => Promise<T> | T,
    options: TimerTimeoutOptions = {}
  ): Promise<T> {
    this.assertActive()
    if (options.signal?.aborted) {
      throw createAbortError()
    }

    const controller = new AbortController()
    const relayAbort = (): void => {
      controller.abort(createAbortError())
    }
    const relayDispose = (): void => {
      controller.abort(createAbortError())
    }
    options.signal?.addEventListener('abort', relayAbort, { once: true })
    this.disposeController.signal.addEventListener('abort', relayDispose, { once: true })

    const timeout = this.after(
      timeoutMs,
      () => {
        controller.abort(createTimeoutError(timeoutMs, options.timeoutMessage))
      },
      {
        ...options,
        signal: undefined,
      }
    )
    const abortWaiter = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(controller.signal.reason ?? createAbortError()),
        { once: true }
      )
    })

    try {
      return await Promise.race([Promise.resolve(task(controller.signal)), abortWaiter])
    } finally {
      options.signal?.removeEventListener('abort', relayAbort)
      this.disposeController.signal.removeEventListener('abort', relayDispose)
      timeout.cancel()
    }
  }

  /** 创建防抖回调；调用方不需要保存原生 timeout handle。 */
  public debounce<Args extends unknown[]>(
    delayMs: number,
    callback: (...args: Args) => void,
    options: TimerTaskOptions = {}
  ): DebouncedTimerCallback<Args> {
    let lease: Nullable<TimerLease> = null
    let latestArgs: Nullable<Args> = null

    const cancel = (): boolean => {
      latestArgs = null
      const cancelled =!!lease?.cancel()
      lease = null
      return cancelled
    }
    const flush = (): void => {
      if (!latestArgs) return

      const args = latestArgs
      lease?.cancel()
      lease = null
      latestArgs = null
      callback(...args)
    }
    const debounced = ((...args: Args): void => {
      latestArgs = args
      lease?.cancel()
      lease = this.after(delayMs, flush, options)
    }) as DebouncedTimerCallback<Args>

    Object.defineProperty(debounced, 'pending', {
      get: () =>!!lease?.active,
    })
    debounced.cancel = cancel
    debounced.dispose = () => {
      cancel()
    }
    debounced.flush = flush
    return debounced
  }

  /** 取消一个由当前作用域创建的 lease。 */
  public cancel(lease?: LooseOptional<TimerLease>): boolean {
    if (!lease) return false

    return this.cancelRecord(lease.id, lease.kind)
  }

  /** 按类型或全部取消当前作用域中的任务。 */
  public cancelAll(kind?: TimerScopeKind): void {
    for (const [id, record] of [...this.records]) {
      if (kind && record.kind !== kind) {
        continue
      }

      this.cancelRecord(id, record.kind)
    }
  }

  /** 释放作用域和所有子作用域。 */
  public dispose(): void {
    if (this.disposed) return

    this.disposed = true
    this.disposeController.abort(createAbortError())
    for (const child of [...this.childScopes]) {
      child.dispose()
    }
    this.childScopes.clear()
    this.cancelAll()
    this.parent?.childScopes.delete(this)
    this.parent = undefined
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error(`${this.name} 已释放。`)
    }
  }

  private assertAnimationFrameSupport(): void {
    if (!this.host.requestAnimationFrame || !this.host.cancelAnimationFrame) {
      throw new Error(`${this.name} 当前运行环境不支持原生 requestAnimationFrame。`)
    }
  }

  private cancelRecord(id: number, expectedKind?: TimerScopeKind): boolean {
    const record = this.records.get(id)
    if (!record || (expectedKind && record.kind !== expectedKind)) return false

    this.records.delete(id)
    record.abortCleanup?.()
    record.cancelNative()
    return true
  }

  private createId(): number {
    return this.nextId++
  }

  private createLease(id: number, kind: TimerScopeKind, label?: string): TimerLease {
    const scope = this
    return {
      id,
      kind,
      label,
      get active() {
        return scope.records.has(id)
      },
      cancel: () => scope.cancelRecord(id, kind),
      dispose: () => {
        scope.cancelRecord(id, kind)
      },
    }
  }

  private takeRecord(id: number): TimerRecord | undefined {
    const record = this.records.get(id)
    this.records.delete(id)
    return record
  }

  private track(
    id: number,
    kind: TimerScopeKind,
    cancelNative: () => void,
    options: TimerTaskOptions
  ): TimerLease {
    if (options.signal?.aborted) {
      cancelNative()
      return this.createLease(id, kind, options.label)
    }

    const lease = this.createLease(id, kind, options.label)
    let abortCleanup: (() => void) | undefined
    if (options.signal) {
      abortCleanup = this.bindAbortSignal(lease, options.signal)
    }
    this.records.set(id, {
      abortCleanup,
      cancelNative,
      kind,
      label: options.label,
    })
    return lease
  }

  private bindAbortSignal(lease: TimerLease, signal: AbortSignal): () => void {
    const abort = (): void => {
      lease.cancel()
    }
    signal.addEventListener('abort', abort, { once: true })
    return () => signal.removeEventListener('abort', abort)
  }
}

export { TimerScope }
export type {
  DebouncedTimerCallback,
  TimerHost,
  TimerLease,
  TimerScopeKind,
  TimerScopeOptions,
  TimerTaskOptions,
  TimerTimeoutOptions,
}
