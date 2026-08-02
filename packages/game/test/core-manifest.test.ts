import { describe, expect, test } from 'bun:test'

import {
  formatGameManifest,
  GameManifestError,
  GameManifestResolver,
  parseGameAssetsManifest,
  parseGamePrefabManifest,
  parseGameProjectManifest,
  parseGameSceneManifest,
  validateGameManifestSourceSet,
} from '../dist/core/index.js'

const project = parseGameProjectManifest({
  name: 'starfall',
  runtime: {
    canvas: { width: 960, height: 540 },
  },
  entryScene: 'scene:level-1',
  scenes: ['scenes/level-1.scene.json', 'scenes/level-2.scene.json'],
  layers: ['background', 'actors', 'ui'],
  collisionLayers: ['ground', 'player', 'enemy'],
  input: {
    actions: {
      jump: ['Space'],
    },
  },
}).value

const assets = parseGameAssetsManifest({
  assets: [
    {
      id: 'player-idle',
      kind: 'texture',
      path: 'assets/sprites/player.png',
    },
  ],
}).value

const playerPrefab = parseGamePrefabManifest({
  id: 'player',
  components: {
    transform: {
      position: { x: 0, y: 12 },
    },
    visual: {
      asset: 'asset:player-idle',
    },
    body: {
      kind: 'dynamic',
      layer: 'player',
      collidesWith: ['ground', 'enemy'],
    },
    tags: ['player'],
    layer: 'actors',
  },
}).value

const level1 = parseGameSceneManifest({
  id: 'level-1',
  entities: [
    {
      id: 'player',
      from: 'prefab:player',
      components: {
        transform: {
          position: { x: 64 },
        },
      },
    },
    {
      id: 'enemy-slime-01',
      components: {
        transform: { position: { x: 500, y: 320 } },
        layer: 'actors',
        body: {
          kind: 'dynamic',
          layer: 'enemy',
          collidesWith: ['ground', 'player'],
        },
      },
    },
  ],
}).value

const level2 = parseGameSceneManifest({
  id: 'level-2',
  extends: 'scene:level-1',
  entities: [
    {
      id: 'player',
      components: {
        transform: {
          position: { y: 120 },
        },
      },
    },
    {
      id: 'enemy-slime-01',
      remove: true,
    },
  ],
}).value

describe('game manifest forgiving parser', () => {
  test('defaults project structure, clamps structural numbers, and reports every adjustment', () => {
    const result = parseGameProjectManifest({
      name: 'tiny-game',
      runtime: {
        canvas: { width: '12000', height: 540 },
        pixelArt: 'false',
      },
      scenes: ['scenes/main.scene.json'],
      input: {
        actions: {
          jump: 'Space',
        },
      },
    })

    expect(result.value.runtime).toEqual({
      profile: 'web-2d',
      canvas: { width: 8192, height: 540 },
      pixelArt: false,
    })
    expect(result.value.entryScene).toBe('scene:main')
    expect(result.value.input.actions.jump).toEqual(['Space'])
    expect(result.appliedAdjustments.some((item) => item.field === '$.runtime.canvas.width')).toBeTrue()
    expect(result.appliedAdjustments.some((item) => item.field === '$.entryScene')).toBeTrue()
  })

  test('infers only unambiguous discriminants and preserves unknown fields with a warning', () => {
    const result = parseGameSceneManifest({
      id: 'level-1',
      futureSceneField: { enabled: true },
      entities: [{
        id: 'player',
        components: {
          visual: { asset: 'asset:player-idle' },
          body: { layer: 'player' },
          futureComponent: { value: 1 },
        },
      }],
    })

    const components = result.value.entities[0]?.components
    expect(components?.visual?.kind).toBe('sprite')
    expect(components?.body?.kind).toBeUndefined()
    expect(components?.futureComponent).toEqual({ value: 1 })
    expect(result.warnings.some((warning) => warning.includes('futureSceneField'))).toBeTrue()
    expect(result.warnings.some((warning) => warning.includes('futureComponent'))).toBeTrue()
  })

  test('normalizes the mesh-specific shorthand without losing its asset reference', () => {
    const result = parseGameSceneManifest({
      id: 'mesh-scene',
      entities: [{
        id: 'mesh-object',
        components: {
          visual: { mesh: 'asset:ship-mesh' },
        },
      }],
    })

    expect(result.value.entities[0]?.components?.visual).toEqual({
      kind: 'mesh',
      asset: 'asset:ship-mesh',
    })
    expect(result.appliedAdjustments.some(
      (item) => item.field === '$.entities[0].components.visual.asset',
    )).toBeTrue()
  })

  test('rejects ambiguous or invalid discriminants with an executable path', () => {
    expect(() => parseGameSceneManifest({
      id: 'level-1',
      entities: [{
        id: 'mixed-visual',
        components: {
          visual: {
            asset: 'asset:player-idle',
            text: 'ambiguous',
          },
        },
      }],
    })).toThrow('$.entities[0].components.visual.kind')
    expect(() => parseGameSceneManifest({
      id: '123',
      entities: [],
    })).toThrow('不能使用 GUID 或纯生成式编号')
  })

  test('rejects absolute and escaping asset paths', () => {
    expect(() => parseGameAssetsManifest({
      assets: [{ id: 'secret', kind: 'texture', path: '../secret.png' }],
    })).toThrow('工程内相对路径')
    expect(() => parseGameAssetsManifest({
      assets: [{ id: 'secret', kind: 'texture', path: '..\\secret.png' }],
    })).toThrow('使用正斜杠的可移植工程内相对路径')
    expect(() => parseGameAssetsManifest({
      assets: [{ id: 'secret', kind: 'texture', path: 'assets//secret.png' }],
    })).toThrow('使用正斜杠的可移植工程内相对路径')
  })

  test('rejects non-object entities and assets instead of silently deleting them', () => {
    for (const parse of [
      () => parseGameSceneManifest({
        id: 'broken-scene',
        entities: ['player'],
      }),
      () => parseGameAssetsManifest({
        assets: ['assets/player.png'],
      }),
    ]) {
      try {
        parse()
        throw new Error('expected parsing to fail')
      } catch (error) {
        expect(error).toBeInstanceOf(GameManifestError)
        const manifestError = error as GameManifestError
        expect(manifestError.path).toMatch(/^\$\.(entities|assets)\[0\]$/u)
        expect(manifestError.message).toContain(manifestError.path as string)
        expect(manifestError.hint).toMatch(/改成.*对象.*显式.*删除/u)
      }
    }
  })
})

describe('game manifest inheritance and reference validator', () => {
  test('resolves prefab and scene patches without letting defaults overwrite inherited fields', () => {
    const resolver = validateGameManifestSourceSet({
      project,
      scenes: [level1, level2],
      prefabs: [playerPrefab],
      assets,
    })
    const resolved = resolver.resolveScene('level-2')
    const player = resolved.entities.find((entity) => entity.id === 'player')

    expect(resolved.entities.map((entity) => entity.id)).toEqual(['player'])
    expect(player?.components.transform?.position).toEqual({ x: 64, y: 120 })
    expect(player?.components.layer).toBe('actors')
    expect(player?.components.order).toBe(0)
  })

  test('applies body and camera defaults only after inheritance patches merge', () => {
    const dynamicPrefab = parseGamePrefabManifest({
      id: 'dynamic-player',
      components: {
        body: {
          kind: 'dynamic',
          layer: 'player',
          collidesWith: ['ground'],
        },
        camera: {
          kind: 'follow',
          target: 'entity:player',
        },
      },
    }).value
    const patchedScene = parseGameSceneManifest({
      id: 'patched',
      entities: [{
        id: 'player',
        from: 'prefab:dynamic-player',
        components: {
          body: { gravityScale: 0.5 },
          camera: { lerp: 0.25 },
        },
      }],
    }).value
    const resolved = validateGameManifestSourceSet({
      project: { ...project, entryScene: 'scene:patched' },
      scenes: [patchedScene],
      prefabs: [dynamicPrefab],
      assets,
    }).resolveEntryScene()
    const player = resolved?.entities[0]

    expect(player?.components.body?.kind).toBe('dynamic')
    expect(player?.components.body?.gravityScale).toBe(0.5)
    expect(player?.components.camera?.kind).toBe('follow')
    expect(player?.components.camera?.lerp).toBe(0.25)
  })

  test('accepts a minimal visual patch and validates the merged discriminated union', () => {
    const visualScene = parseGameSceneManifest({
      id: 'visual-patch',
      entities: [{
        id: 'player',
        from: 'prefab:player',
        components: {
          visual: { anchor: 'top-left' },
        },
      }],
    }).value
    const resolved = validateGameManifestSourceSet({
      project: { ...project, entryScene: 'scene:visual-patch' },
      scenes: [visualScene],
      prefabs: [playerPrefab],
      assets,
    }).resolveEntryScene()

    expect(resolved?.entities[0]?.components.visual).toMatchObject({
      kind: 'sprite',
      asset: 'asset:player-idle',
      anchor: 'top-left',
    })

    // 「最小实例补丁」只在**有基底可继承**时成立；那里不许推断 kind，合并后仍不完整就大声失败。
    const bodyOnlyPrefab = parseGamePrefabManifest({
      id: 'body-only',
      components: { body: { kind: 'static', layer: 'ground' }, layer: 'actors' },
    }).value
    const incompleteScene = parseGameSceneManifest({
      id: 'incomplete-visual',
      entities: [{
        id: 'orphan',
        from: 'prefab:body-only',
        components: {
          visual: { color: '#ffffff' },
        },
      }],
    }).value
    expect(incompleteScene.entities[0]?.components?.visual).toEqual({ color: '#ffffff' })
    expect(() => validateGameManifestSourceSet({
      project: { ...project, entryScene: 'scene:incomplete-visual' },
      scenes: [incompleteScene],
      prefabs: [bodyOnlyPrefab],
      assets,
    })).toThrow('继承合并后仍不完整')
  })

  test('returns valid ids when a reference is missing', () => {
    const missingAssetScene = parseGameSceneManifest({
      id: 'missing-asset',
      entities: [{
        id: 'player',
        components: {
          visual: { kind: 'sprite', asset: 'asset:not-there' },
        },
      }],
    }).value

    try {
      validateGameManifestSourceSet({
        project: { ...project, entryScene: 'scene:missing-asset' },
        scenes: [missingAssetScene],
        prefabs: [],
        assets,
      })
      throw new Error('expected validation to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(GameManifestError)
      expect((error as GameManifestError).code).toBe('INVALID_REFERENCE')
      expect((error as GameManifestError).hint).toContain('1. player-idle')
    }
  })

  test('reports the complete inheritance cycle', () => {
    const sceneA = parseGameSceneManifest({
      id: 'scene-a',
      extends: 'scene:scene-b',
      entities: [],
    }).value
    const sceneB = parseGameSceneManifest({
      id: 'scene-b',
      extends: 'scene:scene-a',
      entities: [],
    }).value
    const resolver = new GameManifestResolver({
      project: { ...project, entryScene: 'scene:scene-a' },
      scenes: [sceneA, sceneB],
      prefabs: [],
      assets,
    })

    expect(() => resolver.resolveEntryScene()).toThrow(
      'scene:scene-a → scene:scene-b → scene:scene-a',
    )
  })

  test('rejects duplicate entity patches and cyclic parent references', () => {
    const duplicate = parseGameSceneManifest({
      id: 'duplicate',
      entities: [
        { id: 'player', components: {} },
        { id: 'player', components: { order: 1 } },
      ],
    }).value
    expect(() => validateGameManifestSourceSet({
      project: { ...project, entryScene: 'scene:duplicate' },
      scenes: [duplicate],
      prefabs: [],
      assets,
    })).toThrow('scene:duplicate entity id 重复')

    const cyclic = parseGameSceneManifest({
      id: 'cyclic',
      entities: [
        { id: 'player', parent: 'entity:camera', components: {} },
        { id: 'camera', parent: 'entity:player', components: {} },
      ],
    }).value
    expect(() => validateGameManifestSourceSet({
      project: { ...project, entryScene: 'scene:cyclic' },
      scenes: [cyclic],
      prefabs: [],
      assets,
    })).toThrow('parent 引用成环')
  })

  test('validates unused prefab assets and animation clip references', () => {
    const unusedPrefab = parseGamePrefabManifest({
      id: 'unused',
      components: {
        animation: {
          clips: [{
            name: 'idle',
            asset: 'asset:player-idle',
          }],
          autoPlay: 'walk',
        },
      },
    }).value

    expect(() => validateGameManifestSourceSet({
      project,
      scenes: [level1, level2],
      prefabs: [playerPrefab, unusedPrefab],
      assets,
    })).toThrow('需要 spritesheet 资产')

    const spritesheetAssets = parseGameAssetsManifest({
      assets: [{
        id: 'player-idle',
        kind: 'spritesheet',
        path: 'assets/sprites/player.png',
        frame: { width: 32, height: 32 },
      }],
    }).value
    expect(() => validateGameManifestSourceSet({
      project,
      scenes: [level1, level2],
      prefabs: [playerPrefab, unusedPrefab],
      assets: spritesheetAssets,
    })).toThrow('autoPlay 引用了未声明的 clip walk')
  })

  test('bounds collision categories without truncating the manifest', () => {
    const collisionLayers = Array.from(
      { length: 32 },
      (_, index) => `layer-${index}`,
    )
    expect(() => validateGameManifestSourceSet({
      project: { ...project, collisionLayers },
      scenes: [level1, level2],
      prefabs: [playerPrefab],
      assets,
    })).toThrow('collisionLayers 最多 31 个')
  })
})

describe('game manifest canonical formatter', () => {
  test('keeps entity order and notes while making key order deterministic', () => {
    const formatted = formatGameManifest({
      notes: 'keep me',
      entities: [
        { components: {}, id: 'second' },
        { components: {}, id: 'first' },
      ],
      kind: 'scene',
      id: 'level-1',
      extends: null,
    })

    expect(formatted.indexOf('"id": "level-1"')).toBeLessThan(formatted.indexOf('"kind": "scene"'))
    expect(formatted.indexOf('"id": "second"')).toBeLessThan(formatted.indexOf('"id": "first"'))
    expect(formatted).toContain('"notes": "keep me"')
    expect(formatted.endsWith('\n')).toBeTrue()
  })
})

/**
 * 第十二轮（真机第一手）：AI 照直觉写出来的清单，要么真的出画面、要么大声说清哪里不对。
 *
 * 真机形态：`components.sprite` + `components.collider` + 工程顶层 `pixelArt` /
 * `canvasWidth` / `canvasHeight`。旧行为是四处「已原样保留，但投影层可以忽略」的轻声警告 +
 * 三个隐形实体 + `errors 0`。
 */
describe('game manifest forgiving normalization (round 12)', () => {
  const baseProject = {
    name: 'platformer',
    entryScene: 'scene:level-1',
    scenes: ['scenes/level-1.scene.json'],
    layers: ['background', 'actors', 'ui'],
    collisionLayers: ['ground', 'player'],
    input: { actions: { jump: ['Space'] } },
  }

  const adjustmentFor = (result, field) =>
    result.appliedAdjustments.find((item) => item.field === field)

  test('真机原样的工程清单：顶层 pixelArt / canvasWidth / canvasHeight 搬到唯一落点并留痕', () => {
    const parsed = parseGameProjectManifest(
      { ...baseProject, pixelArt: false, canvasWidth: 800, canvasHeight: 600 },
      'game.project.json',
    )

    expect(parsed.value.runtime.canvas).toEqual({ width: 800, height: 600 })
    expect(parsed.value.runtime.pixelArt).toBeFalse()
    expect(parsed.value.pixelArt).toBeUndefined()
    expect(parsed.value.canvasWidth).toBeUndefined()
    for (const field of ['$.runtime.pixelArt', '$.runtime.canvas.width', '$.runtime.canvas.height']) {
      expect(adjustmentFor(parsed, field)?.action).toBe('aliased')
    }
    // 搬运是回显，不是警告：这三条不该再以「未知字段」的形态出现。
    expect(parsed.warnings.join('\n')).not.toContain('canvasWidth')
  })

  test('工程清单：目标格已有值时不替作者挑一份，出一句点名两边的话', () => {
    const parsed = parseGameProjectManifest(
      { ...baseProject, runtime: { canvas: { width: 640, height: 360 } }, canvasWidth: 800 },
      'game.project.json',
    )

    expect(parsed.value.runtime.canvas.width).toBe(640)
    expect(adjustmentFor(parsed, '$.runtime.canvas.width')).toBeUndefined()
    const warning = parsed.warnings.find((text) => text.includes('$.canvasWidth'))
    expect(warning).toContain('$.runtime.canvas.width')
    expect(warning).toContain('不会生效')
    // 一个键只说一句：不许再补一条泛泛的「未知字段」。
    expect(parsed.warnings.filter((text) => text.includes('$.canvasWidth')).length).toBe(1)
  })

  test('真机原样的场景清单：sprite/collider 归一 + 尺寸色值推断出 shape，三个实体全部可投影', () => {
    const parsed = parseGameSceneManifest({
      id: 'level-1',
      entities: [
        {
          id: 'ground',
          components: {
            transform: { position: { x: 400, y: 580 } },
            collider: { width: 800, height: 40, layer: 'ground' },
            sprite: { width: 800, height: 40, color: '#6b8e23' },
          },
        },
        {
          id: 'coin',
          components: { sprite: { radius: 12, color: '#ffd700' } },
        },
      ],
    }, 'scenes/level-1.scene.json')

    expect(parsed.value.entities[0]?.components?.visual).toEqual({
      width: 800,
      height: 40,
      color: '#6b8e23',
      kind: 'shape',
      shape: 'rect',
    })
    expect(parsed.value.entities[0]?.components?.body).toEqual({
      width: 800,
      height: 40,
      layer: 'ground',
    })
    expect(parsed.value.entities[0]?.components?.sprite).toBeUndefined()
    expect(parsed.value.entities[0]?.components?.collider).toBeUndefined()
    // 只有 radius 时补 circle，不是无脑 rect。
    expect(parsed.value.entities[1]?.components?.visual?.shape).toBe('circle')
    expect(parsed.warnings).toEqual([])

    const resolved = validateGameManifestSourceSet({
      project: parseGameProjectManifest(baseProject).value,
      scenes: [parsed.value],
      prefabs: [],
      assets: parseGameAssetsManifest({ assets: [] }).value,
    }).resolveEntryScene()
    expect(resolved?.entities.map((entity) => entity.components.visual?.kind)).toEqual([
      'shape',
      'shape',
    ])
  })

  test('组件写在实体信封上时搬进 components 并留痕', () => {
    const parsed = parseGameSceneManifest({
      id: 'stray',
      entities: [{ id: 'hero', sprite: 'asset:hero', transform: { position: { x: 8 } } }],
    })

    expect(parsed.value.entities[0]?.components?.visual).toEqual({
      asset: 'asset:hero',
      kind: 'sprite',
    })
    expect(parsed.value.entities[0]?.components?.transform).toEqual({ position: { x: 8 } })
    expect(adjustmentFor(parsed, '$.entities[0].components.sprite')?.action).toBe('aliased')
    expect(parsed.warnings).toEqual([])
  })

  test('继承来的 visual 不许被推断偷换：有 from / extends 时一律不猜 kind', () => {
    const patched = parseGameSceneManifest({
      id: 'patched',
      entities: [{ id: 'hero', from: 'prefab:hero', components: { visual: { color: '#f00' } } }],
    })
    expect(patched.value.entities[0]?.components?.visual).toEqual({ color: '#f00' })

    const derived = parseGameSceneManifest({
      id: 'derived',
      extends: 'scene:base',
      entities: [{ id: 'hero', components: { visual: { width: 64 } } }],
    })
    expect(derived.value.entities[0]?.components?.visual).toEqual({ width: 64 })
  })

  test('别名与 canonical 同时写下时一份都不合并，并点名两边', () => {
    const parsed = parseGameSceneManifest({
      id: 'both',
      entities: [{
        id: 'hero',
        components: {
          visual: { kind: 'shape', shape: 'rect', width: 10, height: 10 },
          sprite: { color: '#fff' },
        },
      }],
    })

    expect(parsed.value.entities[0]?.components?.visual?.width).toBe(10)
    expect(parsed.value.entities[0]?.components?.sprite).toEqual({ color: '#fff' })
    const warning = parsed.warnings.find((text) => text.includes('.sprite'))
    expect(warning).toContain('已经写了')
    expect(parsed.warnings.filter((text) => text.includes('.sprite')).length).toBe(1)
  })

  /**
   * 第十三轮 P0-3：分档判反过一次，这条锁住的是**修正后的判据**。
   *
   * 场景 / prefab / 资产清单的信封**不是**温和档：它们的已知键是 `entities` / `components` /
   * `assets` / `extends` / `meta`，全是最会变成画面的。第十二轮手写的
   * `consequential: false` 让「模型把整份内容写在信封的错名键下」只收到一句
   * 「它既不影响画面也不影响行为」——比更早那句「可以忽略」更肯定，而且是错的。
   */
  test('警告分档由已知键推导：投影层看得见的每一层都说「不会生效」，含三种清单信封', () => {
    const consequential = parseGameSceneManifest({
      id: 'tiers',
      entities: [{ id: 'hero', components: { physics: { mass: 3 } } }],
    })
    const componentWarning = consequential.warnings.find((text) => text.includes('.physics'))
    expect(componentWarning).toContain('不会生效')
    expect(componentWarning).toContain('实体组件表只读')
    expect(componentWarning).not.toContain('可以忽略')

    // 场景信封：整份内容写在错名键下，必须说「不会生效」。
    const sceneEnvelope = parseGameSceneManifest({
      id: 'tiers2',
      objects: [{ id: 'hero' }],
      entities: [],
    }).warnings.find((text) => text.includes('$.objects'))
    expect(sceneEnvelope).toContain('不会生效')
    expect(sceneEnvelope).toContain('场景清单信封只读')
    expect(sceneEnvelope).not.toContain('不影响画面')

    const prefabEnvelope = parseGamePrefabManifest({
      id: 'tiers3',
      parts: { visual: {} },
      components: {},
    }).warnings.find((text) => text.includes('$.parts'))
    expect(prefabEnvelope).toContain('不会生效')

    const assetsEnvelope = parseGameAssetsManifest({
      resources: [{ id: 'hero' }],
      assets: [],
    }).warnings.find((text) => text.includes('$.resources'))
    expect(assetsEnvelope).toContain('不会生效')
  })

  test('kind 已定的 visual 按该形态收窄：sprite 上的 width 会被点名', () => {
    const parsed = parseGameSceneManifest({
      id: 'narrow',
      entities: [{
        id: 'hero',
        components: { visual: { kind: 'sprite', asset: 'asset:hero', width: 64 } },
      }],
    })
    const warning = parsed.warnings.find((text) => text.includes('visual.width'))
    expect(warning).toContain('不会生效')
    expect(warning).toContain('visual 组件只读')
  })

  test('script.params 是给玩法代码的纯数据，绝不下探报未知', () => {
    const parsed = parseGameSceneManifest({
      id: 'params',
      entities: [{
        id: 'hero',
        components: {
          script: { module: 'src/systems/hero.js', params: { anythingGoes: 1, nested: { a: 2 } } },
        },
      }],
    })
    expect(parsed.warnings).toEqual([])
  })

  test('场景顶层写 gravity / background 时搬进 meta', () => {
    const parsed = parseGameSceneManifest({
      id: 'meta-stray',
      gravity: { y: 900 },
      background: '#101018',
      entities: [],
    })
    expect(parsed.value.meta).toEqual({ gravity: { y: 900 }, background: '#101018' })
    expect(adjustmentFor(parsed, '$.meta.gravity')?.action).toBe('aliased')
  })
})

/**
 * 第十三轮（对抗终验第一手）：**解析器读不懂的形状，可以不理解，但不许把它变没。**
 *
 * 病灶链：`recordOrEmpty` / `normalizedStringArray` 把读不懂的值静默摊成 `{}` / `[]`，
 * 而清单编辑器写盘写的是解析后的值——一次带真实 operation 的 `game:scene_edit` 会把这份丢弃
 * **写回磁盘**。ECS 风 `components: [...]` 变成 `{}`（实体不可见、`errors 0`、连空画面信号都不报，
 * 因为组件表是空的、没有闭集外键当证据）；按 id 分组的 `entities: {...}` 整份消失，
 * `diffSummary` 一个字不提删除。
 *
 * 出口只有两个：**归一并留痕**，或者**大声失败**。
 */
describe('game manifest shape fidelity (round 13)', () => {
  const adjustmentFor = (result, field) =>
    result.appliedAdjustments.find((item) => item.field === field)

  test('ECS 风组件数组归一成组件表，内容一条不丢（P0-1）', () => {
    const parsed = parseGameSceneManifest({
      id: 'ecs',
      entities: [{
        id: 'player',
        components: [
          { type: 'transform', position: { x: 100, y: 200 } },
          { type: 'sprite', width: 32, height: 48, color: '#3b82f6' },
          { component: 'collider', width: 32, height: 48, layer: 'player' },
        ],
      }],
    }, 'scenes/ecs.scene.json')

    const components = parsed.value.entities[0]?.components
    expect(components?.transform).toEqual({ position: { x: 100, y: 200 } })
    // 判别值原样交给别名归一：`sprite` → `visual`，尺寸+色值再推断出 shape。
    expect(components?.visual).toEqual({
      width: 32,
      height: 48,
      color: '#3b82f6',
      kind: 'shape',
      shape: 'rect',
    })
    expect(components?.body).toEqual({ width: 32, height: 48, layer: 'player' })
    expect(adjustmentFor(parsed, '$.entities[0].components')?.action).toBe('aliased')
  })

  test('ECS 数组读不懂时抛，绝不摊成空组件表（P0-1）', () => {
    const cases = [
      // 条目不说自己是哪个组件
      [{ position: { x: 1 } }, '没有说自己是哪个组件'],
      // 自称一个不存在的组件
      [{ type: 'physics', mass: 3 }, '本运行时不认识它'],
      // 同一个名字写两次：组件表按名字索引，必然有一条被盖掉
      [{ type: 'visual', text: 'a' }, '出现了两次'],
    ]
    for (const [item, expected] of cases) {
      const entities = [{ id: 'hero', components: [{ type: 'visual', text: 'x' }, item] }]
      expect(() => parseGameSceneManifest({ id: 'bad-ecs', entities })).toThrow(expected)
    }

    // 别名与 canonical 各写一条**不抛**：两把键都留在盘上，与 components:{sprite,visual}
    // 逐字同一档（那句「两个都写了，一份都没合并」）。
    const both = parseGameSceneManifest({
      id: 'alias-pair',
      entities: [{
        id: 'hero',
        components: [
          { type: 'visual', kind: 'shape', shape: 'rect', width: 10, height: 10 },
          { type: 'sprite', color: '#fff' },
        ],
      }],
    })
    expect(both.value.entities[0]?.components?.visual?.width).toBe(10)
    expect(both.value.entities[0]?.components?.sprite).toEqual({ color: '#fff' })
    expect(both.warnings.find((text) => text.includes('.sprite'))).toContain('已经写了')
    // 判别键不是字符串的条目同样抛，不静默跳过
    expect(() => parseGameSceneManifest({
      id: 'bad-ecs2',
      entities: [{ id: 'hero', components: ['transform'] }],
    })).toThrow('解析器读不出')
  })

  test('按 id 分组的 entities / assets 归一成数组，键写进 id（P0-2）', () => {
    const scene = parseGameSceneManifest({
      id: 'keyed',
      entities: {
        player: { components: { visual: { kind: 'text', text: 'hi' } } },
        ground: { id: 'ground', components: {} },
      },
    })
    expect(scene.value.entities.map((entity) => entity.id)).toEqual(['player', 'ground'])
    expect(scene.value.entities[0]?.components?.visual?.text).toBe('hi')
    expect(adjustmentFor(scene, '$.entities')?.action).toBe('aliased')

    const assets = parseGameAssetsManifest({
      assets: { hero: { kind: 'texture', path: 'assets/hero.png' } },
    })
    expect(assets.value.assets).toEqual([
      { id: 'hero', kind: 'texture', path: 'assets/hero.png' },
    ])
  })

  test('键与条目自报的 id 打架时不替作者挑一个（P0-2）', () => {
    expect(() => parseGameSceneManifest({
      id: 'clash',
      entities: { player: { id: 'hero', components: {} } },
    })).toThrow('对不上')
  })

  test('条目里接不住键的位置一律抛，不静默丢键（P0-2）', () => {
    // scenes / prefabs 是裸路径数组：对象的键没有任何一格能承载
    expect(() => parseGameProjectManifest({
      name: 'p',
      scenes: { main: 'scenes/main.scene.json' },
    })).toThrow('解析器读不出')
    // tags / collidesWith / layers / input.actions 同形
    expect(() => parseGameSceneManifest({
      id: 'tags',
      entities: [{ id: 'hero', components: { tags: { player: true } } }],
    })).toThrow('解析器读不出')
    expect(() => parseGameProjectManifest({ name: 'p', layers: 3 })).toThrow('解析器读不出')
  })

  test('带内容的非对象值落在键值表位置上时抛，不摊成 {}（P0-1）', () => {
    expect(() => parseGameProjectManifest({ name: 'p', runtime: [{ pixelArt: false }] }))
      .toThrow('解析器读不出')
    expect(() => parseGameProjectManifest({ name: 'p', input: 'keyboard' }))
      .toThrow('解析器读不出')
    // 清单根不是对象 = 读不懂，不是半成品
    expect(() => parseGameSceneManifest([{ id: 'hero' }], 'scenes/x.scene.json'))
      .toThrow('顶层必须是一个 JSON 对象')
  })

  test('不带内容的三种形状仍然静默收下（缺席 / null / 空容器）', () => {
    const scene = parseGameSceneManifest({ id: 'empty', entities: {} })
    expect(scene.value.entities).toEqual([])
    const prefab = parseGamePrefabManifest({ id: 'blank', components: [] })
    expect(prefab.value.components).toEqual({})
    const project = parseGameProjectManifest({
      name: 'p',
      prefabs: null,
      dev: [],
      input: { actions: null },
    })
    expect(project.value.prefabs).toEqual([])
    expect(project.value.input.actions).toEqual({})
  })

  test('路径条目里带着接不住的键时不降回字符串（自查补洞）', () => {
    // 冗余复述（id === 文件名推出来的 slug）仍然收下：丢掉它不损失任何信息。
    const redundant = parseGameProjectManifest({
      name: 'p',
      scenes: [{ id: 'main', path: 'scenes/main.scene.json' }],
    })
    expect(redundant.value.scenes).toEqual(['scenes/main.scene.json'])
    // 带着真内容（或对不上的 id）就抛：降回字符串等于把它们丢掉。
    expect(() => parseGameProjectManifest({
      name: 'p',
      scenes: [{ path: 'scenes/main.scene.json', preload: true }],
    })).toThrow('只装工程内相对路径')
    expect(() => parseGameProjectManifest({
      name: 'p',
      scenes: [{ id: 'level-one', path: 'scenes/main.scene.json' }],
    })).toThrow('只装工程内相对路径')
  })

  test('组件槽读不懂时抛我们自己那句话，而不是 zod 的裸「Invalid input」（自查补洞）', () => {
    // 判别联合上 zod 只会回一句 `$.…visual：Invalid input`——连收到了什么都不说。
    expect(() => parseGameSceneManifest({
      id: 'slot',
      entities: [{ id: 'a', components: { visual: 'red box' } }],
    })).toThrow('是字符串 "red box"')
    expect(() => parseGameSceneManifest({
      id: 'slot2',
      entities: [{ id: 'a', components: { transform: [1, 2] } }],
    })).toThrow('是一个 2 项的数组')
  })

  test('显式 null 的组件槽原样透传：「清掉继承来的它」不许被归一吞掉', () => {
    const parsed = parseGameSceneManifest({
      id: 'clear',
      extends: 'scene:base',
      entities: [{ id: 'a', components: { visual: null, body: null } }],
    })
    expect(parsed.value.entities[0]?.components?.visual).toBeNull()
    expect(parsed.value.entities[0]?.components?.body).toBeNull()
  })

  test('animation.clips 也收按 name 分组的对象（同一个机械家族）', () => {
    const parsed = parseGameSceneManifest({
      id: 'clips',
      entities: [{
        id: 'hero',
        components: {
          animation: { clips: { walk: { asset: 'asset:hero', fps: 8 } }, autoPlay: 'walk' },
        },
      }],
    })
    expect(parsed.value.entities[0]?.components?.animation?.clips).toEqual([
      { name: 'walk', asset: 'asset:hero', fps: 8 },
    ])
  })
})
