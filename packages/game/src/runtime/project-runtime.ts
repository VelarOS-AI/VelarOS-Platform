import type {
  GameInputResult,
  GameInputStep,
  GameProjectManifest,
  GameRunRequest,
  GameRunResult,
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
    if (pageWasReady && !result.restarted) return result
    try {
      await this.pageHost.open({
        url: result.url,
        scene: result.scene,
      })
      this.pageOpen = true
      notifyObserver(() => this.observer?.onRun?.(result))
      return result
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

  private requireRunning(operation: string): void {
    if (this.isRunning()) return
    throw new Error(`${operation} 需要运行中的游戏页面；请先调用 game_run。`)
  }
}
