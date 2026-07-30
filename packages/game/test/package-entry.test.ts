import { describe, expect, test } from 'bun:test'

import {
  createGameCapability,
  createGameCapabilityDescriptor,
} from '../dist/composition/index.js'
import {
  GameProjectDirectories,
  GameProjectFileName,
  GameSchemaChannel,
} from '../dist/core/index.js'
import { createGameRuntimeDescriptor } from '../dist/runtime/index.js'
import { GameToolNames } from '../dist/tools/index.js'

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
      'game_scene_edit',
      'game_run',
      'game_stop',
      'game_screenshot',
      'game_query_state',
      'game_input',
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
    const context = capability.createToolContext(
      new AbortController().signal,
    )

    expect(capability.toolApi.isProjectAvailable()).toBe(false)
    expect(capability.tools.game_run.isAvailable?.(context)).toBe(false)
    await expect(capability.toolApi.runtime.run({})).rejects.toThrow(
      '宿主没有为当前会话注入',
    )
    expect(await capability.toolApi.runtime.stop()).toEqual({
      status: 'stopped',
      wasRunning: false,
    })
  })
})
