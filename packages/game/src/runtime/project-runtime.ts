import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type {
  GameInputResult,
  GameInputStep,
  GameProjectManifest,
  GameRunRequest,
  GameRunResult,
  GameRuntimeErrorRecord,
  GameRuntimePort,
  GameRuntimeQuery,
  GameRuntimeQueryResult,
  GameScreenshotRequest,
  GameScreenshotResult,
  GameStopResult,
} from '../core/index.js'

import {
  type GameApprovedProcessHost,
  type GameBuiltinDevServerHost,
  GameDevServerController,
} from './dev-server.js'

/**
 * 页面承载（打开 → 投递 → 首帧就绪）的上限。
 *
 * 判据：正常路径实测 51 秒跑完一次「改脚本 + 重启」（含 dev server 起停与页面重载），
 * 90s 给足两倍余量。越过它就不是「慢」，是承载起不来了。
 *
 * 这一格存在的理由是一条 brick 级缺陷（AGENT-12）：`pageHost.open()` 里的每一步都没有上限，
 * 宿主的会话串行队列一旦被死结占住，这里就**永远 await 下去**——14 分钟没有回执、
 * 舞台停在「正在接管」、abort 也解不开，只有重启应用。
 * **等外部承载的 await 没有上限 = 一个工具可以吊死整条会话**，这比工具本身坏掉严重得多。
 */
const GamePageOpenTimeoutMs = 90_000

/**
 * 首帧观测的上限。
 *
 * 它是 best-effort 的观测（读不到就照原样交回启动结果），所以上限可以短得多——
 * 但**必须有**：观测走的是同一条会话队列，没有上限时「监控把被监控者吊死」会原样重演。
 */
const GameFirstFrameTimeoutMs = 20_000

/** 页面级操作（截图 / 查询 / 输入 / 关闭）的上限：它们全都经同一条会话队列。 */
const GamePageOperationTimeoutMs = 60_000

/**
 * 三档上限做成可注入的一格 —— **为了让「不许无限等」这条规矩能被机械证明**。
 *
 * 常量写死时，唯一能验证超时真的生效的办法是让测试真等 90 秒；那种测试没人会跑，
 * 于是规矩退回成注释。注入之后契约本身可测，默认值仍是产品口径。
 */
export interface GameRuntimeTimeouts {
  readonly pageOpenMs: number
  readonly firstFrameMs: number
  readonly pageOperationMs: number
}

export const DefaultGameRuntimeTimeouts: GameRuntimeTimeouts = {
  pageOpenMs: GamePageOpenTimeoutMs,
  firstFrameMs: GameFirstFrameTimeoutMs,
  pageOperationMs: GamePageOperationTimeoutMs,
}

/**
 * 页面承载超时的**身份标记**：宿主靠它认出「这是承载起不来」，好接上自己的连续失败熔断。
 *
 * 刻意不做成 `AppError` 的子类：`AppError` 的 `Symbol.hasInstance` 认的是 `name === 'AppError'`，
 * 子类一改 `name` 就不再 `instanceof AppError`，整条错误通道会把它降级成 UNKNOWN。
 * 判别走 `context.scope`，与 house style 一致（错误是数据，不是类层次）。
 */
export const GamePageHostTimeoutScope = 'game.page-host-timeout'

/**
 * 页面承载起不来 —— **终态**，不是「再试一次就好」。
 *
 * 措辞里必须带出路，否则模型会把它当成瞬时失败反复重试
 * （已有先例：一个没有状态的可重试措辞换来三分半钟死循环 + 幻觉式交付）。
 */
export function createGamePageHostTimeoutError(
  operation: string,
  timeoutMs: number,
  startupLogTail?: string
): AppError {
  const logTail = startupLogTail ? `\n启动日志末尾：\n${startupLogTail.slice(-1_200)}` : ''
  return new AppError(
    'TIMEOUT',
    `游戏页面承载在 ${timeoutMs}ms 内没有就绪（${operation}）。` +
      `这次启动没有成功，运行态已经回滚到「未启动」，可以安全地再发一次 game:run。` +
      `如果再次出现同样的超时，不要继续重试：说明这条会话没有可见的游戏舞台承载，` +
      `需要先把会话切到游戏空间、确认舞台出现，或者检查玩法脚本里有没有会卡死渲染进程的死循环。` +
      `${logTail}`,
    undefined,
    { scope: GamePageHostTimeoutScope, operation, timeoutMs }
  )
}

/**
 * 给一个「等外部承载」的 await 套上限。
 *
 * 超时后被等待的 promise 仍挂在原地（没有办法撤回一次已经发给宿主的调用），
 * 但调用方拿到的是**终态失败**而不是一个永远不来的答案，运行态也随之回滚。
 */
async function withGameDeadline<T>(
  operation: string,
  timeoutMs: number,
  action: () => Promise<T>
): Promise<T> {
  const timers = new TimerScope({ name: 'GameProjectRuntime' })
  try {
    return await timers.withTimeout(timeoutMs, () => action(), {
      label: operation,
      timeoutMessage: `${operation} 超过 ${timeoutMs}ms 未返回。`,
    })
  } catch (error) {
    // 超时一律翻成带出路的终态错误：`TimeoutError` 那句话对模型没有任何可执行信息。
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw createGamePageHostTimeoutError(operation, timeoutMs)
    }
    throw error
  } finally {
    timers.dispose()
  }
}

/** 这个错误是不是本层的承载超时（宿主的连续失败熔断也认同一个标记）。 */
export function isGamePageHostTimeout(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === 'TIMEOUT' &&
    error.context.scope === GamePageHostTimeoutScope
  )
}

export interface GameRuntimePageHost {
  readonly open: (input: { readonly url: string; readonly scene: string }) => Promise<void>
  readonly close: () => Promise<void>
  readonly screenshot: (request: GameScreenshotRequest) => Promise<GameScreenshotResult>
  readonly query: (request: GameRuntimeQuery) => Promise<GameRuntimeQueryResult>
  readonly input: (
    steps: readonly GameInputStep[],
    options?: {
      readonly repeat?: number
      readonly settleFrames?: number
      readonly captureAfter?: boolean
    }
  ) => Promise<GameInputResult>
}

export interface GameRuntimeObserver {
  readonly onRun?: (result: GameRunResult) => void
  readonly onStop?: (result: GameStopResult) => void
  readonly onQuery?: (request: GameRuntimeQuery, result: GameRuntimeQueryResult) => void
  readonly onInput?: (result: GameInputResult) => void
}

function notifyObserver(callback?: () => void): void {
  try {
    callback?.()
  } catch {
    // arch-guard:silent-catch-ok 观测是尽力而为：一次上报失败绝不许改变游戏操作本身的结果。
  }
}

/**
 * Owns the V0 closed loop while leaving process and browser implementation to the host.
 */
export class GameProjectRuntime implements GameRuntimePort {
  private readonly devServer: GameDevServerController
  private pageOpen = false

  public constructor(
    projectRoot: string,
    project: GameProjectManifest,
    processHost: GameApprovedProcessHost,
    private readonly pageHost: GameRuntimePageHost,
    private readonly observer?: GameRuntimeObserver,
    builtinHost?: GameBuiltinDevServerHost,
    private readonly timeouts: GameRuntimeTimeouts = DefaultGameRuntimeTimeouts
  ) {
    this.devServer = new GameDevServerController(projectRoot, project, processHost, builtinHost)
  }

  public isAvailable(): boolean {
    return true
  }

  public isRunning(): boolean {
    return this.pageOpen && this.devServer.isRunning()
  }

  public updateProject(project: GameProjectManifest): void {
    this.devServer.updateProject(project)
  }

  public async run(request: GameRunRequest): Promise<GameRunResult> {
    const pageWasReady = this.isRunning()
    let result: GameRunResult
    try {
      result = await this.devServer.run(request)
    } catch (error) {
      if (this.pageOpen) {
        this.pageOpen = false
        await this.closePageQuietly()
      }
      throw error
    }
    if (pageWasReady && !result.restarted) return this.withFirstFrame(result)
    try {
      // **有上限地等承载**：这一步以前是裸 await，宿主那条会话串行队列一卡死就永远回不来。
      await withGameDeadline('game:run 打开游戏页面', this.timeouts.pageOpenMs, () =>
        this.pageHost.open({
          url: result.url,
          scene: result.scene,
        })
      )
      this.pageOpen = true
      const observed = await this.withFirstFrame(result)
      notifyObserver(() => this.observer?.onRun?.(observed))
      return observed
    } catch (error) {
      // 失败即回滚到「未启动」：下一次 game:run 必须从干净状态起步，绝不把坏状态留给下一轮
      // （AGENT-12 的第二半：abort 之后再发照样挂，因为坏状态一直留在进程里）。
      this.pageOpen = false
      await this.closePageQuietly()
      await this.stopDevServerQuietly()
      // 承载超时要带上启动日志尾巴才有诊断价值——那是 `withGameDeadline` 拿不到的东西。
      throw isGamePageHostTimeout(error)
        ? createGamePageHostTimeoutError(
          '打开游戏页面',
          this.timeouts.pageOpenMs,
          result.startupLogTail
        )
        : error
    }
  }

  /**
   * 关页面 —— 有上限，且失败不改变调用方要抛的那个错。
   *
   * 清理路径本身也走宿主的会话队列，所以它同样可能卡住。清理卡住时必须让位给
   * 「把失败如实抛给调用方」，否则一次启动失败会退化成又一次永久挂起。
   */
  private async closePageQuietly(): Promise<void> {
    try {
      await withGameDeadline('关闭游戏页面', this.timeouts.pageOperationMs, () =>
        this.pageHost.close()
      )
    } catch {
      // arch-guard:silent-catch-ok 关页面只是清理：要抛给调用方的是上游那个启动错误，
      // 清理本身失败（含超时）不该把它顶掉。
    }
  }

  private async stopDevServerQuietly(): Promise<void> {
    try {
      await withGameDeadline('停止游戏 dev server', this.timeouts.pageOperationMs, () =>
        this.devServer.stop(false)
      )
    } catch {
      // arch-guard:silent-catch-ok 同上：回滚是尽力而为，它失败不该顶掉真正的启动失败原因。
    }
  }

  public async stop(force = false): Promise<GameStopResult> {
    let pageCloseError: unknown
    if (this.pageOpen) {
      try {
        await withGameDeadline('game:stop 关闭游戏页面', this.timeouts.pageOperationMs, () =>
          this.pageHost.close()
        )
      } catch (error) {
        // arch-guard:silent-catch-ok 不是吞错：这里先记下，等 dev server 也停完再抛（见下方
        // `if (pageCloseError) throw pageCloseError`）——先抛会让进程留在跑着的状态。
        pageCloseError = error
      } finally {
        this.pageOpen = false
      }
    }
    const result = await this.devServer.stop(force)
    if (pageCloseError) throw pageCloseError
    notifyObserver(() => this.observer?.onStop?.(result))
    return result
  }

  public async screenshot(request: GameScreenshotRequest): Promise<GameScreenshotResult> {
    this.requireRunning('game:screenshot')
    return withGameDeadline('game:screenshot', this.timeouts.pageOperationMs, () =>
      this.pageHost.screenshot(request)
    )
  }

  public async query(request: GameRuntimeQuery): Promise<GameRuntimeQueryResult> {
    this.requireRunning('game:query_state')
    const result = await withGameDeadline('game:query_state', this.timeouts.pageOperationMs, () =>
      this.pageHost.query(request)
    )
    notifyObserver(() => this.observer?.onQuery?.(request, result))
    return result
  }

  public async input(
    steps: readonly GameInputStep[],
    options?: {
      readonly repeat?: number
      readonly settleFrames?: number
      readonly captureAfter?: boolean
    }
  ): Promise<GameInputResult> {
    this.requireRunning('game:input')
    const result = await withGameDeadline('game:input', this.timeouts.pageOperationMs, () =>
      this.pageHost.input(steps, options)
    )
    notifyObserver(() => this.observer?.onInput?.(result))
    return result
  }

  /**
   * 就绪的下一刻读一次页面：可见性计数 + 页面已攒下的诊断，拼进 `game:run` 的结果。
   *
   * ## 为什么在这里，而不是让模型自己去 `game:query_state`
   * 「跑」结束那一刻就是模型报告成功的地方（真机第一手：跑完直接截图、报告三个物体都在，
   * 全程没查过状态）。首帧诊断本来就是 `GameRunResult` 已有的字段——内置服务那条路上它一直
   * 恒为空，因为诊断攒在**页面**里而 `waitUntilReady` 只看得到进程日志。这里把两半接上。
   *
   * ## best-effort 的边界
   * 观测失败（页面还没挂上窄桥、求值被拒、结果形状不对）一律**原样返回启动结果**：
   * 观测绝不许改变 `game:run` 本身的成败——那是「监控把被监控者搞挂」的经典自伤。
   */
  private async withFirstFrame(result: GameRunResult): Promise<GameRunResult> {
    try {
      // 观测也要有上限：它走的是同一条会话队列，没有上限时「监控把被监控者吊死」原样重演。
      const scene = await withGameDeadline('game:run 读首帧', this.timeouts.firstFrameMs, () =>
        this.pageHost.query({ select: 'scene' })
      )
      if (scene.select !== 'scene') return result
      const errors = await withGameDeadline('game:run 读首帧诊断', this.timeouts.firstFrameMs, () =>
        this.pageHost.query({ select: 'errors', limit: 20, offset: 0 })
      )
      const pageErrors = errors.select === 'errors' ? errors.errors : []
      return {
        ...result,
        firstFrame: {
          entityCount: scene.entityCount,
          renderedEntities: scene.renderedEntities,
          invisibleEntities: scene.invisibleEntities,
        },
        runtimeErrors: mergeErrorRecords(result.runtimeErrors, pageErrors),
      }
    } catch {
      // arch-guard:silent-catch-ok 观测是尽力而为：读不到首帧就照原样交回启动结果，
      // 绝不让一次观测失败把「游戏其实跑起来了」翻成失败。
      return result
    }
  }

  private requireRunning(operation: string): void {
    if (this.isRunning()) return
    throw new Error(`${operation} 需要运行中的游戏页面；请先调用 game:run。`)
  }
}

/** 进程日志与页面各自攒的诊断按 `signature` 合并去重（同一条不许在结果里出现两遍）。 */
function mergeErrorRecords(
  base: readonly GameRuntimeErrorRecord[],
  extra: readonly GameRuntimeErrorRecord[],
): readonly GameRuntimeErrorRecord[] {
  if (extra.length === 0) return base
  const merged = new Map(base.map((record) => [record.signature, record]))
  for (const record of extra) merged.set(record.signature, record)
  return [...merged.values()]
}
