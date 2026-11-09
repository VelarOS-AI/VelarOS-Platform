import { isFalse, isNull } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { createKeyedSerialQueue } from '@velaros-ai/core/utils/KeyedSerialQueue'
import { type TimerLease, TimerScope } from '@velaros-ai/core/utils/TimerScope'

import { ComputerErrorCodes, ComputerHelperErrorCodes } from '../contract/constants.js'
import type {
  ComputerSidecarManagerOptions,
  ComputerSidecarProcess,
  ComputerSidecarSpawner,
} from '../contract/requires.js'
import type {
  ComputerAvailability,
  ComputerCapabilities,
  ComputerClickOptions,
  ComputerClickResult,
  ComputerDragInput,
  ComputerDragResult,
  ComputerElementAction,
  ComputerElementInput,
  ComputerElementValueInput,
  ComputerHelperLaunchSpec,
  ComputerInputState,
  ComputerKeyResult,
  ComputerKeyStateInput,
  ComputerMouseDownInput,
  ComputerMouseUpInput,
  ComputerMoveOptions,
  ComputerMoveResult,
  ComputerPermissionStatus,
  ComputerRecording,
  ComputerRecordInput,
  ComputerScreenshot,
  ComputerScreenSize,
  ComputerScrollInput,
  ComputerScrollResult,
  ComputerTree,
  ComputerTreeInput,
  ComputerTypeResult,
  ComputerWindow,
  ComputerWindowInput,
} from '../types/computer.js'
import type { ComputerCommand } from '../types/protocol.js'
import {
  classifyStartError,
  describeHelperError,
  permissionMissingDetail,
} from '../utils/availability.js'
import { spawnComputerHelperProcess } from '../utils/process.js'
import {
  decodeComputerResponse,
  drainResponseLines,
  encodeComputerRequest,
} from '../utils/protocol.js'
import { ComputerTuning } from '../utils/tuning.js'

import { createComputerHelperLocator } from './ComputerHelperLocator.js'

/**
 * 桌面控制运行时：宿主持有的那一份，管着 Python helper 子进程的整个生命周期。
 *
 * 每个动作方法都可能懒启动 sidecar；`ensureAvailable` 永不抛，其余方法一律抛——动作类调用没有「降级」这一说。
 */
export interface ComputerRuntimeApi {
  /** 查询本平台窗口、控件树和录像能力及限制。 */
  capabilities(signal?: AbortSignal): Promise<ComputerCapabilities>
  /** 枚举可见窗口；id 只用于本 helper，失效后重新枚举。 */
  windows(signal?: AbortSignal): Promise<ComputerWindow[]>
  /** 截取指定窗口。图经图片通道交给模型；图上坐标使用 coordinateSpace: 'window' 和本次 snapshotId。 */
  screenshotWindow(input: ComputerWindowInput, signal?: AbortSignal): Promise<ComputerScreenshot>
  /** 将指定窗口置前并聚焦；窗口身份失效时失败。 */
  focusWindow(input: ComputerWindowInput, signal?: AbortSignal): Promise<ComputerWindow>
  /** 在指定位置独立滚动；正数向右/下，负数向左/上，单位为滚轮刻度，每轴最多 100。 */
  scroll(input: ComputerScrollInput, signal?: AbortSignal): Promise<ComputerScrollResult>
  /** 原子拖拽，两端先校验再按下；durationMs 为 100–3000（默认 500），失败也释放鼠标。 */
  drag(input: ComputerDragInput, signal?: AbortSignal): Promise<ComputerDragResult>
  /** 在指定位置按下鼠标；用 mouseUp 配对，最多 5000 毫秒后自动释放。 */
  mouseDown(input: ComputerMouseDownInput, signal?: AbortSignal): Promise<ComputerInputState>
  /** 释放鼠标按钮；不需要旧截图，可以重复调用。 */
  mouseUp(input: ComputerMouseUpInput, signal?: AbortSignal): Promise<ComputerInputState>
  /** 按住单个键；必须用 keyUp 配对，最多 5000 毫秒后自动释放。 */
  keyDown(input: ComputerKeyStateInput, signal?: AbortSignal): Promise<ComputerInputState>
  /** 释放单个键；可重复调用。 */
  keyUp(input: ComputerKeyStateInput, signal?: AbortSignal): Promise<ComputerInputState>
  /** 释放此 helper 持有的全部键与鼠标按钮，用于错误恢复。 */
  releaseInputs(signal?: AbortSignal): Promise<ComputerInputState>
  /** 查询窗口的 UI 控件树；maxDepth 最多 12，maxNodes 最多 500；检查 truncated 和 warnings。 */
  uiTree(input: ComputerTreeInput, signal?: AbortSignal): Promise<ComputerTree>
  /** 经控件的 Invoke/AXPress 语义激活；绑定 uiTree 的身份，过期或不支持时报错，不猜坐标。 */
  invokeElement(input: ComputerElementInput, signal?: AbortSignal): Promise<ComputerElementAction>
  /** 经 Value/AXValue 设置控件文本，最多 10000 字符；不会把文本当快捷键。 */
  setElementValue(
    input: ComputerElementValueInput,
    signal?: AbortSignal
  ): Promise<ComputerElementAction>
  /** 录制主屏或窗口到新的绝对路径 MP4；durationMs 100–5000，fps 1–10；不覆盖，不含音频。 */
  record(input: ComputerRecordInput, signal?: AbortSignal): Promise<ComputerRecording>
  /** sidecar 是否完成了 ready 握手。 */
  isReady(): boolean
  /** 探测桌面控制是否可用（解析 helper、启动进程、执行 check），永不抛错，一切失败都在结果里。 */
  ensureAvailable(): Promise<ComputerAvailability>
  /** 主显示器的逻辑几何。 */
  screenSize(signal?: AbortSignal): Promise<ComputerScreenSize>
  /** 截取主显示器，始终按逻辑分辨率，保证图上量出的像素与点击坐标 1:1。 */
  screenshot(signal?: AbortSignal): Promise<ComputerScreenshot>
  /**
   * 在指定坐标空间移动指针；主屏坐标要带截图绑定，helper 在移动前再校验一次。
   * `durationMs` 给需要平滑移动的宿主用。
   */
  mouseMove(
    x: number,
    y: number,
    options?: ComputerMoveOptions,
    signal?: AbortSignal
  ): Promise<ComputerMoveResult>
  /** 在指定坐标空间点击；主屏坐标要带截图绑定，helper 在按下前再校验一次。按哪个键由 `options.button` 决定。 */
  click(
    x: number,
    y: number,
    options?: ComputerClickOptions,
    signal?: AbortSignal
  ): Promise<ComputerClickResult>
  /** 在当前焦点处原样输入文本。 */
  typeText(text: string, signal?: AbortSignal): Promise<ComputerTypeResult>
  /** 按下一个键或组合键。 */
  key(keys: string, signal?: AbortSignal): Promise<ComputerKeyResult>
  /** 终止 sidecar 并拒绝在飞请求；置位后不再有任何状态迁移。 */
  dispose(): void
}

/** 一条在飞请求的账：应答到了怎么交回去，超时了怎么拒绝，以及它自己的超时租约。 */
export interface ComputerSidecarManagerPendingRequest {
  /** 应答到达时把结果交回调用方。 */
  resolve: (value: unknown) => void
  /** 超时、进程死亡或管道断开时拒绝调用方。 */
  reject: (error: Error) => void
  /** 这条请求的超时租约；应答到达或提前失败时要取消。 */
  timer: TimerLease
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
 * **两条「永远不能无界等待」的闸（2026-09-16 实测后补）**：
 * 3. `start()` 自带 `startupTimeoutMs` 租约。helper 卡在导入阶段、或握手行被上一轮残片污染时，
 *    `onReady` 永不触发；而请求的超时租约要等 `await this.start()` 返回才装，于是调用方**永远
 *    挂起**。启动与请求各自有界，最坏等待是两者之和。
 * 4. `teardown()` 连同 `stdoutBuffer` / `stderrBuffer` 一起归零，`data` 处理器又按 child 身份
 *    过滤。上一轮 helper 死在半行 JSON 上时，残片会粘在下一个 helper 的握手行前面，整行解码
 *    失败被当坏帧丢掉——新进程于是「永远没准备好」。缓冲是进程级流状态，不是管理器级状态。
 *
 * **时序与关联**：请求 id 从 1 单调递增、不复用；每个请求自带超时租约（`requestTimeoutMs`），
 * 到点就从 `pending` 摘除并拒绝——所以**响应迟到时找不到 pending 会被静默丢弃**，这是设计而非
 * 缺陷（迟到的结果对调用方已无意义）。进程死亡时 `rejectAllPending` 一次性清账，不留悬挂 promise。
 *
 * **管道错误不许外溢**：`stdin` 的 `EPIPE`（helper 关掉输入或已退出）是**异步错误事件**，
 * `write()` 外的 try/catch 接不住；没有 `'error'` 监听者它就是宿主进程的未捕获异常，在 Electron
 * 主进程会直接弹错误框。`start()` 给 stdin 装了监听器，按「写失败」拒掉在飞请求并 teardown。
 *
 * **妥协**：不做重启退避/自动重连。sidecar 死了就回 idle，等下一次调用重新拉起；桌面控制是
 * 低频人工触发的能力，重试策略留给调用方比在这里内建一套更可预期。
 */
export class ComputerSidecarManager implements ComputerRuntimeApi {
  /** helper 启动完成时主动发来的握手行用这个 id，与任何真实请求 id（从 1 递增）不冲突。 */
  private static readonly ReadyHandshakeId = 0
  /** 这些 helper 错误码属于「入参/截图绑定不对」，报 VALIDATION 让模型重新截图；其余是运行时故障。 */
  private static readonly SnapshotValidationErrorCodes: ReadonlySet<string> = new Set([
    ComputerHelperErrorCodes.snapshotRequired,
    ComputerHelperErrorCodes.snapshotStale,
    ComputerHelperErrorCodes.snapshotUnexpected,
    ComputerHelperErrorCodes.coordinateOutOfBounds,
    ComputerHelperErrorCodes.coordinateSpaceInvalid,
    ComputerHelperErrorCodes.screenStateInvalid,
  ])

  private readonly resolveHelper: () => Nullable<ComputerHelperLaunchSpec>
  private readonly spawnProcess: ComputerSidecarSpawner
  private readonly requestTimeoutMs: number
  private readonly startupTimeoutMs: number
  private readonly onLog?: (message: string) => void
  private readonly timers = new TimerScope({ name: 'ComputerSidecarManager' })
  private readonly requests = createKeyedSerialQueue()
  private generation = 0

  private child: Nullable<ComputerSidecarProcess> = null
  private startPromise: Nullable<Promise<void>> = null
  private rejectStartup: Nullable<(error: Error) => void> = null
  private stdoutBuffer = ''
  private stderrBuffer = ''
  private stdoutDecoder = new TextDecoder('utf-8', { fatal: true })
  private stderrDecoder = new TextDecoder('utf-8', { fatal: true })
  private ready = false
  private disposed = false
  private nextRequestId = 1
  private readonly pending = new Map<number, ComputerSidecarManagerPendingRequest>()

  constructor(options: ComputerSidecarManagerOptions = {}) {
    const locator = createComputerHelperLocator()
    this.resolveHelper = options.resolveHelper ?? (() => locator.resolve())
    this.spawnProcess = options.spawnProcess ?? spawnComputerHelperProcess
    this.requestTimeoutMs = options.requestTimeoutMs ?? ComputerTuning.requestTimeoutMs
    this.startupTimeoutMs = options.startupTimeoutMs ?? ComputerTuning.startupTimeoutMs
    this.onLog = options.onLog
  }

  public isReady(): boolean {
    return this.ready
  }

  public async capabilities(signal?: AbortSignal): Promise<ComputerCapabilities> {
    return this.request<ComputerCapabilities>('capabilities', {}, signal)
  }

  public async windows(signal?: AbortSignal): Promise<ComputerWindow[]> {
    return this.request<ComputerWindow[]>('windows', {}, signal)
  }

  public async screenshotWindow(
    input: ComputerWindowInput,
    signal?: AbortSignal
  ): Promise<ComputerScreenshot> {
    return this.request<ComputerScreenshot>('screenshot_window', { ...input }, signal)
  }

  public async focusWindow(
    input: ComputerWindowInput,
    signal?: AbortSignal
  ): Promise<ComputerWindow> {
    return this.request<ComputerWindow>('focus_window', { ...input }, signal)
  }

  public async scroll(
    input: ComputerScrollInput,
    signal?: AbortSignal
  ): Promise<ComputerScrollResult> {
    return this.request<ComputerScrollResult>('scroll', { ...input }, signal)
  }

  public async drag(input: ComputerDragInput, signal?: AbortSignal): Promise<ComputerDragResult> {
    return this.request<ComputerDragResult>('drag', { ...input }, signal)
  }

  public async mouseDown(
    input: ComputerMouseDownInput,
    signal?: AbortSignal
  ): Promise<ComputerInputState> {
    return this.request<ComputerInputState>('mouse_down', { ...input }, signal)
  }

  public async mouseUp(
    input: ComputerMouseUpInput,
    signal?: AbortSignal
  ): Promise<ComputerInputState> {
    return this.request<ComputerInputState>('mouse_up', { ...input }, signal)
  }

  public async keyDown(
    input: ComputerKeyStateInput,
    signal?: AbortSignal
  ): Promise<ComputerInputState> {
    return this.request<ComputerInputState>('key_down', { ...input }, signal)
  }

  public async keyUp(
    input: ComputerKeyStateInput,
    signal?: AbortSignal
  ): Promise<ComputerInputState> {
    return this.request<ComputerInputState>('key_up', { ...input }, signal)
  }

  public async releaseInputs(signal?: AbortSignal): Promise<ComputerInputState> {
    return this.request<ComputerInputState>('release_inputs', {}, signal)
  }

  public async uiTree(input: ComputerTreeInput, signal?: AbortSignal): Promise<ComputerTree> {
    return this.request<ComputerTree>('ui_tree', { ...input }, signal)
  }

  public async invokeElement(
    input: ComputerElementInput,
    signal?: AbortSignal
  ): Promise<ComputerElementAction> {
    return this.request<ComputerElementAction>('invoke_element', { ...input }, signal)
  }

  public async setElementValue(
    input: ComputerElementValueInput,
    signal?: AbortSignal
  ): Promise<ComputerElementAction> {
    return this.request<ComputerElementAction>('set_element_value', { ...input }, signal)
  }

  public async record(
    input: ComputerRecordInput,
    signal?: AbortSignal
  ): Promise<ComputerRecording> {
    return this.request<ComputerRecording>('record', { ...input }, signal)
  }

  public async ensureAvailable(): Promise<ComputerAvailability> {
    try {
      const spec = this.resolveHelper()
      if (!spec)
        return {
          available: false,
          reason: 'helper-missing',
          detail: '没有找到桌面控制 helper 脚本（插件未安装或已被停用）。',
        }
      await this.start()
    } catch (error) {
      return {
        available: false,
        reason: classifyStartError(error),
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
        detail: permissionMissing ? permissionMissingDetail(permissions) : null,
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

  public async screenSize(signal?: AbortSignal): Promise<ComputerScreenSize> {
    return this.request<ComputerScreenSize>('screen_size', {}, signal)
  }

  public async screenshot(signal?: AbortSignal): Promise<ComputerScreenshot> {
    // 不暴露自定义缩放：截图统一返回逻辑分辨率，保证与点击坐标空间 1:1 一致。
    return this.request<ComputerScreenshot>('screenshot', {}, signal)
  }

  public async mouseMove(
    x: number,
    y: number,
    options: ComputerMoveOptions = {},
    signal?: AbortSignal
  ): Promise<ComputerMoveResult> {
    return this.request<ComputerMoveResult>('mouse_move', { x, y, ...options }, signal)
  }

  public async click(
    x: number,
    y: number,
    options: ComputerClickOptions = {},
    signal?: AbortSignal
  ): Promise<ComputerClickResult> {
    return this.request<ComputerClickResult>('left_click', { x, y, ...options }, signal)
  }

  public async typeText(text: string, signal?: AbortSignal): Promise<ComputerTypeResult> {
    return this.request<ComputerTypeResult>('type', { text }, signal)
  }

  public async key(keys: string, signal?: AbortSignal): Promise<ComputerKeyResult> {
    return this.request<ComputerKeyResult>('key', { keys }, signal)
  }

  /** 终止 sidecar，并拒绝仍在进行中的请求。 */
  public dispose(): void {
    this.disposed = true
    const error = new AppError(
      ComputerErrorCodes.sidecarDisposed,
      '桌面控制 sidecar 已释放，这次请求不再继续。'
    )
    this.rejectStartup?.(error)
    this.rejectAllPending(error)
    this.timers.dispose()
    this.teardown(true)
  }

  /** 发送命令并等待关联响应；必要时会懒启动 sidecar。 */
  private async request<TResult>(
    command: ComputerCommand,
    payload: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<TResult> {
    const generation = this.generation
    return this.requests.run('computer', () => {
      if (this.disposed)
        throw new AppError(
          ComputerErrorCodes.sidecarDisposed,
          '桌面控制 sidecar 已释放，无法继续使用。'
        )
      signal?.throwIfAborted()
      if (generation !== this.generation)
        throw new AppError(
          ComputerErrorCodes.sidecarExited,
          '桌面控制 helper 已重置，排队中的动作未执行；请先重新观察再操作。'
        )
      return this.performRequest<TResult>(command, payload, signal)
    })
  }

  /** 同一时间只向原生 helper 发送一个请求；失败代次的排队动作不能在新进程中自动重放。 */
  private async performRequest<TResult>(
    command: ComputerCommand,
    payload: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<TResult> {
    if (this.disposed)
      throw new AppError(
        ComputerErrorCodes.sidecarDisposed,
        '桌面控制 sidecar 已释放，无法继续使用。'
      )
    await this.start()
    signal?.throwIfAborted()
    if (this.disposed)
      throw new AppError(
        ComputerErrorCodes.sidecarDisposed,
        '桌面控制 sidecar 已释放，无法继续使用。'
      )

    const id = this.nextRequestId++
    return new Promise<TResult>((resolvePromise, rejectPromise) => {
      const timer = this.timers.after(
        this.requestTimeoutMs,
        () => {
          const error = new AppError(
            'TIMEOUT',
            `桌面控制 helper 的 ${command} 请求在 ${this.requestTimeoutMs} 毫秒内没有回应。`,
            undefined,
            {
              command,
              requestId: id,
              timeoutMs: this.requestTimeoutMs,
            }
          )
          // 原生可访问性提供者可能卡死；回收这一代 helper，防止后续动作排进失控队列。
          this.rejectAllPending(error)
          this.teardown(true)
        },
        { label: `computer-request:${id}` }
      )

      this.pending.set(id, {
        resolve: (value) => resolvePromise(value as TResult),
        reject: rejectPromise,
        timer,
      })

      const failWrite = (message: string, cause?: unknown) => {
        timer.cancel()
        this.pending.delete(id)
        rejectPromise(new AppError(ComputerErrorCodes.sidecarWriteFailed, message, cause))
      }

      const child = this.child
      // start() 成功后才到这里；child 为空说明这中间进程已退出并 teardown，不要写空指针。
      if (!child) {
        failWrite('桌面控制 helper 在请求发出前已退出，请重试。')
        return
      }

      try {
        child.stdin.write(encodeComputerRequest(id, command, payload))
      } catch (error) {
        // arch-guard:silent-catch-ok 写入失败会通过 rejectPromise 作为请求错误返回调用方。
        // 同步抛出的只是一部分：管道已断时 EPIPE 走 stdin 的 'error' 事件（见 start()）。
        failWrite(`向桌面控制 helper 写入请求失败：${AppError.getMessage(error)}`, error)
      }
    })
  }

  /** 幂等启动 sidecar，并等待 ready 握手。 */
  private start(): Promise<void> {
    if (this.disposed)
      return Promise.reject(
        new AppError(ComputerErrorCodes.sidecarDisposed, '桌面控制 sidecar 已释放，无法继续使用。')
      )
    if (this.ready) return Promise.resolve()
    if (this.startPromise) return this.startPromise

    const startPromise = new Promise<void>((resolvePromise, rejectPromise) => {
      const spec = this.resolveHelper()
      if (!spec) {
        // 这条失败由错误码分类（见 classifyStartError），不靠文字，所以文案可以是中文。
        rejectPromise(
          new AppError(
            ComputerErrorCodes.helperMissing,
            '没有找到桌面控制 helper 脚本（插件未安装或已被停用）。'
          )
        )
        return
      }

      let child: ComputerSidecarProcess
      try {
        child = this.spawnProcess(spec)
      } catch (error) {
        // arch-guard:silent-catch-ok 启动失败会通过 rejectPromise 作为启动错误返回调用方。
        rejectPromise(AppError.from(error, ComputerErrorCodes.sidecarSpawnFailed))
        return
      }
      this.child = child

      let settled = false
      let startupTimer: Nullable<TimerLease> = null
      const onReady = () => {
        if (settled) return
        settled = true
        startupTimer?.cancel()
        this.rejectStartup = null
        this.ready = true
        resolvePromise()
      }
      const onFail = (error: Error) => {
        if (settled) return
        settled = true
        startupTimer?.cancel()
        this.teardown()
        rejectPromise(error)
      }
      this.rejectStartup = onFail
      const onDecodeFailure = (error: unknown) => {
        const failure = new AppError(
          'PROTOCOL',
          '桌面控制 helper 输出包含无效 UTF-8，已终止这一代进程。',
          error
        )
        onFail(failure)
        this.rejectAllPending(failure)
        this.teardown()
      }
      // helper 卡在导入阶段不打握手、或握手行被上一轮残片吞掉时，这道闸是唯一出口：
      // 没有它 start() 永不 settle，而请求的超时计时器要等 start() 返回才装，调用方永远挂起。
      startupTimer = this.timers.after(
        this.startupTimeoutMs,
        () => {
          onFail(
            new AppError(
              ComputerErrorCodes.sidecarStartupTimeout,
              `桌面控制 helper 在 ${this.startupTimeoutMs} 毫秒内没有完成启动握手，已终止本次启动。`,
              undefined,
              { timeoutMs: this.startupTimeoutMs }
            )
          )
        },
        { label: 'computer-startup' }
      )

      child.stdout.on('data', (chunk) => {
        // 上一轮进程被 teardown 后管道里还可能吐出残余数据，它属于已死的那一轮：
        // 混进共享的行缓冲会把新进程的握手行从中间劈开（C3 的另一半）。
        if (this.child !== child) return
        let decoded: string
        try {
          decoded =
            typeof chunk === 'string' ? chunk : this.stdoutDecoder.decode(chunk, { stream: true })
        } catch (error) {
          onDecodeFailure(error)
          return
        }
        this.handleStdout(decoded, onReady)
      })
      child.stderr.on('data', (chunk) => {
        if (this.child !== child) return
        let decoded: string
        try {
          decoded =
            typeof chunk === 'string' ? chunk : this.stderrDecoder.decode(chunk, { stream: true })
        } catch (error) {
          onDecodeFailure(error)
          return
        }
        this.stderrBuffer += decoded
        if (this.stderrBuffer.length > ComputerTuning.stderrTailChars) {
          this.stderrBuffer = this.stderrBuffer.slice(-ComputerTuning.stderrTailChars)
        }
      })
      // 管道写错误（EPIPE）是异步事件，不接住就是宿主进程的未捕获异常。接住后按「写失败」
      // 清账：在飞的请求一次性拒绝、状态机回 idle，下一次调用重新拉起 helper。
      child.stdin.on?.('error', (error) => {
        if (this.child !== child) return
        this.log(`sidecar stdin error: ${error.message}`)
        const writeError = new AppError(
          ComputerErrorCodes.sidecarWriteFailed,
          `桌面控制 helper 的输入管道已断开：${error.message}`,
          error
        )
        onFail(writeError)
        this.rejectAllPending(writeError)
        this.teardown()
      })
      child.on('error', (error) => {
        if (this.child !== child) return
        this.log(`sidecar process error: ${error.message}`)
        onFail(error)
        this.rejectAllPending(error)
        this.teardown()
      })
      child.on('exit', (code) => {
        if (this.child !== child) return
        let stdoutTail: string
        let stderrTail: string
        try {
          stdoutTail = this.stdoutDecoder.decode()
          stderrTail = this.stderrDecoder.decode()
        } catch (error) {
          onDecodeFailure(error)
          return
        }
        this.handleStdout(stdoutTail, onReady)
        this.stderrBuffer += stderrTail
        this.log(`sidecar exited with code ${code ?? 'null'}`)
        // helper 自己打在 stderr 上的话（多半是 Python 报错）比任何转述都有用，优先原样带出。
        const reason =
          this.stderrBuffer.trim() ||
          `桌面控制 helper 在准备就绪前退出（退出码 ${code ?? 'null'}）。`
        onFail(
          new AppError(ComputerErrorCodes.sidecarExited, reason, undefined, { exitCode: code })
        )
        this.rejectAllPending(
          new AppError(
            ComputerErrorCodes.sidecarExited,
            '桌面控制 helper 进程已退出，这次请求没有完成。',
            undefined,
            {
              exitCode: code,
            }
          )
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

      if (response.id === ComputerSidecarManager.ReadyHandshakeId) {
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
        const errorCode = [
          'VALIDATION',
          'NOT_FOUND',
          'CONFLICT',
          'PERMISSION',
          'UNAVAILABLE',
          'LIMIT',
        ].includes(response.error.code)
          ? response.error.code
          : ComputerSidecarManager.SnapshotValidationErrorCodes.has(response.error.code)
            ? 'VALIDATION'
            : ComputerErrorCodes.helperError
        // helper 资产是 Python，报错是英文；模型要照着它决定「重新截图还是换个做法」，所以在这里按码翻成中文。
        pending.reject(
          new AppError(
            errorCode,
            describeHelperError(response.error.code, response.error.message),
            undefined,
            {
              helperErrorCode: response.error.code,
            }
          )
        )
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      pending.timer.cancel()
      pending.reject(error)
    }
    this.pending.clear()
  }

  /** 把状态机拉回 idle 的**唯一**出口；幂等，重复调用安全（进程可能已自行退出）。 */
  private teardown(graceful = false): void {
    this.generation += 1
    this.ready = false
    this.startPromise = null
    this.rejectStartup = null
    // 两个缓冲是**上一轮进程**的流状态，必须随状态机一起归零：helper 死在半行 JSON 上时，
    // 残片会粘到下一个 helper 的握手行前面，整行解析失败被当坏帧丢掉，新进程于是「永远没准备好」。
    this.stdoutBuffer = ''
    this.stderrBuffer = ''
    this.stdoutDecoder = new TextDecoder('utf-8', { fatal: true })
    this.stderrDecoder = new TextDecoder('utf-8', { fatal: true })
    const child = this.child
    this.child = null
    if (child) {
      try {
        child.stdin.end()
      } catch {
        // arch-guard:silent-catch-ok 释放阶段 best-effort：进程可能已退出，管道关闭失败无补救动作也无诊断价值。
      }
      const shutdown = () => {
        try {
          child.kill('SIGTERM')
        } catch (error) {
          // arch-guard:silent-catch-ok 退出失败通过注入的 onLog 接收器报告，进程可能已先行退出。
          this.log(`sidecar shutdown: ${AppError.getMessage(error)}`)
        }
      }
      if (graceful) {
        // 先让 helper 在 EOF 的 finally 中释放持有的输入，再回收不响应的进程。
        const cleanup = new TimerScope({ name: 'ComputerSidecarCleanup' })
        cleanup.after(
          1_000,
          () => {
            shutdown()
            cleanup.dispose()
          },
          { label: 'computer-shutdown' }
        )
        child.on('exit', () => cleanup.dispose())
      } else shutdown()
    }
  }

  private log(message: string): void {
    this.onLog?.(`[computer-sidecar] ${message}`)
  }
}

/** 创建一份桌面控制运行时；宿主整个进程持有一份，用完 `dispose()`。 */
export function createComputerRuntime(
  options: ComputerSidecarManagerOptions = {}
): ComputerRuntimeApi {
  return new ComputerSidecarManager(options)
}
