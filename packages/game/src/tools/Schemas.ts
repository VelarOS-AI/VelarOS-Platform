import { z } from 'zod'

import { isNotUndefined, isUndefined } from '@velaros-ai/core'
import {
  type AppliedAdjustment,
  clampedInt,
  inferActionFromFields,
} from '@velaros-ai/core/utils/ForgivingSchema'

import {
  createGameReferenceSchema,
  GameSlugSchema,
} from '../core/index.js'

const UnknownValuesSchema = z.record(z.string(), z.unknown())
const PrefabReferenceSchema = createGameReferenceSchema('prefab')
const SceneReferenceSchema = createGameReferenceSchema('scene')

function normalizeGameSlug(value: string): string {
  let normalized = value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  if (!normalized) normalized = 'capture'
  if (!/\p{L}/u.test(normalized)) normalized = `capture-${normalized}`
  return [...normalized]
    .slice(0, 120)
    .join('')
    .replace(/-+$/u, '') || 'capture'
}

export const GameManifestEditTargetSchema = z.union([
  z.literal('project'),
  z.literal('assets'),
  SceneReferenceSchema,
  PrefabReferenceSchema,
])

export const GameManifestEditOperationSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('set_entity'),
    entityId: GameSlugSchema,
    from: PrefabReferenceSchema.nullable().optional(),
    components: UnknownValuesSchema.optional(),
  }),
  z.object({
    action: z.literal('remove_entity'),
    entityId: GameSlugSchema,
  }),
  z.object({
    action: z.literal('rename_entity'),
    entityId: GameSlugSchema,
    newId: GameSlugSchema,
  }),
  z.object({
    action: z.literal('set_component'),
    entityId: GameSlugSchema.optional(),
    component: GameSlugSchema,
    values: UnknownValuesSchema,
  }),
  z.object({
    action: z.literal('remove_component'),
    entityId: GameSlugSchema.optional(),
    component: GameSlugSchema,
  }),
  z.object({
    action: z.literal('set_scene_meta'),
    values: UnknownValuesSchema,
  }),
  z.object({
    action: z.literal('set_extends'),
    // 裸 slug 也收：target 已经唯一确定了 scene / prefab，补前缀无歧义（编辑器负责归一并留痕）。
    // `null` 是真实意图（清除继承），所以是 nullable 而不是 optional——省略它没有安全的默认值。
    extends: z.union([SceneReferenceSchema, PrefabReferenceSchema, GameSlugSchema]).nullable(),
  }),
  z.object({
    action: z.literal('set_asset'),
    assetId: GameSlugSchema,
    values: UnknownValuesSchema,
  }),
  z.object({
    action: z.literal('remove_asset'),
    assetId: GameSlugSchema,
  }),
  z.object({
    action: z.literal('set_project'),
    values: UnknownValuesSchema,
  }),
])

export const GameSceneEditSchema = z.object({
  target: GameManifestEditTargetSchema,
  operations: z.array(GameManifestEditOperationSchema).max(
    200,
    '单次 game:scene_edit 最多接受 200 个语义操作；请按目标拆批。',
  ),
  reason: z.string().trim().min(1).optional(),
  dryRun: z.boolean().optional(),
})

export const GameRunSchema = z
  .object({
    scene: z.union([SceneReferenceSchema, GameSlugSchema]).optional(),
    restart: z.boolean().optional(),
    timeoutMs: clampedInt(1_000, 180_000).optional(),
  })
  .transform((input) => {
    const adjustments: AppliedAdjustment[] = []
    const scene = input.scene?.startsWith('scene:')
      ? input.scene
      : isUndefined(input.scene)
        ? undefined
        : `scene:${input.scene}`
    if (isNotUndefined(input.scene) && scene !== input.scene) {
      adjustments.push({
        field: 'scene',
        action: 'aliased',
        detail: `裸 scene slug 已归一为 ${scene}。`,
      })
    }
    return {
      ...input,
      scene,
      appliedAdjustments: adjustments,
    }
  })

export const GameStopSchema = z.object({
  force: z.boolean().optional(),
})

export const GameScreenshotSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .transform(normalizeGameSlug)
    .optional(),
  region: z
    .object({
      x: clampedInt(0, 16_384),
      y: clampedInt(0, 16_384),
      width: clampedInt(1, 16_384),
      height: clampedInt(1, 16_384),
    })
    .optional(),
  waitFrames: clampedInt(0, 120).optional(),
  overlay: z.boolean().optional(),
})

const ResolvedGameQueryStateSchema = z.union([
  z.object({ select: z.literal('scene') }),
  z.object({
    select: z.literal('entities'),
    limit: clampedInt(1, 200).optional(),
    offset: clampedInt(0, 1_000_000).optional(),
  }),
  z.object({
    select: z.literal('entity'),
    entityId: GameSlugSchema,
    components: z.array(GameSlugSchema).optional(),
  }),
  z.object({
    select: z.literal('errors'),
    limit: clampedInt(1, 200).optional(),
    offset: clampedInt(0, 1_000_000).optional(),
  }),
  z.object({ select: z.literal('perf') }),
])

export const GameQueryStateSchema = z
  .object({
    select: z
      .enum(['scene', 'entities', 'entity', 'errors', 'perf'])
      .optional(),
    entityId: GameSlugSchema.optional(),
    components: z.array(GameSlugSchema).optional(),
    limit: clampedInt(1, 200).optional(),
    offset: clampedInt(0, 1_000_000).optional(),
  })
  .transform((input) => ({
    ...input,
    select: input.select
      ?? inferActionFromFields(input, { entity: ['entityId'] })
      ?? 'scene',
  }))
  .pipe(ResolvedGameQueryStateSchema)

export const ValidGameInputStepSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('press'),
    logicalAction: GameSlugSchema,
    ms: clampedInt(0, 10_000).optional(),
  }),
  z.object({
    action: z.literal('key_down'),
    key: z.string().trim().min(1).max(64),
  }),
  z.object({
    action: z.literal('key_up'),
    key: z.string().trim().min(1).max(64),
  }),
  z.object({
    action: z.literal('tap'),
    x: z.number().finite(),
    y: z.number().finite(),
  }),
  z.object({
    action: z.literal('move'),
    x: z.number().finite(),
    y: z.number().finite(),
  }),
  z.object({
    action: z.literal('wait'),
    ms: clampedInt(0, 10_000),
  }),
])

export const GameInputSchema = z.object({
  // Keep the batch parseable even when one model-produced item is malformed;
  // Tools.ts validates each item independently and reports its original index.
  steps: z.array(z.unknown()).max(
    200,
    '单次 game:input 最多接受 200 个步骤；请拆分观察闭环。',
  ),
  repeat: clampedInt(1, 20).optional(),
  settleFrames: clampedInt(0, 120).optional(),
  captureAfter: z.boolean().optional(),
})
