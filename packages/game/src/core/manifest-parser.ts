import { type z } from 'zod'

import {
  isArray,
  isBlank,
  isBoolean,
  isEmpty,
  isFiniteNumber,
  isNonBlankString,
  isNotNull,
  isNotUndefined,
  isPlainObject,
  isPresent,
  isString,
  isTrue,
  isUndefined,
  toNullable,
} from '@velaros-ai/core'
import {
  type AppliedAdjustment,
  buildAppliedAdjustments,
} from '@velaros-ai/core/utils/ForgivingSchema'

import { gameManifestIdFromPath, GameSlugSchema } from './references.js'
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

/**
 * 清单层的失败。
 *
 * ## `hint` 必须进 `message`（第七轮判决，与 `startupLogTail` 同一条教训）
 * 二十来个抛出点都精心写了 `hint`——「可用 scene：scene:level1」「可用 asset id：…」
 * 「先把文件移到 …，再改声明」——**它们过去一条都没到过模型手里**：`hint` 是个只写字段，
 * 全仓唯一的读者是本包自己的单测，而工具错误通道送达的只有 `Error.message` 那一句。
 * 模型看到的因此是光秃秃的「找不到编辑目标 scene:levl1。」，一步自纠的抓手全被吞掉。
 *
 * 结构化字段保留（调用方想分开渲染仍拿得到），但正文一律带上提示。
 */
export class GameManifestError extends Error {
  public readonly code: GameManifestErrorCode
  public readonly path: Nullable<string>
  public readonly hint: Nullable<string>

  public constructor(
    code: GameManifestErrorCode,
    message: string,
    options: { path?: string; hint?: string } = {},
  ) {
    super(options.hint ? `${message}\n${options.hint}` : message)
    this.name = 'GameManifestError'
    this.code = code
    this.path = toNullable(options.path)
    this.hint = toNullable(options.hint)
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
  /**
   * 本次归一的清单来源（文件路径）。
   *
   * 归一器用它从文件名反推缺席的 `id`；`parseNormalized` 用它把「哪一份清单没过校验」
   * 写进错误正文——少了这一句，模型会把子清单的报错记在自己刚发的那次编辑头上。
   */
  sourceName: string
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
  return isPlainObject(value)
}

function recordOrEmpty(
  value: unknown,
  field: string,
  context: NormalizationContext,
): Record<string, unknown> {
  if (isRecord(value)) return value
  if (isNotUndefined(value)) {
    context.adjustments.push({
      field,
      action: 'ignored',
      detail: '非对象值无法无歧义解释，按空对象处理。',
    })
  }
  return {}
}

/**
 * 键**缺席**（`undefined`）时补缺省值并留痕；显式写下的 `null` 原样透传。
 *
 * 这里的 `T | undefined` 是本函数的语义本身，不是「懒得写 `?`」：清单解析要区分 JSON 的三态
 * ——键没写（`undefined`，该补缺省）、键写了 `null`（显式缺席，是值，必须原样进 schema，
 * `$.extends` 就靠这点区分「没写」与「显式没有父级」）、键有值。改成 `Nullable<T>` 会把显式
 * `null` 也吞成缺省值并多留一条 adjustment；改成 `?:` 又要把它挪到形参表末尾，
 * 十五个调用点的可读性换一条门，不划算。
 */
// @arch-guard:suspend code-style/forbid-explicit-undefined-union 理由：三态解析器要把「键缺席」与「显式 null」分开，`Nullable<T>` 会吞掉显式 null，`?:` 需把首参挪到末位。
function defaulted<T>(
  value: T | undefined,
  fallback: T,
  field: string,
  context: NormalizationContext,
): T {
  if (isNotUndefined(value)) return value
  context.adjustments.push({
    field,
    action: 'defaulted',
    detail: `缺省值已补为 ${JSON.stringify(fallback)}。`,
  })
  return fallback
}

function finiteNumber(value: unknown): number | undefined {
  if (isFiniteNumber(value)) return value
  if (!isString(value) || isBlank(value)) return undefined
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
  if (isUndefined(parsed)) return value
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
  if (isBoolean(value)) return value
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
  if (isArray(value)) return value
  if (isNonBlankString(value)) {
    context.adjustments.push({
      field,
      action: 'aliased',
      detail: '单个字符串已提升为单元素数组。',
    })
    return [value]
  }
  if (isNotUndefined(value)) {
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
    if (isUndefined(visual.kind)) {
      const candidates = [
        isUndefined(visual.asset) ? null : 'sprite',
        isUndefined(visual.mesh) ? null : 'mesh',
        isUndefined(visual.text) ? null : 'text',
        isUndefined(visual.shape) ? null : 'shape',
      ].filter(isNotNull)
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
      isUndefined(visual.asset) &&
      isString(visual.mesh)
    ) {
      visual.asset = visual.mesh
      delete visual.mesh
      context.adjustments.push({
        field: `${path}.visual.asset`,
        action: 'aliased',
        detail: 'mesh 专属字段已归一为通用 asset 引用。',
      })
    }
    if (isNotUndefined(visual.size)) {
      visual.size = normalizedNumber(visual.size, `${path}.visual.size`, context)
    }
    normalized.visual = visual
  }

  if (isRecord(components.body)) {
    const body = { ...components.body }
    for (const key of ['width', 'height', 'radius', 'gravityScale'] as const) {
      if (isNotUndefined(body[key])) {
        body[key] = normalizedNumber(body[key], `${path}.body.${key}`, context)
      }
    }
    if (isNotUndefined(body.collidesWith)) {
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
      if (!isRecord(clip) || isUndefined(clip.fps)) return clip
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

  if (isNotUndefined(components.tags)) {
    normalized.tags = normalizedStringArray(components.tags, `${path}.tags`, context)
  }
  if (isNotUndefined(components.order)) {
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
    ...(isPresent(manifest.id) ? {} : withIdFromSourceName(context)),
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
    if (isTrue(entity.remove) && isUndefined(entity.components)) return { ...entity }
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

/**
 * 场景/prefab 清单缺 `id` 时按文件名补上。
 *
 * 判据（真机第一手）：模型手写 `scenes/main.scene.json` 时很自然地不写 `id`——路径已经说了
 * 它是哪一个，工程清单也是按路径声明它的。而校验只回一句 `$.id：expected string, received
 * undefined`，既没说是哪份文件，也没说该填什么；模型把这条记在自己刚发的 `set_project` 头上，
 * 于是判定语义 API 设不了入口场景，改去手写 JSON。
 *
 * 同一个文件里 `entryScene` 的缺省早就是这么推的（`scenes[0]` 的文件名），这里只是把同一条
 * 推断补到清单自己的 `id` 上——「钳制不拒绝」。推不出合法 slug 时不补，报错照旧。
 */
function withIdFromSourceName(context: NormalizationContext): Record<string, unknown> {
  const derivedId = gameManifestIdFromPath(context.sourceName)
  if (!derivedId) return {}
  context.adjustments.push({
    field: '$.id',
    action: 'defaulted',
    detail: `清单缺 id，已按文件名补为 ${JSON.stringify(derivedId)}。`,
  })
  return { id: derivedId }
}

/**
 * 路径数组项的宽容归一：`{ path }` / `{ id, path }` 对象降回字符串路径。
 *
 * 判据（真机第一手）：模型给 `scenes` 传的是 `[{ id: 'main', path: 'assets/scenes/main.scene.json' }]`，
 * 而清单要的是纯路径数组。这个形状**无歧义**——对象里只有 `path` 一个键能当路径，`id` 又本就
 * 由清单自己声明。所以按「钳制不拒绝」归一并留痕，而不是回一句 `expected string, received object`
 * 让模型自己猜。真的猜不出来（没有 `path` 字符串）时原样透传，由 schema 报带示例的类型错。
 */
function normalizedPathArray(
  value: unknown,
  field: string,
  context: NormalizationContext,
): unknown[] {
  return normalizedStringArray(value, field, context).map((item, index) => {
    if (!isRecord(item) || !isString(item.path)) return item
    context.adjustments.push({
      field: `${field}[${index}]`,
      action: 'aliased',
      detail: `对象形态已归一为路径字符串 ${JSON.stringify(item.path)}。`,
    })
    return item.path
  })
}

/**
 * `entryScene` 的宽容归一：裸 slug 与已声明的场景路径都收敛成 `scene:<slug>` 引用。
 *
 * `game_run` 的 `scene` 参数早就这么归一（GameRunSchema 的 transform，真机日志里
 * 「裸 scene slug 已归一为 scene:main」正常工作过）；工程清单这一格却只会拒绝，
 * 于是同一个概念在两个入口有两套严格度。这里补齐，让两边一致。
 */
function normalizedEntryScene(
  value: unknown,
  scenePaths: readonly unknown[],
  context: NormalizationContext,
): unknown {
  if (!isString(value)) return value
  const trimmed = value.trim()
  if (!trimmed || trimmed.startsWith('scene:')) return value

  const declaredPathId = scenePaths.includes(trimmed) ? gameManifestIdFromPath(trimmed) : null
  const slug = declaredPathId ?? (GameSlugSchema.safeParse(trimmed).success ? trimmed : null)
  if (!slug) return value

  const normalized = `scene:${slug}`
  context.adjustments.push({
    field: '$.entryScene',
    action: 'aliased',
    detail: `${JSON.stringify(value)} 已归一为 ${normalized}。`,
  })
  return normalized
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
  const scenes = normalizedPathArray(project.scenes, '$.scenes', context)
  warnUnknownKeys(project, KnownProjectKeys, '$', context)
  warnUnknownKeys(runtime, KnownRuntimeKeys, '$.runtime', context)
  warnUnknownKeys(canvas, KnownCanvasKeys, '$.runtime.canvas', context)
  warnUnknownKeys(input, KnownInputKeys, '$.input', context)
  warnUnknownKeys(dev, KnownDevKeys, '$.dev', context)
  warnUnknownKeys(server, KnownServerKeys, '$.dev.server', context)
  warnUnknownKeys(overlay, KnownOverlayKeys, '$.dev.overlay', context)
  const entryFallback = isString(scenes[0])
    ? gameManifestIdFromPath(scenes[0])
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
    entryScene: normalizedEntryScene(
      defaulted(
        project.entryScene,
        entryFallback ? `scene:${entryFallback}` : null,
        '$.entryScene',
        context,
      ),
      scenes,
      context,
    ),
    scenes,
    prefabs: isUndefined(project.prefabs)
      ? defaulted(project.prefabs, [], '$.prefabs', context)
      : normalizedPathArray(project.prefabs, '$.prefabs', context),
    assets: defaulted(project.assets, 'assets/assets.json', '$.assets', context),
    layers: isUndefined(project.layers)
      ? defaulted(project.layers, ['background', 'actors', 'ui'], '$.layers', context)
      : normalizedStringArray(project.layers, '$.layers', context),
    collisionLayers: isUndefined(project.collisionLayers)
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
      ...(isUndefined(dev.server) ? {} : {
        server: {
          ...server,
          ...(isUndefined(server.port) ? {} : {
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
        if (isNotUndefined(frame.count)) {
          frame.count = normalizedNumber(
            frame.count,
            `$.assets[${index}].frame.count`,
            context,
            [1, 10_000],
          )
        }
      }
      return { ...asset, ...(isUndefined(frame) ? {} : { frame }) }
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

/** 字段路径 → 该位置正确形状的示例；数组下标在查表前统一抹掉。 */
const ExpectedShapeExamples: Readonly<Record<string, string>> = {
  scenes: '工程内相对路径字符串数组，如 ["scenes/main.scene.json"]',
  prefabs: '工程内相对路径字符串数组，如 ["prefabs/player.prefab.json"]',
  assets: '单个工程内相对路径字符串，如 "assets/assets.json"',
  entryScene: 'scene:<slug> 引用字符串或 null，如 "scene:main"',
  id: '稳定 kebab-case slug 字符串，如 "main"',
  layers: 'slug 字符串数组，如 ["background","actors","ui"]',
  collisionLayers: 'slug 字符串数组，如 ["player","enemy"]',
  entities: '实体对象数组，如 [{ "id": "player", "components": {} }]',
}

type ManifestValidationIssue = z.ZodError['issues'][number]

function formatIssuePath(issue: ManifestValidationIssue): string {
  return !isEmpty(issue.path) ? `$.${issue.path.join('.')}` : '$'
}

/**
 * 类型不符时补一句「该长什么样」。
 *
 * zod 的 `expected string, received object` 只说了不该长什么样。带自定义 message 的字段
 * （slug / `kind:<slug>` 引用 / 工程内相对路径）本来就自带示例，这里只兜住剩下那档裸类型错——
 * 真机上 `$.entryScene` 有说明、紧挨着的 `$.scenes.0` 只有裸类型错，模型照着改了一半仍然错。
 */
function describeExpectedShape(issue: ManifestValidationIssue): string {
  if (issue.code !== 'invalid_type') return issue.message
  // 数组下标不参与查表：`scenes.0` 与 `scenes` 要的是同一句形状说明。
  const fieldPath = issue.path
    .map(String)
    .filter((segment) => !/^\d+$/u.test(segment))
    .join('.')
  const example = ExpectedShapeExamples[fieldPath]
  return example ? `${issue.message}（应为${example}）` : issue.message
}

function parseNormalized<T>(
  raw: unknown,
  schema: z.ZodType<T>,
  normalize: (value: unknown, context: NormalizationContext) => unknown,
  sourceName: string,
): GameManifestParseResult<T> {
  const context: NormalizationContext = { adjustments: [], warnings: [], sourceName }
  const result = schema.safeParse(normalize(raw, context))
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${formatIssuePath(issue)}：${describeExpectedShape(issue)}`)
      .join('\n')
    // 文件名必须进正文：编辑器一次 edit 会重解工程 + 全部场景 + 全部 prefab + 资产清单，
    // 不点名就等于让模型在四类清单里猜是谁不合格（真机上它猜成了自己刚发的编辑参数）。
    throw new GameManifestError('INVALID_MANIFEST', `${sourceName} 清单校验失败：\n${issues}`, {
      path: sourceName,
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

export function parseGameProjectManifest(
  input: unknown,
  sourceName = 'game.project.json',
): GameManifestParseResult<GameProjectManifest> {
  return parseNormalized(
    input,
    GameProjectManifestSchema as z.ZodType<GameProjectManifest>,
    normalizeProject,
    sourceName,
  )
}

export function parseGameProjectManifestText(
  text: string,
  sourceName = 'game.project.json',
): GameManifestParseResult<GameProjectManifest> {
  return parseGameProjectManifest(parseJson(text, sourceName), sourceName)
}

export function parseGameSceneManifest(
  input: unknown,
  sourceName = 'scene manifest',
): GameManifestParseResult<GameSceneManifest> {
  return parseNormalized(
    input,
    GameSceneManifestSchema as z.ZodType<GameSceneManifest>,
    (value, context) => normalizeSceneLike(value, 'scene', context),
    sourceName,
  )
}

export function parseGameSceneManifestText(
  text: string,
  sourceName = 'scene manifest',
): GameManifestParseResult<GameSceneManifest> {
  return parseGameSceneManifest(parseJson(text, sourceName), sourceName)
}

export function parseGamePrefabManifest(
  input: unknown,
  sourceName = 'prefab manifest',
): GameManifestParseResult<GamePrefabManifest> {
  return parseNormalized(
    input,
    GamePrefabManifestSchema as z.ZodType<GamePrefabManifest>,
    (value, context) => normalizeSceneLike(value, 'prefab', context),
    sourceName,
  )
}

export function parseGamePrefabManifestText(
  text: string,
  sourceName = 'prefab manifest',
): GameManifestParseResult<GamePrefabManifest> {
  return parseGamePrefabManifest(parseJson(text, sourceName), sourceName)
}

export function parseGameAssetsManifest(
  input: unknown,
  sourceName = 'assets manifest',
): GameManifestParseResult<GameAssetsManifest> {
  return parseNormalized(
    input,
    GameAssetsManifestSchema as z.ZodType<GameAssetsManifest>,
    normalizeAssets,
    sourceName,
  )
}

export function parseGameAssetsManifestText(
  text: string,
  sourceName = 'assets manifest',
): GameManifestParseResult<GameAssetsManifest> {
  return parseGameAssetsManifest(parseJson(text, sourceName), sourceName)
}

export type { GameComponentMap }
