import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'

import { type ComputerHelperLaunchSpec, resolveComputerHelper } from './ComputerHelperResolver'
import {
  decodeComputerResponse,
  drainResponseLines,
  encodeComputerRequest,
} from './ComputerSidecarProtocol'
import type {
  ComputerAvailability,
  ComputerClickResult,
  ComputerCommand,
  ComputerKeyResult,
  ComputerMoveResult,
  ComputerPermissionStatus,
  ComputerScreenshot,
  ComputerScreenSize,
  ComputerTypeResult,
} from './types'

type Nullable<T> = T | null

/** manager 依赖的最小子进程接口，测试中可注入替身。 */
export interface ComputerSidecarProcess {
  stdin: { write(chunk: string): void; end(): void }
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): void }
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): void }
  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'exit', listener: (code: Nullable<number>) => void): void
  kill(signal?: NodeJS.Signals): void
}

export type ComputerSidecarSpawner = (
  spec: ComputerHelperLaunchSpec
) => ComputerSidecarProcess

export interface ComputerSidecarManagerOptions {
  /** 覆盖 helper 解析逻辑，用于测试或自定义打包。 */
  resolveHelper?: () => Nullable<ComputerHelperLaunchSpec>
  /** 覆盖子进程创建逻辑，测试中注入假 duplex。 */
  spawnProcess?: ComputerSidecarSpawner
  /** 单个请求超时时间，单位毫秒，默认 15000。 */
  requestTimeoutMs?: number
  /** 可选诊断日志接收器。 */
  onLog?: (message: string) => void
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

function defaultSpawner(spec: ComputerHelperLaunchSpec): ComputerSidecarProcess {
  const child: ChildProcessWithoutNullStreams = spawn(
    spec.pythonCommand,
    [spec.helperScript],
    {
      cwd: spec.runtimeDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' },
    }
  )
  return child
}

/**
 * 桌面控制辅助进程的长生命周期管理器。
 *
 * 负责懒启动平台脚本、完成握手、关联请求响应、报告可用性并释放资源。
 * 在调用动作或 ensureAvailable 前不会自动启动，测试和 CI 中导入没有副作用。
 */
export class ComputerSidecarManager {
  private readonly resolveHelper: () => Nullable<ComputerHelperLaunchSpec>
  private readonly spawnProcess: ComputerSidecarSpawner
  private readonly requestTimeoutMs: number
  private readonly onLog?: (message: string) => void

  private child: Nullable<ComputerSidecarProcess> = null
  private startPromise: Nullable<Promise<void>> = null
  private stdoutBuffer = ''
  private stderrBuffer = ''
  private ready = false
  private disposed = false
  private nextRequestId = 1
  private readonly pending = new Map<number, PendingRequest>()

  constructor(options: ComputerSidecarManagerOptions = {}) {
    this.resolveHelper = options.resolveHelper ?? (() => resolveComputerHelper())
    this.spawnProcess = options.spawnProcess ?? defaultSpawner
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.onLog = options.onLog
  }

  /** sidecar ready 握手完成后返回 true。 */
  public isReady(): boolean {
    return this.ready
  }

  /**
   * 探测桌面控制是否可用：解析 helper、启动进程并执行 check。
   *
   * 该方法不向外抛错，而是返回结构化可用性结果。
   */
  public async ensureAvailable(): Promise<ComputerAvailability> {
    const spec = this.resolveHelper()
    if (!spec) return {
        available: false,
        reason: 'helper-missing',
        detail: 'Desktop-control helper script was not found.',
      }

    try {
      await this.start()
    } catch (error) {
      return {
        available: false,
        reason: this.classifyStartError(error as Error),
        detail: (error as Error).message,
      }
    }

    try {
      const permissions = await this.request<ComputerPermissionStatus>('check', {})
      const permissionMissing =
        permissions.accessibility === false || permissions.screenRecording === false
      return {
        available: !permissionMissing,
        reason: permissionMissing ? 'permission-missing' : 'available',
        detail: permissionMissing ? this.permissionMissingDetail(permissions) : null,
        permissions,
      }
    } catch (error) {
      return {
        available: false,
        reason: 'dependencies-missing',
        detail: (error as Error).message,
      }
    }
  }

  public async screenSize(): Promise<ComputerScreenSize> {
    return this.request<ComputerScreenSize>('screen_size', {})
  }

  public async screenshot(): Promise<ComputerScreenshot> {
    // 不暴露自定义缩放：截图统一返回逻辑分辨率，保证与点击坐标空间 1:1 一致。
    return this.request<ComputerScreenshot>('screenshot', {})
  }

  public async mouseMove(x: number, y: number): Promise<ComputerMoveResult> {
    return this.request<ComputerMoveResult>('mouse_move', { x, y })
  }

  public async leftClick(
    x: number,
    y: number,
    options: { button?: 'left' | 'right' | 'middle'; count?: number } = {}
  ): Promise<ComputerClickResult> {
    return this.request<ComputerClickResult>('left_click', { x, y, ...options })
  }

  public async typeText(text: string): Promise<ComputerTypeResult> {
    return this.request<ComputerTypeResult>('type', { text })
  }

  public async key(keys: string): Promise<ComputerKeyResult> {
    return this.request<ComputerKeyResult>('key', { keys })
  }

  /** 发送命令并等待关联响应；必要时会懒启动 sidecar。 */
  public async request<TResult>(
    command: ComputerCommand,
    payload: Record<string, unknown>
  ): Promise<TResult> {
    if (this.disposed) throw new Error('Computer sidecar has been disposed')
    await this.start()

    const id = this.nextRequestId++
    return new Promise<TResult>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectPromise(new Error(`Computer sidecar request "${command}" timed out`))
      }, this.requestTimeoutMs)

      this.pending.set(id, {
        resolve: (value) => resolvePromise(value as TResult),
        reject: rejectPromise,
        timer,
      })

      try {
        this.child!.stdin.write(encodeComputerRequest(id, command, payload))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        rejectPromise(error as Error)
      }
    })
  }

  /** 幂等启动 sidecar，并等待 ready 握手。 */
  public start(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Computer sidecar has been disposed'))
    if (this.ready) return Promise.resolve()
    if (this.startPromise) return this.startPromise

    this.startPromise = new Promise<void>((resolvePromise, rejectPromise) => {
      const spec = this.resolveHelper()
      if (!spec) {
        rejectPromise(new Error('Desktop-control helper script was not found.'))
        return
      }

      let child: ComputerSidecarProcess
      try {
        child = this.spawnProcess(spec)
      } catch (error) {
        rejectPromise(error as Error)
        return
      }
      this.child = child

      let settled = false
      const onReady = () => {
        if (settled) return
        settled = true
        this.ready = true
        resolvePromise()
      }
      const onFail = (error: Error) => {
        if (settled) return
        settled = true
        this.teardown()
        rejectPromise(error)
      }

      child.stdout.on('data', (chunk) => {
        this.handleStdout(String(chunk), onReady)
      })
      child.stderr.on('data', (chunk) => {
        this.stderrBuffer += String(chunk)
        if (this.stderrBuffer.length > 8_000) {
          this.stderrBuffer = this.stderrBuffer.slice(-8_000)
        }
      })
      child.on('error', (error) => {
        this.log(`sidecar process error: ${error.message}`)
        onFail(error)
      })
      child.on('exit', (code) => {
        this.log(`sidecar exited with code ${code ?? 'null'}`)
        const reason =
          this.stderrBuffer.trim() ||
          `Computer sidecar exited before becoming ready (code ${code ?? 'null'}).`
        onFail(new Error(reason))
        this.rejectAllPending(new Error('Computer sidecar exited.'))
      })
    })

    return this.startPromise
  }

  /** 终止 sidecar，并拒绝仍在进行中的请求。 */
  public dispose(): void {
    this.disposed = true
    this.rejectAllPending(new Error('Computer sidecar disposed.'))
    this.teardown()
  }

  private handleStdout(chunk: string, onReady: () => void): void {
    this.stdoutBuffer += chunk
    const { lines, rest } = drainResponseLines(this.stdoutBuffer)
    this.stdoutBuffer = rest

    for (const line of lines) {
      let response
      try {
        response = decodeComputerResponse(line)
      } catch (error) {
        this.log(`failed to decode sidecar line: ${(error as Error).message}`)
        continue
      }

      // id=0 是启动时发出的 ready 握手。
      if (response.id === 0) {
        onReady()
        continue
      }

      if (response.id === null) continue
      const pending = this.pending.get(response.id)
      if (!pending) continue
      this.pending.delete(response.id)
      clearTimeout(pending.timer)

      if (response.ok) {
        pending.resolve(response.result)
      } else {
        pending.reject(new Error(`${response.error.code}: ${response.error.message}`))
      }
    }
  }

  private classifyStartError(error: Error): ComputerAvailability['reason'] {
    const message = error.message.toLowerCase()
    if (message.includes('enoent') || message.includes('not found')) return 'python-missing'
    if (message.includes('modulenotfounderror') || message.includes('no module named'))
      return 'dependencies-missing'
    return 'spawn-failed'
  }

  private permissionMissingDetail(permissions: ComputerPermissionStatus): string {
    if (permissions.platform === 'linux') return 'Linux desktop control requires a graphical display session with screenshot and input access.'

    return 'Desktop control requires Accessibility and Screen Recording permissions.'
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private teardown(): void {
    this.ready = false
    this.startPromise = null
    if (this.child) {
      try {
        this.child.stdin.end()
      } catch {
        // 忽略释放阶段的 best-effort 失败。
      }
      try {
        this.child.kill('SIGTERM')
      } catch {
        // 忽略释放阶段的 best-effort 失败。
      }
      this.child = null
    }
  }

  private log(message: string): void {
    this.onLog?.(`[computer-sidecar] ${message}`)
  }
}
