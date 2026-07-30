import {
  type GameInputResult,
  type GameInputStep,
  type GameManifestDocument,
  type GameManifestDocumentChange,
  type GameManifestDocumentStore,
  type GameManifestEditRequest,
  type GameManifestEditResult,
  GameManifestWorkspaceEditor,
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
  type GameManagedDevProcess,
  GameProjectRuntime,
  type GameRuntimeDescriptor,
  type GameRuntimeObserver,
  type GameRuntimePageHost,
} from '../runtime/index.js'
import { type GameToolContext, GameToolNames, gameTools, type ToolGameApi } from '../tools/index.js'

export * from './mod.js'
export * from './turn-context.js'

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

export interface CreateGameProjectCapabilityOptions {
  readonly projectRoot: string
  readonly project: GameProjectManifest
  readonly documents: GameManifestDocumentStore
  readonly processHost: GameApprovedProcessHost
  readonly pageHost: GameRuntimePageHost
  readonly observer?: GameRuntimeObserver
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
    throw new GameCapabilityUnavailableError('game_scene_edit')
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
    throw new GameCapabilityUnavailableError('game_run')
  }

  public async stop(_force?: boolean): Promise<GameStopResult> {
    return { status: 'stopped', wasRunning: false }
  }

  public async screenshot(_request: GameScreenshotRequest): Promise<GameScreenshotResult> {
    throw new GameCapabilityUnavailableError('game_screenshot')
  }

  public async query(_request: GameRuntimeQuery): Promise<GameRuntimeQueryResult> {
    throw new GameCapabilityUnavailableError('game_query_state')
  }

  public async input(
    _steps: readonly GameInputStep[],
    _options?: {
      readonly repeat?: number
      readonly settleFrames?: number
      readonly captureAfter?: boolean
    }
  ): Promise<GameInputResult> {
    throw new GameCapabilityUnavailableError('game_input')
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
  return new GameManifestWorkspaceEditor(documents)
}

export function createGameProjectCapability(
  options: CreateGameProjectCapabilityOptions
): GameCapability {
  const runtime = new GameProjectRuntime(
    options.projectRoot,
    options.project,
    options.processHost,
    options.pageHost,
    options.observer
  )
  const editor = new GameManifestWorkspaceEditor(options.documents)
  const synchronizedEditor: GameSceneEditorPort = {
    isAvailable: () => editor.isAvailable(),
    edit: async (request) => {
      const result = await editor.edit(request)
      if (result.changedFiles.includes('game.project.json')) {
        const projectDocument = await options.documents.read('game.project.json')
        if (!projectDocument) {
          throw new Error('game.project.json 在语义编辑后不可读取。')
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
        parseGameProjectManifestText(projectText, sourceName ?? 'game.project.json').value
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
      options.sourceName ?? 'game.project.json'
    ).value,
  })
}

export type {
  GameApprovedProcessHost,
  GameManagedDevProcess,
  GameManifestDocument,
  GameManifestDocumentChange,
  GameManifestDocumentStore,
  GameProjectManifest,
  GameRuntimeObserver,
  GameRuntimePageHost,
}
