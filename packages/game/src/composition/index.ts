import { GameToolNames } from '../contracts.js'
import {
  type GameInputResult,
  type GameInputStep,
  type GameManifestDocument,
  type GameManifestDocumentChange,
  type GameManifestDocumentStore,
  type GameManifestEditRequest,
  type GameManifestEditResult,
  GameManifestProjectEditor,
  GameProjectFileName,
  type GameProjectManifest,
  type GameRunRequest,
  type GameRunResult,
  type GameRuntimePort,
  type GameRuntimeQuery,
  type GameRuntimeQueryResult,
  type GameSceneEditorPort,
  GameSchemaChannel,
  type GameScreenshotRequest,
  type GameScreenshotResult,
  type GameStopResult,
  parseGameProjectManifestText,
} from '../core/index.js'
import {
  createGameRuntimeDescriptor,
  type GameApprovedProcessHost,
  GameBuiltinDevServer,
  type GameBuiltinDevServerHost,
  type GameBuiltinHostFilePort,
  type GameDevServerStartupOutcome,
  type GameManagedDevProcess,
  GameProjectRuntime,
  type GameRuntimeDescriptor,
  type GameRuntimeObserver,
  type GameRuntimePageHost,
} from '../runtime/index.js'
import { type GameToolContext, gameTools, type ToolGameApi } from '../tools/index.js'

export { GameProjectFileName }
// 宿主舞台在「工程还没跑起来」时要如实说清工程长什么样，而领域解析不许在壳里复制一份。
export type { GameProjectOverview, GameSceneOverview } from '../core/index.js'
export { summarizeGameProject } from '../core/index.js'
// 就绪窄桥的**失败那一格**：宿主的就绪轮询要读它，键名两侧只能有一份。
export { GameBuiltinHostBootErrorKey } from '../runtime/index.js'
// 承载超时的判别式：宿主要靠它接上自己的连续失败熔断（判据两侧只能有一份）。
export { isGamePageHostTimeout } from '../runtime/index.js'

export interface GameCapabilityDescriptor {
  readonly id: 'game'
  readonly schemaChannel: typeof GameSchemaChannel
  readonly runtime: GameRuntimeDescriptor
  readonly toolNames: typeof GameToolNames
}

export interface CreateGameCapabilityOptions {
  readonly isProjectAvailable?: () => boolean
  readonly editor?: GameSceneEditorPort
  readonly runtime?: GameRuntimePort
}

/**
 * 宿主为「工程只出清单」那条缺省路径提供的两样东西。
 *
 * 缺席 = 内置服务不可用（`GameBuiltinRuntimeUnavailableError` 明说原因），语义编辑与
 * 「工程自己声明了 dev.server.command」那条路都不受影响——**内置服务是缺省，不是前提**。
 */
export interface GameBuiltinRuntimeDelivery {
  /** `@velaros-ai/game` 的浏览器产物 `dist/browser/page.js` 全文（含 phaser 与投影层）。 */
  readonly pageScript: string
  /** 读工程根内一条已声明路径的原始字节；根内确认与符号链接拒绝归宿主。 */
  readonly files: GameBuiltinHostFilePort
}

export interface CreateGameProjectCapabilityOptions {
  readonly projectRoot: string
  readonly project: GameProjectManifest
  readonly documents: GameManifestDocumentStore
  readonly processHost: GameApprovedProcessHost
  readonly pageHost: GameRuntimePageHost
  readonly observer?: GameRuntimeObserver
  /** 缺席即内置服务不可用；见 {@link GameBuiltinRuntimeDelivery}。 */
  readonly builtinRuntime?: GameBuiltinRuntimeDelivery
}

export interface CreateGameProjectCapabilityFromTextOptions extends Omit<
  CreateGameProjectCapabilityOptions,
  'project'
> {
  readonly projectText: string
  readonly sourceName?: string
}

export interface GameCapability {
  readonly descriptor: GameCapabilityDescriptor
  readonly tools: typeof gameTools
  readonly toolApi: ToolGameApi
  readonly updateProjectFromText?: (projectText: string, sourceName?: string) => void
  readonly createToolContext: (abortSignal: AbortSignal) => GameToolContext
}

export class GameCapabilityUnavailableError extends Error {
  public constructor(operation: string) {
    super(`${operation} 不可用：宿主没有为当前会话注入游戏工程运行时与权限端口。`)
    this.name = 'GameCapabilityUnavailableError'
  }
}

class UnavailableGameSceneEditor implements GameSceneEditorPort {
  public isAvailable(): boolean {
    return false
  }

  public async edit(_request: GameManifestEditRequest): Promise<GameManifestEditResult> {
    throw new GameCapabilityUnavailableError('game:scene_edit')
  }
}

class UnavailableGameRuntime implements GameRuntimePort {
  public isAvailable(): boolean {
    return false
  }

  public isRunning(): boolean {
    return false
  }

  public async run(_request: GameRunRequest): Promise<GameRunResult> {
    throw new GameCapabilityUnavailableError('game:run')
  }

  public async stop(_force?: boolean): Promise<GameStopResult> {
    return { status: 'stopped', wasRunning: false }
  }

  public async screenshot(_request: GameScreenshotRequest): Promise<GameScreenshotResult> {
    throw new GameCapabilityUnavailableError('game:screenshot')
  }

  public async query(_request: GameRuntimeQuery): Promise<GameRuntimeQueryResult> {
    throw new GameCapabilityUnavailableError('game:query_state')
  }

  public async input(
    _steps: readonly GameInputStep[],
    _options?: {
      readonly repeat?: number
      readonly settleFrames?: number
      readonly captureAfter?: boolean
    }
  ): Promise<GameInputResult> {
    throw new GameCapabilityUnavailableError('game:input')
  }
}

const UnavailableEditor = new UnavailableGameSceneEditor()
const UnavailableRuntime = new UnavailableGameRuntime()

export function createGameCapabilityDescriptor(): GameCapabilityDescriptor {
  return Object.freeze({
    id: 'game',
    schemaChannel: GameSchemaChannel,
    runtime: createGameRuntimeDescriptor(),
    toolNames: GameToolNames,
  })
}

/**
 * Game's only host-facing composition entry.
 *
 * Missing ports remain invisible and fail closed. The host owns project/session lifecycle,
 * filesystem confinement, process approval, browser control, and disposal.
 */
export function createGameCapability(options: CreateGameCapabilityOptions = {}): GameCapability {
  const editor = options.editor ?? UnavailableEditor
  const runtime = options.runtime ?? UnavailableRuntime
  const isProjectAvailable = options.isProjectAvailable ?? (() => false)
  const toolApi: ToolGameApi = Object.freeze({
    isProjectAvailable,
    editor,
    runtime,
  })

  return Object.freeze({
    descriptor: createGameCapabilityDescriptor(),
    tools: gameTools,
    toolApi,
    createToolContext: (abortSignal: AbortSignal): GameToolContext =>
      Object.freeze({ abortSignal, game: toolApi }),
  })
}

export function createGameManifestEditor(
  documents: GameManifestDocumentStore
): GameSceneEditorPort {
  return new GameManifestProjectEditor(documents)
}

/**
 * 内置服务的装配。
 *
 * **一份工程一台服务**：它与 `GameProjectRuntime` 同生同死，起停全经
 * `GameDevServerController`，因此不需要在壳里再记一份句柄——上一批「dev server 活过应用退出」
 * 那个洞正是从「壳自己另拿一条终止路径」长出来的。
 */
function toBuiltinDevServerHost(
  options: CreateGameProjectCapabilityOptions
): GameBuiltinDevServerHost | undefined {
  const delivery = options.builtinRuntime
  if (!delivery) return undefined
  const server = new GameBuiltinDevServer({
    documents: options.documents,
    files: delivery.files,
    pageScript: delivery.pageScript,
  })
  return { start: () => server.start() }
}

export function createGameProjectCapability(
  options: CreateGameProjectCapabilityOptions
): GameCapability {
  const runtime = new GameProjectRuntime(
    options.projectRoot,
    options.project,
    options.processHost,
    options.pageHost,
    options.observer,
    toBuiltinDevServerHost(options)
  )
  const editor = new GameManifestProjectEditor(options.documents)
  const synchronizedEditor: GameSceneEditorPort = {
    isAvailable: () => editor.isAvailable(),
    edit: async (request) => {
      const result = await editor.edit(request)
      if (result.changedFiles.includes(GameProjectFileName)) {
        const projectDocument = await options.documents.read(GameProjectFileName)
        if (!projectDocument) {
          throw new Error(`${GameProjectFileName} 在语义编辑后不可读取。`)
        }
        runtime.updateProject(
          parseGameProjectManifestText(projectDocument.text, projectDocument.path).value
        )
      }
      return result
    },
  }
  const capability = createGameCapability({
    isProjectAvailable: () => true,
    editor: synchronizedEditor,
    runtime,
  })
  return Object.freeze({
    ...capability,
    updateProjectFromText: (projectText: string, sourceName?: string) =>
      runtime.updateProject(
        parseGameProjectManifestText(projectText, sourceName ?? GameProjectFileName).value
      ),
  })
}

export function createGameProjectCapabilityFromText(
  options: CreateGameProjectCapabilityFromTextOptions
): GameCapability {
  return createGameProjectCapability({
    ...options,
    project: parseGameProjectManifestText(
      options.projectText,
      options.sourceName ?? GameProjectFileName
    ).value,
  })
}

export type {
  GameApprovedProcessHost,
  GameBuiltinDevServerHost,
  GameBuiltinHostFilePort,
  GameDevServerStartupOutcome,
  GameManagedDevProcess,
  GameManifestDocument,
  GameManifestDocumentChange,
  GameManifestDocumentStore,
  GameProjectManifest,
  GameRuntimeObserver,
  GameRuntimePageHost,
}
