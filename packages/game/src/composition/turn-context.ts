import type { CapabilityScopeId, TurnContextDeltaSource } from '@velaros-ai/core/types'
import {
  type TurnContextAppendHub,
  TurnContextSessionLedgers,
} from '@velaros-ai/core/utils/TurnContextLedger'

import type {
  GameInputResult,
  GameRunResult,
  GameRuntimeErrorRecord,
  GameRuntimeQuery,
  GameRuntimeQueryResult,
  GameRuntimeSceneSnapshot,
  GameStopResult,
} from '../core/index.js'

import { GameTurnContextSourceIds } from './mod.js'

type GameTurnContextSourceId = (typeof GameTurnContextSourceIds)[number]

function errorSignature(error: GameRuntimeErrorRecord): string {
  return `${error.source}:${error.signature}:${error.count}:${error.lastAt}`
}

function sceneSignature(scene: GameRuntimeSceneSnapshot): string {
  return `${scene.scene}:${scene.running}:${scene.url ?? ''}:${scene.entityCount}`
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
  private readonly lastSelections = new Map<string, string | null>()

  public constructor(appendHub?: TurnContextAppendHub) {
    this.ledgers = Object.fromEntries(
      GameTurnContextSourceIds.map((sourceId) => [
        sourceId,
        new TurnContextSessionLedgers(sourceId, { appendHub }),
      ])
    ) as Record<GameTurnContextSourceId, TurnContextSessionLedgers>
  }

  public createSources(scopes: readonly CapabilityScopeId[]): readonly TurnContextDeltaSource[] {
    return GameTurnContextSourceIds.map((sourceId) => ({
      id: sourceId,
      scopes,
      rendererVisible: true,
      peekCached: (input) => ({
        ...this.ledgers[sourceId].peek(input.sessionId, input),
        anchors: [],
      }),
    }))
  }

  public observeRun(sessionId: string, result: GameRunResult): void {
    this.observeErrors(sessionId, [...result.compileErrors, ...result.runtimeErrors])
    this.observeScene(sessionId, {
      scene: result.scene,
      running: true,
      url: result.url,
      entityCount: 0,
      fps: null,
      elapsedMs: result.readyMs,
    })
  }

  public observeStop(sessionId: string, _result: GameStopResult): void {
    this.lastScenes.delete(sessionId)
    this.ledgers['game.scene-state'].append(sessionId, {
      label: 'Game stopped',
      summaryText: 'Game runtime stopped.',
      inspect: { tool: 'game_run' },
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
      this.observeSelection(sessionId, result.entity?.id ?? null)
    }
    if (request.select === 'entity' && result.select === 'entity') {
      this.observeSelection(sessionId, result.entity.id)
    }
  }

  public observeInput(sessionId: string, result: GameInputResult): void {
    if (result.stateAfter) this.observeScene(sessionId, result.stateAfter)
  }

  public observeSelection(sessionId: string, entityId: string | null): void {
    if (this.lastSelections.get(sessionId) === entityId) return
    this.lastSelections.set(sessionId, entityId)
    this.ledgers['game.selection'].append(sessionId, {
      label: entityId ? `Selected ${entityId}` : 'Selection cleared',
      summaryText: entityId
        ? `The user selected game entity "${entityId}".`
        : 'The user cleared the game entity selection.',
      inspect: entityId
        ? { tool: 'game_query_state', argsHint: { select: 'entity', entityId } }
        : { tool: 'game_query_state', argsHint: { select: 'selection' } },
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
          label: 'Game errors cleared',
          summaryText: 'The game runtime error list is now empty.',
          inspect: { tool: 'game_query_state', argsHint: { select: 'errors' } },
        })
      }
      return
    }
    const latest = errors[0]!
    this.ledgers['game.runtime-errors'].append(sessionId, {
      label: `${errors.length} game error${errors.length === 1 ? '' : 's'}`,
      summaryText: `Game runtime reported ${errors.length} error(s). Latest: ${latest.message}`,
      inspect: { tool: 'game_query_state', argsHint: { select: 'errors' } },
    })
  }

  private observeScene(sessionId: string, scene: GameRuntimeSceneSnapshot): void {
    const signature = sceneSignature(scene)
    if (this.lastScenes.get(sessionId) === signature) return
    this.lastScenes.set(sessionId, signature)
    this.ledgers['game.scene-state'].append(sessionId, {
      label: `${scene.scene} · ${scene.entityCount} entities`,
      summaryText: `Game scene "${scene.scene}" is ${
        scene.running ? 'running' : 'stopped'
      } with ${scene.entityCount} entities.`,
      inspect: { tool: 'game_query_state', argsHint: { select: 'scene' } },
    })
  }
}
