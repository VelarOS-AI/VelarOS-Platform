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
  GameDevServerController,
} from './dev-server.js'

export interface GameRuntimePageHost {
  readonly open: (input: {
    readonly url: string
    readonly scene: string
  }) => Promise<void>
  readonly close: () => Promise<void>
  readonly screenshot: (
    request: GameScreenshotRequest,
  ) => Promise<GameScreenshotResult>
  readonly query: (
    request: GameRuntimeQuery,
  ) => Promise<GameRuntimeQueryResult>
  readonly input: (
    steps: readonly GameInputStep[],
    options?: {
      readonly repeat?: number
      readonly settleFrames?: number
      readonly captureAfter?: boolean
    },
  ) => Promise<GameInputResult>
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
  ) {
    this.devServer = new GameDevServerController(
      projectRoot,
      project,
      processHost,
    )
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
        await this.pageHost.close().catch(() => undefined)
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
      return result
    } catch (error) {
      this.pageOpen = false
      await this.pageHost.close().catch(() => undefined)
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
        pageCloseError = error
      } finally {
        this.pageOpen = false
      }
    }
    const result = await this.devServer.stop(force)
    if (pageCloseError) throw pageCloseError
    return result
  }

  public async screenshot(
    request: GameScreenshotRequest,
  ): Promise<GameScreenshotResult> {
    this.requireRunning('game_screenshot')
    return this.pageHost.screenshot(request)
  }

  public async query(
    request: GameRuntimeQuery,
  ): Promise<GameRuntimeQueryResult> {
    this.requireRunning('game_query_state')
    return this.pageHost.query(request)
  }

  public async input(
    steps: readonly GameInputStep[],
    options?: {
      readonly repeat?: number
      readonly settleFrames?: number
      readonly captureAfter?: boolean
    },
  ): Promise<GameInputResult> {
    this.requireRunning('game_input')
    return this.pageHost.input(steps, options)
  }

  private requireRunning(operation: string): void {
    if (this.isRunning()) return
    throw new Error(`${operation} 需要运行中的游戏页面；请先调用 game_run。`)
  }
}
