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
  /** 工程扫描次数 —— 「编辑已声明的清单一次盘都不走」这条判决要有锁。 */
  public manifestScans = 0

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

  public async listManifests(): Promise<readonly GameManifestDocument[]> {
    this.manifestScans += 1
    return [...this.documents.values()].filter(
      (document) =>
        document.path.endsWith('.scene.json') || document.path.endsWith('.prefab.json'),
    )
  }

  public async writeBatch(
    changes: readonly GameManifestDocumentChange[],
  ): Promise<void> {
    for (const change of changes) {
      // `create` 是「以不存在为前提」的更强断言，宿主端口不比对 revision（见
      // GameManifestDocumentChange 的判决）。测试替身必须照抄这条，否则自举写入会被一个
      // 真实宿主根本不做的比对判红。
      if (change.create) {
        expect(this.documents.has(change.path)).toBeFalse()
        continue
      }
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

  public has(path: string): boolean {
    return this.documents.has(path)
  }

  /** 整盘快照 —— 「报告与磁盘逐字对应」这条锁的地面真值。 */
  public snapshot(): Record<string, string> {
    return Object.fromEntries(
      [...this.documents].map(([path, document]) => [path, document.text]),
    )
  }

  public text(path: string): string | null {
    return this.documents.get(path)?.text ?? null
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
      // 显式声明命令 = 走「工程自带 dev server」那条路。缺省已改成宿主内置静态服务
      // （2026-08-01 判决），而本 fixture 断言的正是命令那条路，所以必须自己声明。
      dev: { server: { command: 'bun run dev', port: 5173 } },
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

  test('adopts a pre-created prefab draft when it is named as the edit target', async () => {
    // 第六轮判决：文档级 target 也是 upsert。磁盘上已有的草稿在被**指名为编辑目标**时进入拓扑
    // （「我现在要编它」本身就是显式激活），不再要求先走一趟 set_project；未被指名的草稿仍留在
    // 拓扑外（下一条用例锁的就是那一面）。
    const store = createStore()
    const editor = new GameManifestWorkspaceEditor(store)
    const adopted = await editor.edit({
      target: 'prefab:enemy',
      operations: [
        { action: 'set_component', component: 'body', values: { kind: 'dynamic' } },
      ],
    })
    // 被指名的那一份由本批拥有 canonical 形态：同一批里的语义操作必须落盘，
    // 「采纳时保留草稿原文」那条规则只对 set_project 顺手声明进来的草稿成立。
    expect(adopted.changedFiles).toEqual([
      'game.project.json',
      'prefabs/enemy.prefab.json',
    ])
    expect(store.value('game.project.json').prefabs).toEqual([
      'prefabs/player.prefab.json',
      'prefabs/enemy.prefab.json',
    ])
    expect(store.value('prefabs/enemy.prefab.json')).toEqual({
      id: 'enemy',
      kind: 'prefab',
      extends: null,
      components: { tags: ['enemy'], body: { kind: 'dynamic' } },
    })
  })

  test('creates the scene document when the target does not exist yet', async () => {
    const store = createStore()
    const editor = new GameManifestWorkspaceEditor(store)
    const created = await editor.edit({
      target: 'scene:arena',
      operations: [
        { action: 'set_entity', entityId: 'hero' },
        { action: 'set_scene_meta', values: { title: 'Arena' } },
      ],
    })

    expect(created.changedFiles).toEqual([
      'game.project.json',
      'scenes/arena.scene.json',
    ])
    expect(store.value('scenes/arena.scene.json')).toEqual({
      id: 'arena',
      kind: 'scene',
      extends: null,
      meta: { title: 'Arena' },
      entities: [{ id: 'hero', components: {} }],
    })
    expect(store.value('game.project.json').scenes).toEqual([
      'scenes/base.scene.json',
      'scenes/level-1.scene.json',
      'scenes/arena.scene.json',
    ])
    // 工程已有 entryScene 时不许被新场景顶掉（只补缺席，不否决显式意图）。
    expect(store.value('game.project.json').entryScene).toBe('scene:base')
  })

  test('refuses to hijack a manifest whose declared id differs from the target', async () => {
    const store = createStore()
    store.setText(
      'prefabs/enemy.prefab.json',
      JSON.stringify({ id: 'enemy-slime', kind: 'prefab', components: {} }),
    )
    const editor = new GameManifestWorkspaceEditor(store)
    await expect(
      editor.edit({ target: 'prefab:enemy', operations: [] }),
    ).rejects.toThrow('与编辑目标 prefab:enemy 对不上')
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

    // 场景与资产清单一进拓扑就由编辑器拥有 canonical 形态（`serializeWorkspace` 无条件格式化
    // 它们），所以声明它们的这一批会把两份文件一并写成 canonical。「采纳时保留原文」那条只对
    // prefab 草稿成立。
    expect(declared.changedFiles).toEqual([
      'game.project.json',
      'scenes/bonus.scene.json',
      'assets/next.json',
    ])
    expect(store.value('scenes/bonus.scene.json')).toEqual({
      id: 'bonus',
      kind: 'scene',
      extends: null,
      entities: [],
    })

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
            outcome: { kind: 'ready' } as const,
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

  test('bootstraps an empty project root into a runnable manifest set in one call', async () => {
    // 验收线：空目录 + 一次语义编辑 = 工程清单 + 资产清单 + 入口场景，全部由闭集完成，
    // 不需要模型手写任何一份 JSON。第六轮之前这条路走不通（闭集里没有能新建场景的动作）。
    const store = new MemoryManifestStore({})
    const editor = new GameManifestWorkspaceEditor(store)
    const result = await editor.edit({
      target: 'scene:main',
      operations: [
        {
          action: 'set_entity',
          entityId: 'hero',
          components: { transform: { position: { x: 32, y: 64 } } },
        },
      ],
    })

    expect(result.changedFiles.toSorted()).toEqual([
      'assets/assets.json',
      'game.project.json',
      'scenes/main.scene.json',
    ])
    expect(store.batches[0]?.every((change) => change.create)).toBeTrue()
    const project = store.value('game.project.json')
    expect(project.scenes).toEqual(['scenes/main.scene.json'])
    expect(project.assets).toBe('assets/assets.json')
    // 入口场景在这一刻补上：没有它 game_run 只会说「游戏工程没有 entryScene」。
    expect(project.entryScene).toBe('scene:main')
    expect(
      (store.value('scenes/main.scene.json').entities as Array<Record<string, unknown>>)[0]?.id,
    ).toBe('hero')
  })

  test('rejects a set_project that undeclares a scene holding content', async () => {
    // 不变量 I1（第八轮）：守「移除」那一半。模型重发整份 scenes 数组时只把 basename 打错一格，
    // merge patch 对数组是整体替换，所以重发整份数组是**正常操作方式**。第七轮从「创建」那一侧
    // 拦（同 id 已住在别处），于是换一种打错方式就漏一格；现在判据在**转移**上：
    // 装载时声明过、现在不声明了 = 一次移除，有内容就硬失败。
    const store = new MemoryManifestStore({
      'game.project.json': {
        name: 'orphan-guard',
        entryScene: 'scene:level1',
        scenes: ['scenes/level1.scene.json'],
        assets: 'assets/assets.json',
      },
      'scenes/level1.scene.json': {
        id: 'level1',
        entities: [{ id: 'hero' }, { id: 'ground' }, { id: 'goal' }],
      },
      'assets/assets.json': { assets: [] },
    })
    const editor = new GameManifestWorkspaceEditor(store)

    await expect(
      editor.edit({
        target: 'project',
        operations: [{
          action: 'set_project',
          values: { scenes: ['scenes/levl1.scene.json'] },
        }],
      }),
    ).rejects.toThrow('把 scenes/level1.scene.json 从 game.project.json 的声明里摘掉了')
    // 一个字节都不许落盘：那份有内容的场景必须原样留着，诱饵也不许出现。
    expect(store.batches).toHaveLength(0)
    expect(
      (store.value('scenes/level1.scene.json').entities as unknown[]).length,
    ).toBe(3)
    expect(store.has('scenes/levl1.scene.json')).toBeFalse()
  })

  test('rejects a set_project that repoints assets away from a non-empty manifest', async () => {
    // 同一条不变量的第二格。资产清单**没有稳定 id**，所以第七轮那道从创建侧看的门结构上够不着它
    // ——这正是「判据必须落在转移上」的证据。
    const store = new MemoryManifestStore({
      'game.project.json': { name: 'assets-guard', assets: 'assets/assets.json' },
      'assets/assets.json': {
        assets: [
          { id: 'hero-idle', kind: 'texture', path: 'assets/hero.png' },
          { id: 'jump', kind: 'audio', path: 'assets/jump.wav' },
        ],
      },
    })
    const editor = new GameManifestWorkspaceEditor(store)

    await expect(
      editor.edit({
        target: 'project',
        operations: [{ action: 'set_project', values: { assets: 'data/assets.json' } }],
      }),
    ).rejects.toThrow('把 assets/assets.json 从 game.project.json 的声明里摘掉了')
    expect(store.batches).toHaveLength(0)
    expect(store.has('data/assets.json')).toBeFalse()
  })

  test('rejects a set_project that undeclares a prefab holding components', async () => {
    // 第三格（孪生站点 activateDeclaredPrefabs）。三格一条判据，因为三者都只是
    // 「game.project.json 里的一条路径」。
    const store = createStore()
    const editor = new GameManifestWorkspaceEditor(store)

    await expect(
      editor.edit({
        target: 'project',
        operations: [{ action: 'set_project', values: { prefabs: [] } }],
      }),
    ).rejects.toThrow('把 prefabs/player.prefab.json 从 game.project.json 的声明里摘掉了')
    expect(store.batches).toHaveLength(0)
  })

  test('allows undeclaring an empty manifest and says so in the summary', async () => {
    // I1 只在**确定丢内容**那一档硬失败：空壳退出声明什么都没丢，拦下来只是仪式。
    // 但零 error 零 warning 地发生是不许的。
    const store = createStore()
    // bonus 本来就没被声明，先声明它、再摘掉，才构成一次「移除」。
    await new GameManifestWorkspaceEditor(store).edit({
      target: 'project',
      operations: [{
        action: 'set_project',
        values: {
          scenes: [
            'scenes/base.scene.json',
            'scenes/level-1.scene.json',
            'scenes/bonus.scene.json',
          ],
        },
      }],
    })
    const undeclared = await new GameManifestWorkspaceEditor(store).edit({
      target: 'project',
      operations: [{
        action: 'set_project',
        values: { scenes: ['scenes/base.scene.json', 'scenes/level-1.scene.json'] },
      }],
    })

    expect(undeclared.diffSummary).toContain(
      'undeclared scene: scenes/bonus.scene.json（空清单，文件保留在磁盘上）',
    )
    expect(undeclared.warnings.join('\n')).toContain('scenes/bonus.scene.json 已退出 project 声明')
    // 文件本身留在磁盘上，一个字节都没动。
    expect(store.value('scenes/bonus.scene.json').id).toBe('bonus')
  })

  test('materializes the target lazily so a set-then-rename batch works from nothing', async () => {
    // 第八轮的形二：第七轮「批次里出现 rename_* 就不创建 target」的前置判据被实测证伪——
    // 同一批打在一份已存在的空场景上两条全成立。现在物化由**操作顺序**决定：
    // set_entity 先到就把场景建出来，rename_entity 随后自然找得到那条实体。
    const store = new MemoryManifestStore({})
    const editor = new GameManifestWorkspaceEditor(store)
    const result = await editor.edit({
      target: 'scene:main',
      operations: [
        { action: 'set_entity', entityId: 'hero' },
        { action: 'rename_entity', entityId: 'hero', newId: 'player' },
      ],
    })

    expect(result.changedFiles).toContain('scenes/main.scene.json')
    expect(
      (store.value('scenes/main.scene.json').entities as Array<Record<string, unknown>>)[0]?.id,
    ).toBe('player')
  })

  test('tells the model the target was freshly created when an entity lookup fails inside it', async () => {
    // 混合批次打错 target：set_* 先到，所以场景确实被建了出来，随后 remove_entity 落空。
    // 第七轮担心的正是这句报错会把模型指向「去建实体」；修法不是拦创建（那要靠预测整批），
    // 而是把我们手里本来就有的事实说出来——这份清单是本次调用刚创建的。
    const store = createStore()
    const editor = new GameManifestWorkspaceEditor(store)

    await expect(
      editor.edit({
        target: 'scene:levl-1',
        operations: [
          { action: 'set_entity', entityId: 'hero' },
          { action: 'remove_entity', entityId: 'player' },
        ],
      }),
    ).rejects.toThrow('是本次调用刚创建的')
    expect(store.batches).toHaveLength(0)
  })

  test('adopts a hand-written manifest that already carries the target id', async () => {
    // 第八轮的形三（真机第一手）：文档明确保留「模型用 ws_edit 直接写 .scene.json」这条路。
    // 上一版只扫 prefabs/ 一个目录，于是手写在 levels/ 的那份被跳过、另起一份空 scenes/main，
    // 磁盘上从此两份 id=main，全程零提示。现在扫描面 = 整个工程，已有载体一律采纳。
    const store = new MemoryManifestStore({
      'game.project.json': { name: 'handwritten', assets: 'assets/assets.json' },
      'assets/assets.json': { assets: [] },
      'levels/main.scene.json': {
        id: 'main',
        entities: [{ id: 'hero' }, { id: 'ground' }],
      },
    })
    const editor = new GameManifestWorkspaceEditor(store)
    const result = await editor.edit({
      target: 'scene:main',
      operations: [{ action: 'set_entity', entityId: 'goal' }],
    })

    expect(result.diffSummary).toContain('declared scene: scene:main → levels/main.scene.json')
    expect(store.has('scenes/main.scene.json')).toBeFalse()
    expect(store.value('game.project.json').scenes).toEqual(['levels/main.scene.json'])
    expect(store.value('game.project.json').entryScene).toBe('scene:main')
    expect(
      (store.value('levels/main.scene.json').entities as Array<Record<string, unknown>>).map(
        (entity) => entity.id,
      ),
    ).toEqual(['hero', 'ground', 'goal'])
  })

  test('refuses to guess when two files on disk carry the same stable id', async () => {
    // 双射真的在磁盘上被打破时（ws_edit 不过编辑器，拦不住）当面报出来，不挑一份继续跑。
    const store = new MemoryManifestStore({
      'game.project.json': { name: 'ambiguous', assets: 'assets/assets.json' },
      'assets/assets.json': { assets: [] },
      'levels/main.scene.json': { id: 'main', entities: [] },
      'scenes/main.scene.json': { id: 'main', entities: [] },
    })
    const editor = new GameManifestWorkspaceEditor(store)

    await expect(
      editor.edit({ target: 'scene:main', operations: [] }),
    ).rejects.toThrow('scene:main 在工程里有 2 份载体')
    expect(store.batches).toHaveLength(0)
  })

  test('refuses to bootstrap a declared path when the id already has a carrier', async () => {
    // 声明指向 A、载体却在 B：这一档不能靠采纳解决（模型显式指定了落点），所以报错点名 B。
    const store = new MemoryManifestStore({
      'game.project.json': { name: 'carrier', assets: 'assets/assets.json' },
      'assets/assets.json': { assets: [] },
      'levels/arena.scene.json': { id: 'arena', entities: [{ id: 'hero' }] },
    })
    const editor = new GameManifestWorkspaceEditor(store)

    await expect(
      editor.edit({
        target: 'project',
        operations: [{
          action: 'set_project',
          values: { scenes: ['scenes/arena.scene.json'] },
        }],
      }),
    ).rejects.toThrow('scene:arena 已经住在 levels/arena.scene.json')
    expect(store.batches).toHaveLength(0)
  })

  test('empty operations declare and canonicalize an existing draft without losing content', async () => {
    // 用法文字必须与行为逐字对应。上一版写的是「空 operations 是成功的 no-op：它只保证目标清单
    // 存在，不会重写已有内容」——但对一份磁盘已有、尚未声明的草稿，空批次会把它规范化重写并
    // 写进 project.prefabs（changedFiles 两条）。内容确实一条没丢，那句话却是假的，
    // 而空批次恰恰是模型用来「只确认目标存在」的探路手势。
    const store = createStore()
    store.setText(
      'prefabs/enemy.prefab.json',
      '{"components":{"tags":["enemy"]},"id":"enemy","kind":"prefab"}',
    )
    const editor = new GameManifestWorkspaceEditor(store)
    const probe = await editor.edit({ target: 'prefab:enemy', operations: [] })

    expect(probe.operationsApplied).toBe(0)
    expect(probe.changedFiles).toEqual([
      'game.project.json',
      'prefabs/enemy.prefab.json',
    ])
    expect(probe.diffSummary).toContain(
      'declared prefab: prefab:enemy → prefabs/enemy.prefab.json',
    )
    // 内容一条不丢，只重排键序与缩进。
    expect(store.value('prefabs/enemy.prefab.json')).toEqual({
      id: 'enemy',
      kind: 'prefab',
      extends: null,
      components: { tags: ['enemy'] },
    })
  })

  test('never walks the project when every touched manifest is already declared', async () => {
    // 扫描的代价只在「要采纳或创建」时付。编辑一份已声明的清单一次盘都不走。
    const store = createStore()
    const editor = new GameManifestWorkspaceEditor(store)
    await editor.edit({
      target: 'scene:base',
      operations: [{ action: 'set_entity', entityId: 'ground' }],
    })

    expect(store.manifestScans).toBe(0)
  })

  test('names every bootstrap creation in diffSummary', async () => {
    // 同一条判决的另一半：`set_project` 声明一条还不存在的场景路径**可以**创建（那是显式意图），
    // 但创建必须在结果里看得见。第六轮这条路径一行摘要都不写。
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
            'scenes/arena.scene.json',
          ],
        },
      }],
    })

    expect(declared.changedFiles).toContain('scenes/arena.scene.json')
    expect(declared.diffSummary).toContain(
      'created scene: scene:arena → scenes/arena.scene.json',
    )
  })

  test('keeps the did-you-mean error instead of materializing a mistyped target', async () => {
    // 第七轮 P2（主线判决）：永远不许拿「你是不是想说 X」的报错去换一次静默创建。
    // 这一批只有 remove_entity —— 模型显然是在指一个它认为已经存在的场景。
    const store = createStore()
    const editor = new GameManifestWorkspaceEditor(store)

    await expect(
      editor.edit({
        target: 'scene:levl-1',
        operations: [{ action: 'remove_entity', entityId: 'player' }],
      }),
    ).rejects.toThrow('找不到编辑目标 scene:levl-1')
    expect(store.batches).toHaveLength(0)
    expect(store.value('game.project.json').scenes).toEqual([
      'scenes/base.scene.json',
      'scenes/level-1.scene.json',
    ])
  })

  test('refuses to create a prefab target for a remove-only batch', async () => {
    // prefab 上的 remove_component 在空 prefab 上**静默成功**，所以第六轮的无差别 upsert 会把
    // 一个打错的 target 落成一份空文件并报成功——比场景那一档更隐蔽。
    const store = createStore()
    const editor = new GameManifestWorkspaceEditor(store)

    await expect(
      editor.edit({
        target: 'prefab:playr',
        operations: [{ action: 'remove_component', component: 'body' }],
      }),
    ).rejects.toThrow('可用 prefab：prefab:player')
    expect(store.batches).toHaveLength(0)
  })

  test('still creates a mistyped-looking target when the batch actually writes into it', async () => {
    // 反向锁：第六轮的 P0 不许被修回去。带 set_* 的批次照样从零建出场景。
    const store = createStore()
    const editor = new GameManifestWorkspaceEditor(store)
    const created = await editor.edit({
      target: 'scene:arena',
      operations: [{ action: 'set_entity', entityId: 'hero' }],
    })

    expect(created.changedFiles).toContain('scenes/arena.scene.json')
  })

  test('upserts the entity when set_component names one that does not exist yet', async () => {
    // 第七轮 P2：set_component 是闭集里唯一没被摊平的一级，而用法文字说所有 set_* 都是 upsert。
    // 摊平它——落盘结果与 set_entity(components:{...}) 逐字节相同。
    const store = createStore()
    const editor = new GameManifestWorkspaceEditor(store)
    const result = await editor.edit({
      target: 'scene:base',
      operations: [{
        action: 'set_component',
        entityId: 'ground',
        component: 'transform',
        values: { position: { x: 0, y: 480 } },
      }],
    })

    expect(result.diffSummary).toContain('added entity: entity:ground')
    const entities = store.value('scenes/base.scene.json').entities as Array<
      Record<string, unknown>
    >
    expect(entities.at(-1)).toEqual({
      id: 'ground',
      components: { transform: { position: { x: 0, y: 480 } } },
    })
  })

  test('lets set_component override an inherited entity by creating a local patch', async () => {
    // 顺带修好的第二个真缺陷：requireSceneEntity 只看本地 entities，于是「在子场景里改一个
    // 继承来的实体」过去也撞墙——而正解恰恰是建一条本地覆盖条目。
    const store = createStore()
    const editor = new GameManifestWorkspaceEditor(store)
    await editor.edit({
      target: 'scene:base',
      operations: [{ action: 'set_entity', entityId: 'obstacle' }],
    })
    await editor.edit({
      target: 'scene:level-1',
      operations: [{
        action: 'set_component',
        entityId: 'obstacle',
        component: 'transform',
        values: { position: { x: 320, y: 96 } },
      }],
    })

    const entities = store.value('scenes/level-1.scene.json').entities as Array<
      Record<string, unknown>
    >
    expect(entities.map((entity) => entity.id)).toEqual(['player', 'obstacle'])
    expect(entities.at(-1)).toEqual({
      id: 'obstacle',
      components: { transform: { position: { x: 320, y: 96 } } },
    })
  })

  test('repairs a half-built project whose declared manifests are missing', async () => {
    // 真机第一手：模型手写了 game.project.json、资产清单还没落盘，旧行为抛
    // 「找不到游戏清单 assets/assets.json」并让模型继续手写。缺席是半成品，不是损坏。
    const store = new MemoryManifestStore({
      'game.project.json': {
        name: 'half-built',
        scenes: ['scenes/main.scene.json'],
        assets: 'assets/assets.json',
      },
    })
    const editor = new GameManifestWorkspaceEditor(store)
    const result = await editor.edit({ target: 'project', operations: [] })

    expect(result.changedFiles.toSorted()).toEqual([
      'assets/assets.json',
      'scenes/main.scene.json',
    ])
    expect(store.value('assets/assets.json')).toEqual({ assets: [] })
    expect(store.value('scenes/main.scene.json')).toEqual({
      id: 'main',
      kind: 'scene',
      extends: null,
      entities: [],
    })
  })

  test('follows the carrier when a declared manifest moved, instead of bricking every target', async () => {
    // 第九轮 P1（真机可达链条）：手写 levels/main → 被采纳登记 → 模型照 usage 又手写一份
    // scenes/main → 清理时删掉被声明的 levels/main。此后装载站点只会「创建第二个载体 →
    // 撞 I3 → 抛错」，于是**每一个** target 都抛同一句，连报错正文自己开的 set_project
    // 药方也抛同一句，会话彻底不可用。装载期必须走完整的 I3：载体在哪，声明就跟到哪。
    const store = new MemoryManifestStore({
      'game.project.json': {
        name: 'moved',
        scenes: ['levels/main.scene.json'],
        entryScene: 'scene:main',
        assets: 'assets/assets.json',
      },
      'assets/assets.json': { assets: [] },
      'scenes/main.scene.json': { id: 'main', entities: [{ id: 'hero' }] },
    })
    const editor = new GameManifestWorkspaceEditor(store)
    const repaired = await editor.edit({ target: 'assets', operations: [] })

    expect(repaired.diffSummary).toContain(
      'redeclared scene: levels/main.scene.json（已不在磁盘上）→ scenes/main.scene.json',
    )
    // 修复必须落盘：基线若在修复之后才取，摘要行会说做了而磁盘上没做，下一次调用再修一遍。
    expect(repaired.changedFiles).toContain('game.project.json')
    expect(store.value('game.project.json').scenes).toEqual(['scenes/main.scene.json'])
    // 修完就是干净的：同一批再跑一次不该产生任何变更。
    const settled = await editor.edit({ target: 'assets', operations: [] })
    expect(settled.changedFiles).toEqual([])
    expect(settled.diffSummary).toEqual([])
  })

  test('drops a dangling declaration whose id is ambiguous rather than failing every target', async () => {
    // 同一 id 两份载体、声明却指向已删除的第三条路径：这一档采纳不了（编辑器不挑一份），
    // 但它同样不许把无关的 target 打死。声明指向的文件根本不存在，摘掉它什么都不丢；
    // entryScene 指着它就一并撤下，否则刚修好的工程会立刻被一条悬空引用重新判死。
    const store = new MemoryManifestStore({
      'game.project.json': {
        name: 'ambiguous-dangling',
        scenes: ['levels/main.scene.json'],
        entryScene: 'scene:main',
        assets: 'assets/assets.json',
      },
      'assets/assets.json': { assets: [] },
      'scenes/main.scene.json': { id: 'main', entities: [] },
      'stages/main.scene.json': { id: 'main', entities: [] },
    })
    const editor = new GameManifestWorkspaceEditor(store)
    const dropped = await editor.edit({ target: 'assets', operations: [] })

    expect(dropped.diffSummary).toContain(
      'dropped dangling scene: levels/main.scene.json（声明已摘除，磁盘上本就没有这份文件）',
    )
    expect(dropped.diffSummary).toContain(
      'cleared entry scene: scene:main（入口场景随悬空声明一并撤下）',
    )
    expect(store.value('game.project.json').scenes).toEqual([])
    expect(store.value('game.project.json').entryScene).toBeNull()
    // 真去触碰那个 id 时仍然 fail-fast——放宽的只有装载，不是运行。
    await expect(
      editor.edit({ target: 'scene:main', operations: [] }),
    ).rejects.toThrow('scene:main 在工程里有 2 份载体')
  })

  test('refuses to let one path play two roles in the project topology', async () => {
    // 第九轮 P3：documents 过去按 [project, ...scenes, ...prefabs, assets] 平铺而不按路径收敛，
    // 路径重合时产出两条同路径 change，真实宿主把「同批重复路径」当硬错整批拒——模型拿到的是
    // 一句内部实现口吻、无自救动作的话。判读与提交现在读同一张带角色的表。
    const store = new MemoryManifestStore({
      'game.project.json': {
        name: 'two-roles',
        prefabs: ['prefabs/player.prefab.json'],
        assets: 'assets/assets.json',
      },
      'assets/assets.json': { assets: [] },
      'prefabs/player.prefab.json': { id: 'player', components: {} },
    })
    const editor = new GameManifestWorkspaceEditor(store)

    await expect(
      editor.edit({
        target: 'project',
        operations: [{
          action: 'set_project',
          values: { assets: 'prefabs/player.prefab.json' },
        }],
      }),
    ).rejects.toThrow('同时扮演 2 个角色：prefab:player、资产清单')
    expect(store.batches).toHaveLength(0)
  })

  test('does not discover a second carrier of an already declared id (documented cost of not scanning)', async () => {
    // **这是文档口径的锁，不是缺陷的锁**（第九轮 P2 裁决：改文档不改代码）。
    // I3 被强制的时机是「编辑器创建或采纳一份清单」，而编辑一份**已声明**的清单一次盘都不走
    // （上面的 manifestScans === 0 锁），所以 ws_edit 事后手写的第二份在这条路径上发现不了。
    // 要让它「当面报出」只能把每次编辑都扫盘的代价加回来——第八轮刚把它压掉。
    const store = new MemoryManifestStore({
      'game.project.json': {
        name: 'shadow',
        scenes: ['scenes/main.scene.json'],
        assets: 'assets/assets.json',
      },
      'assets/assets.json': { assets: [] },
      'scenes/main.scene.json': { id: 'main', entities: [] },
      'levels/main.scene.json': { id: 'main', entities: [{ id: 'handwritten' }] },
    })
    const editor = new GameManifestWorkspaceEditor(store)
    const result = await editor.edit({
      target: 'scene:main',
      operations: [{ action: 'set_entity', entityId: 'goal' }],
    })

    expect(result.changedFiles).toEqual(['scenes/main.scene.json'])
    expect(store.manifestScans).toBe(0)
    expect(store.value('game.project.json').scenes).toEqual(['scenes/main.scene.json'])
  })

  // ===================================================================================
  // 不变量 I4（第十轮）：一次编辑只为它自己造成的破损负责。
  // 验收线是「不许 brick」，所以这一组锁的形状刻意是**对状态空间取样**而不是逐案例：
  // 每一种坏工程都只问同一个问题——`target='project'` 还能不能用。
  // ===================================================================================

  /** 一组「一次 ws_edit 就能造出来」的坏工程。新想到的坏法请加进这张表，不要新开测试。 */
  const damagedProjects: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['两节点继承环', {
      'game.project.json': {
        name: 'damaged',
        scenes: ['scenes/a.scene.json', 'scenes/b.scene.json'],
        assets: 'assets/assets.json',
        entryScene: 'scene:a',
      },
      'scenes/a.scene.json': { id: 'a', extends: 'scene:b', entities: [{ id: 'ha' }] },
      'scenes/b.scene.json': { id: 'b', extends: 'scene:a', entities: [{ id: 'hb' }] },
      'assets/assets.json': { assets: [] },
    }],
    ['场景自环', {
      'game.project.json': { name: 'damaged', scenes: ['scenes/a.scene.json'], assets: 'assets/assets.json' },
      'scenes/a.scene.json': { id: 'a', extends: 'scene:a', entities: [{ id: 'ha' }] },
      'assets/assets.json': { assets: [] },
    }],
    ['prefab 继承环', {
      'game.project.json': {
        name: 'damaged',
        prefabs: ['prefabs/p.prefab.json', 'prefabs/q.prefab.json'],
        assets: 'assets/assets.json',
      },
      'prefabs/p.prefab.json': { id: 'p', extends: 'prefab:q', components: {} },
      'prefabs/q.prefab.json': { id: 'q', extends: 'prefab:p', components: {} },
      'assets/assets.json': { assets: [] },
    }],
    ['两条路径同一个 scene id', {
      'game.project.json': {
        name: 'damaged',
        scenes: ['scenes/a.scene.json', 'levels/a.scene.json'],
        assets: 'assets/assets.json',
      },
      'scenes/a.scene.json': { id: 'a', entities: [{ id: 'x' }] },
      'levels/a.scene.json': { id: 'a', entities: [{ id: 'y' }] },
      'assets/assets.json': { assets: [] },
    }],
    ['声明数组里同一条路径出现两次', {
      'game.project.json': {
        name: 'damaged',
        scenes: ['scenes/a.scene.json', 'scenes/a.scene.json'],
        assets: 'assets/assets.json',
      },
      'scenes/a.scene.json': { id: 'a', entities: [{ id: 'x' }] },
      'assets/assets.json': { assets: [] },
    }],
    ['已声明的场景是坏 JSON', {
      'game.project.json': { name: 'damaged', scenes: ['scenes/a.scene.json'], assets: 'assets/assets.json' },
      'scenes/a.scene.json': '{ "id": "a", "entities": [ }',
      'assets/assets.json': { assets: [] },
    }],
    ['已声明的资产清单是坏 JSON', {
      'game.project.json': { name: 'damaged', scenes: [], assets: 'assets/assets.json' },
      'assets/assets.json': '{ "assets": [',
    }],
    ['一条路径同时是场景和资产清单', {
      'game.project.json': { name: 'damaged', scenes: ['scenes/a.scene.json'], assets: 'scenes/a.scene.json' },
      'scenes/a.scene.json': { id: 'a', entities: [{ id: 'x' }] },
    }],
    ['一份场景被同时声明成 prefab', {
      'game.project.json': {
        name: 'damaged',
        scenes: ['scenes/a.scene.json'],
        prefabs: ['scenes/a.scene.json'],
        assets: 'assets/assets.json',
      },
      'scenes/a.scene.json': { id: 'a', kind: 'scene', entities: [{ id: 'x' }] },
      'assets/assets.json': { assets: [] },
    }],
    ['entryScene / extends / asset 三处引用全悬空', {
      'game.project.json': {
        name: 'damaged',
        scenes: ['scenes/a.scene.json'],
        assets: 'assets/assets.json',
        entryScene: 'scene:nowhere',
      },
      'scenes/a.scene.json': {
        id: 'a',
        extends: 'scene:ghost',
        entities: [{ id: 'x', components: { visual: { kind: 'sprite', asset: 'asset:ghost' } } }],
      },
      'assets/assets.json': { assets: [] },
    }],
    ['继承深度超过上限', {
      'game.project.json': {
        name: 'damaged',
        scenes: [0, 1, 2, 3, 4, 5].map((i) => `scenes/s${i}.scene.json`),
        assets: 'assets/assets.json',
      },
      ...Object.fromEntries([0, 1, 2, 3, 4, 5].map((i) => [
        `scenes/s${i}.scene.json`,
        { id: `s${i}`, extends: i < 5 ? `scene:s${i + 1}` : null, entities: [] },
      ])),
      'assets/assets.json': { assets: [] },
    }],
    ['以上全部同时发生', {
      'game.project.json': {
        name: 'damaged',
        scenes: ['scenes/a.scene.json', 'levels/a.scene.json', 'x/bad.scene.json'],
        prefabs: ['p/p.prefab.json'],
        assets: 'p/p.prefab.json',
        entryScene: 'scene:nowhere',
      },
      'scenes/a.scene.json': { id: 'a', extends: 'scene:a', entities: [{ id: 'x', parent: 'entity:x' }] },
      'levels/a.scene.json': { id: 'a', entities: [{ id: 'y' }] },
      'x/bad.scene.json': '###',
      'p/p.prefab.json': { id: 'p', extends: 'prefab:p', components: {} },
    }],
    // ↓ 第十一轮补的三格坏法（照本表的规矩：新坏法加进表，不新开测试）。
    ['工程清单被声明成场景（第十一轮 P0）', {
      'game.project.json': {
        name: 'damaged',
        scenes: ['scenes/a.scene.json', 'game.project.json'],
        assets: 'assets/assets.json',
      },
      'scenes/a.scene.json': { id: 'a', entities: [{ id: 'x' }] },
      'assets/assets.json': { assets: [] },
    }],
    ['工程清单被声明成资产清单（第十一轮 P0）', {
      'game.project.json': {
        name: 'damaged',
        scenes: ['scenes/a.scene.json'],
        assets: 'game.project.json',
      },
      'scenes/a.scene.json': { id: 'a', entities: [{ id: 'x' }] },
    }],
    ['一份中立文件被同时声明成场景与 prefab（第十一轮 P1）', {
      'game.project.json': {
        name: 'damaged',
        scenes: ['scenes/a.scene.json', 'shared/thing.json'],
        prefabs: ['prefabs/p.prefab.json', 'shared/thing.json'],
        assets: 'assets/assets.json',
      },
      'scenes/a.scene.json': { id: 'a', entities: [{ id: 'x' }] },
      'prefabs/p.prefab.json': { id: 'p', components: {} },
      'shared/thing.json': {},
      'assets/assets.json': { assets: [] },
    }],
  ]

  for (const [label, entries] of damagedProjects) {
    test(`I4: target=project stays usable — ${label}`, async () => {
      for (const request of [
        { target: 'project', operations: [] },
        {
          target: 'project',
          operations: [{ action: 'set_project', values: { name: 'renamed' } }],
        },
      ] as const) {
        const store = new MemoryManifestStore(entries)
        const result = await new GameManifestWorkspaceEditor(store).edit(request)
        expect(result.ok).toBeTrue()
        // **第十一轮补的这一半才是这条电池的重点**：上一版只断 `ok`，于是「ok:true、
        // diffSummary 说 updated project、changedFiles 空、磁盘零变化」这种撒谎形态整格躺在
        // 绿灯里（P0 实测三种变体全同）。可用 = 改动真的落到磁盘上，不是「没抛错」。
        if (request.operations.length > 0) {
          expect(store.value('game.project.json').name).toBe('renamed')
        }
      }
    })
  }

  /**
   * 原则甲的机械锁：**一次编辑的报告，必须与它对磁盘做的事逐字对应**。
   *
   * 对整张坏工程表取样，三条判据全部从外部判定，不依赖任何实现细节：
   *  1. `changedFiles` 就是这次真正被改动过的文件集合（多一条少一条都算撒谎）；
   *  2. 声称 `created …` 的路径必须真的出现在 `changedFiles` 里；
   *  3. 声称 `skipped write …` 的路径必须真的没写。
   */
  for (const [label, entries] of damagedProjects) {
    test(`原则甲: 报告与磁盘逐字对应 — ${label}`, async () => {
      for (const target of ['project', 'assets', 'scene:a', 'prefab:p'] as const) {
        const store = new MemoryManifestStore(entries)
        const before = store.snapshot()
        const result = await new GameManifestWorkspaceEditor(store)
          .edit({ target, operations: [] })
          .catch(() => null)
        const after = store.snapshot()
        if (!result) {
          // 抛错这一档的承诺是「零文件落盘」。
          expect(after).toEqual(before)
          continue
        }
        const touched = [...new Set([...Object.keys(before), ...Object.keys(after)])]
          .filter((path) => before[path] !== after[path])
          .sort()
        expect([...result.changedFiles].sort()).toEqual(touched)
        for (const line of result.diffSummary) {
          const subject = line
            .slice(line.indexOf(': ') + 2)
            .split('（')[0]
            .split(' →')
            .at(-1)
            ?.trim()
          if (!subject || !(subject in after || subject in before)) continue
          if (line.startsWith('created ')) expect(result.changedFiles).toContain(subject)
          if (line.startsWith('skipped write')) expect(result.changedFiles).not.toContain(subject)
        }
      }
    })
  }

  test('I4: a pre-existing inheritance cycle is reported as a warning that names set_extends', async () => {
    const store = new MemoryManifestStore({
      'game.project.json': {
        name: 'cycle',
        scenes: ['scenes/a.scene.json', 'scenes/b.scene.json'],
        assets: 'assets/assets.json',
      },
      'scenes/a.scene.json': { id: 'a', extends: 'scene:b', entities: [{ id: 'ha' }] },
      'scenes/b.scene.json': { id: 'b', extends: 'scene:a', entities: [{ id: 'hb' }] },
      'assets/assets.json': { assets: [] },
    })
    const editor = new GameManifestWorkspaceEditor(store)
    const reported = await editor.edit({ target: 'project', operations: [] })
    const damage = reported.warnings.find((warning) => warning.includes('继承成环'))
    expect(damage).toContain('scene:a → scene:b → scene:a')
    expect(damage).toContain('set_extends')

    // 报错正文开的药方必须真的走得通。
    const healed = await editor.edit({
      target: 'scene:b',
      operations: [{ action: 'set_extends', extends: null }],
    })
    expect(healed.changedFiles).toEqual(['scenes/b.scene.json'])
    const settled = await editor.edit({ target: 'project', operations: [] })
    expect(settled.warnings.filter((warning) => warning.includes('继承成环'))).toEqual([])
    expect(store.value('scenes/a.scene.json').entities).toHaveLength(1)
    expect(store.value('scenes/b.scene.json').entities).toHaveLength(1)
  })

  test('I4: a cycle introduced by this edit still fails fast with zero writes', async () => {
    const store = createStore()
    const editor = new GameManifestWorkspaceEditor(store)
    await expect(editor.edit({
      target: 'scene:base',
      operations: [{ action: 'set_extends', extends: 'scene:level-1' }],
    })).rejects.toThrow('继承成环')
    expect(store.batches).toHaveLength(0)
  })

  test('set_extends normalizes a bare slug and refuses a cross-kind reference', async () => {
    const store = createStore()
    const editor = new GameManifestWorkspaceEditor(store)
    const result = await editor.edit({
      target: 'prefab:enemy',
      operations: [{ action: 'set_extends', extends: 'player' }],
    })
    expect(store.value('prefabs/enemy.prefab.json').extends).toBe('prefab:player')
    expect(result.appliedAdjustments.some((adjustment) => adjustment.action === 'aliased')).toBeTrue()

    await expect(editor.edit({
      target: 'prefab:enemy',
      operations: [{ action: 'set_extends', extends: 'scene:base' }],
    })).rejects.toThrow('只能继承同类清单')
    await expect(editor.edit({
      target: 'project',
      operations: [{ action: 'set_extends', extends: null }],
    })).rejects.toThrow('set_extends 只能用于')
  })

  test('an unreadable declared manifest is excluded, never overwritten, and still protected by I1', async () => {
    const store = createStore()
    store.setText('scenes/bonus.scene.json', '{ "id": "bonus", ')
    const declared = {
      ...(store.value('game.project.json') as Record<string, unknown>),
      scenes: [
        'scenes/base.scene.json',
        'scenes/level-1.scene.json',
        'scenes/bonus.scene.json',
      ],
    }
    store.setText('game.project.json', JSON.stringify(declared))
    const editor = new GameManifestWorkspaceEditor(store)

    const reported = await editor.edit({ target: 'project', operations: [] })
    expect(reported.warnings.some((warning) => warning.includes('scenes/bonus.scene.json')
      && warning.includes('读不出来'))).toBeTrue()
    expect(reported.changedFiles).not.toContain('scenes/bonus.scene.json')
    expect(store.text('scenes/bonus.scene.json')).toBe('{ "id": "bonus", ')
    expect(store.value('game.project.json').scenes).toContain('scenes/bonus.scene.json')

    // 触碰它 = 当场知道它坏了。
    await expect(editor.edit({
      target: 'scene:bonus',
      operations: [{ action: 'set_entity', entityId: 'z' }],
    })).rejects.toThrow('不是合法 JSON')

    // I1 仍然拦得住「顺手把它摘出声明」。
    await expect(editor.edit({
      target: 'project',
      operations: [{
        action: 'set_project',
        values: { scenes: ['scenes/base.scene.json', 'scenes/level-1.scene.json'] },
      }],
    })).rejects.toThrow('从 game.project.json 的声明里摘掉了')
  })

  test('a path playing two roles is never written, and set_project repairs it without losing content', async () => {
    const store = new MemoryManifestStore({
      'game.project.json': {
        name: 'roles',
        scenes: ['scenes/a.scene.json'],
        assets: 'scenes/a.scene.json',
      },
      'scenes/a.scene.json': { id: 'a', entities: [{ id: 'x' }] },
    })
    const editor = new GameManifestWorkspaceEditor(store)
    const reported = await editor.edit({ target: 'project', operations: [] })
    expect(reported.changedFiles).not.toContain('scenes/a.scene.json')
    expect(reported.diffSummary.some((line) => line.startsWith('skipped write'))).toBeTrue()

    await editor.edit({
      target: 'project',
      operations: [{ action: 'set_project', values: { assets: 'assets/assets.json' } }],
    })
    // 冲突期间这条路径一个字节都没被动过，所以它保持装载时的原文（不是 canonical 形态）。
    expect(store.value('scenes/a.scene.json').entities).toEqual([{ id: 'x' }])
    const settled = await editor.edit({ target: 'project', operations: [] })
    expect(settled.warnings.filter((warning) => warning.includes('两个角色'))).toEqual([])
  })

  test('a declaration array that repeats one path is deduped instead of failing', async () => {
    const store = new MemoryManifestStore({
      'game.project.json': {
        name: 'dup',
        scenes: ['scenes/a.scene.json', 'scenes/a.scene.json'],
        assets: 'assets/assets.json',
      },
      'scenes/a.scene.json': { id: 'a', entities: [{ id: 'x' }] },
      'assets/assets.json': { assets: [] },
    })
    const editor = new GameManifestWorkspaceEditor(store)
    await editor.edit({
      target: 'project',
      operations: [{ action: 'set_project', values: { name: 'renamed' } }],
    })
    expect(store.value('game.project.json').scenes).toEqual(['scenes/a.scene.json'])
  })

  test('P0: 工程清单被声明成自己的子清单时，set_project 仍然真的落盘', async () => {
    // 写盘保护（读不出来的不写 / 一路径两角色一个字节都不动）本身是对的，错的是它罩住了
    // **拓扑的唯一来源**：工程清单一旦被 project.scenes / prefabs / assets 指到自己，
    // target='project' + set_project 就变成 ok:true、diffSummary 说 updated project、
    // changedFiles 空、磁盘零变化——而三条闭集出路全被 I1 封死（摘掉那条自指声明在 I1 眼里
    // 就是「摘掉一份有内容的清单」）。修法不是给保护开例外，是让这个状态结构上不存在。
    for (const [field, project] of [
      ['scenes', { scenes: ['scenes/a.scene.json', 'game.project.json'] }],
      ['prefabs', { scenes: ['scenes/a.scene.json'], prefabs: ['game.project.json'] }],
      ['assets', { scenes: ['scenes/a.scene.json'], assets: 'game.project.json' }],
    ] as const) {
      const store = new MemoryManifestStore({
        'game.project.json': { name: 'p', assets: 'assets/assets.json', ...project },
        'scenes/a.scene.json': { id: 'a', entities: [{ id: 'x' }], notes: 'keep' },
        'assets/assets.json': { assets: [] },
      })
      const editor = new GameManifestWorkspaceEditor(store)
      const renamed = await editor.edit({
        target: 'project',
        operations: [{ action: 'set_project', values: { name: 'renamed' } }],
      })
      expect(store.value('game.project.json').name).toBe(`renamed`)
      expect(renamed.changedFiles).toContain('game.project.json')
      expect(renamed.diffSummary.some((line) => line.startsWith('dropped self-declaration'))).toBeTrue()
      expect(renamed.warnings.join('\n')).toContain(`project.${field}`)
      // 被误声明的那份场景一个字节都没丢。
      expect(store.value('scenes/a.scene.json').notes).toBe('keep')
      // 修完就是干净的：同一批再跑一次不该产生任何变更。
      const settled = await editor.edit({ target: 'project', operations: [] })
      expect(settled.changedFiles).toEqual([])
      expect(settled.diffSummary).toEqual([])
    }
  })

  test('P0: 本次编辑写出的自指声明当场抛，零文件落盘', async () => {
    // 归因与 throwIfDeclaredByThisEdit 同形：装载期已经把既存的摘掉了，走到这里只可能是这批写的。
    const store = new MemoryManifestStore({
      'game.project.json': { name: 'p', scenes: ['scenes/a.scene.json'], assets: 'assets/assets.json' },
      'scenes/a.scene.json': { id: 'a', entities: [{ id: 'x' }] },
      'assets/assets.json': { assets: [] },
    })
    await expect(new GameManifestWorkspaceEditor(store).edit({
      target: 'project',
      operations: [{
        action: 'set_project',
        values: { scenes: ['scenes/a.scene.json', 'game.project.json'] },
      }],
    })).rejects.toThrow('它是工程拓扑的根')
    expect(store.batches).toHaveLength(0)
  })

  test('P1: 装载与收尾读同一份拓扑，第二个角色不会在收尾凭空出现', async () => {
    // 上一版 scenes 与 prefabs 两个装载循环共用一个**跨种类**去重集：同一条路径被 scenes
    // 抢先认领后 prefabs 循环直接 continue，第二个角色对 diagnosisAtLoad 隐身；而
    // activateDeclaredPrefabs 没有同一条去重，于是角色冲突在收尾凭空出现，acceptDiagnosis
    // 判成「本次编辑引入」并抛——六个 target 全死。这不是又一种坏法，是 I4 的归因基准错了。
    const store = new MemoryManifestStore({
      'game.project.json': {
        name: 'p',
        scenes: ['scenes/a.scene.json', 'shared/thing.json'],
        prefabs: ['prefabs/p.prefab.json', 'shared/thing.json'],
        assets: 'assets/assets.json',
      },
      'scenes/a.scene.json': { id: 'a', entities: [{ id: 'x' }] },
      'prefabs/p.prefab.json': { id: 'p', components: {} },
      'shared/thing.json': { note: 'hand written' },
      'assets/assets.json': { assets: [] },
    })
    const editor = new GameManifestWorkspaceEditor(store)
    const reported = await editor.edit({ target: 'project', operations: [] })
    expect(reported.ok).toBeTrue()
    // 装载时就成立的冲突 → 随 warning 报出，那条路径一个字节都不动，且**说出来**。
    expect(reported.warnings.join('\n')).toContain('shared/thing.json')
    expect(reported.diffSummary.some((line) => line.startsWith('skipped write: shared/thing.json'))).toBeTrue()
    expect(store.text('shared/thing.json')).toBe('{"note":"hand written"}')
    // 药方走得通。
    await editor.edit({
      target: 'project',
      operations: [{ action: 'set_project', values: { prefabs: ['prefabs/p.prefab.json'] } }],
    })
    const settled = await editor.edit({ target: 'project', operations: [] })
    expect(settled.warnings.filter((warning) => warning.includes('个角色'))).toEqual([])
  })

  test('P2: 触碰一个有两份载体的 id 时失败，而不是按数组顺序挑一份', async () => {
    // 失败语义表那一行（「列出全部载体路径；编辑器不挑一份继续跑」）过去只对**未声明**的双载体
    // 成立。两份都被声明时 resolveTarget 用 find 取第一条：实体只落进数组里靠前的那一份，
    // 摘要一个字不提写的是哪一份；把声明顺序对调，同一条调用改写另一份。
    for (const order of [
      ['scenes/a.scene.json', 'levels/a.scene.json'],
      ['levels/a.scene.json', 'scenes/a.scene.json'],
    ]) {
      const store = new MemoryManifestStore({
        'game.project.json': { name: 'p', scenes: order, assets: 'assets/assets.json' },
        'scenes/a.scene.json': { id: 'a', entities: [{ id: 'x' }] },
        'levels/a.scene.json': { id: 'a', entities: [{ id: 'y' }] },
        'assets/assets.json': { assets: [] },
      })
      await expect(new GameManifestWorkspaceEditor(store).edit({
        target: 'scene:a',
        operations: [{ action: 'set_entity', entityId: 'z' }],
      })).rejects.toThrow('scene:a 在工程里有 2 份载体')
      expect(store.batches).toHaveLength(0)
      // 无关 target 照常可用——被拒的只是坏在那一点上的那个 target（I4 没有被推倒）。
      const unrelated = await new GameManifestWorkspaceEditor(store).edit({
        target: 'project',
        operations: [{ action: 'set_project', values: { name: 'renamed' } }],
      })
      expect(unrelated.ok).toBeTrue()
      expect(store.value('game.project.json').name).toBe('renamed')
    }
  })

  test('P2: I1 第三条药方在 entryScene 指着它时也走得通', async () => {
    const store = new MemoryManifestStore({
      'game.project.json': {
        name: 'p',
        scenes: ['scenes/a.scene.json'],
        entryScene: 'scene:a',
        assets: 'assets/assets.json',
      },
      'scenes/a.scene.json': { id: 'a', entities: [{ id: 'x' }] },
      'assets/assets.json': { assets: [] },
    })
    const editor = new GameManifestWorkspaceEditor(store)
    const refused = await editor
      .edit({ target: 'project', operations: [{ action: 'set_project', values: { scenes: [] } }] })
      .catch((error: Error) => error)
    // 药方开出来的那一刻就得把 entryScene 这一步带上，否则模型照做之后撞死胡同。
    expect((refused as Error).message).toContain('entryScene')

    store.documents.delete('scenes/a.scene.json')
    // 漏改 entryScene 时的报错必须点名字段、点名文件、说明零落盘。
    const dangling = await editor
      .edit({ target: 'project', operations: [{ action: 'set_project', values: { scenes: [] } }] })
      .catch((error: Error) => error)
    expect((dangling as Error).message).toContain('entryScene 指向 scene:a')
    expect((dangling as Error).message).toContain('零文件落盘')
    expect(store.batches).toHaveLength(0)

    const healed = await editor.edit({
      target: 'project',
      operations: [{ action: 'set_project', values: { scenes: [], entryScene: null } }],
    })
    expect(healed.ok).toBeTrue()
    expect(store.value('game.project.json').entryScene).toBeNull()
    // 那份场景从来没被建出来，所以摘要里不许留一句「created scene」。
    expect(healed.diffSummary.some((line) => line.startsWith('created scene'))).toBeFalse()
    expect(store.has('scenes/a.scene.json')).toBeFalse()
  })

  test('P3: 中途采纳的清单被重写时，diffSummary 里有它自己的一行', async () => {
    // 模型看到一份自己没听说改过的文件出现在 changedFiles 里，只能怀疑并发写入。
    const store = new MemoryManifestStore({
      'game.project.json': { name: 'p', scenes: ['scenes/a.scene.json'], assets: 'scenes/a.scene.json' },
      'scenes/a.scene.json': { id: 'a', entities: [{ id: 'x' }] },
      'assets/assets.json': { assets: [{ id: 'tex', kind: 'texture', path: 'x.png' }], notes: 'keep me' },
    })
    const adopted = await new GameManifestWorkspaceEditor(store).edit({
      target: 'project',
      operations: [{ action: 'set_project', values: { assets: 'assets/assets.json' } }],
    })
    expect(adopted.changedFiles).toContain('assets/assets.json')
    expect(adopted.diffSummary.some((line) =>
      line.startsWith('declared assets manifest: assets/assets.json'))).toBeTrue()
    expect(store.value('assets/assets.json').notes).toBe('keep me')
  })

  test('game.project.json is the only manifest whose failure is fatal, and it says so', async () => {
    const store = new MemoryManifestStore({ 'game.project.json': '{ "name": "x", ' })
    const editor = new GameManifestWorkspaceEditor(store)
    await expect(editor.edit({ target: 'project', operations: [] })).rejects.toThrow(
      '唯一一份编辑器无法降级处理的清单',
    )
    // 一次 ws_edit 就修好了，出路只有一步。
    store.setText('game.project.json', JSON.stringify({ name: 'x' }))
    const healed = await editor.edit({ target: 'project', operations: [] })
    expect(healed.ok).toBeTrue()
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
