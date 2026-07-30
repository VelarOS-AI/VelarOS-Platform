import { z } from 'zod'

import {
  createGameReferenceSchema,
  GameProjectRelativePathSchema,
  type GameReference,
  GameSlugSchema,
} from './references.js'

const SceneReferenceSchema = createGameReferenceSchema('scene')
const PrefabReferenceSchema = createGameReferenceSchema('prefab')
const EntityReferenceSchema = createGameReferenceSchema('entity')
const AssetReferenceSchema = createGameReferenceSchema('asset')
const VisualAnchorSchema = z.enum([
  'center',
  'top-left',
  'top',
  'top-right',
  'left',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
])
const VisualKindSchema = z.enum(['sprite', 'mesh', 'text', 'shape'])

const NullableNumberSchema = z.number().finite().nullable().optional()
const Vector2PatchSchema = z.looseObject({
  x: NullableNumberSchema,
  y: NullableNumberSchema,
})
const Vector3PatchSchema = z.looseObject({
  x: NullableNumberSchema,
  y: NullableNumberSchema,
  z: NullableNumberSchema,
})

export const GameTransformComponentSchema = z.looseObject({
  position: Vector3PatchSchema.nullable().optional(),
  rotation: z.union([z.number().finite(), Vector3PatchSchema]).nullable().optional(),
  scale: Vector3PatchSchema.nullable().optional(),
})

const SpriteVisualSchema = z.looseObject({
  kind: z.literal('sprite'),
  asset: AssetReferenceSchema,
  anchor: VisualAnchorSchema.nullable().optional(),
})
const MeshVisualSchema = z.looseObject({
  kind: z.literal('mesh'),
  asset: AssetReferenceSchema,
})
const TextVisualSchema = z.looseObject({
  kind: z.literal('text'),
  text: z.string(),
  font: AssetReferenceSchema.nullable().optional(),
  color: z.string().nullable().optional(),
  size: z.number().positive().nullable().optional(),
})
const ShapeVisualSchema = z.looseObject({
  kind: z.literal('shape'),
  shape: z.enum(['circle', 'ellipse', 'rect', 'rounded-rect', 'triangle']),
  width: z.number().positive().nullable().optional(),
  height: z.number().positive().nullable().optional(),
  radius: z.number().positive().nullable().optional(),
  color: z.string().nullable().optional(),
})

export const GameVisualComponentSchema = z.discriminatedUnion('kind', [
  SpriteVisualSchema,
  MeshVisualSchema,
  TextVisualSchema,
  ShapeVisualSchema,
])
const GameVisualComponentPatchSchema = z.looseObject({
  kind: VisualKindSchema.optional(),
  asset: AssetReferenceSchema.optional(),
  mesh: AssetReferenceSchema.optional(),
  anchor: VisualAnchorSchema.nullable().optional(),
  text: z.string().optional(),
  font: AssetReferenceSchema.nullable().optional(),
  color: z.string().nullable().optional(),
  size: z.number().positive().nullable().optional(),
  shape: z.enum(['circle', 'ellipse', 'rect', 'rounded-rect', 'triangle']).optional(),
  width: z.number().positive().nullable().optional(),
  height: z.number().positive().nullable().optional(),
  radius: z.number().positive().nullable().optional(),
})

export const GameBodyComponentSchema = z.looseObject({
  kind: z.enum(['static', 'dynamic', 'kinematic']).optional(),
  shape: z.enum(['circle', 'rect', 'capsule']).nullable().optional(),
  width: z.number().positive().nullable().optional(),
  height: z.number().positive().nullable().optional(),
  radius: z.number().positive().nullable().optional(),
  gravityScale: z.number().finite().nullable().optional(),
  layer: GameSlugSchema.nullable().optional(),
  collidesWith: z.array(GameSlugSchema).nullable().optional(),
})

export const GameCameraComponentSchema = z.looseObject({
  kind: z.enum(['fixed', 'follow', 'orthographic', 'perspective']).optional(),
  target: EntityReferenceSchema.nullable().optional(),
  lerp: z.number().min(0).max(1).nullable().optional(),
})

const AnimationClipSchema = z.looseObject({
  name: GameSlugSchema,
  asset: AssetReferenceSchema,
  fps: z.number().int().min(1).max(240).optional(),
  loop: z.boolean().optional(),
})

export const GameAnimationComponentSchema = z.looseObject({
  clips: z.array(AnimationClipSchema),
  autoPlay: GameSlugSchema.nullable().optional(),
})

export const GameScriptComponentSchema = z.looseObject({
  module: GameProjectRelativePathSchema.nullable().optional(),
  params: z.record(z.string(), z.unknown()).nullable().optional(),
})

export const GameComponentMapSchema = z.looseObject({
  transform: GameTransformComponentSchema.nullable().optional(),
  visual: z.union([
    GameVisualComponentSchema,
    GameVisualComponentPatchSchema,
  ]).nullable().optional(),
  body: GameBodyComponentSchema.nullable().optional(),
  camera: GameCameraComponentSchema.nullable().optional(),
  animation: GameAnimationComponentSchema.nullable().optional(),
  script: GameScriptComponentSchema.nullable().optional(),
  tags: z.array(GameSlugSchema).nullable().optional(),
  layer: GameSlugSchema.nullable().optional(),
  order: z.number().int().min(-100_000).max(100_000).nullable().optional(),
})

export const GameEntityManifestSchema = z.looseObject({
  id: GameSlugSchema,
  from: PrefabReferenceSchema.nullable().optional(),
  parent: EntityReferenceSchema.nullable().optional(),
  remove: z.boolean().optional(),
  components: GameComponentMapSchema.optional(),
  notes: z.string().optional(),
})

export const GameSceneManifestSchema = z.looseObject({
  id: GameSlugSchema,
  kind: z.literal('scene'),
  extends: SceneReferenceSchema.nullable(),
  meta: z.looseObject({
    title: z.string().optional(),
    background: z.string().optional(),
    gravity: Vector2PatchSchema.optional(),
  }).optional(),
  entities: z.array(GameEntityManifestSchema),
  notes: z.string().optional(),
})

export const GamePrefabManifestSchema = z.looseObject({
  id: GameSlugSchema,
  kind: z.literal('prefab'),
  extends: PrefabReferenceSchema.nullable(),
  components: GameComponentMapSchema,
  notes: z.string().optional(),
})

const AssetBaseSchema = z.looseObject({
  id: GameSlugSchema,
  path: GameProjectRelativePathSchema,
  notes: z.string().optional(),
})
const TextureAssetSchema = AssetBaseSchema.extend({ kind: z.literal('texture') })
const SpriteSheetAssetSchema = AssetBaseSchema.extend({
  kind: z.literal('spritesheet'),
  frame: z.looseObject({
    width: z.number().positive(),
    height: z.number().positive(),
    count: z.number().int().min(1).max(10_000).optional(),
  }),
})
const AudioAssetSchema = AssetBaseSchema.extend({ kind: z.literal('audio') })
const FontAssetSchema = AssetBaseSchema.extend({ kind: z.literal('font') })
const MeshAssetSchema = AssetBaseSchema.extend({ kind: z.literal('mesh') })
const TilemapAssetSchema = AssetBaseSchema.extend({
  kind: z.literal('tilemap'),
  tileset: AssetReferenceSchema,
})

export const GameAssetManifestSchema = z.discriminatedUnion('kind', [
  TextureAssetSchema,
  SpriteSheetAssetSchema,
  AudioAssetSchema,
  FontAssetSchema,
  MeshAssetSchema,
  TilemapAssetSchema,
])

export const GameAssetsManifestSchema = z.looseObject({
  assets: z.array(GameAssetManifestSchema),
  notes: z.string().optional(),
})

export const GameProjectManifestSchema = z.looseObject({
  name: GameSlugSchema,
  schemaChannel: z.literal('v0'),
  runtime: z.looseObject({
    profile: z.literal('web-2d'),
    canvas: z.looseObject({
      width: z.number().int().min(64).max(8192),
      height: z.number().int().min(64).max(8192),
    }),
    pixelArt: z.boolean(),
  }),
  entryScene: SceneReferenceSchema.nullable(),
  scenes: z.array(GameProjectRelativePathSchema),
  prefabs: z.array(GameProjectRelativePathSchema),
  assets: GameProjectRelativePathSchema,
  layers: z.array(GameSlugSchema).min(1),
  collisionLayers: z.array(GameSlugSchema),
  input: z.looseObject({
    actions: z.record(GameSlugSchema, z.array(z.string().trim().min(1))),
  }),
  dev: z.looseObject({
    server: z.looseObject({
      command: z.string().trim().min(1).optional(),
      readyText: z.string().trim().min(1).max(512).optional(),
      port: z.number().int().min(1).max(65_535).optional(),
    }).optional(),
    overlay: z.looseObject({
      colliders: z.boolean(),
      entityBounds: z.boolean(),
      logs: z.boolean(),
    }),
  }),
  notes: z.string().optional(),
})

export interface GameComponentMap {
  readonly [key: string]: unknown
  transform?: z.infer<typeof GameTransformComponentSchema> | null
  visual?: z.infer<typeof GameVisualComponentPatchSchema> | null
  body?: z.infer<typeof GameBodyComponentSchema> | null
  camera?: z.infer<typeof GameCameraComponentSchema> | null
  animation?: z.infer<typeof GameAnimationComponentSchema> | null
  script?: z.infer<typeof GameScriptComponentSchema> | null
  tags?: string[] | null
  layer?: string | null
  order?: number | null
}

export interface GameEntityManifest {
  readonly [key: string]: unknown
  id: string
  from?: GameReference<'prefab'> | null
  parent?: GameReference<'entity'> | null
  remove?: boolean
  components?: GameComponentMap
  notes?: string
}

export interface GameSceneManifest {
  readonly [key: string]: unknown
  id: string
  kind: 'scene'
  extends: GameReference<'scene'> | null
  meta?: {
    readonly [key: string]: unknown
    title?: string
    background?: string
    gravity?: { readonly [key: string]: unknown; x?: number | null; y?: number | null }
  }
  entities: GameEntityManifest[]
  notes?: string
}

export interface GamePrefabManifest {
  readonly [key: string]: unknown
  id: string
  kind: 'prefab'
  extends: GameReference<'prefab'> | null
  components: GameComponentMap
  notes?: string
}

export interface GameAssetManifest {
  readonly [key: string]: unknown
  id: string
  kind: 'audio' | 'font' | 'mesh' | 'spritesheet' | 'texture' | 'tilemap'
  path: string
  frame?: {
    readonly [key: string]: unknown
    width: number
    height: number
    count?: number
  }
  tileset?: GameReference<'asset'>
  notes?: string
}

export interface GameAssetsManifest {
  readonly [key: string]: unknown
  assets: GameAssetManifest[]
  notes?: string
}

export interface GameProjectManifest {
  readonly [key: string]: unknown
  name: string
  schemaChannel: 'v0'
  runtime: {
    readonly [key: string]: unknown
    profile: 'web-2d'
    canvas: {
      readonly [key: string]: unknown
      width: number
      height: number
    }
    pixelArt: boolean
  }
  entryScene: GameReference<'scene'> | null
  scenes: string[]
  prefabs: string[]
  assets: string
  layers: string[]
  collisionLayers: string[]
  input: {
    readonly [key: string]: unknown
    actions: Record<string, string[]>
  }
  dev: {
    readonly [key: string]: unknown
    server?: {
      readonly [key: string]: unknown
      command?: string
      readyText?: string
      port?: number
    }
    overlay: {
      readonly [key: string]: unknown
      colliders: boolean
      entityBounds: boolean
      logs: boolean
    }
  }
  notes?: string
}
