import type { AppliedAdjustment } from '@velaros-ai/core/utils/ForgivingSchema'

export interface GameRuntimeErrorRecord {
  readonly signature: string
  readonly message: string
  readonly source: 'compile' | 'console' | 'runtime'
  readonly file?: string
  readonly line?: number
  readonly stack?: string
  readonly count: number
  readonly firstAt: number
  readonly lastAt: number
}

export interface GameRuntimeEntitySnapshot {
  readonly id: string
  readonly from?: string | null
  readonly tags: readonly string[]
  readonly components: Readonly<Record<string, unknown>>
}

export interface GameRuntimeSceneSnapshot {
  readonly scene: string
  readonly running: boolean
  readonly url: string | null
  readonly entityCount: number
  readonly fps: number | null
  readonly elapsedMs: number
}

export type GameRuntimeQuery =
  | { readonly select?: 'scene' }
  | { readonly select: 'selection' }
  | {
      readonly select: 'entities'
      readonly limit?: number
      readonly offset?: number
    }
  | {
      readonly select: 'entity'
      readonly entityId: string
      readonly components?: readonly string[]
    }
  | {
      readonly select: 'errors'
      readonly limit?: number
      readonly offset?: number
    }
  | { readonly select: 'perf' }

export type GameRuntimeQueryResult =
  | (GameRuntimeSceneSnapshot & { readonly select: 'scene' })
  | {
      readonly select: 'selection'
      readonly entity: GameRuntimeEntitySnapshot | null
    }
  | {
      readonly select: 'entities'
      readonly entities: readonly GameRuntimeEntitySnapshot[]
      readonly total: number
      readonly nextOffset?: number
    }
  | {
      readonly select: 'entity'
      readonly entity: GameRuntimeEntitySnapshot
    }
  | {
      readonly select: 'errors'
      readonly errors: readonly GameRuntimeErrorRecord[]
      readonly total: number
      readonly nextOffset?: number
    }
  | {
      readonly select: 'perf'
      readonly fps: {
        readonly average: number | null
        readonly minimum: number | null
      }
      readonly frameMs: {
        readonly p50: number | null
        readonly p95: number | null
      }
      readonly entityCount: number
    }

export type GameInputStep =
  | {
      readonly action: 'press'
      readonly logicalAction: string
      readonly ms?: number
    }
  | { readonly action: 'key_down'; readonly key: string }
  | { readonly action: 'key_up'; readonly key: string }
  | { readonly action: 'tap'; readonly x: number; readonly y: number }
  | { readonly action: 'move'; readonly x: number; readonly y: number }
  | { readonly action: 'wait'; readonly ms: number }

export interface GameRunRequest {
  readonly scene?: string
  readonly restart?: boolean
  readonly timeoutMs?: number
}

export interface GameRunResult {
  readonly status: 'running'
  readonly url: string
  readonly port: number
  readonly scene: string
  readonly readyMs: number
  readonly compileErrors: readonly GameRuntimeErrorRecord[]
  readonly runtimeErrors: readonly GameRuntimeErrorRecord[]
  readonly startupLogTail: string
  readonly restarted: boolean
  readonly appliedAdjustments?: readonly AppliedAdjustment[]
}

export interface GameStopResult {
  readonly status: 'stopped'
  readonly wasRunning: boolean
  readonly exitCode?: number
}

export interface GameScreenshotRequest {
  readonly label?: string
  readonly region?: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
  readonly waitFrames?: number
  readonly overlay?: boolean
}

export interface GameScreenshotResult {
  readonly path: string
  readonly width: number
  readonly height: number
  readonly capturedAt: number
  readonly overlay: boolean
}

export interface GameInputResult {
  readonly appliedSteps: number
  readonly droppedSteps: ReadonlyArray<{
    readonly index: number
    readonly reason: string
  }>
  readonly stateAfter?: GameRuntimeSceneSnapshot
}

export interface GameRuntimePort {
  readonly isAvailable: () => boolean
  readonly isRunning: () => boolean
  readonly run: (request: GameRunRequest) => Promise<GameRunResult>
  readonly stop: (force?: boolean) => Promise<GameStopResult>
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
