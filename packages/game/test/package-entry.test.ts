import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

import {
  createGameCapability,
  createGameCapabilityDescriptor,
} from '../dist/composition/index.js'
import { createGameBundledModDefinition } from '../dist/composition/mod.js'
import { GameTurnContextCoordinator } from '../dist/composition/turn-context.js'
import {
  GameModId,
  GameToolName,
  GameToolNames,
  GameTurnContextSourceIds,
} from '../dist/contracts.js'
import {
  GameProjectDirectories,
  GameProjectFileName,
  GameSchemaChannel,
} from '../dist/core/index.js'
import { createGameRuntimeDescriptor } from '../dist/runtime/index.js'

describe('@velaros-ai/game partition entries', () => {
  test('publish one renderer-neutral project identity', () => {
    expect(GameSchemaChannel).toBe('v0')
    expect(GameProjectFileName).toBe('game.project.json')
    expect(GameProjectDirectories.scenes).toBe('scenes')
  })

  test('keep the Phaser choice in runtime and expose one tool-name source', () => {
    expect(createGameRuntimeDescriptor()).toEqual({
      backend: 'phaser4',
      renderer: 'web',
    })
    expect(GameToolNames).toEqual([
      'game:scene_edit',
      'game:run',
      'game:stop',
      'game:screenshot',
      'game:query_state',
      'game:input',
    ])
  })

  test('compose the four partitions without adding domain behavior', () => {
    expect(createGameCapabilityDescriptor()).toEqual({
      id: 'game',
      schemaChannel: 'v0',
      runtime: {
        backend: 'phaser4',
        renderer: 'web',
      },
      toolNames: GameToolNames,
    })
  })

  test('fails closed until the host injects project-scoped ports', async () => {
    const capability = createGameCapability()
    const context = capability.createToolContext(new AbortController().signal)

    expect(capability.toolApi.isProjectAvailable()).toBe(false)
    expect(capability.tools[GameToolName.run].isAvailable?.(context)).toBe(false)
    await expect(capability.toolApi.runtime.run({})).rejects.toThrow('宿主没有为当前会话注入')
    expect(await capability.toolApi.runtime.stop()).toEqual({
      status: 'stopped',
      wasRunning: false,
    })
  })

  test('ships as a default-disabled official mod with one game-space identity', () => {
    const pack = createGameBundledModDefinition()
    expect(pack.id).toBe(GameModId)
    expect(pack.defaultEnabled).toBe(false)
    expect(pack.specifier).toBe('bundled:velaros.game')
    expect(pack.bindings.tools).toBeDefined()
    expect(pack.bindings.toolCategories.game.id).toBe('game')
  })

  test('locks the packaged mod manifest to the runtime definition', () => {
    const packaged = JSON.parse(
      readFileSync(new URL('../velaros.mod.json', import.meta.url), 'utf8')
    ) as {
      module: { id: string; version: string }
      agent: { id: string; version: string }
    }
    const pack = createGameBundledModDefinition()

    expect(packaged.agent).toEqual(pack.manifest)
    expect(packaged.module.id).toBe(pack.id)
    expect(packaged.module.version).toBe(packaged.agent.version)
  })

  test('derives scopes independently for every game turn-context source', () => {
    const coordinator = new GameTurnContextCoordinator()
    const resolved: string[] = []
    const sources = coordinator.createSources((sourceId) => {
      resolved.push(sourceId)
      return sourceId === 'game.selection' ? ['game'] : []
    })

    expect(resolved).toEqual([...GameTurnContextSourceIds])
    expect(sources.find((source) => source.id === 'game.selection')?.scopes).toEqual(['game'])
    expect(sources.find((source) => source.id === 'game.scene-state')?.scopes).toEqual([])
  })

  test('projects selection through the game-owned turn-context source', () => {
    const coordinator = new GameTurnContextCoordinator()
    const selection = coordinator
      .createSources(['game'])
      .find((source) => source.id === 'game.selection')
    expect(selection).toBeDefined()

    coordinator.observeSelection('session-1', 'player')
    const snapshot = selection!.peekCached({
      sessionId: 'session-1',
      afterSeq: 0,
      generation: null,
    })
    expect(snapshot.deltas).toHaveLength(1)
    expect(snapshot.deltas[0]?.inspect).toEqual({
      tool: 'game:query_state',
      argsHint: { select: 'entity', entityId: 'player' },
    })

    coordinator.clearSession('session-1')
    expect(
      selection!.peekCached({
        sessionId: 'session-1',
        afterSeq: 0,
        generation: null,
      }).deltas
    ).toEqual([])
  })
})
