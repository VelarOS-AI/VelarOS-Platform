import { type z } from 'zod'

import {
  type AppliedAdjustment,
  buildAppliedAdjustments,
} from '@velaros-ai/core/utils/ForgivingSchema'

import {
  type GameAssetsManifest,
  GameAssetsManifestSchema,
  type GameComponentMap,
  type GamePrefabManifest,
  GamePrefabManifestSchema,
  type GameProjectManifest,
  GameProjectManifestSchema,
  type GameSceneManifest,
  GameSceneManifestSchema,
} from './schemas.js'

export type GameManifestErrorCode =
  | 'INHERITANCE_CYCLE'
  | 'INHERITANCE_DEPTH'
  | 'INVALID_JSON'
  | 'INVALID_MANIFEST'
  | 'INVALID_REFERENCE'

export class GameManifestError extends Error {
  public readonly code: GameManifestErrorCode
  public readonly path: string | null
  public readonly hint: string | null

  public constructor(
    code: GameManifestErrorCode,
    message: string,
    options: { path?: string; hint?: string } = {},
  ) {
    super(message)
    this.name = 'GameManifestError'
    this.code = code
    this.path = options.path ?? null
    this.hint = options.hint ?? null
  }
}

export interface GameManifestParseResult<T> {
  readonly value: T
  readonly warnings: readonly string[]
  readonly appliedAdjustments: readonly AppliedAdjustment[]
}

interface NormalizationContext {
  adjustments: AppliedAdjustment[]
  warnings: string[]
}

const KnownComponentKeys = new Set([
  'animation',
  'body',
  'camera',
  'layer',
  'order',
  'script',
  'tags',
  'transform',
  'visual',
])
const KnownProjectKeys = new Set([
  'assets',
  'collisionLayers',
  'dev',
  'entryScene',
  'input',
  'layers',
  'name',
  'notes',
  'prefabs',
  'runtime',
  'scenes',
  'schemaChannel',
])
const KnownRuntimeKeys = new Set(['canvas', 'pixelArt', 'profile'])
const KnownCanvasKeys = new Set(['height', 'width'])
const KnownInputKeys = new Set(['actions'])
const KnownDevKeys = new Set(['overlay', 'server'])
const KnownServerKeys = new Set(['command', 'port', 'readyText'])
const KnownOverlayKeys = new Set(['colliders', 'entityBounds', 'logs'])
const KnownSceneKeys = new Set([
  'entities',
  'extends',
  'id',
  'kind',
  'meta',
  'notes',
])
const KnownPrefabKeys = new Set([
  'components',
  'extends',
  'id',
  'kind',
  'notes',
])
const KnownEntityKeys = new Set([
  'components',
  'from',
  'id',
  'notes',
  'parent',
  'remove',
])
const KnownAssetsManifestKeys = new Set(['assets', 'notes'])
const KnownAssetKeys = new Set([
  'frame',
  'id',
  'kind',
  'notes',
  'path',
  'tileset',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordOrEmpty(
  value: unknown,
  field: string,
  context: NormalizationContext,
): Record<string, unknown> {
  if (isRecord(value)) return value
  if (value !== undefined) {
    context.adjustments.push({
      field,
      action: 'ignored',
      detail: '非对象值无法无歧义解释，按空对象处理。',
    })
  }
  return {}
}

function defaulted<T>(
  value: T | undefined,
  fallback: T,
  field: string,
  context: NormalizationContext,
): T {
  if (value !== undefined) return value
  context.adjustments.push({
    field,
    action: 'defaulted',
    detail: `缺省值已补为 ${JSON.stringify(fallback)}。`,
  })
  return fallback
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function normalizedNumber(
  value: unknown,
  field: string,
  context: NormalizationContext,
  bounds?: readonly [number, number],
): unknown {
  const parsed = finiteNumber(value)
  if (parsed === undefined) return value
  const rounded = Math.round(parsed)
  const normalized = bounds
    ? Math.min(bounds[1], Math.max(bounds[0], rounded))
    : parsed
  if (normalized !== value) {
    context.adjustments.push({
      field,
      action: bounds && normalized !== rounded ? 'clamped' : 'aliased',
      detail: `${JSON.stringify(value)} 已归一为 ${normalized}。`,
    })
  }
  return normalized
}

function normalizedBoolean(
  value: unknown,
  field: string,
  context: NormalizationContext,
): unknown {
  if (typeof value === 'boolean') return value
  if (value !== 'true' && value !== 'false') return value
  const normalized = value === 'true'
  context.adjustments.push({
    field,
    action: 'aliased',
    detail: `字符串 ${JSON.stringify(value)} 已归一为布尔值 ${normalized}。`,
  })
  return normalized
}

function normalizedStringArray(
  value: unknown,
  field: string,
  context: NormalizationContext,
): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    context.adjustments.push({
      field,
      action: 'aliased',
      detail: '单个字符串已提升为单元素数组。',
    })
    return [value]
  }
  if (value !== undefined) {
    context.adjustments.push({
      field,
      action: 'ignored',
      detail: '无法解释为数组，按空数组处理。',
    })
  }
  return []
}

function warnUnknownKeys(
  value: Record<string, unknown>,
  known: ReadonlySet<string>,
  path: string,
  context: NormalizationContext,
): void {
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      context.warnings.push(`${path}.${key} 是当前运行时未知字段；已原样保留，但投影层可以忽略。`)
    }
  }
}

function normalizeComponents(
  value: unknown,
  path: string,
  context: NormalizationContext,
): Record<string, unknown> {
  const components = recordOrEmpty(value, path, context)
  warnUnknownKeys(components, KnownComponentKeys, path, context)
  const normalized = { ...components }

  if (isRecord(components.visual)) {
    const visual = { ...components.visual }
    if (visual.kind === undefined) {
      const candidates = [
        visual.asset === undefined ? null : 'sprite',
        visual.mesh === undefined ? null : 'mesh',
        visual.text === undefined ? null : 'text',
        visual.shape === undefined ? null : 'shape',
      ].filter((candidate): candidate is string => candidate !== null)
      if (candidates.length > 1) {
        throw new GameManifestError(
          'INVALID_MANIFEST',
          `${path}.visual.kind 无法唯一推断；候选为 ${candidates.join(', ')}。`,
          {
            path: `${path}.visual.kind`,
            hint: '显式填写 visual.kind，并只保留该 kind 对应的专属字段。',
          },
        )
      }
      if (candidates.length === 1) {
        visual.kind = candidates[0]
        context.adjustments.push({
          field: `${path}.visual.kind`,
          action: 'defaulted',
          detail: `由专属字段唯一推断为 ${candidates[0]}。`,
        })
      }
    }
    if (
      visual.kind === 'mesh' &&
      visual.asset === undefined &&
      typeof visual.mesh === 'string'
    ) {
      visual.asset = visual.mesh
      delete visual.mesh
      context.adjustments.push({
        field: `${path}.visual.asset`,
        action: 'aliased',
        detail: 'mesh 专属字段已归一为通用 asset 引用。',
      })
    }
    if (visual.size !== undefined) {
      visual.size = normalizedNumber(visual.size, `${path}.visual.size`, context)
    }
    normalized.visual = visual
  }

  if (isRecord(components.body)) {
    const body = { ...components.body }
    for (const key of ['width', 'height', 'radius', 'gravityScale'] as const) {
      if (body[key] !== undefined) {
        body[key] = normalizedNumber(body[key], `${path}.body.${key}`, context)
      }
    }
    if (body.collidesWith !== undefined) {
      body.collidesWith = normalizedStringArray(
        body.collidesWith,
        `${path}.body.collidesWith`,
        context,
      )
    }
    normalized.body = body
  }

  if (isRecord(components.camera)) {
    normalized.camera = { ...components.camera }
  }

  if (isRecord(components.animation)) {
    const clips = normalizedStringArray(
      components.animation.clips,
      `${path}.animation.clips`,
      context,
    ).map((clip, index) => {
      if (!isRecord(clip) || clip.fps === undefined) return clip
      return {
        ...clip,
        fps: normalizedNumber(
          clip.fps,
          `${path}.animation.clips[${index}].fps`,
          context,
          [1, 240],
        ),
      }
    })
    normalized.animation = { ...components.animation, clips }
  }

  if (components.tags !== undefined) {
    normalized.tags = normalizedStringArray(components.tags, `${path}.tags`, context)
  }
  if (components.order !== undefined) {
    normalized.order = normalizedNumber(
      components.order,
      `${path}.order`,
      context,
      [-100_000, 100_000],
    )
  }
  return normalized
}

function normalizeSceneLike(
  value: unknown,
  expectedKind: 'prefab' | 'scene',
  context: NormalizationContext,
): Record<string, unknown> {
  const manifest = recordOrEmpty(value, '$', context)
  warnUnknownKeys(
    manifest,
    expectedKind === 'scene' ? KnownSceneKeys : KnownPrefabKeys,
    '$',
    context,
  )
  const normalized: Record<string, unknown> = {
    ...manifest,
    kind: defaulted(manifest.kind, expectedKind, '$.kind', context),
    extends: defaulted(manifest.extends, null, '$.extends', context),
  }

  if (expectedKind === 'prefab') {
    normalized.components = normalizeComponents(manifest.components, '$.components', context)
    return normalized
  }

  const entities = normalizedStringArray(manifest.entities, '$.entities', context)
  normalized.entities = entities.map((entity, index) => {
    if (!isRecord(entity)) {
      const path = `$.entities[${index}]`
      throw new GameManifestError(
        'INVALID_MANIFEST',
        `${path} 必须是对象，不能在 canonical 写盘前静默丢弃。`,
        {
          path,
          hint: '把该项改成包含 id 与 components 的实体对象，或显式从 entities 数组删除该项。',
        },
      )
    }
    warnUnknownKeys(entity, KnownEntityKeys, `$.entities[${index}]`, context)
    if (entity.remove === true && entity.components === undefined) return { ...entity }
    return {
      ...entity,
      components: normalizeComponents(
        entity.components,
        `$.entities[${index}].components`,
        context,
      ),
    }
  })
  return normalized
}

function sceneIdFromPath(path: string): string | null {
  const fileName = path.split('/').at(-1)
  if (!fileName) return null
  return fileName.replace(/\.scene\.json$/u, '').replace(/\.json$/u, '') || null
}

function normalizeProject(value: unknown, context: NormalizationContext): Record<string, unknown> {
  const project = recordOrEmpty(value, '$', context)
  const runtime = recordOrEmpty(project.runtime, '$.runtime', context)
  const canvas = recordOrEmpty(runtime.canvas, '$.runtime.canvas', context)
  const input = recordOrEmpty(project.input, '$.input', context)
  const actions = recordOrEmpty(input.actions, '$.input.actions', context)
  const dev = recordOrEmpty(project.dev, '$.dev', context)
  const server = recordOrEmpty(dev.server, '$.dev.server', context)
  const overlay = recordOrEmpty(dev.overlay, '$.dev.overlay', context)
  const scenes = normalizedStringArray(project.scenes, '$.scenes', context)
  warnUnknownKeys(project, KnownProjectKeys, '$', context)
  warnUnknownKeys(runtime, KnownRuntimeKeys, '$.runtime', context)
  warnUnknownKeys(canvas, KnownCanvasKeys, '$.runtime.canvas', context)
  warnUnknownKeys(input, KnownInputKeys, '$.input', context)
  warnUnknownKeys(dev, KnownDevKeys, '$.dev', context)
  warnUnknownKeys(server, KnownServerKeys, '$.dev.server', context)
  warnUnknownKeys(overlay, KnownOverlayKeys, '$.dev.overlay', context)
  const entryFallback = typeof scenes[0] === 'string'
    ? sceneIdFromPath(scenes[0])
    : null

  return {
    ...project,
    schemaChannel: defaulted(project.schemaChannel, 'v0', '$.schemaChannel', context),
    runtime: {
      ...runtime,
      profile: defaulted(runtime.profile, 'web-2d', '$.runtime.profile', context),
      canvas: {
        ...canvas,
        width: normalizedNumber(
          defaulted(canvas.width, 960, '$.runtime.canvas.width', context),
          '$.runtime.canvas.width',
          context,
          [64, 8192],
        ),
        height: normalizedNumber(
          defaulted(canvas.height, 540, '$.runtime.canvas.height', context),
          '$.runtime.canvas.height',
          context,
          [64, 8192],
        ),
      },
      pixelArt: normalizedBoolean(
        defaulted(runtime.pixelArt, true, '$.runtime.pixelArt', context),
        '$.runtime.pixelArt',
        context,
      ),
    },
    entryScene: defaulted(
      project.entryScene,
      entryFallback ? `scene:${entryFallback}` : null,
      '$.entryScene',
      context,
    ),
    scenes,
    prefabs: project.prefabs === undefined
      ? defaulted(project.prefabs, [], '$.prefabs', context)
      : normalizedStringArray(project.prefabs, '$.prefabs', context),
    assets: defaulted(project.assets, 'assets/assets.json', '$.assets', context),
    layers: project.layers === undefined
      ? defaulted(project.layers, ['background', 'actors', 'ui'], '$.layers', context)
      : normalizedStringArray(project.layers, '$.layers', context),
    collisionLayers: project.collisionLayers === undefined
      ? defaulted(project.collisionLayers, [], '$.collisionLayers', context)
      : normalizedStringArray(project.collisionLayers, '$.collisionLayers', context),
    input: {
      ...input,
      actions: Object.fromEntries(
        Object.entries(actions).map(([name, bindings]) => [
          name,
          normalizedStringArray(bindings, `$.input.actions.${name}`, context),
        ]),
      ),
    },
    dev: {
      ...dev,
      ...(dev.server === undefined ? {} : {
        server: {
          ...server,
          ...(server.port === undefined ? {} : {
            port: normalizedNumber(server.port, '$.dev.server.port', context, [1, 65_535]),
          }),
        },
      }),
      overlay: {
        ...overlay,
        colliders: normalizedBoolean(
          defaulted(overlay.colliders, true, '$.dev.overlay.colliders', context),
          '$.dev.overlay.colliders',
          context,
        ),
        entityBounds: normalizedBoolean(
          defaulted(overlay.entityBounds, true, '$.dev.overlay.entityBounds', context),
          '$.dev.overlay.entityBounds',
          context,
        ),
        logs: normalizedBoolean(
          defaulted(overlay.logs, true, '$.dev.overlay.logs', context),
          '$.dev.overlay.logs',
          context,
        ),
      },
    },
  }
}

function normalizeAssets(value: unknown, context: NormalizationContext): Record<string, unknown> {
  const manifest = recordOrEmpty(value, '$', context)
  const assets = normalizedStringArray(manifest.assets, '$.assets', context)
  warnUnknownKeys(manifest, KnownAssetsManifestKeys, '$', context)
  return {
    ...manifest,
    assets: assets.map((asset, index) => {
      if (!isRecord(asset)) {
        const path = `$.assets[${index}]`
        throw new GameManifestError(
          'INVALID_MANIFEST',
          `${path} 必须是对象，不能在 canonical 写盘前静默丢弃。`,
          {
            path,
            hint: '把该项改成包含 id、kind 与 path 的资产对象，或显式从 assets 数组删除该项。',
          },
        )
      }
      warnUnknownKeys(asset, KnownAssetKeys, `$.assets[${index}]`, context)
      const frame = isRecord(asset.frame) ? { ...asset.frame } : asset.frame
      if (isRecord(frame)) {
        for (const key of ['width', 'height'] as const) {
          frame[key] = normalizedNumber(frame[key], `$.assets[${index}].frame.${key}`, context)
        }
        if (frame.count !== undefined) {
          frame.count = normalizedNumber(
            frame.count,
            `$.assets[${index}].frame.count`,
            context,
            [1, 10_000],
          )
        }
      }
      return { ...asset, ...(frame === undefined ? {} : { frame }) }
    }),
  }
}

function parseJson(text: string, sourceName: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new GameManifestError(
      'INVALID_JSON',
      `${sourceName} 不是合法 JSON：${detail}`,
      { hint: '先读取报错位置附近内容，修复 JSON 标点后再重试。' },
    )
  }
}

function parseNormalized<T>(
  raw: unknown,
  schema: z.ZodType<T>,
  normalize: (value: unknown, context: NormalizationContext) => unknown,
): GameManifestParseResult<T> {
  const context: NormalizationContext = { adjustments: [], warnings: [] }
  const result = schema.safeParse(normalize(raw, context))
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.length > 0 ? `$.${issue.path.join('.')}` : '$'}：${issue.message}`)
      .join('\n')
    throw new GameManifestError('INVALID_MANIFEST', `清单校验失败：\n${issues}`, {
      hint: '按每条路径提示修正判别字段、稳定 slug 或必填引用；未知字段无需删除。',
    })
  }
  return {
    value: result.data,
    warnings: context.warnings,
    ...(buildAppliedAdjustments(context.adjustments) as {
      appliedAdjustments?: AppliedAdjustment[]
    }),
    appliedAdjustments: context.adjustments,
  }
}

export function parseGameProjectManifest(input: unknown): GameManifestParseResult<GameProjectManifest> {
  return parseNormalized(
    input,
    GameProjectManifestSchema as z.ZodType<GameProjectManifest>,
    normalizeProject,
  )
}

export function parseGameProjectManifestText(
  text: string,
  sourceName = 'game.project.json',
): GameManifestParseResult<GameProjectManifest> {
  return parseGameProjectManifest(parseJson(text, sourceName))
}

export function parseGameSceneManifest(input: unknown): GameManifestParseResult<GameSceneManifest> {
  return parseNormalized(
    input,
    GameSceneManifestSchema as z.ZodType<GameSceneManifest>,
    (value, context) => normalizeSceneLike(value, 'scene', context),
  )
}

export function parseGameSceneManifestText(
  text: string,
  sourceName = 'scene manifest',
): GameManifestParseResult<GameSceneManifest> {
  return parseGameSceneManifest(parseJson(text, sourceName))
}

export function parseGamePrefabManifest(input: unknown): GameManifestParseResult<GamePrefabManifest> {
  return parseNormalized(
    input,
    GamePrefabManifestSchema as z.ZodType<GamePrefabManifest>,
    (value, context) => normalizeSceneLike(value, 'prefab', context),
  )
}

export function parseGamePrefabManifestText(
  text: string,
  sourceName = 'prefab manifest',
): GameManifestParseResult<GamePrefabManifest> {
  return parseGamePrefabManifest(parseJson(text, sourceName))
}

export function parseGameAssetsManifest(input: unknown): GameManifestParseResult<GameAssetsManifest> {
  return parseNormalized(
    input,
    GameAssetsManifestSchema as z.ZodType<GameAssetsManifest>,
    normalizeAssets,
  )
}

export function parseGameAssetsManifestText(
  text: string,
  sourceName = 'assets manifest',
): GameManifestParseResult<GameAssetsManifest> {
  return parseGameAssetsManifest(parseJson(text, sourceName))
}

export type { GameComponentMap }
