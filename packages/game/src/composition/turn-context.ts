import type { CapabilityScopeId, TurnContextDeltaSource } from '@velaros-ai/agent/protocol'
import {
  type TurnContextAppendHub,
  TurnContextSessionLedgers,
} from '@velaros-ai/agent/run-context'
import { isFunction, isUndefined, toNullable } from '@velaros-ai/core'

import { GameTurnContextSourceIds } from '../contracts.js'
import type {
  GameInputResult,
  GameRunResult,
  GameRuntimeErrorRecord,
  GameRuntimeQuery,
  GameRuntimeQueryResult,
  GameRuntimeSceneSnapshot,
  GameStopResult,
} from '../core/index.js'

export type GameTurnContextSourceId = (typeof GameTurnContextSourceIds)[number]
export type GameTurnContextScopeResolver = (
  sourceId: GameTurnContextSourceId
) => readonly CapabilityScopeId[]
type NullableString = ReturnType<typeof toNullable<string>>

function errorSignature(error: GameRuntimeErrorRecord): string {
  return `${error.source}:${error.signature}:${error.count}:${error.lastAt}`
}

function sceneSignature(scene: GameRuntimeSceneSnapshot): string {
  return [
    scene.scene,
    scene.running,
    scene.url ?? '',
    scene.entityCount,
    // 可见性进指纹：实体数不变而「可见 0 → 可见 3」是一次真实的状态跃迁（改完清单重跑），
    // 不进指纹就会被去重吃掉，回合上下文里永远停在第一次的那句话上。
    scene.renderedEntities,
  ].join(':')
}

/**
 * Game-domain event formatter and in-memory turn-context source owner.
 *
 * The host supplies only session ids and the shared append hub. No filesystem,
 * renderer, or Desktop dependency crosses this boundary.
 */
export class GameTurnContextCoordinator {
  private readonly ledgers: Record<GameTurnContextSourceId, TurnContextSessionLedgers>
  private readonly lastErrors = new Map<string, string>()
  private readonly lastScenes = new Map<string, string>()
  private readonly lastSelections = new Map<string, NullableString>()

  public constructor(appendHub?: TurnContextAppendHub) {
    this.ledgers = Object.fromEntries(
      GameTurnContextSourceIds.map((sourceId) => [
        sourceId,
        new TurnContextSessionLedgers(sourceId, { appendHub }),
      ])
    ) as Record<GameTurnContextSourceId, TurnContextSessionLedgers>
  }

  public createSources(
    scopes: readonly CapabilityScopeId[] | GameTurnContextScopeResolver
  ): readonly TurnContextDeltaSource[] {
    return GameTurnContextSourceIds.map((sourceId) => ({
      id: sourceId,
      scopes: isFunction(scopes) ? scopes(sourceId) : scopes,
      rendererVisible: true,
      peekCached: (input) => ({
        ...this.ledgers[sourceId].peek(input.sessionId, input),
        anchors: [],
      }),
    }))
  }

  public observeRun(sessionId: string, result: GameRunResult): void {
    this.observeErrors(sessionId, [...result.compileErrors, ...result.runtimeErrors])
    const firstFrame = result.firstFrame
    // 「首帧没读到」不是「场景是空的」。填 0 会让回合上下文说出一句
    // 「包含 0 个实体，其中 0 个产生了可见画面」的**假话**——而且 blind 判据
    // (`entityCount > 0`) 恰好在这时失效，唯一会喊「去看 errors」的那句话被一并吞掉。
    // 观测失败必须以观测失败的样子出现,不许伪装成一个看起来很确定的零。
    if (isUndefined(firstFrame)) {
      this.lastScenes.delete(sessionId)
      this.ledgers['game.scene-state'].replaceLatest(sessionId, {
        label: `${result.scene} · 首帧没读到`,
        summaryText:
          `游戏场景“${result.scene}”已启动（${result.url}），但这一轮**没能读到首帧**：` +
          '实体数与可见数当前不可知——别把它当成 0。' +
          '用 game:query_state({select:"scene"}) 现取一次，再用 {select:"errors"} 看有没有报错。',
        inspect: { tool: 'game:query_state', argsHint: { select: 'scene' } },
      })
      return
    }
    this.observeScene(sessionId, {
      scene: result.scene,
      running: true,
      url: result.url,
      entityCount: firstFrame.entityCount,
      renderedEntities: firstFrame.renderedEntities,
      invisibleEntities: firstFrame.invisibleEntities,
      fps: null,
      elapsedMs: result.readyMs,
    })
  }

  /**
   * `game.scene-state` 是**状态**不是事件流：它只回答「游戏现在什么样」，所以走
   * `replaceLatest` 而不是 `append`——新状态到达即让旧状态失效。
   *
   * 不这么做就会出实测过的事故：能力重建时如实记下「游戏已停止」（当时确实停着），
   * 随后 `game:run` 又记下运行态，两条一起投给下一回合，模型读了前一条就断定
   * 「游戏已经停止了，需要先启动它」，白跑一次 `game:run`。
   *
   * 另外两个 source 保持 `append`：`game.runtime-errors`（每批报错是独立事实，
   * 而且「报错已清零」要能与之前那批对照着读）与 `game.selection`（选中变更是流水）。
   */
  public observeStop(sessionId: string, _result: GameStopResult): void {
    this.lastScenes.delete(sessionId)
    this.ledgers['game.scene-state'].replaceLatest(sessionId, {
      label: '游戏已停止',
      summaryText: '游戏运行态已停止。',
      inspect: { tool: 'game:run' },
    })
  }

  public observeQuery(
    sessionId: string,
    request: GameRuntimeQuery,
    result: GameRuntimeQueryResult
  ): void {
    if (result.select === 'scene') this.observeScene(sessionId, result)
    if (result.select === 'errors') this.observeErrors(sessionId, result.errors)
    if (result.select === 'selection') {
      this.observeSelection(sessionId, toNullable(result.entity?.id))
    }
    if (request.select === 'entity' && result.select === 'entity') {
      this.observeSelection(sessionId, result.entity.id)
    }
  }

  public observeInput(sessionId: string, result: GameInputResult): void {
    if (result.stateAfter) this.observeScene(sessionId, result.stateAfter)
  }

  public observeSelection(sessionId: string, entityId: NullableString): void {
    if (this.lastSelections.get(sessionId) === entityId) return
    this.lastSelections.set(sessionId, entityId)
    this.ledgers['game.selection'].append(sessionId, {
      label: entityId ? `已选择 ${entityId}` : '已清除实体选择',
      summaryText: entityId
        ? `用户选择了游戏实体“${entityId}”。`
        : '用户清除了游戏实体选择。',
      inspect: entityId
        ? { tool: 'game:query_state', argsHint: { select: 'entity', entityId } }
        : { tool: 'game:query_state', argsHint: { select: 'selection' } },
    })
  }

  public clearSession(sessionId: string): void {
    for (const sourceId of GameTurnContextSourceIds) {
      this.ledgers[sourceId].clearSession(sessionId)
    }
    this.lastErrors.delete(sessionId)
    this.lastScenes.delete(sessionId)
    this.lastSelections.delete(sessionId)
  }

  private observeErrors(sessionId: string, errors: readonly GameRuntimeErrorRecord[]): void {
    const signature = errors.map(errorSignature).join('|')
    const previous = this.lastErrors.get(sessionId)
    if (previous === signature) return
    this.lastErrors.set(sessionId, signature)
    if (errors.length === 0) {
      if (previous) {
        this.ledgers['game.runtime-errors'].append(sessionId, {
          label: '游戏报错已清零',
          summaryText: '游戏运行态报错列表现已为空。',
          inspect: { tool: 'game:query_state', argsHint: { select: 'errors' } },
        })
      }
      return
    }
    const latest = errors[0]!
    this.ledgers['game.runtime-errors'].append(sessionId, {
      label: `${errors.length} 条游戏报错`,
      summaryText: `游戏运行态报告了 ${errors.length} 条报错，最新一条：${latest.message}`,
      inspect: { tool: 'game:query_state', argsHint: { select: 'errors' } },
    })
  }

  private observeScene(sessionId: string, scene: GameRuntimeSceneSnapshot): void {
    const signature = sceneSignature(scene)
    if (this.lastScenes.get(sessionId) === signature) return
    this.lastScenes.set(sessionId, signature)
    const blind = scene.entityCount > 0 && scene.renderedEntities === 0
    // 状态型 source：后来者取代前任（判决见 observeStop 上方注释）。
    this.ledgers['game.scene-state'].replaceLatest(sessionId, {
      label: `${scene.scene} · ${scene.entityCount} 个实体 · 可见 ${scene.renderedEntities}`,
      summaryText: `游戏场景“${scene.scene}”当前${
        scene.running ? '正在运行' : '已停止'
      }，包含 ${scene.entityCount} 个实体，其中 ${scene.renderedEntities} 个产生了可见画面。${
        blind
          ? '一个都没画出来——画面上只有调试叠加层；用 game:query_state({select:"errors"}) 看逐实体原因。'
          : ''
      }`,
      inspect: { tool: 'game:query_state', argsHint: { select: 'scene' } },
    })
  }
}
