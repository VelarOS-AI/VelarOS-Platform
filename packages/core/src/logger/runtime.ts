import { isBoolean, isPresent } from '../typeGuards.js'
import { isEmpty } from '../utils/array.js'

import { LogAssertionError, LogError } from './errors.js'
import {
  buildConsolePayload,
  detectEnvironment,
  detectLevel,
  detectPlatform,
  filterDefined,
  formatConsoleTag,
  isPromiseLike,
  LEVEL_TO_CONSOLE_METHOD,
  LEVEL_TO_NUMERIC,
  mergeContext,
  shouldDispatch,
} from './helpers.js'
import { Logger } from './Logger.js'
import type {
  GlobalLog,
  LogContext,
  LogEnvironment,
  LogErrorOptions,
  LogEventRecord,
  LogLevel,
  LogMessageRecord,
  LogPlatform,
  LogRecord,
  LogRuntimeOptions,
  LogTransport,
} from './types.js'

const INTERNAL_CONSOLE_TRANSPORT_ID = '__console__'

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error'

interface GuardedConsoleStream {
  destroyed?: boolean
  writableEnded?: boolean
  on?: (event: 'error', listener: (error: unknown) => void) => unknown
}

interface ConsoleStreamState {
  faulted: boolean
}

const consoleStreamStates = new WeakMap<object, ConsoleStreamState>()

function resolveConsoleStream(method: ConsoleMethod): GuardedConsoleStream | null {
  const runtimeProcess = (
    globalThis as typeof globalThis & {
      process?: { stdout?: GuardedConsoleStream; stderr?: GuardedConsoleStream }
    }
  ).process
  return method === 'warn' || method === 'error'
    ? runtimeProcess?.stderr ?? null
    : runtimeProcess?.stdout ?? null
}

function prepareConsoleStream(method: ConsoleMethod): boolean {
  const stream = resolveConsoleStream(method)
  if (!stream || typeof stream !== 'object') return true
  let state = consoleStreamStates.get(stream)
  if (!state) {
    state = { faulted: false }
    consoleStreamStates.set(stream, state)
    stream.on?.('error', () => {
      state!.faulted = true
    })
  }
  return !state.faulted && stream.destroyed !== true && stream.writableEnded !== true
}

function markConsoleStreamFaulted(method: ConsoleMethod): void {
  const stream = resolveConsoleStream(method)
  if (!stream || typeof stream !== 'object') return
  const state = consoleStreamStates.get(stream) ?? { faulted: false }
  state.faulted = true
  consoleStreamStates.set(stream, state)
}

type RuntimeState = {
  appName?: string
  serviceName?: string
  environment: LogEnvironment
  platform: LogPlatform
  level: LogLevel
  consoleEnabled: boolean
  staticContext: LogContext
}

type WriteMessageOptions = {
  level: LogLevel
  scope: string
  message: string
  args: unknown[]
  context: LogContext
  error?: unknown
}

type WriteEventOptions = {
  scope: string
  name: string
  payload: LogContext
  context: LogContext
}

export class LogRuntime implements GlobalLog {
  private readonly transports = new Map<string, LogTransport>()
  private readonly pendingTasks = new Set<Promise<void>>()
  private pausedRecords: LogRecord[] = []
  private isPaused = false
  private state: RuntimeState

  constructor(options: LogRuntimeOptions = {}) {
    this.state = resolveState(options)
    this.addTransport({
      id: INTERNAL_CONSOLE_TRANSPORT_ID,
      write: (record) => this.writeToConsole(record),
    })
  }

  public init(options: boolean | Partial<LogRuntimeOptions>): void {
    if (isBoolean(options)) {
      this.configure({
        environment: options ? 'development' : 'production',
        level: options ? 'debug' : 'info',
      })
      return
    }

    this.configure(options)
  }

  public configure(options: Partial<LogRuntimeOptions>): void {
    this.state = resolveState({
      ...this.state,
      ...options,
      staticContext: options.staticContext
        ? mergeContext(this.state.staticContext, options.staticContext)
        : this.state.staticContext,
    })
  }

  public setLevel(level: LogLevel): void {
    this.configure({ level })
  }

  public pause(): void {
    this.isPaused = true
  }

  public resume(): void {
    if (!this.isPaused) return

    this.isPaused = false
    const buffered = [...this.pausedRecords]
    this.pausedRecords = []
    for (const record of buffered) {
      this.dispatch(record)
    }
  }

  public tag(scope: string, context: LogContext = {}): Logger {
    return new Logger(this, scope, context)
  }

  public event(name: string, payload: LogContext = {}): void {
    this.writeEvent({
      scope: 'App',
      name,
      payload,
      context: {},
    })
  }

  public addTransport(transport: LogTransport): void {
    if (this.transports.has(transport.id)) {
      throw new LogError('LogRuntime', `Transport already exists: ${transport.id}`)
    }

    this.transports.set(transport.id, transport)
  }

  public tryAddTransport(transport: LogTransport): boolean {
    if (this.transports.has(transport.id)) return false

    this.transports.set(transport.id, transport)
    return true
  }

  public removeTransport(id: string): boolean {
    const transport = this.transports.get(id)
    if (!isPresent(transport)) return false

    this.transports.delete(id)
    this.track(transport.dispose?.(), transport.id)
    return true
  }

  public hasTransport(id: string): boolean {
    return this.transports.has(id)
  }

  public listTransports(): string[] {
    return Array.from(this.transports.keys())
  }

  public async flush(): Promise<void> {
    const pending = Array.from(this.pendingTasks)
    if (!isEmpty(pending)) {
      await Promise.allSettled(pending)
    }

    const flushTasks = filterDefined(
      Array.from(this.transports.values(), (transport) => transport.flush?.())
    )
    if (!isEmpty(flushTasks)) {
      await Promise.allSettled(flushTasks)
    }
  }

  public async dispose(): Promise<void> {
    await this.flush()

    const disposeTasks = filterDefined(
      Array.from(this.transports.values(), (transport) => transport.dispose?.())
    )
    if (!isEmpty(disposeTasks)) {
      await Promise.allSettled(disposeTasks)
    }
  }

  public createAssertionError(
    scope: string,
    message: string,
    options: LogErrorOptions = {}
  ): LogAssertionError {
    return new LogAssertionError(scope, message, options)
  }

  public createFailureError(
    scope: string,
    message: string,
    options: LogErrorOptions = {}
  ): LogError {
    return new LogError(scope, message, options)
  }

  public writeMessage(options: WriteMessageOptions): void {
    const record: LogMessageRecord = {
      kind: 'message',
      scope: options.scope,
      level: options.level,
      message: options.message,
      args: [...options.args],
      error: options.error,
      timestamp: new Date(),
      environment: this.state.environment,
      platform: this.state.platform,
      appName: this.state.appName,
      serviceName: this.state.serviceName,
      context: mergeContext(this.state.staticContext, options.context),
    }

    this.emit(record)
  }

  public writeEvent(options: WriteEventOptions): void {
    const record: LogEventRecord = {
      kind: 'event',
      scope: options.scope,
      name: options.name,
      payload: options.payload,
      timestamp: new Date(),
      environment: this.state.environment,
      platform: this.state.platform,
      appName: this.state.appName,
      serviceName: this.state.serviceName,
      context: mergeContext(this.state.staticContext, options.context),
    }

    this.emit(record)
  }

  private emit(record: LogRecord): void {
    if (record.kind === 'message' && !this.shouldLog(record.level)) return

    if (this.isPaused) {
      this.pausedRecords.push(record)
      return
    }

    this.dispatch(record)
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_TO_NUMERIC[level] >= LEVEL_TO_NUMERIC[this.state.level]
  }

  private dispatch(record: LogRecord): void {
    for (const transport of this.transports.values()) {
      if (!shouldDispatch(record, transport)) continue
      this.track(transport.write(record), transport.id)
    }
  }

  private writeToConsole(record: LogRecord): void {
    if (!this.state.consoleEnabled || record.kind !== 'message') return

    const method = LEVEL_TO_CONSOLE_METHOD[record.level]
    if (!prepareConsoleStream(method)) return
    const tag = formatConsoleTag(record.level, record.timestamp, record.scope)
    const payload = buildConsolePayload(record)

    try {
      console[method](tag, ...payload)
    } catch {
      markConsoleStreamFaulted(method)
      // stdout/stderr 写入失败（EIO/EPIPE，如父进程关闭了管道、终端断开、dev 启动进程退出）
      // 时静默丢弃这条日志。异步 error 由 prepareConsoleStream 注册的流级监听隔离；同步异常
      // 在这里隔离。一次控制台写入失败绝不能冒泡成 uncaughtException 把主进程拖崩。
    }
  }

  private track(task: void | Promise<void>, transportId = INTERNAL_CONSOLE_TRANSPORT_ID): void {
    if (!isPromiseLike(task)) return

    const pending = Promise.resolve(task)
    this.pendingTasks.add(pending)
    pending
      .catch((error) => {
        if (!prepareConsoleStream('error')) return
        try {
          console.error('[ERR] [LogRuntime] transport failed', { transportId, error })
        } catch {
          markConsoleStreamFaulted('error')
          // 同 writeToConsole：控制台写入失败（EIO/EPIPE）不再向上抛。
        }
      })
      .finally(() => {
        this.pendingTasks.delete(pending)
      })
  }
}

function resolveState(options: LogRuntimeOptions): RuntimeState {
  const environment = options.environment ?? detectEnvironment()

  return {
    appName: options.appName,
    serviceName: options.serviceName,
    environment,
    platform: options.platform ?? detectPlatform(),
    level: options.level ?? detectLevel(environment),
    consoleEnabled: options.consoleEnabled ?? true,
    staticContext: options.staticContext ? { ...options.staticContext } : {},
  }
}
