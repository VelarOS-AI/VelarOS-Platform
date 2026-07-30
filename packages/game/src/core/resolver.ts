import { buildValidItemsHint } from '@velaros-ai/core/utils/ForgivingSchema'

import { GameManifestError } from './manifest-parser.js'
import {
  type GameReference,
  gameReferenceId,
} from './references.js'
import {
  type GameAssetManifest,
  type GameAssetsManifest,
  type GameComponentMap,
  type GameEntityManifest,
  type GamePrefabManifest,
  type GameProjectManifest,
  type GameSceneManifest,
  GameVisualComponentSchema,
} from './schemas.js'

export interface GameManifestSourceSet {
  readonly project: GameProjectManifest
  readonly scenes: readonly GameSceneManifest[]
  readonly prefabs: readonly GamePrefabManifest[]
  readonly assets: GameAssetsManifest
}

export interface GameResolvedEntity {
  readonly [key: string]: unknown
  readonly id: string
  readonly from?: GameReference<'prefab'> | null
  readonly parent?: GameReference<'entity'> | null
  readonly notes?: string
  readonly components: GameComponentMap
}

export interface GameResolvedScene {
  readonly [key: string]: unknown
  readonly id: string
  readonly kind: 'scene'
  readonly extends: null
  readonly meta?: GameSceneManifest['meta']
  readonly entities: readonly GameResolvedEntity[]
  readonly notes?: string
}

const MaxInheritanceDepth = 4

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, cloneValue(nested)]))
}

export function applyGameMergePatch(base: unknown, patch: unknown, depth = 0): unknown {
  if (patch === null) return undefined
  if (Array.isArray(patch)) return patch.map(cloneValue)
  if (!isRecord(patch)) return cloneValue(patch)
  // scene → entity → components → component value-object 需要保留到 position.x 这一层；
  // 再深的对象（如任意 script params）整体替换，避免发明不可预测的递归合并语义。
  if (!isRecord(base) || depth > 3) return cloneValue(patch)

  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const next = applyGameMergePatch(merged[key], value, depth + 1)
    if (next === undefined) delete merged[key]
    else merged[key] = next
  }
  return merged
}

function indexUnique<T extends { readonly id: string }>(
  items: readonly T[],
  label: string,
): Map<string, T> {
  const index = new Map<string, T>()
  for (const item of items) {
    if (index.has(item.id)) {
      throw new GameManifestError(
        'INVALID_MANIFEST',
        `${label} id 重复：${item.id}。稳定 slug 在同一命名空间内必须唯一。`,
      )
    }
    index.set(item.id, item)
  }
  return index
}

function assertUniqueNames(values: readonly string[], label: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) {
      throw new GameManifestError(
        'INVALID_MANIFEST',
        `${label} 重复声明 ${value}；同一命名空间内必须唯一。`,
      )
    }
    seen.add(value)
  }
}

function missingReference(
  kind: string,
  reference: GameReference,
  validIds: readonly string[],
): never {
  throw new GameManifestError(
    'INVALID_REFERENCE',
    `找不到 ${reference}。`,
    { hint: buildValidItemsHint(`可用 ${kind} id`, validIds) },
  )
}

function assertKnownSlug(value: string | null | undefined, valid: ReadonlySet<string>, path: string): void {
  if (value === null || value === undefined || valid.has(value)) return
  throw new GameManifestError(
    'INVALID_REFERENCE',
    `${path} 引用了未声明的名称 ${value}。`,
    { hint: buildValidItemsHint('可用名称', [...valid]) },
  )
}

function assetReferences(components: GameComponentMap): string[] {
  const references: Array<GameReference<'asset'>> = []
  const visual = components.visual
  if (visual && typeof visual.asset === 'string') {
    references.push(visual.asset as GameReference<'asset'>)
  }
  if (visual?.kind === 'text' && visual.font) references.push(visual.font)
  const animation = components.animation
  if (animation) references.push(...animation.clips.map((clip) => clip.asset))
  return references.map((reference) => gameReferenceId(reference))
}

function applyResolvedDefaults(
  components: GameComponentMap,
  project: GameProjectManifest,
): GameComponentMap {
  const transform = isRecord(components.transform) ? components.transform : {}
  const position = isRecord(transform.position) ? transform.position : {}
  const scale = isRecord(transform.scale) ? transform.scale : {}
  const defaults: GameComponentMap = {
    transform: {
      ...transform,
      position: { x: 0, y: 0, ...position },
      rotation: transform.rotation ?? 0,
      scale: { x: 1, y: 1, ...scale },
    },
    tags: components.tags ?? [],
    layer: components.layer ?? project.layers[0],
    order: components.order ?? 0,
  }
  if (components.body) {
    defaults.body = {
      kind: 'static',
      shape: 'rect',
      gravityScale: 1,
      ...components.body,
    }
  }
  if (components.camera) {
    defaults.camera = {
      kind: 'fixed',
      ...components.camera,
    }
  }
  if (components.visual?.kind === 'sprite') {
    defaults.visual = {
      anchor: 'center',
      ...components.visual,
    }
  }
  return applyGameMergePatch(defaults, components) as GameComponentMap
}

export class GameManifestResolver {
  private readonly sceneIndex: ReadonlyMap<string, GameSceneManifest>
  private readonly prefabIndex: ReadonlyMap<string, GamePrefabManifest>
  private readonly assetIndex: ReadonlyMap<string, GameAssetManifest>
  private readonly sceneCache = new Map<string, GameResolvedScene>()
  private readonly prefabCache = new Map<string, GameComponentMap>()

  public constructor(private readonly source: GameManifestSourceSet) {
    this.sceneIndex = indexUnique(source.scenes, 'scene')
    this.prefabIndex = indexUnique(source.prefabs, 'prefab')
    this.assetIndex = indexUnique(source.assets.assets, 'asset')
  }

  public validate(): void {
    assertUniqueNames(this.source.project.scenes, 'scene manifest path')
    assertUniqueNames(this.source.project.prefabs, 'prefab manifest path')
    assertUniqueNames(this.source.project.layers, 'render layer')
    assertUniqueNames(this.source.project.collisionLayers, 'collision layer')
    if (this.source.project.collisionLayers.length > 31) {
      throw new GameManifestError(
        'INVALID_MANIFEST',
        'collisionLayers 最多 31 个；Arcade Physics 投影需要把具名层映射到 32-bit category。',
        { hint: '合并语义重复的碰撞层；清单仍只引用名字，不要手写 bitmask。' },
      )
    }
    if (this.source.project.entryScene) {
      this.requireScene(gameReferenceId(this.source.project.entryScene))
    }
    for (const scene of this.source.scenes) {
      indexUnique(scene.entities, `scene:${scene.id} entity`)
      this.resolveScene(scene.id)
    }
    for (const prefab of this.source.prefabs) this.resolvePrefab(prefab.id)

    const collisionLayers = new Set(this.source.project.collisionLayers)
    const renderLayers = new Set(this.source.project.layers)
    for (const prefab of this.source.prefabs) {
      this.validateComponents(
        this.resolvePrefab(prefab.id),
        `prefab:${prefab.id}.components`,
        renderLayers,
        collisionLayers,
      )
    }
    for (const scene of this.sceneCache.values()) {
      const entityIds = new Set(scene.entities.map((entity) => entity.id))
      for (const entity of scene.entities) {
        if (entity.parent) {
          assertKnownSlug(
            gameReferenceId(entity.parent),
            entityIds,
            `scene:${scene.id}/entity:${entity.id}.parent`,
          )
        }
        this.validateComponents(
          entity.components,
          `scene:${scene.id}/entity:${entity.id}.components`,
          renderLayers,
          collisionLayers,
          entityIds,
        )
      }
      this.assertAcyclicParents(scene)
    }

    for (const asset of this.source.assets.assets) {
      if (asset.kind === 'tilemap') {
        if (!asset.tileset) {
          throw new GameManifestError(
            'INVALID_MANIFEST',
            `tilemap 资产 asset:${asset.id} 缺少 tileset 引用。`,
          )
        }
        const tilesetId = gameReferenceId(asset.tileset)
        this.requireAssetKind(
          tilesetId,
          ['spritesheet', 'texture'],
          `asset:${asset.id}.tileset`,
        )
      }
    }
  }

  private validateComponents(
    components: GameComponentMap,
    path: string,
    renderLayers: ReadonlySet<string>,
    collisionLayers: ReadonlySet<string>,
    entityIds?: ReadonlySet<string>,
  ): void {
    const visualResult = components.visual
      ? GameVisualComponentSchema.safeParse(components.visual)
      : null
    if (visualResult && !visualResult.success) {
      const issue = visualResult.error.issues[0]
      throw new GameManifestError(
        'INVALID_MANIFEST',
        `${path}.visual 在继承合并后仍不完整：${issue?.message ?? '无法解析 visual。'}`,
        {
          path: [path, 'visual', ...(issue?.path ?? [])].join('.'),
          hint: '在 prefab 或实体补丁合并后，visual 必须具备对应 kind 的全部必填字段。',
        },
      )
    }
    const visual = visualResult?.data
    for (const assetId of assetReferences(components)) {
      if (!this.assetIndex.has(assetId)) {
        missingReference('asset', `asset:${assetId}`, [...this.assetIndex.keys()])
      }
    }
    assertKnownSlug(components.layer, renderLayers, `${path}.layer`)
    if (components.body) {
      assertKnownSlug(components.body.layer, collisionLayers, `${path}.body.layer`)
      for (const layer of components.body.collidesWith ?? []) {
        assertKnownSlug(layer, collisionLayers, `${path}.body.collidesWith`)
      }
    }
    if (visual?.kind === 'sprite') {
      this.requireAssetKind(
        gameReferenceId(visual.asset),
        ['spritesheet', 'texture'],
        `${path}.visual.asset`,
      )
    } else if (visual?.kind === 'mesh') {
      this.requireAssetKind(
        gameReferenceId(visual.asset),
        ['mesh'],
        `${path}.visual.asset`,
      )
    } else if (
      visual?.kind === 'text' &&
      visual.font
    ) {
      this.requireAssetKind(
        gameReferenceId(visual.font),
        ['font'],
        `${path}.visual.font`,
      )
    }
    if (components.animation) {
      const clipNames = components.animation.clips.map((clip) => clip.name)
      assertUniqueNames(clipNames, `${path}.animation clip`)
      for (const clip of components.animation.clips) {
        this.requireAssetKind(
          gameReferenceId(clip.asset),
          ['spritesheet'],
          `${path}.animation.clips.${clip.name}.asset`,
        )
      }
      if (
        components.animation.autoPlay &&
        !clipNames.includes(components.animation.autoPlay)
      ) {
        throw new GameManifestError(
          'INVALID_REFERENCE',
          `${path}.animation.autoPlay 引用了未声明的 clip ${components.animation.autoPlay}。`,
          { hint: buildValidItemsHint('可用 clip', clipNames) },
        )
      }
    }
    if (components.camera?.target && entityIds) {
      assertKnownSlug(
        gameReferenceId(components.camera.target),
        entityIds,
        `${path}.camera.target`,
      )
    }
  }

  private requireAssetKind(
    assetId: string,
    expectedKinds: ReadonlyArray<GameAssetManifest['kind']>,
    path: string,
  ): GameAssetManifest {
    const asset = this.assetIndex.get(assetId)
    if (!asset) return missingReference('asset', `asset:${assetId}`, [...this.assetIndex.keys()])
    if (!expectedKinds.includes(asset.kind)) {
      throw new GameManifestError(
        'INVALID_REFERENCE',
        `${path} 需要 ${expectedKinds.join(' | ')} 资产，但 asset:${assetId} 是 ${asset.kind}。`,
      )
    }
    return asset
  }

  private assertAcyclicParents(scene: GameResolvedScene): void {
    const parents = new Map(
      scene.entities.flatMap((entity) => (
        entity.parent
          ? [[entity.id, gameReferenceId(entity.parent)] as const]
          : []
      )),
    )
    for (const entity of scene.entities) {
      const chain: string[] = []
      const seen = new Set<string>()
      let current: string | undefined = entity.id
      while (current !== undefined) {
        if (seen.has(current)) {
          const cycleStart = chain.indexOf(current)
          const cycle = [...chain.slice(cycleStart), current]
          throw new GameManifestError(
            'INVALID_REFERENCE',
            `scene:${scene.id} 的 parent 引用成环：${cycle.map((id) => `entity:${id}`).join(' → ')}。`,
          )
        }
        seen.add(current)
        chain.push(current)
        current = parents.get(current)
      }
    }
  }

  public resolveEntryScene(): GameResolvedScene | null {
    const reference = this.source.project.entryScene
    return reference ? this.resolveScene(gameReferenceId(reference)) : null
  }

  public resolveScene(id: string, chain: readonly string[] = []): GameResolvedScene {
    const cached = this.sceneCache.get(id)
    if (cached) return cached
    this.assertInheritanceStep(`scene:${id}`, chain)

    const manifest = this.requireScene(id)
    const nextChain = [...chain, `scene:${id}`]
    const inherited = manifest.extends
      ? this.resolveScene(gameReferenceId(manifest.extends), nextChain)
      : null
    const entityOrder: string[] = inherited ? inherited.entities.map((entity) => entity.id) : []
    const entities = new Map(
      inherited?.entities.map((entity) => [entity.id, entity as GameEntityManifest]) ?? [],
    )

    for (const patch of manifest.entities) {
      if (patch.remove) {
        entities.delete(patch.id)
        const index = entityOrder.indexOf(patch.id)
        if (index >= 0) entityOrder.splice(index, 1)
        continue
      }
      const existing = entities.get(patch.id)
      entities.set(
        patch.id,
        applyGameMergePatch(existing ?? {}, patch) as GameEntityManifest,
      )
      if (!existing) entityOrder.push(patch.id)
    }

    const resolvedEntities = entityOrder.map((entityId) => {
      const entity = entities.get(entityId)
      if (!entity) {
        throw new GameManifestError('INVALID_MANIFEST', `实体顺序索引丢失：${entityId}。`)
      }
      const prefabComponents = entity.from
        ? this.resolvePrefab(gameReferenceId(entity.from))
        : {}
      const components = applyResolvedDefaults(
        applyGameMergePatch(
          prefabComponents,
          entity.components ?? {},
        ) as GameComponentMap,
        this.source.project,
      )
      const { remove: _remove, ...entityWithoutRemove } = entity
      return { ...entityWithoutRemove, components }
    })

    const resolved: GameResolvedScene = {
      ...inherited,
      ...manifest,
      extends: null,
      meta: applyGameMergePatch(
        inherited?.meta ?? {},
        manifest.meta ?? {},
      ) as GameSceneManifest['meta'],
      entities: resolvedEntities,
    }
    this.sceneCache.set(id, resolved)
    return resolved
  }

  public resolvePrefab(id: string, chain: readonly string[] = []): GameComponentMap {
    const cached = this.prefabCache.get(id)
    if (cached) return cached
    this.assertInheritanceStep(`prefab:${id}`, chain)

    const manifest = this.requirePrefab(id)
    const nextChain = [...chain, `prefab:${id}`]
    const inherited = manifest.extends
      ? this.resolvePrefab(gameReferenceId(manifest.extends), nextChain)
      : {}
    const resolved = applyGameMergePatch(
      inherited,
      manifest.components,
    ) as GameComponentMap
    this.prefabCache.set(id, resolved)
    return resolved
  }

  private assertInheritanceStep(reference: string, chain: readonly string[]): void {
    if (chain.includes(reference)) {
      throw new GameManifestError(
        'INHERITANCE_CYCLE',
        `继承成环：${[...chain, reference].join(' → ')}`,
      )
    }
    if (chain.length >= MaxInheritanceDepth) {
      throw new GameManifestError(
        'INHERITANCE_DEPTH',
        `继承深度超过 ${MaxInheritanceDepth}：${[...chain, reference].join(' → ')}`,
      )
    }
  }

  private requireScene(id: string): GameSceneManifest {
    const scene = this.sceneIndex.get(id)
    return scene ?? missingReference('scene', `scene:${id}`, [...this.sceneIndex.keys()])
  }

  private requirePrefab(id: string): GamePrefabManifest {
    const prefab = this.prefabIndex.get(id)
    return prefab ?? missingReference('prefab', `prefab:${id}`, [...this.prefabIndex.keys()])
  }
}

export function validateGameManifestSourceSet(source: GameManifestSourceSet): GameManifestResolver {
  const resolver = new GameManifestResolver(source)
  resolver.validate()
  return resolver
}
