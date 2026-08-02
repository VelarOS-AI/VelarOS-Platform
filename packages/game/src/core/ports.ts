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
  readonly url: Nullable<string>
  readonly entityCount: number
  /**
   * 真的产生了显示对象的实体数。
   *
   * 「跑起来了但什么都看不见」是最难自己发现的一档失败（真机第一手：`entities 3`、`errors 0`、
   * FPS 正常、截图是真 PNG，而画面上只有调试碰撞框）。`entityCount` 单独一个数对这一档完全
   * 无感，所以可见性必须是**独立的一格事实**，而不是靠调用方去看截图猜。
   *
   * `renderedEntities + invisibleEntities === entityCount` 恒成立。
   */
  readonly renderedEntities: number
  /** 只拿到不可见占位块的实体数（没有 `visual`，或 `visual` 投影不出来）。 */
  readonly invisibleEntities: number
  readonly fps: Nullable<number>
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
      readonly entity: Nullable<GameRuntimeEntitySnapshot>
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
        readonly average: Nullable<number>
        readonly minimum: Nullable<number>
      }
      readonly frameMs: {
        readonly p50: Nullable<number>
        readonly p95: Nullable<number>
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

/**
 * 页面就绪后立刻读到的那一帧事实。
 *
 * 放在 `game:run` 的结果里，是因为**「跑」结束那一刻就是模型最可能停下来报告成功的地方**：
 * 真机上它跑完直接截图、报告「绿色地面、蓝色玩家、金色金币都在」，从没调过 `game:query_state`。
 * 可见性只挂在查询工具上等于给了一条它不会走的路。
 */
export interface GameRunFirstFrame {
  readonly entityCount: number
  readonly renderedEntities: number
  readonly invisibleEntities: number
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
  /** 页面读得到时才有；观测失败绝不改变 `game:run` 本身的成败（best-effort）。 */
  readonly firstFrame?: GameRunFirstFrame
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
