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
  isNull,
  isNumber,
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

import {
  GameDefaultAssetsManifestPath,
  gameManifestIdFromPath,
  GameSlugSchema,
} from './references.js'
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
  /**
   * 不含 `hint` 的那一句正文。
   *
   * 重新包装一条清单错误（补一句更外层的出路）时必须用它，否则 `message` 会带着旧 `hint`
   * 再拼一遍新的，模型读到两段半重复的建议。
   */
  public readonly detail: string

  public constructor(
    code: GameManifestErrorCode,
    message: string,
    // `path` / `hint` 收 `Nullable`：**重新包装一条已有清单错误**（补一句更外层的出路）时，
    // 源错误的这两格本来就是 `Nullable<string>`，收窄成 `string?` 只会逼每个包装点写一次
    // 单属性条件展开。缺席与 null 在这里没有语义差别（都走 `toNullable`）。
    options: { path?: LooseOptional<string>; hint?: LooseOptional<string> } = {},
  ) {
    super(options.hint ? `${message}\n${options.hint}` : message)
    this.name = 'GameManifestError'
    this.code = code
    this.detail = message
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
   * 已经就这条字段路径说过话的位置（`$.entities[0].components.sprite` 这种全路径）。
   *
   * 归一器对同一个键可能有两条更贴切的话要说（「两个都写了，这次一个都没改」比泛泛的
   * 「未知字段」有用得多）。有了它，那条更贴切的话说完就把路径记下，`warnUnknownKeys`
   * 不再补一句同义的——**一个键一句话**，否则模型读到两段半重复的建议。
   */
  reported: Set<string>
  /**
   * 本次归一的清单来源（文件路径）。
   *
   * 归一器用它从文件名反推缺席的 `id`；`parseNormalized` 用它把「哪一份清单没过校验」
   * 写进错误正文——少了这一句，模型会把子清单的报错记在自己刚发的那次编辑头上。
   */
  sourceName: string
}

/**
 * 未知键所在位置的人话名字；**后果分档不写在这里**，见 {@link isConsequentialLevel}。
 */
const ManifestPositions = {
  animationComponent: 'animation 组件',
  assetEntry: '资产条目',
  assetsEnvelope: '资产清单信封',
  bodyComponent: 'body 组件',
  cameraComponent: 'camera 组件',
  canvasConfig: 'runtime.canvas 配置',
  components: '实体组件表',
  devConfig: 'dev 配置',
  devOverlayConfig: 'dev.overlay 配置',
  devServerConfig: 'dev.server 配置',
  entity: '实体块',
  inputConfig: 'input 配置',
  prefabEnvelope: 'prefab 清单信封',
  projectManifest: '工程清单',
  runtimeConfig: 'runtime 配置',
  sceneEnvelope: '场景清单信封',
  sceneMeta: '场景 meta',
  scriptComponent: 'script 组件',
  transformComponent: 'transform 组件',
  visualComponent: 'visual 组件',
} as const satisfies Readonly<Record<string, string>>

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
/** 场景 `meta` 的已知键；同时是「场景顶层写错位置」那条归一的落点表（见 {@link relocateSceneMetaKeys}）。 */
const KnownSceneMetaKeys = new Set(['background', 'gravity', 'title'])
const KnownTransformKeys = new Set(['position', 'rotation', 'scale'])
const KnownBodyKeys = new Set([
  'collidesWith',
  'gravityScale',
  'height',
  'kind',
  'layer',
  'radius',
  'shape',
  'width',
])
const KnownCameraKeys = new Set(['kind', 'lerp', 'target'])
const KnownAnimationKeys = new Set(['autoPlay', 'clips'])
const KnownScriptKeys = new Set(['module', 'params'])
/** `visual` 四种形态字段的并集；`kind` 已定时改用 {@link VisualKeysByKind} 逐形态收窄。 */
const KnownVisualKeys = new Set([
  'anchor',
  'asset',
  'color',
  'font',
  'height',
  'kind',
  'mesh',
  'radius',
  'shape',
  'size',
  'text',
  'width',
])
const VisualKeysByKind: Readonly<Record<string, ReadonlySet<string>>> = {
  mesh: new Set(['asset', 'kind', 'mesh']),
  shape: new Set(['color', 'height', 'kind', 'radius', 'shape', 'width']),
  sprite: new Set(['anchor', 'asset', 'kind']),
  text: new Set(['color', 'font', 'kind', 'size', 'text']),
}

/**
 * v0 清单里出现过的**每一个**已知键 —— 从上面那些表机械并起来，不是手抄的第二份。
 *
 * 唯一用途是给「这个名字在 schema 里被占用了吗」这种问题一个可证的答案
 * （见 {@link ComponentEntryDiscriminators}）：schema 长出新字段时它自动跟着长，
 * 于是靠它做判据的那些归一会自动收敛，而不是漂成一条过期的假设。
 */
const AllKnownManifestKeys: ReadonlySet<string> = new Set([
  ...KnownComponentKeys,
  ...KnownProjectKeys,
  ...KnownRuntimeKeys,
  ...KnownCanvasKeys,
  ...KnownInputKeys,
  ...KnownDevKeys,
  ...KnownServerKeys,
  ...KnownOverlayKeys,
  ...KnownSceneKeys,
  ...KnownPrefabKeys,
  ...KnownEntityKeys,
  ...KnownAssetsManifestKeys,
  ...KnownAssetKeys,
  ...KnownSceneMetaKeys,
  ...KnownTransformKeys,
  ...KnownBodyKeys,
  ...KnownCameraKeys,
  ...KnownAnimationKeys,
  ...KnownScriptKeys,
  ...KnownVisualKeys,
])

/**
 * 「这一层只装文件身份与人写注解」的键。
 *
 * 分档判据（{@link isConsequentialLevel}）唯一的输入。刻意**不含 `kind`**：
 * `visual.kind` / `body.kind` / `camera.kind` / 资产条目的 `kind` 全是判别值，写错就没画面；
 * 把它算成「身份」会让「只有 kind 与 notes」的层被判成温和档。宁可多说一句也不少说。
 */
const InertManifestKeys: ReadonlySet<string> = new Set(['id', 'notes'])

/**
 * 未知键的**后果分档** —— 从这一层的已知键集合**推导**，不再逐位置手写。
 *
 * ## 判决（第十三轮 P0-3）：手写分档判反了，而且判反的是最要紧的三层
 * 第十二轮把场景 / prefab / 资产清单的**信封**手写成 `consequential: false`，理由写的是
 * 「那一层的已知键是文件身份与人写注解」。那句话对 `KnownSceneKeys` / `KnownPrefabKeys` /
 * `KnownAssetsManifestKeys` **不成立**：它们的成员恰恰是 `entities` / `components` / `assets` /
 * `extends` / `meta`——全是最会变成画面的。于是「模型把整份内容写在信封的错名键下」
 * （`{"objects": [...]}`、`{"scene": {...}}`）得到的唯一一句话是**「它既不影响画面也不影响行为」**，
 * 比第十二轮之前那句「可以忽略」更肯定，而且是错的。
 *
 * 病灶不是那三行填错了，是**分档被手写**。判据本来就机械可证：
 * 这一层的已知键里只要有一个不是身份 / 注解，多写一个键就可能是「作者以为会生效」。
 * 推导之后，schema 长出新字段、`visual` 按 kind 收窄、将来真出现纯元数据层，
 * 分档全部自动跟上——没有第二份可以填错的表。
 *
 * v0 里第二档是**空集**：这就是结论本身。留着这条分支是让规则显式（将来真出现
 * `backendHints` 一类逃生舱时它自动落进温和档），而不是留一格给人去填。
 */
function isConsequentialLevel(known: ReadonlySet<string>): boolean {
  for (const key of known) {
    if (!InertManifestKeys.has(key)) return true
  }
  return false
}

/**
 * 组件层的**无歧义别名**：别名 → canonical 组件名。
 *
 * ## 收谁不收谁的判据（第十二轮判决；只收无歧义的，其余走分档警告）
 * 一条别名要被收进这张表，三条必须同时成立：
 *  1. **闭集内唯一目标**：这个名字在 v0 的九个组件里只能指向一个——接到别处会立刻违反那个键的 schema；
 *  2. **名字有依据**：它要么是本 schema 自己的词汇表（`visual.kind` 的成员名），要么是**真机第一手**
 *     观察到模型写出来的；「我觉得模型可能这么写」不算依据；
 *  3. **canonical 键不在场**：两个都写了 = 两种意图，归一等于替作者挑一个 —— 那一档走警告，不猜。
 *
 * ### 收
 *  - `sprite` / `text` —— `visual.kind` 的成员名，且这两个词在整份 schema 里只出现在 `visual` 下。
 *  - `collider` —— 真机第一手（模型把物理体写成 `collider`）。v0 只有一个物理组件，
 *    而且它的内容（`width/height/layer/collidesWith`）只有 `body` 能承载。
 *
 * ### 刻意不收（同类候选逐个判过）
 *  - `shape` —— **`shape` 同时是 `visual.shape` 与 `body.shape` 的字段名**。`components.shape`
 *    到底是「画个方块」还是「碰撞形状」没有唯一解，正是第 1 条要挡的那种歧义。
 *  - `rect` —— 它是 `visual.shape` 与 `body.shape` 的**取值**，同样两边都能读通。
 *  - `mesh` —— 名字虽唯一，但 V0 web-2d 根本不投影 mesh（只有占位块 + 一条诊断）。
 *    给一条不产画面的路加别名没有收益，只多一条静默改写路径。
 *  - `renderer` / `graphic` / `image` —— 不在本 schema 的词汇表里（第 2 条），而且 `renderer`
 *    在 Phaser 里指 WebGL 渲染器，是货真价实的反向含义。
 *  - `fill` / `tint` → `color` —— `tint` 在 Phaser 是**贴图乘色**而不是填充色（语义不同，
 *    归一会改变含义）；`fill` 是 SVG/canvas 词汇，且它隐含还有 `stroke` 这一半。
 *  - `size: { w, h }` → `width` / `height` —— **`size` 在本 schema 里已经有含义**
 *    （`TextVisualSchema.size` = 字号），`w` / `h` 也从不出现（我们用 `x/y/width/height`）。
 *    正面撞车 = 第 1 条判负。
 *
 * 表外的新形状**不靠猜补**：真机再抓到一次就按判据 2 的「真机第一手」补一行，成本是一行。
 */
const ComponentAliases: ReadonlyMap<string, string> = new Map([
  ['collider', 'body'],
  ['sprite', 'visual'],
  ['text', 'visual'],
])

/**
 * 别名写成裸字符串时的提升目标：`sprite: "asset:player"` → `visual: { asset: "asset:player" }`。
 *
 * 提升后不写 `kind`——让它照旧走既有的「由专属字段唯一推断」那条路（`asset` → sprite、
 * `text` → text），这样推断规则只有一份。
 */
const ComponentAliasScalarField: Readonly<Record<string, string>> = {
  sprite: 'asset',
  text: 'text',
}

/**
 * ECS 风组件数组（`components: [{ type: 'transform', … }, …]`）的判别键候选。
 *
 * ## 收谁的判据：**名字没被 schema 占用**，机械可证（不是「我觉得模型会这么写」）
 * 候选逐个过 {@link AllKnownManifestKeys}：只要这个名字在 v0 清单的**任何一层**是字段名，
 * 它就出局——那时 `{ kind: 'dynamic', width: 32 }` 到底是「一条 body 组件」还是「某个组件
 * 自己的 kind 字段」没有唯一解。于是：
 *  - 收 `type` / `component`：整份 v0 schema 里都不存在这两个字段名，它们出现在组件数组的条目上
 *    只可能是在说「这条是哪个组件」。
 *  - **不收 `kind`**：`visual.kind` / `body.kind` / `camera.kind` / 资产条目的 `kind` 都是字段名。
 *  - **不收 `name`**：`project.name` 与 `animation.clips[].name` 都在 schema 词汇表里，
 *    而且它们都不指组件。
 *
 * 过滤是在模块初始化时真的跑一遍，不是注释里的一句承诺：schema 将来长出 `type` 字段，
 * 这个候选自动掉出表，ECS 形态从此**大声失败**而不是被错读。
 */
const ComponentEntryDiscriminators: readonly string[] = ['component', 'type'].filter(
  (name) => !AllKnownManifestKeys.has(name),
)

/**
 * ECS 风数组 → 组件表：`[{ type:'visual', … }]` → `{ visual: { … } }`。
 *
 * ## 为什么归一而不是报错：这个形状**无歧义**
 * 条目自称是哪个组件（判别键的名字在 schema 里没被占用），而它自称的那个名字必须落在组件闭集
 * 或别名表里 —— 三条都成立时，把剩下的键当成那个组件的内容没有第二种读法。
 * 三条里任何一条不成立就**抛**（各有各的正文），绝不退回「按空表处理」。
 *
 * 判别值**原样保留**（`sprite` 不在这里就地换成 `visual`）：别名归一只有
 * {@link applyComponentAliases} 一份实现，`{type:'sprite'}` 与 `components.sprite` 于是走同一条路，
 * 连「两个都写了不替你挑一份」那一档都自动一致。
 */
function componentsFromEntryArray(
  items: readonly unknown[],
  field: string,
  context: NormalizationContext,
): Record<string, unknown> {
  const available = [...KnownComponentKeys].sort().join('、')
  const normalized: Record<string, unknown> = {}
  const claimed = new Set<string>()
  for (const [index, item] of items.entries()) {
    const at = `${field}[${index}]`
    if (!isRecord(item)) {
      throwUnreadableShape(at, item, '一条组件', 'ECS 风数组里的每一项都必须是组件对象。')
    }
    const discriminator = ComponentEntryDiscriminators.find((name) => isNonBlankString(item[name]))
    if (!discriminator) {
      throw new GameManifestError(
        'INVALID_MANIFEST',
        `${at} 没有说自己是哪个组件。`,
        {
          path: at,
          hint:
            `组件写成数组时，每一项要用 ${ComponentEntryDiscriminators.join(' 或 ')} 指明组件名`
            + `（可用：${available}），例如 { "${ComponentEntryDiscriminators[0]}": "transform", "position": { "x": 0 } }；`
            + '直接写成 { "transform": { … }, "visual": { … } } 这样的键值表也可以。'
            + '解析器不替你猜，这份文件一个字节都没动。',
        },
      )
    }
    const declared = (item[discriminator] as string).trim()
    const canonical = ComponentAliases.get(declared) ?? declared
    if (!KnownComponentKeys.has(canonical)) {
      throw new GameManifestError(
        'INVALID_MANIFEST',
        `${at}.${discriminator} 自称是组件 ${JSON.stringify(declared)}，而本运行时不认识它。`,
        {
          path: at,
          hint: `可用组件：${available}（别名：${[...ComponentAliases.keys()].sort().join('、')}）。`
            + '改成其中一个名字，或把这一项从数组里删掉——解析器不会替你把它丢掉。',
        },
      )
    }
    // 判据是**判别值本身**重不重，不是它们归一后撞不撞：`[{type:'sprite'},{type:'visual'}]`
    // 两个名字不同，两把键都留在表上，随后由 applyComponentAliases 出那句
    // 「两个都写了，这次一份都没合并」——与 `components:{sprite,visual}` 逐字同一档，
    // 而且内容两份都在盘上。只有**同一个名字写两次**才真的会有一份被键覆盖掉，那一档抛。
    if (claimed.has(declared)) {
      throw new GameManifestError(
        'INVALID_MANIFEST',
        `${field} 里 ${declared} 出现了两次。`,
        {
          path: at,
          hint: '组件表是按名字索引的，同一个名字写两条必然有一条被另一条盖掉——'
            + '解析器不替你挑一份。把它们合成一条再来。',
        },
      )
    }
    claimed.add(declared)
    normalized[declared] = Object.fromEntries(
      Object.entries(item).filter(([key]) => key !== discriminator),
    )
  }
  context.adjustments.push({
    field,
    action: 'aliased',
    detail: `ECS 风数组（${items.length} 项）已归一为组件表：每一项的 `
      + `${ComponentEntryDiscriminators.join('/')} 变成了键，其余字段变成了该组件的内容。`,
  })
  return normalized
}

/**
 * 组件表的形状归一 —— 对象原样；数组走 {@link componentsFromEntryArray}；其余交
 * {@link recordAt}（缺席 / null / 空数组静默，带内容的形状抛）。
 */
function componentsRecordAt(
  value: unknown,
  field: string,
  context: NormalizationContext,
): Record<string, unknown> {
  if (isArray(value) && !isEmpty(value)) return componentsFromEntryArray(value, field, context)
  return recordAt(value, field, context, '组件表')
}

/**
 * 自足 `visual` 里「只有 shape 能承载」的字段。
 *
 * `width` / `height` / `radius` 只在 `ShapeVisualSchema` 上存在；`color` 虽然 text 也有，
 * 但 text 必须带 `text` 字段，那一档在上一层的专属字段推断里已经命中。所以在一个**自足**的
 * visual 里，这四个字段中出现任何一个，判别联合里唯一还能被满足的成员就是 `shape`。
 */
const ShapeOnlyVisualFields = ['color', 'height', 'radius', 'width'] as const

/**
 * 组件闭集，供投影层复用（「这一帧只有调试层」的证据判据要用同一份表，不许抄第二份）。
 */
export const GameKnownComponentKeys: ReadonlySet<string> = KnownComponentKeys

/**
 * 实体**信封**的闭集，同样供投影层复用。
 *
 * 判决（第十三轮 P1-2）：空画面信号的证据判据过去只扫组件表，而
 * {@link relocateEntityComponents} 只搬名字在闭集或别名表里的键 —— 闭集**外**的
 * （`renderer` / `graphic` / `image` / 直接写在实体上的 `color`、`width`）原地留在信封上。
 * 于是「写了视觉意图 + 什么都没画」在运行期彻底无诊断，而回合上下文恰恰叫模型去
 * `game:query_state({select:'errors'})` 看原因 —— 那张表是空的。证据面必须与
 * 「未兑现的意图可能停在哪」一致，所以两层闭集都要给到投影层。
 */
export const GameKnownEntityKeys: ReadonlySet<string> = KnownEntityKeys

function isRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value)
}

/** 报错正文要先说「你写的是什么」，再说「我要什么」——只说后半句读起来像在怪对方。 */
function describeShape(value: unknown): string {
  if (isArray(value)) return `一个 ${value.length} 项的数组`
  if (isNull(value)) return 'null'
  if (isRecord(value)) return '一张键值表'
  if (isString(value)) return `字符串 ${JSON.stringify(value)}`
  if (isBoolean(value)) return `布尔值 ${String(value)}`
  if (isNumber(value)) return `数字 ${String(value)}`
  return `${typeof value} 值 ${JSON.stringify(value) ?? String(value)}`
}

/**
 * 解析器读不懂这个形状 —— **抛**。
 *
 * ## 判决（第十三轮主线）：猜不出来只有两个出口，丢掉不是其中之一
 * > 解析器遇到不认识的形状时，可以不理解它，但不许把它变没。
 *
 * 第十二轮之前这里是第三条出口：`recordOrEmpty` / `normalizedStringArray` 把读不懂的值
 * 静默摊成 `{}` / `[]`，只留一条 `action:'ignored'` 的 adjustment。而清单编辑器写盘写的是
 * **解析后的值**（`serializeWorkspace` → `formatGameManifest(entry.value)`），于是
 * 「一次带真实 operation 的 `game:scene_edit`」会把这份丢弃**写回磁盘**：ECS 风
 * `components: [...]` 变成 `{}`（实体不可见、`errors 0`、连空画面信号都不报，因为组件表是空的、
 * 没有闭集外键当证据），按 id 分组的 `entities: {...}` 整份消失（`diffSummary` 只说
 * 「added entity: …」，一个字不提删除）。这直接违反两条铁律：**写盘永远全保真**，以及
 * **一次编辑的报告必须与它对磁盘做的事逐字对应**。
 *
 * 抛出去在每一个调用点上都落到「零字节改动」：装载期被 `parseOrReport` 降级成 warning
 * （文件与声明原样保留、永不写盘，不变量 I4 因此仍然成立——一份坏场景不会打死
 * `target='project'`）；采纳 / 收尾重解时抛在 `writeBatch` 之前，整批拒绝、零文件落盘。
 * 所以正文里那句「一个字节都没动」在两条路径上都是真话。
 */
function throwUnreadableShape(
  field: string,
  value: unknown,
  expected: string,
  hint: string,
): never {
  throw new GameManifestError(
    'INVALID_MANIFEST',
    `${field} 是${describeShape(value)}，解析器读不出它想表达的${expected}。`,
    {
      path: field,
      hint:
        `${hint}\n`
        + '（解析器读不懂的内容永远不会被改写后写回磁盘：这份文件此刻一个字节都没动，'
        + '改成上面说的形状再发一次即可。）',
    },
  )
}

/**
 * 这一格必须是一张键值表 —— 读不懂就抛，**不再静默摊成 `{}`**。
 *
 * 只有三种「没有内容可丢」的形状被静默接受成空表：键缺席、显式 `null`、空数组
 * （后两种留痕）。任何**带着内容**的形状都走 {@link throwUnreadableShape}。
 */
function recordAt(
  value: unknown,
  field: string,
  context: NormalizationContext,
  expected = '键值表',
): Record<string, unknown> {
  if (isRecord(value)) return value
  if (isUndefined(value)) return {}
  if (isNull(value)) {
    context.adjustments.push({
      field,
      action: 'defaulted',
      detail: '显式 null 按「这一层什么都没写」处理（它本来就不带内容）。',
    })
    return {}
  }
  if (isArray(value) && isEmpty(value)) {
    context.adjustments.push({
      field,
      action: 'aliased',
      detail: '空数组已按空对象处理（两种写法都不含任何内容）。',
    })
    return {}
  }
  return throwUnreadableShape(
    field,
    value,
    expected,
    `${field} 要的是 { … } 形态的键值表。`,
  )
}

/**
 * 清单根 —— 只接受对象。
 *
 * 与 {@link recordAt} 分开是因为根没有「缺席」这一档：一份不是对象的清单文件不是半成品，
 * 是读不懂。把它摊成 `{}` 会在 canonical 重写时把原文整份换掉。
 */
function manifestRootRecord(
  value: unknown,
  context: NormalizationContext,
): Record<string, unknown> {
  if (isRecord(value)) return value
  return throwUnreadableShape(
    '$',
    value,
    '清单',
    `${context.sourceName} 的顶层必须是一个 JSON 对象（{ … }）。`,
  )
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

/**
 * 「这个数组的每一项都自带一个稳定名字」的位置 —— 那种位置才收得下按名字分组的对象 map。
 *
 * `entities` / `assets` / `animation.clips` 是同一个机械家族：条目里本来就有一格
 * （`id` / `id` / `name`）承载那个名字，所以 `{ player: { … } }` 的键**只能**是它，
 * 归一没有第二种解释。`scenes` / `prefabs` / `tags` / `layers` / `collidesWith` /
 * `input.actions.<name>` 都是**裸标量数组**，条目里没有任何一格能接住那个键——
 * 收下就等于把键丢掉，那正是本轮要根治的东西，所以那些位置一律走
 * {@link throwUnreadableShape}。
 */
interface KeyedArrayShape {
  /** 对象 map 的键写进条目的哪一格。 */
  readonly keyField: string
  /** 报错正文里这类条目的人话名字。 */
  readonly itemLabel: string
}

const EntityArrayShape: KeyedArrayShape = { keyField: 'id', itemLabel: '实体' }
const AssetEntryArrayShape: KeyedArrayShape = { keyField: 'id', itemLabel: '资产条目' }
const AnimationClipArrayShape: KeyedArrayShape = { keyField: 'name', itemLabel: '动画片段' }

/**
 * 这一格必须是数组 —— 读不懂就抛，**不再静默摊成 `[]`**（判决见 {@link throwUnreadableShape}）。
 *
 * 收下的宽容形态：
 *  - 键缺席 / 显式 `null` / 空对象 → 空数组（都不带内容，后两种留痕）；
 *  - 单个非空字符串 → 单元素数组（第十二轮就有的那条，未改）；
 *  - **按名字分组的对象 map** → 数组（只在 `shape` 给了 `keyField` 的位置，见 {@link KeyedArrayShape}）。
 */
function normalizedArray(
  value: unknown,
  field: string,
  context: NormalizationContext,
  shape: Nullable<KeyedArrayShape> = null,
): unknown[] {
  if (isArray(value)) return value
  if (isUndefined(value)) return []
  if (isNull(value)) {
    context.adjustments.push({
      field,
      action: 'defaulted',
      detail: '显式 null 按空数组处理（它本来就不带内容）。',
    })
    return []
  }
  if (isNonBlankString(value)) {
    context.adjustments.push({
      field,
      action: 'aliased',
      detail: '单个字符串已提升为单元素数组。',
    })
    return [value]
  }
  if (isRecord(value)) {
    if (isEmpty(Object.keys(value))) {
      context.adjustments.push({
        field,
        action: 'aliased',
        detail: '空对象已按空数组处理（两种写法都不含任何内容）。',
      })
      return []
    }
    if (shape) return keyedArrayFromRecord(value, field, context, shape)
    return throwUnreadableShape(
      field,
      value,
      '列表',
      `${field} 是一串裸值，条目里没有任何一格能接住你写的那些键——`
        + `收下就等于把键丢掉。改成 [ … ] 数组。`,
    )
  }
  return throwUnreadableShape(field, value, '列表', `${field} 要的是 [ … ] 数组。`)
}

/**
 * `{ player: { … }, ground: { … } }` → `[{ id: 'player', … }, { id: 'ground', … }]`。
 *
 * 键与条目里那一格**同时写了且不一样**时不猜：那是两种意图，替作者挑一个正是本面反复被抓的
 * 那类静默改写。顺序取 `Object.keys` 的插入序 —— JSON 对象的书写顺序，与作者看到的一致。
 */
function keyedArrayFromRecord(
  record: Record<string, unknown>,
  field: string,
  context: NormalizationContext,
  shape: KeyedArrayShape,
): unknown[] {
  const items = Object.entries(record).map(([key, item]) => {
    if (!isRecord(item)) throwUnreadableShape(
      `${field}.${key}`,
      item,
      `一条${shape.itemLabel}`,
      `按 ${shape.keyField} 分组的写法里，每个键的值必须是一条完整的${shape.itemLabel}对象。`,
    )
    const declared = item[shape.keyField]
    if (isNotUndefined(declared) && declared !== key) {
      throw new GameManifestError(
        'INVALID_MANIFEST',
        `${field}.${key} 的 ${shape.keyField} 写的是 ${JSON.stringify(declared)}，与它所在的键 `
          + `${JSON.stringify(key)} 对不上。`,
        {
          path: `${field}.${key}`,
          hint:
            `按 ${shape.keyField} 分组的写法里，键就是那条${shape.itemLabel}的 ${shape.keyField}；`
            + '两个名字不一样时解析器不替你挑一个。把它们改成同一个，或改用 [ … ] 数组写法。',
        },
      )
    }
    return { [shape.keyField]: key, ...item }
  })
  context.adjustments.push({
    field,
    action: 'aliased',
    detail: `按 ${shape.keyField} 分组的对象已归一为 ${items.length} 条的数组，`
      + `每个键写进了对应条目的 ${shape.keyField}。`,
  })
  return items
}

/**
 * 未知键 → 与后果相称的一句话（分档判据见 {@link isConsequentialLevel}）。
 *
 * 判据是「模型读完这句话应该知道要不要改」：
 *  - 第一档先说**后果**（这一项不会生效）、再说**为什么**（这一层只读哪些键）、最后给**出路**；
 *  - 第二档如实说「本运行时不解释它，也不影响任何东西」，不制造要改的错觉。
 *
 * 同一条路径已经被更贴切的一句话说过（`context.reported`）时闭嘴——一个键只说一次。
 */
function warnUnknownKeys(
  value: Record<string, unknown>,
  known: ReadonlySet<string>,
  path: string,
  context: NormalizationContext,
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !known.has(key))
  if (isEmpty(unknown)) return
  const available = [...known].sort().join('、')
  for (const key of unknown) {
    const field = `${path}.${key}`
    if (context.reported.has(field)) continue
    context.reported.add(field)
    context.warnings.push(
      isConsequentialLevel(known)
        ? `${field} 不会生效：${label}只读 [${available}]，${key} 不在其中——投影层不会去看它，你写它想要的那个效果不会发生。内容已原样留在文件里；改成上面某个名字、或搬到它真正该在的位置，才会有画面/行为。`
        : `${field}：${label}只装文件身份与人写注解，本运行时不解释这里多出来的键。已原样保留（前向兼容），它既不影响画面也不影响行为。`,
    )
  }
}

/** 已有更贴切的一句话时登记路径，让 {@link warnUnknownKeys} 不再补一句同义的。 */
function reportConflict(field: string, message: string, context: NormalizationContext): void {
  if (context.reported.has(field)) return
  context.reported.add(field)
  context.warnings.push(message)
}

function peekRecord(
  root: Record<string, unknown>,
  path: readonly string[],
): Nullable<Record<string, unknown>> {
  let node: unknown = root
  for (const segment of path) {
    if (!isRecord(node)) return null
    node = node[segment]
  }
  return isRecord(node) ? node : null
}

/**
 * 沿路径 clone-on-write，返回可写的目标容器。
 *
 * `cache` 保证同一条路径只 clone 一次——否则第二次搬运会把第一次的写入丢掉。
 */
function writableAt(
  rootClone: Record<string, unknown>,
  path: readonly string[],
  cache: Map<string, Record<string, unknown>>,
): Record<string, unknown> {
  const key = path.join('.')
  const cached = cache.get(key)
  if (cached) return cached
  if (isEmpty(path)) {
    cache.set(key, rootClone)
    return rootClone
  }
  const parent = writableAt(rootClone, path.slice(0, -1), cache)
  const name = path[path.length - 1]!
  const child = parent[name]
  const cloned = isRecord(child) ? { ...child } : {}
  parent[name] = cloned
  cache.set(key, cloned)
  return cloned
}

/**
 * 组件别名归一：`sprite` / `text` → `visual`，`collider` → `body`（判据见 {@link ComponentAliases}）。
 *
 * **canonical 键已经写了就不动**——那不是打错字，是两种意图；替作者挑一个才是最坏的静默改写。
 * 那一档在这里出一句点名两边的话，`warnUnknownKeys` 随后闭嘴（`context.reported`）。
 */
function applyComponentAliases(
  components: Record<string, unknown>,
  path: string,
  context: NormalizationContext,
): Record<string, unknown> {
  const normalized = { ...components }
  for (const [alias, canonical] of ComponentAliases) {
    if (!Object.hasOwn(normalized, alias)) continue
    if (isNotUndefined(normalized[canonical])) {
      reportConflict(
        `${path}.${alias}`,
        `${path}.${alias} 不会生效：${path}.${canonical} 已经写了。${alias} 是 ${canonical} 的别名，`
          + `两个都收下就等于替你挑一份——这次一份都没合并。把两者合成一个 ${canonical} 再来。`,
        context,
      )
      continue
    }
    const raw = normalized[alias]
    const scalarField = ComponentAliasScalarField[alias]
    const lifted = isString(raw) && isPresent(scalarField)
    normalized[canonical] = lifted ? { [scalarField]: raw } : raw
    delete normalized[alias]
    context.adjustments.push({
      field: `${path}.${canonical}`,
      action: 'aliased',
      detail: lifted
        ? `组件 ${alias} 已归一为 ${canonical}，裸字符串提升为 ${canonical}.${scalarField}；投影层只读 ${canonical}。`
        : `组件 ${alias} 已归一为 ${canonical}；投影层只读 ${canonical}，原名不会出画面。`,
    })
  }
  return normalized
}

/**
 * `visual.kind` 的推断与 `shape` 的缺省 —— **只在这份 visual 自足时才做**。
 *
 * `selfContained` = 这个实体没有 `from`、所在清单也没有 `extends`。为什么必须有这道闸：
 * 补丁语义下 `{ visual: { color: '#f00' } }` 的意思是「把继承来的那个 visual 改个颜色」，
 * 在那里推断出 `kind:'shape'` 会把继承来的 sprite 整个换成一个方块 —— 那正是 V0-2 判决④
 * 立下的规矩（「visual 允许只写最小实例补丁，resolver 在合并后再严格校验」）。
 * 自足时不存在可被覆盖的基底，推断因此是纯收益。
 */
function normalizeVisual(
  input: Record<string, unknown>,
  path: string,
  context: NormalizationContext,
  selfContained: boolean,
): Record<string, unknown> {
  const visual = { ...input }
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
        `${path}.kind 无法唯一推断；候选为 ${candidates.join(', ')}。`,
        {
          path: `${path}.kind`,
          hint: '显式填写 visual.kind，并只保留该 kind 对应的专属字段。',
        },
      )
    }
    if (candidates.length === 1) {
      visual.kind = candidates[0]
      context.adjustments.push({
        field: `${path}.kind`,
        action: 'defaulted',
        detail: `由专属字段唯一推断为 ${candidates[0]}。`,
      })
    } else if (selfContained) {
      const evidence = ShapeOnlyVisualFields.filter((field) => isNotUndefined(visual[field]))
      if (!isEmpty(evidence)) {
        visual.kind = 'shape'
        context.adjustments.push({
          field: `${path}.kind`,
          action: 'defaulted',
          detail: `写了 ${evidence.join(' / ')} 却没写 kind：sprite/mesh/text 都要各自的必填字段，`
            + '判别联合里唯一还能被满足的是 shape，已按 shape 投影（这样它才会真的出画面）。',
        })
      }
    }
  }
  if (visual.kind === 'shape' && isUndefined(visual.shape) && selfContained) {
    const inferred = isNotUndefined(visual.radius)
      && isUndefined(visual.width)
      && isUndefined(visual.height)
      ? 'circle'
      : 'rect'
    visual.shape = inferred
    context.adjustments.push({
      field: `${path}.shape`,
      action: 'defaulted',
      detail: `shape 是必填判别值，缺席时按现有尺寸字段补为 ${inferred}。`,
    })
  }
  if (
    visual.kind === 'mesh' &&
    isUndefined(visual.asset) &&
    isString(visual.mesh)
  ) {
    visual.asset = visual.mesh
    delete visual.mesh
    context.adjustments.push({
      field: `${path}.asset`,
      action: 'aliased',
      detail: 'mesh 专属字段已归一为通用 asset 引用。',
    })
  }
  if (isNotUndefined(visual.size)) {
    visual.size = normalizedNumber(visual.size, `${path}.size`, context)
  }
  // kind 已定时按该形态收窄：`visual:{kind:'sprite', width:64}` 的 width 投影层根本不读，
  // 而它读起来像「把精灵缩放到 64」——这正是要大声说清的那一档。
  const known = isString(visual.kind) && isPresent(VisualKeysByKind[visual.kind])
    ? VisualKeysByKind[visual.kind]!
    : KnownVisualKeys
  warnUnknownKeys(visual, known, path, context, ManifestPositions.visualComponent)
  return visual
}

/** 值本身是一张表的那几个组件槽（`tags` / `layer` / `order` 是标量，不在此列）。 */
const RecordComponentSlots = [
  'animation',
  'body',
  'camera',
  'script',
  'transform',
  'visual',
] as const

/**
 * 每个组件槽的形状归一。
 *
 * 缺席与显式 `null` **原样透传**：`{ visual: null }` 在补丁语义下是「把继承来的 visual 清掉」，
 * 归一成 `{}` 会把这条真语义吞掉。其余一律过 {@link recordAt}——读不懂时抛我们自己那句
 * 「你写的是什么 / 这一格要什么」，而不是让 zod 在判别联合上回一句光秃秃的 `Invalid input`
 * （它连收到了什么都不说，模型无从下手）。
 */
function normalizeComponentSlots(
  components: Record<string, unknown>,
  path: string,
  context: NormalizationContext,
): Record<string, unknown> {
  const normalized = { ...components }
  for (const slot of RecordComponentSlots) {
    const value = normalized[slot]
    if (isUndefined(value) || isNull(value)) continue
    normalized[slot] = recordAt(value, `${path}.${slot}`, context, `「${slot}」组件`)
  }
  return normalized
}

function normalizeComponents(
  value: unknown,
  path: string,
  context: NormalizationContext,
  selfContained: boolean,
): Record<string, unknown> {
  const aliased = applyComponentAliases(componentsRecordAt(value, path, context), path, context)
  warnUnknownKeys(aliased, KnownComponentKeys, path, context, ManifestPositions.components)
  const components = normalizeComponentSlots(aliased, path, context)
  const normalized = { ...components }

  if (isRecord(components.transform)) {
    warnUnknownKeys(
      components.transform,
      KnownTransformKeys,
      `${path}.transform`,
      context,
      ManifestPositions.transformComponent,
    )
  }

  if (isRecord(components.visual)) {
    normalized.visual = normalizeVisual(
      components.visual,
      `${path}.visual`,
      context,
      selfContained,
    )
  }

  if (isRecord(components.body)) {
    const body = { ...components.body }
    for (const key of ['width', 'height', 'radius', 'gravityScale'] as const) {
      if (isNotUndefined(body[key])) {
        body[key] = normalizedNumber(body[key], `${path}.body.${key}`, context)
      }
    }
    if (isNotUndefined(body.collidesWith)) {
      body.collidesWith = normalizedArray(
        body.collidesWith,
        `${path}.body.collidesWith`,
        context,
      )
    }
    warnUnknownKeys(body, KnownBodyKeys, `${path}.body`, context, ManifestPositions.bodyComponent)
    normalized.body = body
  }

  if (isRecord(components.camera)) {
    warnUnknownKeys(
      components.camera,
      KnownCameraKeys,
      `${path}.camera`,
      context,
      ManifestPositions.cameraComponent,
    )
    normalized.camera = { ...components.camera }
  }

  if (isRecord(components.script)) {
    // `script.params` 是给玩法代码的纯数据，schema 本来就不解释它——所以这里只看 script 自己
    // 这一层，绝不下探 params（下探等于对着「我们本来就不该懂的东西」报未知）。
    warnUnknownKeys(
      components.script,
      KnownScriptKeys,
      `${path}.script`,
      context,
      ManifestPositions.scriptComponent,
    )
  }

  if (isRecord(components.animation)) {
    warnUnknownKeys(
      components.animation,
      KnownAnimationKeys,
      `${path}.animation`,
      context,
      ManifestPositions.animationComponent,
    )
    const clips = normalizedArray(
      components.animation.clips,
      `${path}.animation.clips`,
      context,
      AnimationClipArrayShape,
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
    normalized.tags = normalizedArray(components.tags, `${path}.tags`, context)
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

/**
 * 组件写在**实体信封**上（`entity.sprite` 而不是 `entity.components.sprite`）→ 搬进 `components`。
 *
 * 判据与组件别名同源：只搬名字在组件闭集（或别名表）里、且 `components` 下那一格还空着的。
 * 原名原样搬进去，接着由 {@link applyComponentAliases} 统一归一 —— 推断规则只有一份。
 */
function relocateEntityComponents(
  entity: Record<string, unknown>,
  path: string,
  context: NormalizationContext,
): Record<string, unknown> {
  const strays = Object.keys(entity).filter(
    (key) => !KnownEntityKeys.has(key)
      && (KnownComponentKeys.has(key) || ComponentAliases.has(key)),
  )
  if (isEmpty(strays)) return entity
  const normalized = { ...entity }
  const components = isRecord(normalized.components) ? { ...normalized.components } : {}
  for (const key of strays) {
    const canonical = ComponentAliases.get(key) ?? key
    if (isNotUndefined(components[key]) || isNotUndefined(components[canonical])) {
      reportConflict(
        `${path}.${key}`,
        `${path}.${key} 不会生效：components 下已经有 ${canonical} 了。组件只在 components 下被读取，`
          + `实体块上这一份是多余的第二种意图——这次一份都没合并，把两者合成一个再来。`,
        context,
      )
      continue
    }
    components[key] = normalized[key]
    delete normalized[key]
    context.adjustments.push({
      field: `${path}.components.${key}`,
      action: 'aliased',
      detail: `组件 ${key} 写在实体块上，已搬进 components——投影层只读 components 下的组件。`,
    })
  }
  normalized.components = components
  return normalized
}

/**
 * 场景顶层写了本该在 `meta` 里的键（`gravity` / `background` / `title`）→ 搬进 `meta`。
 *
 * 这三个名字在整份场景 schema 里只有 `meta` 这一个落点，所以是无歧义搬运而不是猜测。
 */
function relocateSceneMetaKeys(
  manifest: Record<string, unknown>,
  context: NormalizationContext,
): Record<string, unknown> {
  const strays = Object.keys(manifest).filter(
    (key) => !KnownSceneKeys.has(key) && KnownSceneMetaKeys.has(key),
  )
  if (isEmpty(strays)) return manifest
  const normalized = { ...manifest }
  const meta = isRecord(normalized.meta) ? { ...normalized.meta } : {}
  for (const key of strays) {
    if (isNotUndefined(meta[key])) {
      reportConflict(
        `$.${key}`,
        `$.${key} 不会生效：$.meta.${key} 已经写了，这次不替你挑一份。删掉顶层这一份即可。`,
        context,
      )
      continue
    }
    meta[key] = normalized[key]
    delete normalized[key]
    context.adjustments.push({
      field: `$.meta.${key}`,
      action: 'aliased',
      detail: `${key} 写在场景顶层，已搬进 meta——运行时只从 meta 读背景与重力。`,
    })
  }
  normalized.meta = meta
  return normalized
}

function normalizeSceneLike(
  value: unknown,
  expectedKind: 'prefab' | 'scene',
  context: NormalizationContext,
): Record<string, unknown> {
  const parsed = manifestRootRecord(value, context)
  const manifest = expectedKind === 'scene' ? relocateSceneMetaKeys(parsed, context) : parsed
  warnUnknownKeys(
    manifest,
    expectedKind === 'scene' ? KnownSceneKeys : KnownPrefabKeys,
    '$',
    context,
    expectedKind === 'scene'
      ? ManifestPositions.sceneEnvelope
      : ManifestPositions.prefabEnvelope,
  )
  const extendsReference = defaulted(manifest.extends, null, '$.extends', context)
  const normalized: Record<string, unknown> = {
    ...manifest,
    ...(isPresent(manifest.id) ? {} : withIdFromSourceName(context)),
    kind: defaulted(manifest.kind, expectedKind, '$.kind', context),
    extends: extendsReference,
  }
  // 「自足」= 这份清单不继承任何基底。只有这时 visual 的推断才不可能覆盖继承来的判别字段。
  const manifestSelfContained = !isPresent(extendsReference)

  if (isRecord(manifest.meta)) {
    warnUnknownKeys(manifest.meta, KnownSceneMetaKeys, '$.meta', context, ManifestPositions.sceneMeta)
  }

  if (expectedKind === 'prefab') {
    normalized.components = normalizeComponents(
      manifest.components,
      '$.components',
      context,
      manifestSelfContained,
    )
    return normalized
  }

  const entities = normalizedArray(manifest.entities, '$.entities', context, EntityArrayShape)
  normalized.entities = entities.map((rawEntity, index) => {
    const path = `$.entities[${index}]`
    if (!isRecord(rawEntity)) {
      throw new GameManifestError(
        'INVALID_MANIFEST',
        `${path} 必须是对象，不能在 canonical 写盘前静默丢弃。`,
        {
          path,
          hint: '把该项改成包含 id 与 components 的实体对象，或显式从 entities 数组删除该项。',
        },
      )
    }
    const entity = relocateEntityComponents(rawEntity, path, context)
    warnUnknownKeys(entity, KnownEntityKeys, path, context, ManifestPositions.entity)
    if (isTrue(entity.remove) && isUndefined(entity.components)) return { ...entity }
    return {
      ...entity,
      components: normalizeComponents(
        entity.components,
        `${path}.components`,
        context,
        manifestSelfContained && !isPresent(entity.from),
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
  const items = normalizedArray(value, field, context).map((item, index) => {
    if (!isRecord(item) || !isString(item.path)) return item
    // `path` 之外还写了别的键时**不降回字符串**：这一格只装路径，降下去那些键就没了，
    // 而「静默丢掉」正是本轮要根治的东西。唯一例外是对路径的**冗余复述**（`id` 与文件名
    // 推出来的那个 slug 逐字相同）——那一格丢掉不损失任何信息。
    const extras = Object.keys(item).filter((key) => key !== 'path')
    const restated = isString(item.id) && item.id.trim() === gameManifestIdFromPath(item.path)
    if (!extras.every((key) => key === 'id' && restated)) {
      throw new GameManifestError(
        'INVALID_MANIFEST',
        `${field}[${index}] 除了 path 还写了 ${extras.join('、')}，而 ${field} 只装工程内相对路径。`,
        {
          path: `${field}[${index}]`,
          hint:
            `把这一项写成路径字符串 ${JSON.stringify(item.path)}；`
            + `清单自己的 id、备注这些属于 ${item.path} 那份文件的内容，写在它里面。`
            + '（解析器不会把这些键降到路径里丢掉，所以这次一个字节都没写。）',
        },
      )
    }
    context.adjustments.push({
      field: `${field}[${index}]`,
      action: 'aliased',
      detail: `对象形态已归一为路径字符串 ${JSON.stringify(item.path)}`
        + `${isPresent(item.id) ? `（同时写下的 id 与文件名推出来的 slug 逐字相同，是冗余复述）` : ''}。`,
    })
    return item.path
  })
  return dedupedPaths(items, field, context)
}

/**
 * 同一条路径在一个声明数组里出现两次 = 纯粹的重复，去掉不丢任何信息。
 *
 * 判决（第十轮，真机第一手）：`scenes:['scenes/a.scene.json','scenes/a.scene.json']` 过去让
 * **六个 target 全死**——装载按路径去重只留一份，声明数组却原样带着两项，激活阶段于是把同一份
 * 场景推进拓扑两次，解析器的 `indexUnique` 抛「scene id 重复：a」。那句话既点不出文件、
 * 也没有可执行动作，而制造这个状态只需要一次 `project:edit`。
 *
 * 这里去重而不是报错，是「钳制不拒绝」：重复项没有第二种解释，报错只能让模型自己猜要删哪一条。
 * 与 I1 不冲突——路径仍然被声明着，只是不再声明两遍。
 */
function dedupedPaths(
  items: readonly unknown[],
  field: string,
  context: NormalizationContext,
): unknown[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (!isString(item)) return true
    if (!seen.has(item)) {
      seen.add(item)
      return true
    }
    context.adjustments.push({
      field,
      action: 'ignored',
      detail: `重复声明的路径 ${JSON.stringify(item)} 已合并为一条。`,
    })
    return false
  })
}

/**
 * `entryScene` 的宽容归一：裸 slug 与已声明的场景路径都收敛成 `scene:<slug>` 引用。
 *
 * `game:run` 的 `scene` 参数早就这么归一（GameRunSchema 的 transform，真机日志里
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

interface ProjectManifestLevel {
  readonly path: readonly string[]
  readonly keys: ReadonlySet<string>
  readonly label: string
}

/** 工程清单的层级表 —— 未知键检测与「唯一落点」搬运共用同一份，不许各写一遍。 */
const ProjectManifestLevels: readonly ProjectManifestLevel[] = [
  { path: [], keys: KnownProjectKeys, label: ManifestPositions.projectManifest },
  { path: ['runtime'], keys: KnownRuntimeKeys, label: ManifestPositions.runtimeConfig },
  { path: ['runtime', 'canvas'], keys: KnownCanvasKeys, label: ManifestPositions.canvasConfig },
  { path: ['input'], keys: KnownInputKeys, label: ManifestPositions.inputConfig },
  { path: ['dev'], keys: KnownDevKeys, label: ManifestPositions.devConfig },
  { path: ['dev', 'server'], keys: KnownServerKeys, label: ManifestPositions.devServerConfig },
  { path: ['dev', 'overlay'], keys: KnownOverlayKeys, label: ManifestPositions.devOverlayConfig },
]

/**
 * 「这个名字在整份工程清单里只有一个落点」的索引 —— **从层级表推导，不是手写清单**。
 *
 * 真机第一手：模型把 `pixelArt` / `canvasWidth` / `canvasHeight` 写在工程顶层，而 schema 里
 * 它们在 `runtime` / `runtime.canvas` 下。三个都被当成未知字段轻声警告掉，画布配置整段没生效。
 *
 * 收它们的判据不是「我认得这三个名字」，而是**机械可证的唯一性**：
 *  - 叶子名（`pixelArt`、`width`、`port`、`actions`、`colliders`…）在整棵树里只出现一次；
 *  - 驼峰复合名（`canvasWidth` = 容器名 + 叶子名）同理。
 * 出现两次的一律不进索引（歧义），与顶层已知键撞名的也不进（那不是错位）。
 * 这样「哪些该搬」由 schema 形状自己决定，schema 长出新字段时索引跟着长，不会漂。
 */
function buildProjectRelocationIndex(): ReadonlyMap<string, readonly string[]> {
  const candidates = new Map<string, Array<readonly string[]>>()
  const register = (name: string, target: readonly string[]): void => {
    const existing = candidates.get(name)
    if (existing) existing.push(target)
    else candidates.set(name, [target])
  }
  for (const level of ProjectManifestLevels) {
    if (isEmpty(level.path)) continue
    const container = level.path[level.path.length - 1]!
    for (const key of level.keys) {
      const target = [...level.path, key]
      register(key, target)
      register(`${container}${key[0]!.toUpperCase()}${key.slice(1)}`, target)
    }
  }
  const index = new Map<string, readonly string[]>()
  for (const [name, targets] of candidates) {
    if (targets.length !== 1 || KnownProjectKeys.has(name)) continue
    index.set(name, targets[0]!)
  }
  return index
}

const ProjectRelocationIndex = buildProjectRelocationIndex()

/**
 * 把工程清单里写错位置的键搬到它唯一的落点（`$.canvasWidth` → `$.runtime.canvas.width`）。
 *
 * 目标格已经有值时**不搬**：那是两种意图，替作者挑一个是最坏的静默改写；那一档出一句
 * 点名两边的话，`warnUnknownKeys` 随后闭嘴。搬运一律记 `appliedAdjustments`。
 */
function relocateProjectKeys(
  project: Record<string, unknown>,
  context: NormalizationContext,
): Record<string, unknown> {
  const moves: Array<{ from: readonly string[]; key: string; to: readonly string[] }> = []
  const claimed = new Set<string>()
  for (const level of ProjectManifestLevels) {
    const container = peekRecord(project, level.path)
    if (!container) continue
    for (const key of Object.keys(container)) {
      if (level.keys.has(key)) continue
      const target = ProjectRelocationIndex.get(key)
      if (!target) continue
      const targetContainer = target.slice(0, -1)
      if (targetContainer.join('.') === level.path.join('.')) continue
      const source = `$.${[...level.path, key].join('.')}`
      const destination = `$.${target.join('.')}`
      const occupied = peekRecord(project, targetContainer)?.[target[target.length - 1]!]
      if (isNotUndefined(occupied) || claimed.has(destination)) {
        reportConflict(
          source,
          `${source} 不会生效：它说的是 ${destination}，而那一格已经有值了——两个都收下就等于替你挑一份。`
            + `删掉其中一份（${destination} 是 canonical 位置）再来。`,
          context,
        )
        continue
      }
      claimed.add(destination)
      moves.push({ from: level.path, key, to: target })
    }
  }
  if (isEmpty(moves)) return project

  const rootClone = { ...project }
  const cache = new Map<string, Record<string, unknown>>()
  for (const move of moves) {
    const source = writableAt(rootClone, move.from, cache)
    const value = source[move.key]
    delete source[move.key]
    writableAt(rootClone, move.to.slice(0, -1), cache)[move.to[move.to.length - 1]!] = value
    context.adjustments.push({
      field: `$.${move.to.join('.')}`,
      action: 'aliased',
      detail: `$.${[...move.from, move.key].join('.')} 写错了位置，已搬到这里`
        + '（这个名字在整份工程 schema 里只有这一个落点，所以是搬运不是猜测）。',
    })
  }
  return rootClone
}

function normalizeProject(value: unknown, context: NormalizationContext): Record<string, unknown> {
  const project = relocateProjectKeys(manifestRootRecord(value, context), context)
  const runtime = recordAt(project.runtime, '$.runtime', context)
  const canvas = recordAt(runtime.canvas, '$.runtime.canvas', context)
  const input = recordAt(project.input, '$.input', context)
  const actions = recordAt(input.actions, '$.input.actions', context)
  const dev = recordAt(project.dev, '$.dev', context)
  const server = recordAt(dev.server, '$.dev.server', context)
  const overlay = recordAt(dev.overlay, '$.dev.overlay', context)
  const scenes = normalizedPathArray(project.scenes, '$.scenes', context)
  warnUnknownKeys(project, KnownProjectKeys, '$', context, ManifestPositions.projectManifest)
  warnUnknownKeys(runtime, KnownRuntimeKeys, '$.runtime', context, ManifestPositions.runtimeConfig)
  warnUnknownKeys(canvas, KnownCanvasKeys, '$.runtime.canvas', context, ManifestPositions.canvasConfig)
  warnUnknownKeys(input, KnownInputKeys, '$.input', context, ManifestPositions.inputConfig)
  warnUnknownKeys(dev, KnownDevKeys, '$.dev', context, ManifestPositions.devConfig)
  warnUnknownKeys(server, KnownServerKeys, '$.dev.server', context, ManifestPositions.devServerConfig)
  warnUnknownKeys(overlay, KnownOverlayKeys, '$.dev.overlay', context, ManifestPositions.devOverlayConfig)
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
    assets: defaulted(project.assets, GameDefaultAssetsManifestPath, '$.assets', context),
    layers: isUndefined(project.layers)
      ? defaulted(project.layers, ['background', 'actors', 'ui'], '$.layers', context)
      : normalizedArray(project.layers, '$.layers', context),
    collisionLayers: isUndefined(project.collisionLayers)
      ? defaulted(project.collisionLayers, [], '$.collisionLayers', context)
      : normalizedArray(project.collisionLayers, '$.collisionLayers', context),
    input: {
      ...input,
      actions: Object.fromEntries(
        Object.entries(actions).map(([name, bindings]) => [
          name,
          normalizedArray(bindings, `$.input.actions.${name}`, context),
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
  const manifest = manifestRootRecord(value, context)
  const assets = normalizedArray(manifest.assets, '$.assets', context, AssetEntryArrayShape)
  warnUnknownKeys(manifest, KnownAssetsManifestKeys, '$', context, ManifestPositions.assetsEnvelope)
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
      warnUnknownKeys(asset, KnownAssetKeys, `$.assets[${index}]`, context, ManifestPositions.assetEntry)
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
  const context: NormalizationContext = {
    adjustments: [],
    warnings: [],
    reported: new Set<string>(),
    sourceName,
  }
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
