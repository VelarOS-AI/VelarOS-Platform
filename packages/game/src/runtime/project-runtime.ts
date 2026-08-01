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
    builtinHost?: GameBuiltinDevServerHost
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
        await this.pageHost.close().catch(() => {
          // arch-guard:silent-catch-ok 关页面只是清理：要抛给调用方的是上面那个启动错误，
          // 清理本身失败不该把它顶掉。
        })
      }
      throw error
    }
    if (pageWasReady && !result.restarted) return this.withFirstFrame(result)
    try {
      await this.pageHost.open({
        url: result.url,
        scene: result.scene,
      })
      this.pageOpen = true
      const observed = await this.withFirstFrame(result)
      notifyObserver(() => this.observer?.onRun?.(observed))
      return observed
    } catch (error) {
      this.pageOpen = false
      await this.pageHost.close().catch(() => {
        // arch-guard:silent-catch-ok 同上：这条路径要抛的是 pageHost.open 的失败原因。
      })
      await this.devServer.stop(false)
      throw error
    }
  }

  public async stop(force = false): Promise<GameStopResult> {
    let pageCloseError: unknown
    if (this.pageOpen) {
      try {
        await this.pageHost.close()
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
    this.requireRunning('game_screenshot')
    return this.pageHost.screenshot(request)
  }

  public async query(request: GameRuntimeQuery): Promise<GameRuntimeQueryResult> {
    this.requireRunning('game_query_state')
    const result = await this.pageHost.query(request)
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
    this.requireRunning('game_input')
    const result = await this.pageHost.input(steps, options)
    notifyObserver(() => this.observer?.onInput?.(result))
    return result
  }

  /**
   * 就绪的下一刻读一次页面：可见性计数 + 页面已攒下的诊断，拼进 `game_run` 的结果。
   *
   * ## 为什么在这里，而不是让模型自己去 `game_query_state`
   * 「跑」结束那一刻就是模型报告成功的地方（真机第一手：跑完直接截图、报告三个物体都在，
   * 全程没查过状态）。首帧诊断本来就是 `GameRunResult` 已有的字段——内置服务那条路上它一直
   * 恒为空，因为诊断攒在**页面**里而 `waitUntilReady` 只看得到进程日志。这里把两半接上。
   *
   * ## best-effort 的边界
   * 观测失败（页面还没挂上窄桥、求值被拒、结果形状不对）一律**原样返回启动结果**：
   * 观测绝不许改变 `game_run` 本身的成败——那是「监控把被监控者搞挂」的经典自伤。
   */
  private async withFirstFrame(result: GameRunResult): Promise<GameRunResult> {
    try {
      const scene = await this.pageHost.query({ select: 'scene' })
      if (scene.select !== 'scene') return result
      const errors = await this.pageHost.query({ select: 'errors', limit: 20, offset: 0 })
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
    throw new Error(`${operation} 需要运行中的游戏页面；请先调用 game_run。`)
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
