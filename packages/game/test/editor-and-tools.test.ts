import { describe, expect, test } from 'bun:test'

import {
  createGameProjectCapability,
  type GameApprovedProcessHost,
  type GameRuntimePageHost,
} from '../dist/composition/index.js'
import {
  type GameManifestDocument,
  type GameManifestDocumentChange,
  type GameManifestDocumentStore,
  GameManifestWorkspaceEditor,
  parseGameProjectManifest,
} from '../dist/core/index.js'
import type { GameDevServerStartRequest } from '../dist/runtime/index.js'
import {
  type GameToolContext,
  GameToolNames,
  gameTools,
} from '../dist/tools/index.js'

class MemoryManifestStore implements GameManifestDocumentStore {
  private readonly documents = new Map<string, GameManifestDocument>()
  public readonly batches: GameManifestDocumentChange[][] = []

  public constructor(entries: Record<string, unknown>) {
    for (const [path, value] of Object.entries(entries)) {
      this.documents.set(path, {
        path,
        text: JSON.stringify(value),
        revision: 'r1',
      })
    }
  }

  public async read(path: string): Promise<GameManifestDocument | null> {
    return this.documents.get(path) ?? null
  }

  public async list(directory: 'prefabs'): Promise<readonly GameManifestDocument[]> {
    return [...this.documents.values()].filter((document) =>
      document.path.startsWith(`${directory}/`),
    )
  }

  public async writeBatch(
    changes: readonly GameManifestDocumentChange[],
  ): Promise<void> {
    for (const change of changes) {
      expect(this.documents.get(change.path)?.revision).toBe(
        change.expectedRevision,
      )
    }
    this.batches.push([...changes])
    for (const change of changes) {
      this.documents.set(change.path, {
        path: change.path,
        text: change.text,
        revision: 'r2',
      })
    }
  }

  public value(path: string): Record<string, unknown> {
    const document = this.documents.get(path)
    if (!document) throw new Error(`missing ${path}`)
    return JSON.parse(document.text) as Record<string, unknown>
  }

  public setText(path: string, text: string): void {
    const document = this.documents.get(path)
    if (!document) throw new Error(`missing ${path}`)
    this.documents.set(path, { ...document, text })
  }
}

function createStore(): MemoryManifestStore {
  return new MemoryManifestStore({
    'game.project.json': {
      name: 'editor-test',
      scenes: ['scenes/base.scene.json', 'scenes/level-1.scene.json'],
      prefabs: ['prefabs/player.prefab.json'],
      assets: 'assets/assets.json',
      layers: ['actors'],
      collisionLayers: [],
      input: { actions: { jump: ['Space'] } },
    },
    'scenes/base.scene.json': {
      id: 'base',
      entities: [
        {
          id: 'player',
          components: {
            transform: { position: { x: 10, y: 20 } },
            camera: { kind: 'follow', target: 'entity:player' },
          },
          notes: 'keep this note',
        },
      ],
    },
    'scenes/level-1.scene.json': {
      id: 'level-1',
      extends: 'scene:base',
      entities: [
        {
          id: 'player',
          components: { transform: { position: { x: 64 } } },
        },
      ],
    },
    'scenes/bonus.scene.json': {
      id: 'bonus',
      entities: [],
    },
    'prefabs/player.prefab.json': {
      id: 'player',
      components: {
        tags: ['player'],
      },
    },
    'prefabs/enemy.prefab.json': {
      id: 'enemy',
      components: {
        tags: ['enemy'],
      },
    },
    'assets/assets.json': { assets: [] },
    'assets/next.json': { assets: [] },
  })
}

describe('GameManifestWorkspaceEditor', () => {
  test('renames an entity and all inherited-scene references in one atomic batch', async () => {
    const store = createStore()
    const editor = new GameManifestWorkspaceEditor(store)
    const result = await editor.edit({
      target: 'scene:base',
      operations: [
        { action: 'rename_entity', entityId: 'player', newId: 'hero' },
      ],
    })

    expect(result.changedFiles).toEqual([
      'scenes/base.scene.json',
      'scenes/level-1.scene.json',
    ])
    expect(store.batches).toHaveLength(1)

    const base = store.value('scenes/base.scene.json')
    const baseEntity = (base.entities as Array<Record<string, unknown>>)[0]
    expect(baseEntity?.id).toBe('hero')
    expect(
      (
        (baseEntity?.components as Record<string, unknown>)
          .camera as Record<string, unknown>
      ).target,
    ).toBe('entity:hero')
    expect(baseEntity?.notes).toBe('keep this note')

    const child = store.value('scenes/level-1.scene.json')
    expect(
      (child.entities as Array<Record<string, unknown>>)[0]?.id,
    ).toBe('hero')
  })

  test('uses a tombstone when removing an inherited entity', async () => {
    const store = createStore()
    const editor = new GameManifestWorkspaceEditor(store)
    await editor.edit({
      target: 'scene:level-1',
      operations: [{ action: 'remove_entity', entityId: 'player' }],
    })

    const child = store.value('scenes/level-1.scene.json')
    expect(child.entities).toEqual([{ id: 'player', remove: true }])
  })

  test('treats empty operations as a no-op and dry-run never writes', async () => {
    const store = createStore()
    const editor = new GameManifestWorkspaceEditor(store)
    const noOp = await editor.edit({
      target: 'scene:base',
      operations: [],
    })
    const dryRun = await editor.edit({
      target: 'prefab:player',
      operations: [
        {
          action: 'set_component',
          component: 'custom-state',
          values: { futureField: true },
        },
      ],
      dryRun: true,
    })

    expect(noOp.changedFiles).toEqual([])
    expect(noOp.operationsApplied).toBe(0)
    expect(dryRun.changedFiles).toEqual(['prefabs/player.prefab.json'])
    expect(store.batches).toHaveLength(0)
  })

  test('activates a pre-created prefab only through project.prefabs', async () => {
    const store = createStore()
    const editor = new GameManifestWorkspaceEditor(store)
    await expect(editor.edit({
      target: 'prefab:enemy',
      operations: [],
    })).rejects.toThrow('找不到编辑目标 prefab:enemy')

    const declared = await editor.edit({
      target: 'project',
      operations: [{
        action: 'set_project',
        values: {
          prefabs: [
            'prefabs/player.prefab.json',
            'prefabs/enemy.prefab.json',
          ],
        },
      }],
    })
    expect(declared.changedFiles).toEqual(['game.project.json'])

    const enemy = await editor.edit({
      target: 'prefab:enemy',
      operations: [],
      dryRun: true,
    })
    expect(enemy.ok).toBeTrue()
  })

  test('ignores malformed undeclared prefab drafts until project.prefabs activates them', async () => {
    const store = createStore()
    store.setText('prefabs/enemy.prefab.json', '{"id":')
    const editor = new GameManifestWorkspaceEditor(store)

    const unrelated = await editor.edit({
      target: 'scene:base',
      operations: [],
    })
    expect(unrelated.changedFiles).toEqual([])

    await expect(editor.edit({
      target: 'project',
      operations: [{
        action: 'set_project',
        values: {
          prefabs: [
            'prefabs/player.prefab.json',
            'prefabs/enemy.prefab.json',
          ],
        },
      }],
    })).rejects.toThrow('不是合法 JSON')
    expect(store.batches).toHaveLength(0)
  })

  test('activates pre-created scene and asset manifests through set_project', async () => {
    const store = createStore()
    const editor = new GameManifestWorkspaceEditor(store)
    const declared = await editor.edit({
      target: 'project',
      operations: [{
        action: 'set_project',
        values: {
          scenes: [
            'scenes/base.scene.json',
            'scenes/level-1.scene.json',
            'scenes/bonus.scene.json',
          ],
          assets: 'assets/next.json',
        },
      }],
    })

    expect(declared.changedFiles).toEqual(['game.project.json'])
    expect(store.batches[0]?.map((change) => change.path)).toEqual([
      'game.project.json',
    ])

    const sceneEdit = await editor.edit({
      target: 'scene:bonus',
      operations: [{
        action: 'set_scene_meta',
        values: { gravity: { y: 900 } },
      }],
    })
    const assetEdit = await editor.edit({
      target: 'assets',
      operations: [{
        action: 'set_asset',
        assetId: 'bonus-tile',
        values: { kind: 'texture', path: 'assets/bonus-tile.png' },
      }],
    })

    expect(sceneEdit.changedFiles).toEqual(['scenes/bonus.scene.json'])
    expect(assetEdit.changedFiles).toEqual(['assets/next.json'])
  })

  test('refreshes the runtime project snapshot after editing game.project.json', async () => {
    const store = createStore()
    const requests: GameDevServerStartRequest[] = []
    const processHost: GameApprovedProcessHost = {
      startApproved: async (request) => {
        requests.push(request)
        return {
          waitUntilReady: async () => ({
            url: 'http://127.0.0.1:5173',
            port: 5173,
            readyMs: 1,
            compileErrors: [],
            runtimeErrors: [],
            startupLogTail: 'ready',
          }),
          stop: async () => ({ exitCode: 0 }),
        }
      },
    }
    const pageHost: GameRuntimePageHost = {
      open: async () => undefined,
      close: async () => undefined,
      screenshot: async () => ({
        path: 'game.png',
        width: 1,
        height: 1,
        capturedAt: 1,
        overlay: false,
      }),
      query: async () => ({
        select: 'scene',
        scene: 'base',
        running: true,
        url: 'http://127.0.0.1:5173',
        entityCount: 1,
        fps: 60,
        elapsedMs: 1,
      }),
      input: async () => ({ appliedSteps: 0, droppedSteps: [] }),
    }
    const capability = createGameProjectCapability({
      projectRoot: '/tmp/game-editor-test',
      project: parseGameProjectManifest(store.value('game.project.json')).value,
      documents: store,
      processHost,
      pageHost,
    })

    await capability.toolApi.editor.edit({
      target: 'project',
      operations: [{
        action: 'set_project',
        values: { name: 'editor-test-refreshed' },
      }],
    })
    await capability.toolApi.runtime.run({ scene: 'base' })

    expect(requests[0]?.approvalReason).toBe(
      '启动游戏工程 editor-test-refreshed 的本地 dev server',
    )
    await capability.toolApi.runtime.stop()
  })
})

describe('game tool contracts', () => {
  test('publish exactly the six stable names with explicit permissions', () => {
    expect(Object.keys(gameTools)).toEqual([...GameToolNames])
    expect(gameTools.game_scene_edit.permissions).toEqual([
      'fs:read',
      'fs:write',
    ])
    expect(gameTools.game_run.permissions).toContain('process:exec')
    expect(gameTools.game_input.permissions).toContain('input:control')
  })

  test('hide behind project availability and point runtime tools to game_run', async () => {
    const context = createToolContext(false)
    expect(gameTools.game_run.isAvailable?.(context)).toBe(false)

    const available = createToolContext(true)
    await expect(
      gameTools.game_query_state.execute(
        gameTools.game_query_state.schema.parse({}),
        available,
      ),
    ).rejects.toThrow('先调用 game_run')
  })

  test('drops one malformed input step without failing the valid step', async () => {
    const context = createToolContext(true, true)
    const input = gameTools.game_input.schema.parse({
      steps: [
        null,
        { key: 'Space' },
        { action: 'tap', x: 10 },
        { action: 'press', logicalAction: 'jump' },
      ],
    })
    const result = await gameTools.game_input.execute(input, context) as {
      appliedSteps: number
      droppedSteps: Array<{ index: number }>
    }

    expect(result.appliedSteps).toBe(1)
    expect(result.droppedSteps).toEqual([
      { index: 0, reason: expect.any(String) },
      { index: 1, reason: expect.any(String) },
      { index: 2, reason: expect.any(String) },
    ])
  })

  test('rejects an input batch whose waits exceed the page-call budget', async () => {
    const context = createToolContext(true, true)
    const input = gameTools.game_input.schema.parse({
      steps: [{ action: 'wait', ms: 6_000 }],
      repeat: 2,
    })

    await expect(
      gameTools.game_input.execute(input, context),
    ).rejects.toThrow('超过单次 10000ms 上限')
  })

  test('infers entity queries and normalizes forgiving run/screenshot fields', async () => {
    const entityQuery = gameTools.game_query_state.schema.parse({
      entityId: 'player',
    })
    const runInput = gameTools.game_run.schema.parse({ scene: 'level-1' })
    const screenshot = gameTools.game_screenshot.schema.parse({
      label: ' First Playable Screenshot! ',
    })

    expect(entityQuery).toEqual({
      select: 'entity',
      entityId: 'player',
    })
    expect(runInput.scene).toBe('scene:level-1')
    expect(screenshot.label).toBe('first-playable-screenshot')

    const result = await gameTools.game_run.execute(
      runInput,
      createToolContext(true),
    ) as {
      appliedAdjustments?: Array<{
        field: string
        action: string
        detail: string
      }>
    }
    expect(result.appliedAdjustments).toEqual([
      {
        field: 'scene',
        action: 'aliased',
        detail: '裸 scene slug 已归一为 scene:level-1。',
      },
    ])
  })
})

function createToolContext(
  projectAvailable: boolean,
  running = false,
): GameToolContext {
  return {
    abortSignal: new AbortController().signal,
    game: {
      isProjectAvailable: () => projectAvailable,
      editor: {
        isAvailable: () => projectAvailable,
        edit: async (request) => ({
          ok: true,
          target: request.target,
          changedFiles: [],
          operationsApplied: request.operations.length,
          diffSummary: [],
          warnings: [],
          appliedAdjustments: [],
          dryRun: request.dryRun ?? false,
        }),
      },
      runtime: {
        isAvailable: () => true,
        isRunning: () => running,
        run: async () => ({
          status: 'running',
          url: 'http://127.0.0.1:5173',
          port: 5173,
          scene: 'level-1',
          readyMs: 1,
          compileErrors: [],
          runtimeErrors: [],
          startupLogTail: '',
          restarted: false,
        }),
        stop: async () => ({ status: 'stopped', wasRunning: running }),
        screenshot: async () => ({
          path: 'artifacts/game.png',
          width: 960,
          height: 540,
          capturedAt: Date.now(),
          overlay: false,
        }),
        query: async () => ({
          select: 'scene',
          scene: 'level-1',
          running,
          url: 'http://127.0.0.1:5173',
          entityCount: 1,
          fps: 60,
          elapsedMs: 1,
        }),
        input: async (steps) => ({
          appliedSteps: steps.length,
          droppedSteps: [],
        }),
      },
    },
  }
}
