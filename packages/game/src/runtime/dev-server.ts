import type {
  GameRunRequest,
  GameRunResult,
  GameRuntimeErrorRecord,
  GameStopResult,
} from '../core/ports.js'
import { gameReferenceId } from '../core/references.js'
import type { GameProjectManifest } from '../core/schemas.js'

export interface GameDevServerStartRequest {
  readonly command: string
  readonly cwd: string
  readonly requestedPort: number
  readonly permission: 'process:exec'
  readonly approvalReason: string
}

export interface GameDevServerReadyResult {
  readonly url: string
  readonly port: number
  readonly readyMs: number
  readonly compileErrors: readonly GameRuntimeErrorRecord[]
  readonly runtimeErrors: readonly GameRuntimeErrorRecord[]
  readonly startupLogTail: string
}

export interface GameManagedDevProcess {
  readonly waitUntilReady: (options: {
    readonly timeoutMs: number
    readonly readyText?: string
  }) => Promise<GameDevServerReadyResult>
  readonly stop: (force: boolean) => Promise<{ readonly exitCode?: number }>
}

export interface GameApprovedProcessHost {
  readonly startApproved: (request: GameDevServerStartRequest) => Promise<GameManagedDevProcess>
}

export class GameRuntimePermissionDeniedError extends Error {
  public constructor() {
    super('game_run 需要 process:exec 权限；宿主未提供获批执行端口，默认拒绝。')
    this.name = 'GameRuntimePermissionDeniedError'
  }
}

export class DenyAllGameProcessHost implements GameApprovedProcessHost {
  public async startApproved(): Promise<GameManagedDevProcess> {
    throw new GameRuntimePermissionDeniedError()
  }
}

export class GameDevServerStartupError extends Error {
  public readonly diagnostics: GameDevServerReadyResult

  public constructor(diagnostics: GameDevServerReadyResult) {
    const first = diagnostics.compileErrors[0]
    super(first
      ? `游戏编译失败：${first.file ? `${first.file}${first.line ? `:${first.line}` : ''} ` : ''}${first.message}`
      : '游戏 dev server 未能进入可交互状态。')
    this.name = 'GameDevServerStartupError'
    this.diagnostics = diagnostics
  }
}

export class GameDevServerPortMismatchError extends Error {
  public constructor(
    public readonly requestedPort: number,
    public readonly actualPort: number,
  ) {
    super(
      `游戏 dev server 使用了端口 ${actualPort}，但工程清单固定为 ${requestedPort}；V0 不自动换端口。`,
    )
    this.name = 'GameDevServerPortMismatchError'
  }
}

export class GameDevServerController {
  private process: GameManagedDevProcess | null = null
  private activeScene: string | null = null
  private ready: GameDevServerReadyResult | null = null
  private projectChangedWhileRunning = false

  public constructor(
    private readonly projectRoot: string,
    private project: GameProjectManifest,
    private readonly processHost: GameApprovedProcessHost = new DenyAllGameProcessHost(),
  ) {}

  public updateProject(project: GameProjectManifest): void {
    this.project = project
    if (this.isRunning()) this.projectChangedWhileRunning = true
  }

  public isRunning(): boolean {
    return this.process !== null && this.ready !== null
  }

  public async run(request: GameRunRequest = {}): Promise<GameRunResult> {
    const scene = this.resolveScene(request.scene)
    const shouldRestart = request.restart === true
      || this.projectChangedWhileRunning
      || (
      this.process !== null
      && this.activeScene !== null
      && this.activeScene !== scene
    )

    if (this.isRunning() && !shouldRestart && this.ready) return this.toRunResult(this.ready, scene, false)
    if (this.process) await this.stop(false)

    const server = this.project.dev.server
    const requestedPort = server?.port ?? 5173
    const process = await this.processHost.startApproved({
      command: server?.command ?? 'bun run dev',
      cwd: this.projectRoot,
      requestedPort,
      permission: 'process:exec',
      approvalReason: `启动游戏工程 ${this.project.name} 的本地 dev server`,
    })
    this.process = process
    this.activeScene = scene

    try {
      const ready = await process.waitUntilReady({
        timeoutMs: Math.min(180_000, Math.max(1_000, Math.round(request.timeoutMs ?? 60_000))),
        ...(server?.readyText ? { readyText: server.readyText } : {}),
      })
      this.ready = ready
      if (ready.compileErrors.length > 0) throw new GameDevServerStartupError(ready)
      if (ready.port !== requestedPort) {
        throw new GameDevServerPortMismatchError(requestedPort, ready.port)
      }
      this.projectChangedWhileRunning = false
      return this.toRunResult(ready, scene, shouldRestart)
    } catch (error) {
      await this.stop(false)
      throw error
    }
  }

  public async stop(force = false): Promise<GameStopResult> {
    const process = this.process
    this.process = null
    this.activeScene = null
    this.ready = null
    this.projectChangedWhileRunning = false
    if (!process) return { status: 'stopped', wasRunning: false }

    const result = await process.stop(force)
    return {
      status: 'stopped',
      wasRunning: true,
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    }
  }

  private resolveScene(requested: string | undefined): string {
    const reference = requested ?? this.project.entryScene
    if (!reference) {
      throw new Error('游戏工程没有 entryScene；请先在 game.project.json 声明入口场景。')
    }
    return reference.includes(':')
      ? gameReferenceId(reference as `scene:${string}`)
      : reference
  }

  private toRunResult(
    ready: GameDevServerReadyResult,
    scene: string,
    restarted: boolean,
  ): GameRunResult {
    return {
      status: 'running',
      url: ready.url,
      port: ready.port,
      scene,
      readyMs: ready.readyMs,
      compileErrors: ready.compileErrors,
      runtimeErrors: ready.runtimeErrors,
      startupLogTail: ready.startupLogTail,
      restarted,
    }
  }
}
