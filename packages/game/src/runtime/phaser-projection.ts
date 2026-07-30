import type Phaser from 'phaser'

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
  body?: Phaser.Physics.Arcade.Body | Phaser.Physics.Arcade.StaticBody | null
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
}

export interface GameEntityScriptContext {
  readonly entityId: string
  readonly params: Readonly<Record<string, unknown>>
  readonly getPosition: () => { readonly x: number; readonly y: number }
  readonly setPosition: (x: number, y: number) => void
  readonly setVelocity: (x: number | undefined, y: number | undefined) => void
  readonly isBlocked: (side: 'down' | 'left' | 'right' | 'up') => boolean
  readonly isActionDown: (action: string) => boolean
  readonly getEntity: (entityId: string) => GameRuntimeEntitySnapshot | null
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
  body: Phaser.Physics.Arcade.Body | Phaser.Physics.Arcade.StaticBody | null | undefined
): body is Phaser.Physics.Arcade.Body {
  return Boolean(body && 'velocity' in body && 'blocked' in body)
}

function hexColor(value: unknown, fallback: number): number {
  if (typeof value !== 'string') return fallback
  const normalized = value.replace(/^#/u, '')
  return /^[0-9a-f]{6}$/iu.test(normalized) ? Number.parseInt(normalized, 16) : fallback
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

function percentile(values: readonly number[], ratio: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] ?? null
}

function normalizePageSize(value: number | undefined, fallback: number): number {
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
  if (known !== undefined) return known
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

function waitForDuration(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, Math.min(60_000, Math.max(0, Math.round(ms))))
  })
}

async function waitForFrames(frameCount: number): Promise<void> {
  for (let index = 0; index < frameCount; index += 1) {
    await new Promise<void>((resolve) => {
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
    private overlayGraphics: Phaser.GameObjects.Graphics | null = null
    private overlayText: Phaser.GameObjects.Text | null = null
    private overlayVisible = true
    private selectedEntityId: string | null = null
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
        this.cameras.main.setBackgroundColor(options.scene.meta?.background ?? '#0b1020')
        this.bindInputActions()

        for (const entity of options.scene.entities) {
          const object = this.createEntityObject(entity)
          object.setInteractive()
          object.on('pointerdown', () => {
            this.selectEntity(entity.id)
          })
          this.records.set(entity.id, {
            manifest: entity,
            object,
          })
        }
        this.configureCamera()
        this.createColliders()
        this.createBehaviors()
        this.createOverlay()
        onReady(this)
      } catch (error) {
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
          this.reportError(error)
        }
      }
      this.drawOverlay()
    }

    public query(request: GameRuntimeQuery = { select: 'scene' }): GameRuntimeQueryResult {
      if (request.select === undefined || request.select === 'scene')
        return {
          select: 'scene',
          scene: options.scene.id,
          running: true,
          url: window.location.href,
          entityCount: this.records.size,
          fps: Number.isFinite(this.game.loop.actualFps)
            ? Math.round(this.game.loop.actualFps)
            : null,
          elapsedMs: Date.now() - this.startedAt,
        }
      if (request.select === 'selection')
        return {
          select: 'selection',
          entity:
            this.selectedEntityId === null ? null : this.entitySnapshot(this.selectedEntityId),
        }
      if (request.select === 'entity')
        return {
          select: 'entity',
          entity: this.entitySnapshot(request.entityId, request.components),
        }
      if (request.select === 'entities') {
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
      if (request.select === 'errors') {
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

      const averageFrame =
        this.frameTimes.length > 0
          ? this.frameTimes.reduce((sum, value) => sum + value, 0) / this.frameTimes.length
          : null
      return {
        select: 'perf',
        fps: {
          average: averageFrame && averageFrame > 0 ? Math.round(1000 / averageFrame) : null,
          minimum:
            this.frameTimes.length > 0 ? Math.round(1000 / Math.max(...this.frameTimes)) : null,
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

    private createEntityObject(entity: GameResolvedEntity): RuntimeGameObject {
      const components = entity.components
      const transform = components.transform ?? {}
      const position = transform.position ?? {}
      const x = position.x ?? 0
      const y = position.y ?? 0
      const object = this.createVisual(components, x, y)
      object.setName(entity.id)
      const rotation = transform.rotation
      object.setRotation(typeof rotation === 'number' ? rotation : (rotation?.z ?? 0))
      object.setScale(transform.scale?.x ?? 1, transform.scale?.y ?? 1)
      const layerIndex = Math.max(0, options.project.layers.indexOf(components.layer ?? ''))
      object.setDepth(layerIndex * 100_000 + (components.order ?? 0))

      if (components.body) this.attachBody(object, components)
      object.setInteractive().on('pointerdown', () => {
        this.selectEntity(entity.id)
      })
      this.createAnimations(object, components)
      return object
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

    private createVisual(components: GameComponentMap, x: number, y: number): RuntimeGameObject {
      const visual = components.visual
      if (visual?.kind === 'sprite') {
        if (!visual.asset) throw new Error('sprite visual 缺少 asset；清单 resolver 未完成校验。')
        const sprite = this.add.sprite(x, y, gameReferenceId(visual.asset))
        const [originX, originY] = anchorOrigin(visual.anchor ?? 'center')
        sprite.setOrigin(originX, originY)
        return sprite as RuntimeGameObject
      }
      if (visual?.kind === 'mesh') {
        diagnostics.report({
          source: 'runtime',
          message: 'V0 web-2d runtime 不投影 mesh visual；已用可见占位块代替。',
        })
        return this.add.rectangle(x, y, 32, 32, 0xf43f5e) as RuntimeGameObject
      }
      if (visual?.kind === 'text')
        return this.add.text(x, y, visual.text ?? '', {
          color: visual.color ?? '#ffffff',
          fontSize: `${visual.size ?? 24}px`,
        }) as RuntimeGameObject
      if (visual?.kind === 'shape') {
        const color = hexColor(visual.color, 0x8b5cf6)
        if (visual.shape === 'circle')
          return this.add.circle(x, y, visual.radius ?? 16, color) as RuntimeGameObject
        if (visual.shape === 'ellipse')
          return this.add.ellipse(
            x,
            y,
            visual.width ?? 32,
            visual.height ?? 24,
            color
          ) as RuntimeGameObject
        if (visual.shape === 'triangle') {
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
            color
          ) as RuntimeGameObject
        }
        return this.add.rectangle(
          x,
          y,
          visual.width ?? 32,
          visual.height ?? 32,
          color
        ) as RuntimeGameObject
      }
      return this.add.rectangle(x, y, 16, 16, 0xffffff, 0.001) as RuntimeGameObject
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

      if (bodySpec.layer != null) {
        const layerIndex = options.project.collisionLayers.indexOf(bodySpec.layer)
        if (layerIndex >= 0) body.setCollisionCategory(1 << layerIndex)
      }
      if (bodySpec.collidesWith != null) {
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
          if (x !== undefined) record.object.body.velocity.x = x
          if (y !== undefined) record.object.body.velocity.y = y
        },
        isBlocked: (side) =>
          isDynamicBody(record.object.body) ? record.object.body.blocked[side] : false,
        isActionDown: (action) => this.actionKeys.get(action)?.some((key) => key.isDown) ?? false,
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
          `scene:${options.scene.id} · entities ${this.records.size}`,
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
        ...(record.manifest.from === undefined ? {} : { from: record.manifest.from }),
        tags: record.manifest.components.tags ?? [],
        components,
      }
    }

    private reportError(error: unknown): void {
      const normalized = error instanceof Error ? error : new Error(String(error))
      diagnostics.report({
        source: 'runtime',
        message: normalized.message,
        ...(normalized.stack ? { stack: normalized.stack } : {}),
      })
      options.onError?.(normalized.message)
    }
  }
}

export class PhaserGameRuntime {
  private destroyed = false
  private pageApi: VelarosGamePageApi | null = null

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
      ...(stateAfter === undefined ? {} : { stateAfter }),
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
