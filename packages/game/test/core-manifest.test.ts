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

    const incompleteScene = parseGameSceneManifest({
      id: 'incomplete-visual',
      entities: [{
        id: 'orphan',
        components: {
          visual: { color: '#ffffff' },
        },
      }],
    }).value
    expect(() => validateGameManifestSourceSet({
      project: { ...project, entryScene: 'scene:incomplete-visual' },
      scenes: [incompleteScene],
      prefabs: [],
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
