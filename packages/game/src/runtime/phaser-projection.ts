import type Phaser from 'phaser'

import {
  isBlank,
  isEmpty,
  isNotUndefined,
  isNull,
  isNumber,
  isPresent,
  isString,
  isUndefined,
  toNullable,
  toOptional,
} from '@velaros-ai/core'

import {
  GameKnownComponentKeys,
  GameKnownEntityKeys,
} from '../core/manifest-parser.js'
import type {
  GameInputResult,
  GameInputStep,
  GameRuntimeEntitySnapshot,
  GameRuntimeQuery,
  GameRuntimeQueryResult,
  GameRuntimeSceneSnapshot,
} from '../core/ports.js'
import { gameReferenceId } from '../core/references.js'
import type { GameResolvedEntity, GameResolvedScene } from '../core/resolver.js'
import type {
  GameAssetManifest,
  GameAssetsManifest,
  GameComponentMap,
  GameProjectManifest,
} from '../core/schemas.js'

import { GameRuntimeDiagnostics } from './diagnostics.js'

type RuntimeGameObject = Phaser.GameObjects.GameObject & {
  x: number
  y: number
  rotation: number
  scaleX: number
  scaleY: number
  body?: LooseOptional<Phaser.Physics.Arcade.Body | Phaser.Physics.Arcade.StaticBody>
  getBounds: () => Phaser.Geom.Rectangle
  setDepth: (depth: number) => RuntimeGameObject
  setInteractive: () => RuntimeGameObject
  setName: (name: string) => RuntimeGameObject
  setPosition: (x: number, y: number) => RuntimeGameObject
  setRotation: (rotation: number) => RuntimeGameObject
  setScale: (x: number, y?: number) => RuntimeGameObject
  on: (event: string, callback: () => void) => RuntimeGameObject
}

interface RuntimeEntityRecord {
  readonly manifest: GameResolvedEntity
  readonly object: RuntimeGameObject
  /**
   * 这个实体是否真的产生了一个会被画出来的显示对象。
   *
   * `false` 只有一个来源：{@link InvisibleEntityPlaceholder} —— 没有 `visual` 的实体拿到的那个
   * 16×16、alpha 0.001 的透明矩形（它存在只是为了让 transform / body / 点选有个载体）。
   * 这一格是「跑起来了但什么都看不见」那条信号的**唯一事实源**，别在别处再算一遍。
   */
  readonly rendered: boolean
}

interface CreatedVisual {
  readonly object: RuntimeGameObject
  readonly rendered: boolean
}

export interface GameEntityScriptContext {
  readonly entityId: string
  readonly params: Readonly<Record<string, unknown>>
  readonly getPosition: () => { readonly x: number; readonly y: number }
  readonly setPosition: (x: number, y: number) => void
  readonly setVelocity: (x?: number, y?: number) => void
  readonly isBlocked: (side: 'down' | 'left' | 'right' | 'up') => boolean
  readonly isActionDown: (action: string) => boolean
  readonly getEntity: (entityId: string) => Nullable<GameRuntimeEntitySnapshot>
  readonly getState: (key: string) => unknown
  readonly setState: (key: string, value: unknown) => void
}

export interface GameEntityBehavior {
  readonly create?: () => void
  readonly update?: (deltaMs: number) => void
  readonly dispose?: () => void
}

export type GameEntityScriptFactory = (context: GameEntityScriptContext) => GameEntityBehavior
export type GameScriptRegistry = Readonly<Record<string, GameEntityScriptFactory>>

export interface PhaserGameRuntimeOptions {
  readonly parent: string | HTMLElement
  readonly project: GameProjectManifest
  readonly scene: GameResolvedScene
  readonly assets: GameAssetsManifest
  readonly scripts?: GameScriptRegistry
  readonly onSelection?: (selection: GameRuntimeEntitySnapshot) => void
  readonly onError?: (message: string) => void
}

export interface VelarosGamePageApi {
  readonly query: (request?: GameRuntimeQuery) => GameRuntimeQueryResult
  readonly input: (
    steps: readonly GameInputStep[],
    options?: {
      readonly repeat?: number
      readonly settleFrames?: number
      readonly captureAfter?: boolean
    }
  ) => Promise<GameInputResult>
  readonly selectEntity: (entityId: string) => GameRuntimeEntitySnapshot
  readonly setOverlayVisible: (visible: boolean) => void
  readonly clearErrors: () => void
}

declare global {
  interface Window {
    __velarosGame?: VelarosGamePageApi
  }
}

interface ProjectionBridge {
  readonly query: (request?: GameRuntimeQuery) => GameRuntimeQueryResult
  readonly selectEntity: (entityId: string) => GameRuntimeEntitySnapshot
  readonly setOverlayVisible: (visible: boolean) => void
  readonly dispose: () => void
}

function isDynamicBody(
  body: LooseOptional<Phaser.Physics.Arcade.Body | Phaser.Physics.Arcade.StaticBody>
): body is Phaser.Physics.Arcade.Body {
  return Boolean(body && 'velocity' in body && 'blocked' in body)
}

/** 一个被解析出来的颜色：Phaser 要的 24 位整数 + 独立的 alpha。 */
export interface ResolvedVisualColor {
  readonly color: number
  readonly alpha: number
}

const HexColorPattern = /^(?:#|0x)?([0-9a-f]+)$/iu
const RgbFunctionPattern = /^rgba?\(([^)]*)\)$/iu

function hexPairs(digits: string): readonly number[] {
  const doubled = digits.length <= 4 ? [...digits].map((digit) => `${digit}${digit}`) : null
  const pairs = doubled ?? (digits.match(/../gu) ?? [])
  return pairs.map((pair) => Number.parseInt(pair, 16))
}

/** `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`（`0x` 前缀与裸写同形）。 */
function parseHexColor(text: string): Nullable<ResolvedVisualColor> {
  const digits = HexColorPattern.exec(text)?.[1]
  if (!isPresent(digits) || ![3, 4, 6, 8].includes(digits.length)) return null
  const [red, green, blue, alpha] = hexPairs(digits)
  if (isUndefined(red) || isUndefined(green) || isUndefined(blue)) return null
  return {
    color: (red << 16) | (green << 8) | blue,
    alpha: isUndefined(alpha) ? 1 : alpha / 255,
  }
}

function channelValue(part: string, scale: number): Nullable<number> {
  const percent = part.endsWith('%')
  const raw = Number.parseFloat(percent ? part.slice(0, -1) : part)
  if (!Number.isFinite(raw)) return null
  const value = percent ? (raw / 100) * scale : raw
  return Math.min(scale, Math.max(0, value))
}

/** `rgb(255, 0, 0)` / `rgba(255 0 0 / 50%)`——逗号、空格、斜杠三种分隔一起认。 */
function parseRgbColor(text: string): Nullable<ResolvedVisualColor> {
  const body = RgbFunctionPattern.exec(text)?.[1]
  if (!isPresent(body)) return null
  const parts = body.split(/[,/\s]+/u).filter((part) => !isBlank(part))
  if (parts.length < 3 || parts.length > 4) return null
  const channels = parts.slice(0, 3).map((part) => channelValue(part, 255))
  const alpha = isUndefined(parts[3]) ? 1 : channelValue(parts[3], 1)
  if (channels.some(isNull) || isNull(alpha)) return null
  const [red, green, blue] = channels.map((channel) => Math.round(channel!))
  return { color: (red! << 16) | (green! << 8) | blue!, alpha }
}

let cssColorProbe: Nullable<CanvasRenderingContext2D> = null
const cssColorCache = new Map<string, Nullable<string>>()

/**
 * 交给**页面自己的 CSS 解析器**去认 `red` / `gold` / `hsl(…)` 这些写法。
 *
 * 判决（第十三轮 P1-1）：不抄一张 148 条的 CSS 具名色表。text visual 的颜色一直是原样
 * 交给 Phaser 走 CSS 通道的，所以 `red` **在那边一直能用**——同一份清单里同一个字段两套语义，
 * 正是要根治的东西。借同一个引擎兜底，两条通道从此认同一个集合。
 *
 * 「认不认得」用两个哨兵判：只有对**两个**哨兵都赋值失败（fillStyle 停在哨兵上）才算不认得，
 * 单哨兵会把「值恰好等于哨兵」误判成非法。
 */
function resolveCssColor(value: string): Nullable<string> {
  const cached = cssColorCache.get(value)
  if (isNotUndefined(cached)) return cached
  const resolved = probeCssColor(value)
  cssColorCache.set(value, resolved)
  return resolved
}

function probeCssColor(value: string): Nullable<string> {
  // 没有 DOM（单测 / Node 侧校验）就只剩本包自己解析的那几档 —— 不是错误，是能力边界。
  cssColorProbe ??= toNullable(globalThis.document?.createElement('canvas').getContext('2d'))
  const probe = cssColorProbe
  if (!probe) return null
  const attempts = ['#010203', '#040506'].map((sentinel) => {
    probe.fillStyle = sentinel
    probe.fillStyle = value
    return { sentinel, result: probe.fillStyle }
  })
  if (attempts.every((attempt) => attempt.result === attempt.sentinel)) return null
  return toNullable(attempts[1]?.result)
}

/**
 * 清单里写的颜色 → 可投影的颜色；认不出来回 `null`（**绝不静默换成别的颜色**）。
 *
 * ## 判决（第十三轮 P1-1）：静默替换比静默丢弃还坏
 * 上一版只认 6 位十六进制，`#f00` / `red` / `gold` / `rgb(…)` / `0x6b8e23` / 8 位带 alpha
 * **一律静默变成同一个紫色**——零 adjustment、零 warning、零诊断。模型看到的是「我写了金色，
 * 它是紫的」，而工具链的每一格都说成功。归一必须留痕，认不出来必须出声。
 *
 * 收下的写法：`#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`（`0x` 前缀与裸写同形）、
 * `rgb()` / `rgba()`（逗号或空格分隔、支持百分比与 alpha），以及页面在场时**任何浏览器
 * 认得的 CSS 颜色**（具名色、`hsl()`、`color()` …）。前两类是本包自己解析的，所以在没有 DOM 的
 * 环境（单测、Node 侧校验）里同样成立。
 */
export function parseVisualColor(value: unknown): Nullable<ResolvedVisualColor> {
  if (!isString(value)) return null
  const text = value.trim()
  if (isBlank(text)) return null
  const literal = parseHexColor(text) ?? parseRgbColor(text)
  if (literal) return literal
  const css = resolveCssColor(text)
  if (isNull(css)) return null
  return parseHexColor(css) ?? parseRgbColor(css)
}

/** 形状 visual 认不出颜色时的回落色（诊断正文里逐字点名它，不许静默）。 */
const DefaultShapeColor = 0x8b5cf6

/** 认不出来时那一句话——必须点名「你写的是什么」「画面上会是什么」「可以怎么写」。 */
export function describeUnreadableColor(
  where: string,
  value: unknown,
  fallback: string,
): string {
  return (
    `${where} 写的是 ${JSON.stringify(value)}，本运行时解析不出这个颜色，这一格已回落到 ${fallback}`
    + '——画面上看到的不是你写的颜色。可用写法：#rgb / #rgba / #rrggbb / #rrggbbaa / '
    + '0xrrggbb / rgb(…) / rgba(…)，以及浏览器认得的 CSS 颜色名（如 red、gold）。'
  )
}

type SpriteAnchor =
  | 'bottom'
  | 'bottom-left'
  | 'bottom-right'
  | 'center'
  | 'left'
  | 'right'
  | 'top'
  | 'top-left'
  | 'top-right'

function anchorOrigin(anchor: SpriteAnchor): readonly [number, number] {
  switch (anchor) {
    case 'top-left':
      return [0, 0]
    case 'top':
      return [0.5, 0]
    case 'top-right':
      return [1, 0]
    case 'left':
      return [0, 0.5]
    case 'right':
      return [1, 0.5]
    case 'bottom-left':
      return [0, 1]
    case 'bottom':
      return [0.5, 1]
    case 'bottom-right':
      return [1, 1]
    case 'center':
      return [0.5, 0.5]
  }
}

/**
 * 「跑起来了但什么都看不见」的**证据判据** —— 抽成纯函数，是为了它能被单测直接钉住
 * （投影本体要 Phaser + DOM，钉不动；而这条判据正是最需要防退化的那一格）。
 *
 * ## 病灶（真机第一手）
 * 模型把视觉写成 `components.sprite`（正确名字是 `visual`），三个实体全部只拿到不可见占位块。
 * `entities 3`、`errors 0`、FPS 正常、截图是真 PNG——一切「成功」，画面上只有调试碰撞框。
 *
 * ## 为什么不会误报「故意的纯调试场景」
 * 报，需要**同时**满足：①这个实体没产生任何可见显示对象；②它带着**未兑现意图的证据**——
 * 清单上有本运行时不认识的键，或者它明明声明了 `visual` 却投影不出来。
 * 触发器 / 出生点 / 纯逻辑控制器这类故意不画的实体，清单是干净的（每个键都在闭集里、
 * 没有 `visual`），第②条对它们恒假。命中的一定是「写了点什么、没被认识、结果什么都没画」。
 *
 * ## 证据面 = 组件表 ∪ 实体信封（第十三轮 P1-2）
 * 上一版只扫组件表，而清单解析器只把名字**在组件闭集或别名表里**的键搬进 `components`——
 * 闭集外的（`renderer` / `graphic` / `image`、或者直接写在实体上的 `color` / `width`）原地
 * 留在信封上。于是最典型的那一档「写了视觉意图 + 什么都没画」在运行期一条诊断都没有，
 * 而回合上下文偏偏叫模型去 `game:query_state({select:'errors'})` 看原因——那张表是空的。
 *
 * @returns 该报的那句话；没有证据（= 作者本来就没打算画）时回 `null`。
 */
export function describeUnrealizedVisual(
  entity: GameResolvedEntity,
  rendered: boolean
): Nullable<string> {
  if (rendered) return null
  const components = entity.components
  if (isPresent(components.visual))
    return `实体 ${entity.id} 声明了 visual 却没有产生任何画面：它的 kind 不在 sprite/mesh/text/shape 里，投影层只能给一个不可见占位块。`
  const strayComponents = Object.keys(components).filter(
    (key) => !GameKnownComponentKeys.has(key)
  )
  const strayOnEntity = Object.keys(entity).filter((key) => !GameKnownEntityKeys.has(key))
  if (isEmpty(strayComponents) && isEmpty(strayOnEntity)) return null
  const where = [
    ...(isEmpty(strayOnEntity)
      ? []
      : [`实体块上的 ${strayOnEntity.join(' / ')}（组件只在 components 下被读取）`]),
    ...(isEmpty(strayComponents) ? [] : [`components 下的 ${strayComponents.join(' / ')}`]),
  ].join('、')
  return (
    `实体 ${entity.id} 没有产生任何画面：${where} 不是本运行时认识的组件` +
    `（可用：${[...GameKnownComponentKeys].sort().join('、')}），而它没有 visual —— ` +
    '视觉意图必须写在 components.visual 下才会被画出来。'
  )
}

function percentile(values: readonly number[], ratio: number): Nullable<number> {
  if (isEmpty(values)) return null
  const sorted = [...values].sort((left, right) => left - right)
  return toNullable(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))])
}

function normalizePageSize(value: LooseOptional<number>, fallback: number): number {
  return Math.min(200, Math.max(1, Math.round(value ?? fallback)))
}

function normalizePhaserKeyBinding(binding: string): string {
  if (binding.startsWith('Arrow')) return binding.slice('Arrow'.length).toUpperCase()
  if (/^Key[A-Z]$/u.test(binding)) return binding.slice('Key'.length)
  if (/^Digit[0-9]$/u.test(binding)) return binding.slice('Digit'.length)
  return binding.replace(/(?:Left|Right)$/u, '').toUpperCase()
}

function browserKeyBinding(binding: string): {
  readonly code: string
  readonly key: string
} {
  if (/^Key[A-Z]$/u.test(binding))
    return { code: binding, key: binding.slice('Key'.length).toLowerCase() }
  if (/^Digit[0-9]$/u.test(binding)) return { code: binding, key: binding.slice('Digit'.length) }
  if (binding === 'Space') return { code: 'Space', key: ' ' }
  return { code: binding, key: binding }
}

function browserKeyCode(binding: string): number {
  const named: Readonly<Record<string, number>> = {
    ArrowDown: 40,
    ArrowLeft: 37,
    ArrowRight: 39,
    ArrowUp: 38,
    Enter: 13,
    Escape: 27,
    Space: 32,
    Tab: 9,
  }
  const known = named[binding]
  if (isNotUndefined(known)) return known
  if (/^Key[A-Z]$/u.test(binding)) return binding.codePointAt(3) ?? 0
  if (/^Digit[0-9]$/u.test(binding)) return binding.codePointAt(5) ?? 0
  return binding.length === 1 ? (binding.toUpperCase().codePointAt(0) ?? 0) : 0
}

function dispatchKeyboardInput(binding: string, type: 'keydown' | 'keyup'): void {
  const { code, key } = browserKeyBinding(binding)
  const event = new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    code,
    key,
  })
  // Phaser 4's KeyboardManager still indexes keys by the legacy numeric keyCode.
  // Chromium does not derive it for script-created KeyboardEvent instances.
  const keyCode = browserKeyCode(binding)
  Object.defineProperties(event, {
    keyCode: { value: keyCode },
    which: { value: keyCode },
  })
  window.dispatchEvent(event)
}

/** 页面侧的一次性等待（见下方 suspend 理由）。 */
function waitForDuration(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // @arch-guard:suspend code-style/forbid-raw-timers 理由：这段跑在被服务的游戏页面里
    // （dist/browser/page.js），不是主进程。TimerScope 管的是「有宿主生命周期可挂」的定时器，
    // 而这一个由它自己的 Promise 完整拥有：resolve 即终结，没有可泄漏的句柄、没有第二个
    // 所有者能取消它，页面整体随 webview 关闭消失。
    window.setTimeout(resolve, Math.min(60_000, Math.max(0, Math.round(ms))))
  })
}

/** 等若干帧，让输入产生的物理/行为落定（见下方 suspend 理由）。 */
async function waitForFrames(frameCount: number): Promise<void> {
  for (let index = 0; index < frameCount; index += 1) {
    await new Promise<void>((resolve) => {
      // @arch-guard:suspend code-style/forbid-raw-timers 理由：同 waitForDuration —— 页面侧、
      // 单帧回调、由 Promise 独占；而且「等一帧」只有 rAF 能表达，换成计时器会与渲染节拍脱钩。
      window.requestAnimationFrame(() => resolve())
    })
  }
}

function createProjectionSceneClass(
  PhaserRuntime: typeof Phaser,
  options: PhaserGameRuntimeOptions,
  diagnostics: GameRuntimeDiagnostics,
  onReady: (bridge: ProjectionBridge) => void,
  onFailure: (error: unknown) => void
) {
  return class GameProjectionScene extends PhaserRuntime.Scene implements ProjectionBridge {
    private readonly records = new Map<string, RuntimeEntityRecord>()
    private readonly behaviors: GameEntityBehavior[] = []
    private readonly actionKeys = new Map<string, Phaser.Input.Keyboard.Key[]>()
    private readonly sharedState = new Map<string, unknown>()
    private readonly frameTimes: number[] = []
    private overlayGraphics: Nullable<Phaser.GameObjects.Graphics> = null
    private overlayText: Nullable<Phaser.GameObjects.Text> = null
    private overlayVisible = true
    private selectedEntityId: Nullable<string> = null
    private startedAt = 0

    public constructor() {
      super({ key: options.scene.id })
    }

    public preload(): void {
      for (const asset of options.assets.assets) this.preloadAsset(asset)
    }

    public create(): void {
      try {
        this.startedAt = Date.now()
        this.cameras.main.setBackgroundColor(this.backgroundColor())
        this.bindInputActions()

        for (const entity of options.scene.entities) {
          const { object, rendered } = this.createEntityObject(entity)
          object.setInteractive()
          object.on('pointerdown', () => {
            this.selectEntity(entity.id)
          })
          this.records.set(entity.id, {
            manifest: entity,
            object,
            rendered,
          })
        }
        this.configureCamera()
        this.createColliders()
        this.createBehaviors()
        this.reportUnrealizedVisuals()
        this.createOverlay()
        onReady(this)
      } catch (error) {
        // arch-guard:silent-catch-ok 不是吞错：reportError 把原文写进 GameRuntimeDiagnostics
        // （→ game:query_state({select:'errors'}) / overlay / game.runtime-errors），onFailure 再让
        // createPhaserGameRuntime 的 ready Promise 带着它 reject。
        this.reportError(error)
        onFailure(error)
      }
    }

    public update(_time: number, delta: number): void {
      this.frameTimes.push(delta)
      if (this.frameTimes.length > 120) this.frameTimes.shift()
      for (const behavior of this.behaviors) {
        try {
          behavior.update?.(delta)
        } catch (error) {
          // arch-guard:silent-catch-ok 不是吞错：reportError 进诊断表。一条玩法脚本每帧抛错
          // 不该把整幕拖垮——那会让「哪个脚本坏了」也一起看不见。
          this.reportError(error)
        }
      }
      this.drawOverlay()
    }

    public query(request: GameRuntimeQuery = { select: 'scene' }): GameRuntimeQueryResult {
      switch (request.select) {
        case undefined:
        case 'scene': {
          const renderedEntities = this.countRenderedEntities()
          return {
            select: 'scene',
            scene: options.scene.id,
            running: true,
            url: window.location.href,
            entityCount: this.records.size,
            renderedEntities,
            invisibleEntities: this.records.size - renderedEntities,
            fps: Number.isFinite(this.game.loop.actualFps)
              ? Math.round(this.game.loop.actualFps)
              : null,
            elapsedMs: Date.now() - this.startedAt,
          }
        }
        case 'selection':
          return {
            select: 'selection',
            entity: isNull(this.selectedEntityId)
              ? null
              : this.entitySnapshot(this.selectedEntityId),
          }
        case 'entity':
          return {
            select: 'entity',
            entity: this.entitySnapshot(request.entityId, request.components),
          }
        case 'entities': {
          const offset = Math.max(0, Math.round(request.offset ?? 0))
          const limit = normalizePageSize(request.limit, 50)
          const entities = [...this.records.keys()]
            .slice(offset, offset + limit)
            .map((id) => this.entitySnapshot(id))
          const nextOffset = offset + entities.length
          return {
            select: 'entities',
            entities,
            total: this.records.size,
            ...(nextOffset < this.records.size ? { nextOffset } : {}),
          }
        }
        case 'errors': {
          const errors = diagnostics.list()
          const offset = Math.max(0, Math.round(request.offset ?? 0))
          const limit = normalizePageSize(request.limit, 50)
          const page = errors.slice(offset, offset + limit)
          const nextOffset = offset + page.length
          return {
            select: 'errors',
            errors: page,
            total: errors.length,
            ...(nextOffset < errors.length ? { nextOffset } : {}),
          }
        }
      }

      const averageFrame =
        !isEmpty(this.frameTimes)
          ? this.frameTimes.reduce((sum, value) => sum + value, 0) / this.frameTimes.length
          : null
      return {
        select: 'perf',
        fps: {
          average: averageFrame && averageFrame > 0 ? Math.round(1000 / averageFrame) : null,
          minimum:
            !isEmpty(this.frameTimes) ? Math.round(1000 / Math.max(...this.frameTimes)) : null,
        },
        frameMs: {
          p50: percentile(this.frameTimes, 0.5),
          p95: percentile(this.frameTimes, 0.95),
        },
        entityCount: this.records.size,
      }
    }

    public selectEntity(entityId: string): GameRuntimeEntitySnapshot {
      const snapshot = this.entitySnapshot(entityId)
      this.selectedEntityId = entityId
      options.onSelection?.(snapshot)
      return snapshot
    }

    public setOverlayVisible(visible: boolean): void {
      this.overlayVisible = visible
      this.overlayGraphics?.setVisible(visible)
      this.overlayText?.setVisible(visible)
    }

    public dispose(): void {
      for (const behavior of this.behaviors) {
        try {
          behavior.dispose?.()
        } catch (error) {
          // arch-guard:silent-catch-ok 不是吞错：reportError 进诊断表；一条 dispose 失败不该
          // 阻断其余行为的清理。
          this.reportError(error)
        }
      }
      this.behaviors.length = 0
      this.records.clear()
    }

    private preloadAsset(asset: GameAssetManifest): void {
      switch (asset.kind) {
        case 'texture':
          this.load.image(asset.id, asset.path)
          break
        case 'spritesheet':
          if (!asset.frame) return
          this.load.spritesheet(asset.id, asset.path, {
            frameWidth: asset.frame.width,
            frameHeight: asset.frame.height,
            ...(asset.frame.count ? { endFrame: asset.frame.count - 1 } : {}),
          })
          break
        case 'audio':
          this.load.audio(asset.id, asset.path)
          break
        case 'tilemap':
          this.load.tilemapTiledJSON(asset.id, asset.path)
          break
        case 'font':
        case 'mesh':
          break
      }
    }

    private bindInputActions(): void {
      if (!this.input.keyboard) return
      for (const [action, bindings] of Object.entries(options.project.input.actions)) {
        this.actionKeys.set(
          action,
          bindings.map((binding) => this.input.keyboard!.addKey(normalizePhaserKeyBinding(binding)))
        )
      }
    }

    private createEntityObject(entity: GameResolvedEntity): CreatedVisual {
      const components = entity.components
      const transform = components.transform ?? {}
      const position = transform.position ?? {}
      const x = position.x ?? 0
      const y = position.y ?? 0
      const { object, rendered } = this.createVisual(entity.id, components, x, y)
      object.setName(entity.id)
      const rotation = transform.rotation
      object.setRotation(isNumber(rotation) ? rotation : (rotation?.z ?? 0))
      object.setScale(transform.scale?.x ?? 1, transform.scale?.y ?? 1)
      const layerIndex = Math.max(0, options.project.layers.indexOf(components.layer ?? ''))
      object.setDepth(layerIndex * 100_000 + (components.order ?? 0))

      if (components.body) this.attachBody(object, components)
      object.setInteractive().on('pointerdown', () => {
        this.selectEntity(entity.id)
      })
      this.createAnimations(object, components)
      return { object, rendered }
    }

    private configureCamera(): void {
      for (const record of this.records.values()) {
        const camera = record.manifest.components.camera
        if (camera?.kind !== 'follow') continue
        const targetId = camera.target ? gameReferenceId(camera.target) : record.manifest.id
        const target = this.records.get(targetId)
        if (!target) {
          this.reportError(
            new Error(`实体 ${record.manifest.id} 的 camera.target 找不到 entity:${targetId}。`)
          )
          continue
        }
        this.cameras.main.startFollow(target.object)
        this.cameras.main.setLerp(camera.lerp ?? 1, camera.lerp ?? 1)
      }
    }

    private createVisual(
      entityId: string,
      components: GameComponentMap,
      x: number,
      y: number
    ): CreatedVisual {
      const visual = components.visual
      if (visual?.kind === 'sprite') {
        if (!visual.asset) throw new Error('sprite visual 缺少 asset；清单 resolver 未完成校验。')
        const sprite = this.add.sprite(x, y, gameReferenceId(visual.asset))
        const [originX, originY] = anchorOrigin(visual.anchor ?? 'center')
        sprite.setOrigin(originX, originY)
        return { object: sprite as RuntimeGameObject, rendered: true }
      }
      if (visual?.kind === 'mesh') {
        diagnostics.report({
          source: 'runtime',
          message: 'V0 web-2d runtime 不投影 mesh visual；已用可见占位块代替。',
        })
        return {
          object: this.add.rectangle(x, y, 32, 32, 0xf43f5e) as RuntimeGameObject,
          rendered: true,
        }
      }
      if (visual?.kind === 'text')
        return {
          object: this.add.text(x, y, visual.text ?? '', {
            // text 走 Phaser 的 CSS 通道，所以原样交出去；先过一次同一个解析器只为了
            // **认不出来时出声**（否则 Phaser 会把它默默画成黑色）。
            color: this.cssColorText(visual.color, `实体 ${entityId} 的 visual.color`, '#ffffff'),
            fontSize: `${visual.size ?? 24}px`,
          }) as RuntimeGameObject,
          rendered: true,
        }
      if (visual?.kind === 'shape')
        return { object: this.createShapeVisual(entityId, visual, x, y), rendered: true }
      // 没有可投影的 `visual` —— 给一个不可见载体，让 transform / body / 点选仍然成立。
      // **它是「什么都看不见」那条信号的唯一来源**（见 {@link RuntimeEntityRecord.rendered}）。
      return {
        object: this.add.rectangle(x, y, 16, 16, 0xffffff, 0.001) as RuntimeGameObject,
        rendered: false,
      }
    }

    private createShapeVisual(
      entityId: string,
      visual: NonNullable<GameComponentMap['visual']>,
      x: number,
      y: number
    ): RuntimeGameObject {
      // alpha 是解析出来的第二格：8 位十六进制与 `rgba(…)` 过去连同颜色一起被丢掉，
      // 而 Phaser 的每个形状工厂最后一个参数正好就是它。
      const { color, alpha } = this.shapeColor(entityId, visual.color)
      switch (visual.shape) {
        case 'circle':
          return this.add.circle(x, y, visual.radius ?? 16, color, alpha) as RuntimeGameObject
        case 'ellipse':
          return this.add.ellipse(
            x,
            y,
            visual.width ?? 32,
            visual.height ?? 24,
            color,
            alpha
          ) as RuntimeGameObject
        case 'triangle': {
          const width = visual.width ?? 32
          const height = visual.height ?? 32
          return this.add.triangle(
            x,
            y,
            width / 2,
            0,
            0,
            height,
            width,
            height,
            color,
            alpha
          ) as RuntimeGameObject
        }
      }
      return this.add.rectangle(
        x,
        y,
        visual.width ?? 32,
        visual.height ?? 32,
        color,
        alpha
      ) as RuntimeGameObject
    }

    /**
     * 形状填充色 —— 认不出来时**出声**再回落，绝不静默换色（第十三轮 P1-1）。
     */
    private shapeColor(entityId: string, value: unknown): ResolvedVisualColor {
      const parsed = parseVisualColor(value)
      if (parsed) return parsed
      if (isPresent(value)) {
        this.reportError(
          new Error(
            describeUnreadableColor(`实体 ${entityId} 的 visual.color`, value, '#8b5cf6')
          )
        )
      }
      return { color: DefaultShapeColor, alpha: 1 }
    }

    /** CSS 通道（text / 背景）：原样透传，认不出来时出声并回落。 */
    private cssColorText(value: unknown, where: string, fallback: string): string {
      if (!isPresent(value)) return fallback
      if (isString(value) && isPresent(parseVisualColor(value))) return value
      this.reportError(new Error(describeUnreadableColor(where, value, fallback)))
      return fallback
    }

    private backgroundColor(): string {
      return this.cssColorText(
        options.scene.meta?.background,
        `scene:${options.scene.id} 的 meta.background`,
        '#0b1020'
      )
    }

    private countRenderedEntities(): number {
      let rendered = 0
      for (const record of this.records.values()) if (record.rendered) rendered += 1
      return rendered
    }

    /**
     * 「跑起来了但什么都看不见」的机械信号；判据与不误报的论证见 {@link describeUnrealizedVisual}。
     *
     * 计数（`renderedEntities` / `invisibleEntities`）与本诊断是两回事：**计数永远如实给**
     * （`game:query_state({select:'scene'})` 与 overlay 都读它），故意的纯调试场景在那里显示
     * `visible 0` —— 那是事实陈述，不是告警；本诊断一条都不会出。
     */
    private reportUnrealizedVisuals(): void {
      const unrealized: string[] = []
      for (const record of this.records.values()) {
        const message = describeUnrealizedVisual(record.manifest, record.rendered)
        if (isNull(message)) continue
        unrealized.push(record.manifest.id)
        this.reportError(new Error(message))
      }
      if (isEmpty(unrealized) || this.countRenderedEntities() > 0) return
      this.reportError(
        new Error(
          `场景 scene:${options.scene.id} 的 ${this.records.size} 个实体没有一个产生可见画面：这一帧上只有调试叠加层。上面 ${unrealized.length} 条实体诊断（${unrealized.join('、')}）说明了各自的原因。`
        )
      )
    }

    private attachBody(object: RuntimeGameObject, components: GameComponentMap): void {
      const bodySpec = components.body
      if (!bodySpec) return
      const bodyKind = bodySpec.kind ?? 'static'
      this.physics.add.existing(object, bodyKind === 'static')
      const body = object.body
      if (!body) return

      if (bodySpec.shape === 'circle' && bodySpec.radius) body.setCircle(bodySpec.radius)
      else if (bodySpec.width && bodySpec.height) body.setSize(bodySpec.width, bodySpec.height)

      if (isPresent(bodySpec.layer)) {
        const layerIndex = options.project.collisionLayers.indexOf(bodySpec.layer)
        if (layerIndex >= 0) body.setCollisionCategory(1 << layerIndex)
      }
      if (isPresent(bodySpec.collidesWith)) {
        const masks = bodySpec.collidesWith
          .map((layer) => options.project.collisionLayers.indexOf(layer))
          .filter((index) => index >= 0)
          .map((index) => 1 << index)
        body.setCollidesWith(masks)
      }

      if (isDynamicBody(body)) {
        if (bodyKind === 'kinematic') {
          body.allowGravity = false
          body.immovable = true
        } else {
          const worldGravity = options.scene.meta?.gravity?.y ?? 0
          body.gravity.y = worldGravity * ((bodySpec.gravityScale ?? 1) - 1)
        }
      }
    }

    private createColliders(): void {
      const objects = [...this.records.values()]
        .map((record) => record.object)
        .filter((object) => object.body)
      for (let left = 0; left < objects.length; left += 1) {
        for (let right = left + 1; right < objects.length; right += 1) {
          this.physics.add.collider(
            objects[left] as Phaser.Types.Physics.Arcade.ArcadeColliderType,
            objects[right] as Phaser.Types.Physics.Arcade.ArcadeColliderType
          )
        }
      }
    }

    private createAnimations(object: RuntimeGameObject, components: GameComponentMap): void {
      const animation = components.animation
      if (!animation || !(object instanceof PhaserRuntime.GameObjects.Sprite)) return
      for (const clip of animation.clips) {
        if (this.anims.exists(clip.name)) continue
        this.anims.create({
          key: clip.name,
          frames: this.anims.generateFrameNumbers(gameReferenceId(clip.asset)),
          frameRate: clip.fps ?? 12,
          repeat: clip.loop ? -1 : 0,
        })
      }
      if (animation.autoPlay) object.play(animation.autoPlay)
    }

    private createBehaviors(): void {
      const scripts = options.scripts ?? {}
      for (const record of this.records.values()) {
        const script = record.manifest.components.script
        if (!script?.module) continue
        const factory = scripts[script.module]
        if (!factory) {
          this.reportError(
            new Error(`实体 ${record.manifest.id} 引用了未注册脚本模块 ${script.module}。`)
          )
          continue
        }
        try {
          const behavior = factory(this.createScriptContext(record))
          this.behaviors.push(behavior)
          behavior.create?.()
        } catch (error) {
          // arch-guard:silent-catch-ok 不是吞错：reportError 进诊断表，模型下一轮读得到
          // 「哪个实体的脚本没起来」；单个脚本装不上不该让整幕不出画面。
          this.reportError(error)
        }
      }
    }

    private createScriptContext(record: RuntimeEntityRecord): GameEntityScriptContext {
      return {
        entityId: record.manifest.id,
        params: record.manifest.components.script?.params ?? {},
        getPosition: () => ({ x: record.object.x, y: record.object.y }),
        setPosition: (x, y) => {
          record.object.setPosition(x, y)
        },
        setVelocity: (x, y) => {
          if (!isDynamicBody(record.object.body)) return
          if (isNotUndefined(x)) record.object.body.velocity.x = x
          if (isNotUndefined(y)) record.object.body.velocity.y = y
        },
        isBlocked: (side) =>
          isDynamicBody(record.object.body) ? record.object.body.blocked[side] : false,
        isActionDown: (action) => !!this.actionKeys.get(action)?.some((key) => key.isDown),
        getEntity: (entityId) =>
          this.records.has(entityId) ? this.entitySnapshot(entityId) : null,
        getState: (key) => this.sharedState.get(key),
        setState: (key, value) => {
          this.sharedState.set(key, value)
        },
      }
    }

    private createOverlay(): void {
      const overlay = options.project.dev.overlay
      if (overlay.colliders || overlay.entityBounds) {
        this.overlayGraphics = this.add.graphics().setDepth(2_000_000_000).setScrollFactor(0)
      }
      if (overlay.logs) {
        this.overlayText = this.add
          .text(12, 12, '', {
            color: '#e2e8f0',
            backgroundColor: '#0f172acc',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: '12px',
            padding: { x: 8, y: 6 },
          })
          .setDepth(2_000_000_001)
          .setScrollFactor(0)
      }
    }

    private drawOverlay(): void {
      if (!this.overlayVisible) return
      const overlay = options.project.dev.overlay
      const graphics = this.overlayGraphics
      if (graphics) {
        graphics.clear()
        for (const [entityId, record] of this.records) {
          if (overlay.entityBounds) {
            graphics.lineStyle(
              entityId === this.selectedEntityId ? 2 : 1,
              entityId === this.selectedEntityId ? 0xa78bfa : 0x22d3ee,
              0.9
            )
            const bounds = record.object.getBounds()
            graphics.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height)
          }
          const body = record.object.body
          if (overlay.colliders && body) {
            graphics.lineStyle(1, 0xfbbf24, 0.9)
            graphics.strokeRect(body.x, body.y, body.width, body.height)
          }
        }
      }
      if (this.overlayText) {
        const lastError = diagnostics.list()[0]
        this.overlayText.setText([
          // `visible` 与 `game:query_state` 的 `renderedEntities` 是同一个数：人在截图上
          // 看到 `visible 0/3` 与模型读到的结构化事实必须逐字对应，不许两套算法。
          `scene:${options.scene.id} · entities ${this.records.size} · visible ${this.countRenderedEntities()}`,
          `selection:${this.selectedEntityId ?? 'none'} · errors ${diagnostics.list().length}`,
          ...(lastError ? [`${lastError.source}: ${lastError.message.slice(0, 90)}`] : []),
        ])
      }
    }

    private entitySnapshot(
      entityId: string,
      componentFilter?: readonly string[]
    ): GameRuntimeEntitySnapshot {
      const record = this.records.get(entityId)
      if (!record) {
        throw new Error(
          `找不到 entity:${entityId}。可用实体：${[...this.records.keys()].join(', ') || '(empty)'}`
        )
      }
      const body = record.object.body
      const runtimeComponents: Record<string, unknown> = {
        ...record.manifest.components,
        transform: {
          ...record.manifest.components.transform,
          position: { x: record.object.x, y: record.object.y },
          rotation: record.object.rotation,
          scale: { x: record.object.scaleX, y: record.object.scaleY },
        },
        ...(body
          ? {
              body: {
                ...record.manifest.components.body,
                ...(isDynamicBody(body)
                  ? {
                      velocity: { x: body.velocity.x, y: body.velocity.y },
                      blocked: { ...body.blocked },
                    }
                  : {}),
              },
            }
          : {}),
      }
      const components = componentFilter
        ? Object.fromEntries(
            componentFilter.flatMap((key) =>
              Object.hasOwn(runtimeComponents, key) ? [[key, runtimeComponents[key]]] : []
            )
          )
        : runtimeComponents
      return {
        id: record.manifest.id,
        ...(isUndefined(record.manifest.from) ? {} : { from: record.manifest.from }),
        tags: record.manifest.components.tags ?? [],
        components,
      }
    }

    private reportError(error: unknown): void {
      const normalized = error instanceof Error ? error : new Error(String(error))
      diagnostics.report({
        source: 'runtime',
        message: normalized.message,
        stack: toOptional(normalized.stack),
      })
      options.onError?.(normalized.message)
    }
  }
}

export class PhaserGameRuntime {
  private destroyed = false
  private pageApi: Nullable<VelarosGamePageApi> = null

  public constructor(
    private readonly game: Phaser.Game,
    private readonly bridge: ProjectionBridge,
    private readonly diagnostics: GameRuntimeDiagnostics,
    private readonly removeWindowCapture: () => void,
    private readonly inputActions: Readonly<Record<string, readonly string[]>>
  ) {}

  public query(request?: GameRuntimeQuery): GameRuntimeQueryResult {
    return this.bridge.query(request)
  }

  public selectEntity(entityId: string): GameRuntimeEntitySnapshot {
    return this.bridge.selectEntity(entityId)
  }

  public setOverlayVisible(visible: boolean): void {
    this.bridge.setOverlayVisible(visible)
  }

  public async input(
    steps: readonly GameInputStep[],
    options: {
      readonly repeat?: number
      readonly settleFrames?: number
      readonly captureAfter?: boolean
    } = {}
  ): Promise<GameInputResult> {
    const repeat = Math.min(20, Math.max(1, Math.round(options.repeat ?? 1)))
    const droppedSteps: Array<{ index: number; reason: string }> = []
    const applicableSteps: Array<{
      readonly index: number
      readonly step: GameInputStep
      readonly binding?: string
    }> = []
    for (const [index, step] of steps.entries()) {
      if (step.action !== 'press') {
        applicableSteps.push({ index, step })
        continue
      }
      const binding = this.inputActions[step.logicalAction]?.[0]
      if (binding) {
        applicableSteps.push({ index, step, binding })
        continue
      }
      droppedSteps.push({
        index,
        reason: `未知 logicalAction ${step.logicalAction}；可用动作：${
          Object.keys(this.inputActions).join(', ') || '当前为空'
        }`,
      })
    }
    let appliedSteps = 0

    for (let iteration = 0; iteration < repeat; iteration += 1) {
      for (const entry of applicableSteps) {
        const step = entry.step
        switch (step.action) {
          case 'press': {
            const binding = entry.binding
            if (!binding) throw new Error(`输入动作 ${step.logicalAction} 缺少已解析键位。`)
            dispatchKeyboardInput(binding, 'keydown')
            try {
              await waitForDuration(step.ms ?? 50)
            } finally {
              dispatchKeyboardInput(binding, 'keyup')
            }
            break
          }
          case 'key_down':
            dispatchKeyboardInput(step.key, 'keydown')
            break
          case 'key_up':
            dispatchKeyboardInput(step.key, 'keyup')
            break
          case 'move':
            this.dispatchPointerInput('pointermove', step.x, step.y)
            break
          case 'tap':
            this.dispatchPointerInput('pointerdown', step.x, step.y)
            this.dispatchPointerInput('pointerup', step.x, step.y)
            break
          case 'wait':
            await waitForDuration(step.ms)
        }
        appliedSteps += 1
      }
    }

    await waitForFrames(Math.min(120, Math.max(0, Math.round(options.settleFrames ?? 4))))
    const stateAfter = options.captureAfter
      ? (this.bridge.query({ select: 'scene' }) as GameRuntimeSceneSnapshot & {
          readonly select: 'scene'
        })
      : undefined
    return {
      appliedSteps,
      droppedSteps,
      ...(isUndefined(stateAfter) ? {} : { stateAfter }),
    }
  }

  public clearErrors(): void {
    this.diagnostics.clear()
  }

  public attachPageApi(pageApi: VelarosGamePageApi): void {
    this.pageApi = pageApi
  }

  private dispatchPointerInput(
    type: 'pointerdown' | 'pointermove' | 'pointerup',
    x: number,
    y: number
  ): void {
    const canvas = this.game.canvas
    const bounds = canvas.getBoundingClientRect()
    canvas.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: bounds.left + x,
        clientY: bounds.top + y,
        pointerId: 1,
        pointerType: 'mouse',
        ...(type === 'pointerup' ? { button: 0, buttons: 0 } : { button: 0, buttons: 1 }),
      })
    )
  }

  public destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.bridge.dispose()
    if (window.__velarosGame === this.pageApi) delete window.__velarosGame
    this.removeWindowCapture()
    this.game.destroy(true)
  }
}

export async function createPhaserGameRuntime(
  options: PhaserGameRuntimeOptions
): Promise<PhaserGameRuntime> {
  const PhaserRuntime = (await import('phaser')).default
  const diagnostics = new GameRuntimeDiagnostics()
  const removeWindowCapture = diagnostics.installWindowCapture()
  let resolveBridge: (bridge: ProjectionBridge) => void
  let rejectBridge: (error: unknown) => void
  const ready = new Promise<ProjectionBridge>((resolve, reject) => {
    resolveBridge = resolve
    rejectBridge = reject
  })
  const Scene = createProjectionSceneClass(
    PhaserRuntime,
    options,
    diagnostics,
    (bridge) => resolveBridge(bridge),
    (error) => rejectBridge(error)
  )
  const game = new PhaserRuntime.Game({
    type: PhaserRuntime.AUTO,
    parent: options.parent,
    width: options.project.runtime.canvas.width,
    height: options.project.runtime.canvas.height,
    pixelArt: options.project.runtime.pixelArt,
    physics: {
      default: 'arcade',
      arcade: {
        gravity: {
          x: options.scene.meta?.gravity?.x ?? 0,
          y: options.scene.meta?.gravity?.y ?? 0,
        },
      },
    },
    scene: Scene,
  })

  try {
    const bridge = await ready
    const runtime = new PhaserGameRuntime(
      game,
      bridge,
      diagnostics,
      removeWindowCapture,
      options.project.input.actions
    )
    const pageApi: VelarosGamePageApi = {
      query: (request) => runtime.query(request),
      input: (steps, inputOptions) => runtime.input(steps, inputOptions),
      selectEntity: (entityId) => runtime.selectEntity(entityId),
      setOverlayVisible: (visible) => runtime.setOverlayVisible(visible),
      clearErrors: () => runtime.clearErrors(),
    }
    runtime.attachPageApi(pageApi)
    window.__velarosGame = pageApi
    return runtime
  } catch (error) {
    removeWindowCapture()
    game.destroy(true)
    throw error
  }
}
