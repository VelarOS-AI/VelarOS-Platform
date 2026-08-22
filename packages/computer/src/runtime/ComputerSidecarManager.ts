import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'

import { isFalse, isNull } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { type TimerLease, TimerScope } from '@velaros-ai/core/utils/TimerScope'

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
  timer: TimerLease
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
/** stderr 只留尾部这么多字节：它唯一的用途是给启动失败当 detail，不是日志缓冲区。 */
const STDERR_TAIL_LIMIT = 8_000
/** helper 启动完成时主动发来的握手行用 id=0，与任何真实请求 id（从 1 递增）不冲突。 */
const READY_HANDSHAKE_ID = 0

/**
 * 默认辅助进程启动器。两项行为是刻意设计：
 * - **参数数组直传，不经过命令解释器**：解释器和脚本路径由 `ComputerHelperResolver` 从固定布局
 *   解析，不拼接命令行字符串，因而不产生命令注入面。
 * - **继承父进程环境**：辅助程序是随插件分发的自包含虚拟环境，需要 `PATH`、`HOME` 等信息定位
 *   系统接口与显示会话。这里只额外固定两个 Python 行为开关，关闭缓冲并禁止写入 `.pyc`，保证
 *   标准输入输出协议实时且不在插件目录生成编译产物。
 */
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
 *
 * 导览（§5.3b ②状态机与生命周期 / ③并发与时序 / ⑥非显然的妥协）
 *
 * **状态机**：`idle`(child=null, startPromise=null, ready=false) → `starting`(startPromise 在飞)
 * → `ready`(收到 id=0 握手) → `dead`(进程退出 / dispose)。三个字段是同一个状态的三个投影，
 * 必须一起迁移——**唯一合法的回到 idle 的路径是 `teardown()`**，别在别处单独改 `ready` 或
 * `child`，否则会造出「ready=true 但 child 已死」这种没有出口的假状态。
 * `disposed` 是终态：置位后不再有任何迁移，`start()`/`request()` 一律直接拒。
 *
 * **两个曾经真实存在的死锁（2026-07-30 Q3b 修复，别改回去）**：
 * 1. `start()` 失败后若不把 `startPromise` 归零，后续每次 `start()` 都会拿到**同一个已拒绝的
 *    promise**——一次瞬时失败（helper 未装 / spawn 抛错）就把 sidecar 永久钉死，用户装好插件
 *    也活不过来，只能重启应用。异步失败走 `onFail → teardown()` 归零；**同步**失败走 `start()`
 *    尾部那段带身份校验的 `catch`（executor 体在 `this.startPromise = …` 赋值**之前**就跑完了，
 *    那时 teardown 清的是上一轮的值）。
 * 2. `exit` 事件在 ready **之后**到达时 `onFail` 已 settled、不会再 teardown，于是 `ready` 停在
 *    true、`child` 指着死进程：后续每个请求都写进死管道再干等一整个超时，且永不重启。所以
 *    `exit` 处理器结尾无条件 `teardown()`（幂等），把状态机拉回 idle，下一次请求自然重启。
 *
 * **时序与关联**：请求 id 从 1 单调递增、不复用；每个请求自带超时租约（`requestTimeoutMs`），
 * 到点就从 `pending` 摘除并拒绝——所以**响应迟到时找不到 pending 会被静默丢弃**，这是设计而非
 * 缺陷（迟到的结果对调用方已无意义）。进程死亡时 `rejectAllPending` 一次性清账，不留悬挂 promise。
 *
 * **失败方向**：`ensureAvailable()` 永不抛，把一切失败翻译成结构化 `ComputerAvailability`
 * （上层据此引导用户装插件或授权）；`request()` 则一律抛——动作类调用没有「降级」这一说。
 *
 * **妥协**：不做重启退避/自动重连。sidecar 死了就回 idle，等下一次调用重新拉起；桌面控制是
 * 低频人工触发的能力，重试策略留给调用方比在这里内建一套更可预期。
 */
export class ComputerSidecarManager {
  private readonly resolveHelper: () => Nullable<ComputerHelperLaunchSpec>
  private readonly spawnProcess: ComputerSidecarSpawner
  private readonly requestTimeoutMs: number
  private readonly onLog?: (message: string) => void
  private readonly timers = new TimerScope({ name: 'ComputerSidecarManager' })

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
        reason: this.classifyStartError(error),
        detail: AppError.getMessage(error),
      }
    }

    try {
      const permissions = await this.request<ComputerPermissionStatus>('check', {})
      const permissionMissing =
        isFalse(permissions.accessibility) || isFalse(permissions.screenRecording)
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
        detail: AppError.getMessage(error),
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
    if (this.disposed) throw new AppError('COMPUTER_SIDECAR_DISPOSED', 'Computer sidecar has been disposed')
    await this.start()

    const id = this.nextRequestId++
    return new Promise<TResult>((resolvePromise, rejectPromise) => {
      const timer = this.timers.after(this.requestTimeoutMs, () => {
        this.pending.delete(id)
        rejectPromise(
          new AppError('TIMEOUT', `Computer sidecar request "${command}" timed out`, undefined, {
            command,
            requestId: id,
            timeoutMs: this.requestTimeoutMs,
          })
        )
      }, { label: `computer-request:${id}` })

      this.pending.set(id, {
        resolve: (value) => resolvePromise(value as TResult),
        reject: rejectPromise,
        timer,
      })

      try {
        this.child!.stdin.write(encodeComputerRequest(id, command, payload))
      } catch (error) {
        // arch-guard:silent-catch-ok 写入失败会通过 rejectPromise 作为请求错误返回调用方。
        timer.cancel()
        this.pending.delete(id)
        rejectPromise(AppError.from(error, 'COMPUTER_SIDECAR_WRITE_FAILED'))
      }
    })
  }

  /** 幂等启动 sidecar，并等待 ready 握手。 */
  public start(): Promise<void> {
    if (this.disposed)
      return Promise.reject(
        new AppError('COMPUTER_SIDECAR_DISPOSED', 'Computer sidecar has been disposed')
      )
    if (this.ready) return Promise.resolve()
    if (this.startPromise) return this.startPromise

    const startPromise = new Promise<void>((resolvePromise, rejectPromise) => {
      const spec = this.resolveHelper()
      if (!spec) {
        // 消息文本被 classifyStartError 按关键字分类，改词会改可用性判定，别润色。
        rejectPromise(
          new AppError('COMPUTER_HELPER_MISSING', 'Desktop-control helper script was not found.')
        )
        return
      }

      let child: ComputerSidecarProcess
      try {
        child = this.spawnProcess(spec)
      } catch (error) {
        // arch-guard:silent-catch-ok 启动失败会通过 rejectPromise 作为启动错误返回调用方。
        rejectPromise(AppError.from(error, 'COMPUTER_SIDECAR_SPAWN_FAILED'))
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
        if (this.stderrBuffer.length > STDERR_TAIL_LIMIT) {
          this.stderrBuffer = this.stderrBuffer.slice(-STDERR_TAIL_LIMIT)
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
        onFail(new AppError('COMPUTER_SIDECAR_EXITED', reason, undefined, { exitCode: code }))
        this.rejectAllPending(
          new AppError('COMPUTER_SIDECAR_EXITED', 'Computer sidecar exited.', undefined, {
            exitCode: code,
          })
        )
        // ready 之后才退出时 onFail 已 settled、不会再 teardown，状态机会卡在「ready=true 但进程
        // 已死」——后续每个请求写进死管道再干等一整个超时，且永不重启。teardown 幂等，无条件调用
        // 把状态机拉回 idle，下一次请求自然重新拉起 sidecar。
        this.teardown()
      })
    })

    this.startPromise = startPromise
    // 同步失败路径的归零点：executor 体在上面这行赋值**之前**就已跑完，onFail → teardown() 那时
    // 清的是上一轮的值。不补这一手，一次瞬时启动失败就把 sidecar 永久钉死（详见类头导览）。
    // 身份校验保证不会误清掉后来那一轮的 startPromise。
    void startPromise.catch(() => {
      // arch-guard:silent-catch-ok 拒绝由 startPromise 原样返回调用方；此处理器只修复内部状态。
      if (this.startPromise === startPromise) this.startPromise = null
    })
    return startPromise
  }

  /** 终止 sidecar，并拒绝仍在进行中的请求。 */
  public dispose(): void {
    this.disposed = true
    this.rejectAllPending(
      new AppError('COMPUTER_SIDECAR_DISPOSED', 'Computer sidecar disposed.')
    )
    this.timers.dispose()
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
        // arch-guard:silent-catch-ok 错误通过下方注入的 sidecar 日志端口留痕，再跳过单个坏帧。
        // 坏帧只丢这一行、不拖垮链路：helper 的 print 调试输出混进 stdout 是常态，
        // 为一行噪音杀掉整个 sidecar 会把可恢复问题升级成不可用。留痕后继续读下一行。
        this.log(`failed to decode sidecar line: ${AppError.getMessage(error)}`)
        continue
      }

      if (response.id === READY_HANDSHAKE_ID) {
        onReady()
        continue
      }

      // id 缺失（helper 主动推的非应答行）无从关联，丢弃。
      if (isNull(response.id)) continue
      const pending = this.pending.get(response.id)
      // 找不到 pending = 该请求已超时摘除，迟到的结果对调用方已无意义（见类头导览「时序与关联」）。
      if (!pending) continue
      this.pending.delete(response.id)
      pending.timer.cancel()

      if (response.ok) {
        pending.resolve(response.result)
      } else {
        pending.reject(
          new AppError('COMPUTER_HELPER_ERROR', `${response.error.code}: ${response.error.message}`, undefined, {
            helperErrorCode: response.error.code,
          })
        )
      }
    }
  }

  private classifyStartError(error: unknown): ComputerAvailability['reason'] {
    const message = AppError.getMessage(error).toLowerCase()
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
      pending.timer.cancel()
      pending.reject(error)
    }
    this.pending.clear()
  }

  /** 把状态机拉回 idle 的**唯一**出口；幂等，重复调用安全（进程可能已自行退出）。 */
  private teardown(): void {
    this.ready = false
    this.startPromise = null
    if (this.child) {
      try {
        this.child.stdin.end()
      } catch {
        // arch-guard:silent-catch-ok 释放阶段 best-effort：进程可能已退出，管道关闭失败无补救动作也无诊断价值。
      }
      try {
        this.child.kill('SIGTERM')
      } catch {
        // arch-guard:silent-catch-ok 同上——kill 已退出的进程不是错误，只是竞态。
      }
      this.child = null
    }
  }

  private log(message: string): void {
    this.onLog?.(`[computer-sidecar] ${message}`)
  }
}
