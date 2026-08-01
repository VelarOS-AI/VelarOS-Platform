import { isEmpty, isNotNull, isNull, isTrue, isUndefined } from '@velaros-ai/core'

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

/**
 * 等待就绪的**终态**。
 *
 * 判决（第六轮，真机第一手）：上一版没有这一格，宿主只能把「等了 60 秒没等到」伪装成一条
 * `source: 'compile'` 的错误记录塞进 `compileErrors`，于是模型读到的是
 * 「游戏编译失败：等待游戏 dev server 就绪超时（60000ms）」——一句自相矛盾、且没有任何可执行
 * 信息的话（真实情况是工程根里连 package.json 都没有，进程 50ms 就退了）。
 *
 * 三态各对应一种真实结局，`ready` 之外都必须由 `GameDevServerStartupError` 如实播报：
 *  - `exited`：进程已经不在了（宿主的存活探针发现的）。这一档**不该等满超时**。
 *  - `timeout`：进程还活着，但启动日志里始终没出现可访问的 loopback 地址。
 */
export type GameDevServerStartupOutcome =
  | { readonly kind: 'ready' }
  | { readonly kind: 'exited'; readonly exitCode: Nullable<number> }
  | { readonly kind: 'timeout'; readonly waitedMs: number }

export interface GameDevServerReadyResult {
  readonly url: string
  readonly port: number
  readonly readyMs: number
  readonly outcome: GameDevServerStartupOutcome
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

const MaxStartupExcerptLines = 12
const MaxStartupExcerptChars = 1_200

/**
 * 启动日志尾巴 → 错误正文里那几行。
 *
 * 判据：一个失败的 dev server，唯一能让模型下一步做对的信息就在它自己的输出里
 * （`bun run dev` 在没有 package.json 的目录里那句 `error: Script not found "dev"`）。
 * 上一版把它只放进 `diagnostics.startupLogTail`，而抛出的 `Error` 只带一句话——
 * 工具错误通道送到模型面前的就是那一句话，日志从来没到过模型手里。
 */
function startupLogExcerpt(startupLogTail: string): string {
  const lines = startupLogTail
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
  if (isEmpty(lines)) return ''
  return lines
    .slice(-MaxStartupExcerptLines)
    .join('\n')
    .slice(-MaxStartupExcerptChars)
}

function describeStartupFailure(diagnostics: GameDevServerReadyResult): string {
  const first = diagnostics.compileErrors[0]
  if (first) {
    const location = first.file
      ? `${first.file}${first.line ? `:${first.line}` : ''} `
      : ''
    return `游戏编译失败：${location}${first.message}`
  }
  const outcome = diagnostics.outcome
  switch (outcome.kind) {
    case 'exited':
      return `游戏 dev server 启动后立即退出${
        isNull(outcome.exitCode) ? '' : `（exit ${outcome.exitCode}）`
      }，没有进入可交互状态。`
    case 'timeout':
      return `等待游戏 dev server 就绪超时（${outcome.waitedMs}ms）：进程仍在运行，但启动日志里始终没有出现可访问的 loopback 地址。`
    case 'ready':
      return '游戏 dev server 未能进入可交互状态。'
    default: {
      // 编译期穷尽：终态闭集加一种而这里没接线即编译红，不退化成一句泛化的失败。
      const unknownOutcome: never = outcome
      return `游戏 dev server 未能进入可交互状态（未知终态 ${JSON.stringify(unknownOutcome)}）。`
    }
  }
}

export class GameDevServerStartupError extends Error {
  public readonly diagnostics: GameDevServerReadyResult

  public constructor(diagnostics: GameDevServerReadyResult) {
    const excerpt = startupLogExcerpt(diagnostics.startupLogTail)
    super(
      excerpt
        ? `${describeStartupFailure(diagnostics)}\n启动日志末尾：\n${excerpt}`
        : describeStartupFailure(diagnostics),
    )
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
  private process: Nullable<GameManagedDevProcess> = null
  private activeScene: Nullable<string> = null
  private ready: Nullable<GameDevServerReadyResult> = null
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
    return isNotNull(this.process) && isNotNull(this.ready)
  }

  public async run(request: GameRunRequest = {}): Promise<GameRunResult> {
    const scene = this.resolveScene(request.scene)
    const shouldRestart =
      isTrue(request.restart) ||
      this.projectChangedWhileRunning ||
      (isNotNull(this.process) &&
        isNotNull(this.activeScene) &&
        this.activeScene !== scene)

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
      // 先判终态再登记「已就绪」：失败的那一份不该有任何一瞬间被 isRunning() 当成在跑。
      if (ready.outcome.kind !== 'ready' || !isEmpty(ready.compileErrors)) {
        throw new GameDevServerStartupError(ready)
      }
      this.ready = ready
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
      ...(isUndefined(result.exitCode) ? {} : { exitCode: result.exitCode }),
    }
  }

  private resolveScene(requested: LooseOptional<string>): string {
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
