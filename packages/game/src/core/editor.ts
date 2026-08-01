import {
  isArray,
  isEmpty,
  isPlainObject,
  isPresent,
  isString,
  toNullable,
} from '@velaros-ai/core'
import type { AppliedAdjustment } from '@velaros-ai/core/utils/ForgivingSchema'

import { formatGameManifest } from './formatter.js'
import {
  GameManifestError,
  parseGameAssetsManifestText,
  parseGamePrefabManifestText,
  parseGameProjectManifestText,
  parseGameSceneManifestText,
} from './manifest-parser.js'
import {
  gameManifestIdFromPath,
  GameProjectDirectories,
  GameProjectRelativePathSchema,
  type GameReference,
  gameReferenceId,
  GameSlugSchema,
} from './references.js'
import {
  applyGameMergePatch,
  GameManifestResolver,
  type GameManifestSourceSet,
} from './resolver.js'
import type {
  GameAssetManifest,
  GameAssetsManifest,
  GameEntityManifest,
  GamePrefabManifest,
  GameProjectManifest,
  GameSceneManifest,
} from './schemas.js'

export type GameManifestEditTarget =
  | 'assets'
  | 'project'
  | GameReference<'prefab'>
  | GameReference<'scene'>

export type GameManifestEditOperation =
  | {
      readonly action: 'set_entity'
      readonly entityId: string
      readonly from?: LooseOptional<GameReference<'prefab'>>
      readonly components?: Readonly<Record<string, unknown>>
    }
  | { readonly action: 'remove_entity'; readonly entityId: string }
  | { readonly action: 'rename_entity'; readonly entityId: string; readonly newId: string }
  | {
      readonly action: 'set_component'
      readonly entityId?: string
      readonly component: string
      readonly values: Readonly<Record<string, unknown>>
    }
  | {
      readonly action: 'remove_component'
      readonly entityId?: string
      readonly component: string
    }
  | { readonly action: 'set_scene_meta'; readonly values: Readonly<Record<string, unknown>> }
  | {
      readonly action: 'set_asset'
      readonly assetId: string
      readonly values: Readonly<Record<string, unknown>>
    }
  | { readonly action: 'remove_asset'; readonly assetId: string }
  | { readonly action: 'set_project'; readonly values: Readonly<Record<string, unknown>> }

export interface GameManifestEditRequest {
  readonly target: GameManifestEditTarget
  readonly operations: readonly GameManifestEditOperation[]
  readonly reason?: string
  readonly dryRun?: boolean
}

export interface GameManifestEditResult {
  readonly ok: true
  readonly target: GameManifestEditTarget
  readonly changedFiles: readonly string[]
  readonly operationsApplied: number
  readonly diffSummary: readonly string[]
  readonly warnings: readonly string[]
  readonly appliedAdjustments: readonly AppliedAdjustment[]
  readonly dryRun: boolean
}

export interface GameManifestDocument {
  readonly path: string
  readonly text: string
  readonly revision: string
}

export interface GameManifestDocumentChange {
  readonly path: string
  readonly text: string
  readonly expectedRevision: string
  /**
   * 该路径尚不存在，本次写入即创建（宿主必须以「不存在」为前提做原子创建）。
   *
   * 判决：用显式字段而不是把 `expectedRevision` 留空当哨兵——哨兵会让「读到空文件」与
   * 「文件不存在」在写入端长得一样，冲突检测于是变成一道假门。`create` 为真时
   * `expectedRevision` 只是留痕，不参与比对。
   */
  readonly create?: boolean
}

/**
 * Host-owned project-root-confined storage.
 *
 * Implementations must reject absolute/traversing paths and commit writeBatch atomically.
 * The editor supplies the revision it read so concurrent human/agent edits fail closed.
 */
export interface GameManifestDocumentStore {
  readonly read: (path: string) => Promise<Nullable<GameManifestDocument>>
  /**
   * 工程内所有 `*.scene.json` / `*.prefab.json` 的有界扫描（跳过 `node_modules` / 构建产物 /
   * 点开头目录，不跟随符号链接）。
   *
   * 判决（第八轮）：这是「一个稳定 id 在工程里只许有一个载体」这条不变量的**唯一取证通道**。
   * 上一版只扫 `prefabs/` 一个目录，于是模型按文档许可的那条路手写
   * `levels/main.scene.json`（id=main）之后，`target:'scene:main'` 照样在 `scenes/main.scene.json`
   * 另起一份空清单，手写那份连同实体一起被跳过、全程零提示。扫描面必须与「模型能把文件写到
   * 哪里」一致，否则这条不变量就是文档里的一句空话。
   *
   * 编辑器只在**真的要采纳或创建一份清单**时才调用它，并在单次 `edit` 内记忆结果；
   * 编辑一份已声明的清单一次盘都不走。
   */
  readonly listManifests: () => Promise<readonly GameManifestDocument[]>
  readonly writeBatch: (changes: readonly GameManifestDocumentChange[]) => Promise<void>
}

export interface GameSceneEditorPort {
  readonly isAvailable: () => boolean
  readonly edit: (request: GameManifestEditRequest) => Promise<GameManifestEditResult>
}

interface ParsedDocument<T> {
  readonly document: GameManifestDocument
  value: T
}

/**
 * 自举账：本次编辑里「磁盘上还不存在、由基线顶上」的路径，以及它们在摘要里的创建行。
 *
 * 单独拎成一个类型是因为工程清单必须在 {@link LoadedWorkspace} 组装出来**之前**就读到
 * （它决定了后面要装载哪些文档），而那一步同样可能自举。
 */
interface GameBootstrapLedger {
  /** 「磁盘上还不存在、由自举基线顶上」的清单路径；提交时一律写成创建。 */
  readonly bootstrapPaths: Set<string>
  /**
   * 本次编辑的 diffSummary 累加器 —— **只有这一份**。
   *
   * 判决（第七轮）：创建行必须与语义操作行同框。第六轮把自举摊到了三个站点
   * （装载期的声明扫描、目标解析、`set_project` 的声明投影），但只有中间那个
   * 往 diffSummary 里写行，于是「`set_project` 顺手建了一份空场景」这件事在结果里**完全看不见**
   * ——文档却写着「创建会在 changedFiles / diffSummary 里如实点名」。累加器收口到这里，
   * 任何一个自举站点都写得进同一份摘要。
   */
  readonly summaries: string[]
}

/** 装载那一刻，一条**已声明**清单在磁盘上的样子——不变量 I1（禁静默摘除）的基线。 */
interface DeclaredManifestSnapshot {
  readonly kind: 'assets' | 'prefab' | 'scene'
  /** canonical 形态与「空基线」不同 = 里面有东西，摘掉声明就是丢内容。 */
  readonly hasContent: boolean
}

interface LoadedWorkspace extends GameBootstrapLedger {
  project: ParsedDocument<GameProjectManifest>
  scenes: Array<ParsedDocument<GameSceneManifest>>
  prefabs: Array<ParsedDocument<GamePrefabManifest>>
  assets: ParsedDocument<GameAssetsManifest>
  /**
   * 装载时 `game.project.json` 声明的每一条清单路径 → 它当时的内容状态。
   *
   * 不变量 I1 只需要这一份快照：编辑结束时把它与「现在还声明着什么」一比，差集就是本次
   * **摘除**掉的声明。判据与是谁摘的、怎么摘的、id 能不能从路径推出来全都无关。
   */
  readonly declaredAtLoad: Map<string, DeclaredManifestSnapshot>
  /**
   * 工程内清单扫描的**单次 edit 记忆**：null = 这次调用还没扫过。
   *
   * 走盘只发生在「要采纳或创建一份清单」时；编辑已声明的清单一次都不扫。
   */
  manifestScan: Nullable<readonly GameManifestDocument[]>
  /**
   * 每份文档**刚被解析出来那一刻**的 canonical 形态 —— 变更判定的基线。
   *
   * 判决（第九轮）：这份基线过去是在 `loadWorkspace` **返回之后**才由
   * {@link serializeWorkspace} 现算的，于是装载期就地修好的声明（见
   * {@link GameManifestWorkspaceEditor.loadDeclaredManifest}）与它自己相等，
   * `changedFiles` 空、修复永不落盘、下一次调用再修一遍——摘要行说做了、磁盘上没做。
   * 基线必须在**修复之前**取，所以由装载逐份记账，而不是事后整体现算。
   */
  readonly canonicalAtLoad: Map<string, string>
  warnings: string[]
  adjustments: AppliedAdjustment[]
}

/**
 * 空工程根的自举基线。
 *
 * 判决（为什么在编辑器里而不是在宿主装配期落盘）：清单编辑器是工程清单的**唯一写者**，
 * 把「工程还不存在」这件事交给它处理，六个 game 工具的可用性就只依赖一次显式编辑，
 * 而不是依赖某个装配路径上的隐式副作用（那种副作用一旦漏在某条路径上，表现为
 * 「工具全部隐身、模型反复搜索」——正是本轮真机抓到的形态）。
 *
 * 基线刻意最小：解析器对缺席字段全部给默认值（canvas 960x540、layers 三层、
 * assets 指向 `assets/assets.json`），所以这里只写解析器**没有**默认值的 `name`。
 * 工程名与其余配置由模型随后 `set_project` 覆盖。
 */
const GameProjectBootstrapText = `{
  "name": "game",
  "schemaChannel": "v0"
}
`
const GameAssetsBootstrapText = formatGameManifest({ assets: [] })

/**
 * 场景 / prefab 的自举基线。
 *
 * 走 canonical formatter 而不是手写 JSON 字面量：自举文档一落盘就是这个格式，写两遍必漂。
 * 内容是「合法的空清单」——`id` 显式写出（不靠解析器从文件名反推，那会白留一条 adjustment），
 * 其余交给随后的语义操作填。
 */
function gameSceneBootstrapText(id: string): string {
  return formatGameManifest({ id, kind: 'scene', extends: null, entities: [] })
}

function gamePrefabBootstrapText(id: string): string {
  return formatGameManifest({ id, kind: 'prefab', extends: null, components: {} })
}

/**
 * 稳定 id → **新建**时的默认落点（`GameProjectDirectories` 是布局单源）。
 *
 * 这不是一条被强制的 id↔路径映射：`project.scenes` 接受任意工程内相对路径，
 * `levels/main.scene.json` 声明 `id: main` 是合法状态。真正被强制的只有「一个 (kind,id) 至多
 * 一个载体」（见 {@link GameManifestWorkspaceEditor.assertBootstrapIdIsFree}），
 * 而已有载体时走的是采纳，根本用不到这个默认值。
 */
function gameSceneManifestPath(id: string): string {
  return `${GameProjectDirectories.scenes}/${id}.scene.json`
}

function gamePrefabManifestPath(id: string): string {
  return `${GameProjectDirectories.prefabs}/${id}.prefab.json`
}

/**
 * 「这份清单是不是一个空壳」—— 判据是 **canonical 形态与自举基线逐字节相同**。
 *
 * 不手数 `entities.length` / `Object.keys(components).length`：那种谓词每加一个可选字段
 * （`meta` / `notes` / `extends`）就漏一格，正是本面前七轮反复复发的形状。与基线比字节
 * 只有一个单源（自举文本本身），加字段自动跟上。
 */
function isEmptySceneManifest(value: GameSceneManifest): boolean {
  return formatGameManifest(value) === gameSceneBootstrapText(value.id)
}

function isEmptyPrefabManifest(value: GamePrefabManifest): boolean {
  return formatGameManifest(value) === gamePrefabBootstrapText(value.id)
}

function isEmptyAssetsManifest(value: GameAssetsManifest): boolean {
  return formatGameManifest(value) === GameAssetsBootstrapText
}
/** 自举文档的占位 revision：`create` 为真时宿主不比对它（见 GameManifestDocumentChange）。 */
const GameBootstrapRevision = ''

function cloneRecord<T>(value: T): T {
  return structuredClone(value)
}

function withoutKey(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([candidate]) => candidate !== key),
  )
}

function requireDocument(
  document: Nullable<GameManifestDocument>,
  path: string,
): GameManifestDocument {
  if (document) {
    if (document.path !== path) {
      throw new GameManifestError(
        'INVALID_MANIFEST',
        `文档存储读取 ${path} 时返回了不匹配的路径 ${document.path}。`,
        {
          path,
          hint: '宿主文档端口必须保持请求路径与返回路径一一对应。',
        },
      )
    }
    return document
  }
  throw new GameManifestError('INVALID_REFERENCE', `找不到游戏清单 ${path}。`, {
    path,
    hint: '先读取 game.project.json，确认工程清单声明的相对路径仍存在。',
  })
}

/**
 * 宿主文档端口回来的路径必须仍是工程内相对路径。
 *
 * **只查「在不在工程内」，不查「在不在某个目录下」**（判决，真机踩过）：清单路径是工程清单
 * 自己声明的、已经过 `GameProjectRelativePathSchema` 收窄，宿主只是原样回声。加一条目录前缀
 * 断言等于凭空规定「场景必须放 `scenes/`、资产清单必须放 `assets/`」，而这条规定既没写进
 * schema 也没写进任何提示词；模型把场景建在 `assets/scenes/main.scene.json` 就会撞上一句
 * 「宿主返回了工程边界外的清单路径」——既冤枉（路径就在工程内）又无从下手（说的是宿主的错）。
 */
function assertProjectDocumentPath(path: string): void {
  if (!GameProjectRelativePathSchema.safeParse(path).success) {
    throw new GameManifestError(
      'INVALID_MANIFEST',
      `宿主返回了工程边界外的清单路径 ${path}。`,
      {
        path,
        hint: '文档存储端口必须把 list/read 结果限制在当前游戏工程根内。',
      },
    )
  }
}

function summary(action: string, target: string): string {
  return `${action}: ${target}`
}

/**
 * 每个动作对「目标清单不存在」的态度 —— **本编辑器唯一的创建判据**。
 *
 * ## 判决（第八轮）：目标不再被**预先**物化
 * 第六轮把创建做成无条件前置，第七轮改成「这一批里出现 `remove_*` / `rename_*` 就不创建」，
 * 论据是「这四个动作在一份刚建出的空清单上没有一条可能成立」。**该论据被实测证伪**：
 * `[set_entity hero, rename_entity hero→player]` 打在一份不存在的场景上被判死，而同一批
 * 打在一份已存在的空场景上两条全成立——判据只看「批次里出现过什么」，却忽略批内在先的
 * `set_*` 已经把清单填满了。凡是「预测这一批会怎样」的判据，都要为它没预见到的顺序赔一条回归。
 *
 * 现在物化是**惰性**的：目标在第一条真要写进它的操作到达时才被创建，`remove_*` / `rename_*`
 * 先跑就自然找不到目标、报出「可用 scene：…」。行为**由操作顺序本身决定**，不需要任何前提论证，
 * 也就没有可以被证伪的前提。
 *
 * 表本身是 `Record<action, …>`：闭集加一个动作，编译器当场要求它表态，不会像 `Set` 那样
 * 静默落进默认分支。
 */
const GameEditTargetIntentByAction: Record<
  GameManifestEditOperation['action'],
  'assert' | 'upsert'
> = {
  remove_asset: 'assert',
  remove_component: 'assert',
  remove_entity: 'assert',
  rename_entity: 'assert',
  set_asset: 'upsert',
  set_component: 'upsert',
  set_entity: 'upsert',
  set_project: 'upsert',
  set_scene_meta: 'upsert',
}

/**
 * 「工程里本来有哪些 scene / prefab」。
 *
 * **本次调用自举出来的不算**：它们还没落盘，而且这句提示存在的意义正是让模型看清自己
 * 打错的那个名字不在列——把刚建出来的 `scene:levl-1` 也列进「可用」是自相矛盾的。
 */
function availableTargetsHint(
  workspace: LoadedWorkspace,
  target: GameManifestEditTarget,
): string {
  const existing = (
    target.startsWith('scene:')
      ? (workspace.scenes as ReadonlyArray<ParsedDocument<GamePrefabManifest | GameSceneManifest>>)
      : workspace.prefabs
  ).filter((candidate) => !workspace.bootstrapPaths.has(candidate.document.path))
  const kind = target.startsWith('scene:') ? 'scene' : 'prefab'
  return `可用 ${kind}：${
    existing.map((candidate) => `${kind}:${candidate.value.id}`).join(', ') || '当前为空'
  }`
}

/**
 * 目标不存在，而这条操作断言它已经存在 —— **不创建，报错**。
 *
 * 主线判决（第七轮，保留）：永远不许拿「你是不是想说」的报错，去换一次静默创建。
 * 场景名只打错一个字母时，「找不到编辑目标，可用的是这几个」这句是模型一步自纠的唯一抓手。
 *
 * 第八轮改的只有理由那一句：正文不再断言「本批含 remove_*，它们在空清单上不可能成立」
 * （那是个被实测证伪的前提），只说**这条操作**要求目标已存在。走到这里时工程内清单已经
 * 扫过一遍，所以「也没有任何未声明的文件自称是它」是一句可以负责的话。
 */
function throwMissingEditTarget(
  workspace: LoadedWorkspace,
  target: GameManifestEditTarget,
  action: GameManifestEditOperation['action'],
): never {
  throw new GameManifestError('INVALID_REFERENCE', `找不到编辑目标 ${target}。`, {
    hint:
      `${availableTargetsHint(workspace, target)}；工程目录里也没有任何文件自称是 ${target}。` +
      `${action} 要求目标清单已经存在，所以编辑器不会顺手把它建出来。` +
      'target 打错了就照上面改；确实要新建这份清单，就让本批的第一条操作是 set_*（或单发一批空 operations）。',
  })
}

/**
 * 目标里找不到这个实体。
 *
 * 附带一句「这份清单是本次调用刚建出来的」——那正是第七轮抓到的误导形态：
 * 打错 target 的批次先建出空场景，报错于是变成「scene:levl-1 中找不到 entity:enemy」，
 * 模型顺着去建实体，拼写错从此不可见。事实（这个目标本来不存在）我们手里就有，说出来即可，
 * 不需要靠「预测这一批会怎样」去把创建拦掉。
 */
function requireSceneEntity(
  workspace: LoadedWorkspace,
  entry: ParsedDocument<GameSceneManifest>,
  entityId: string,
): GameEntityManifest {
  const scene = entry.value
  const entity = scene.entities.find((candidate) => candidate.id === entityId)
  if (entity) return entity
  const freshTarget = workspace.bootstrapPaths.has(entry.document.path)
    ? `\nscene:${scene.id} 是本次调用刚创建的（工程里原本没有这份清单）。` +
      `如果你本来想编辑一份已有场景，${availableTargetsHint(workspace, `scene:${scene.id}`)}。`
    : ''
  throw new GameManifestError(
    'INVALID_REFERENCE',
    `scene:${scene.id} 中找不到 entity:${entityId}。`,
    {
      hint: `可用 entity id：${
        scene.entities.map((candidate) => candidate.id).join(', ') || '当前为空'
      }${freshTarget}`,
    },
  )
}

function requireEntityId(
  operation: { readonly action: string; readonly entityId?: string },
  target: string,
): string {
  if (operation.entityId) return operation.entityId
  throw new GameManifestError(
    'INVALID_MANIFEST',
    `${operation.action} 作用于 ${target} 时必须提供 entityId。`,
  )
}

function replaceEntityReferences(
  value: unknown,
  oldReference: GameReference<'entity'>,
  nextReference: GameReference<'entity'>,
): unknown {
  if (value === oldReference) return nextReference
  if (isArray(value)) return value.map((item) => replaceEntityReferences(item, oldReference, nextReference))
  if (!isPlainObject(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      replaceEntityReferences(nested, oldReference, nextReference),
    ]),
  )
}

function sceneDescendsFrom(
  scene: GameSceneManifest,
  ancestorId: string,
  index: ReadonlyMap<string, GameSceneManifest>,
): boolean {
  const seen = new Set<string>()
  let current = scene
  while (current.extends) {
    const parentId = gameReferenceId(current.extends)
    if (parentId === ancestorId) return true
    if (seen.has(parentId)) return false
    seen.add(parentId)
    const parent = index.get(parentId)
    if (!parent) return false
    current = parent
  }
  return false
}

function collectParseResult(
  workspace: LoadedWorkspace,
  result: {
    readonly warnings: readonly string[]
    readonly appliedAdjustments: readonly AppliedAdjustment[]
  },
): void {
  workspace.warnings.push(...result.warnings)
  workspace.adjustments.push(...result.appliedAdjustments)
}

function sourceSet(workspace: LoadedWorkspace): GameManifestSourceSet {
  const declaredPrefabPaths = new Set(workspace.project.value.prefabs)
  return {
    project: workspace.project.value,
    scenes: workspace.scenes.map((entry) => entry.value),
    prefabs: workspace.prefabs
      .filter((entry) => declaredPrefabPaths.has(entry.document.path))
      .map((entry) => entry.value),
    assets: workspace.assets.value,
  }
}

/**
 * 拓扑里的每一份清单 → 它此刻应有的 canonical 文本。
 *
 * **一条规则**：进了工程声明的清单一律按值 canonical 重写。第七轮这里分了三档
 * （装载时就声明的 / 被指名为 target 采纳的 / 由 `set_project` 顺手声明的草稿保留原文），
 * 而 scene 与 assets 从来都是无条件 canonical——同一个概念在 prefab 上多出一档例外，
 * 就是下一个「为什么这份文件没被格式化」的坑。规范化不丢内容（解析 → 重排键序），
 * 而「未被声明的草稿不许动」这一半由**它根本不在这张表里**保证。
 */
function serializeWorkspace(workspace: LoadedWorkspace): Map<string, string> {
  return new Map([
    [workspace.project.document.path, formatGameManifest(workspace.project.value)],
    ...workspace.scenes.map(
      (entry) =>
        [entry.document.path, formatGameManifest(entry.value)] as const,
    ),
    ...workspace.prefabs.map(
      (entry) => [entry.document.path, formatGameManifest(entry.value)] as const,
    ),
    [workspace.assets.document.path, formatGameManifest(workspace.assets.value)],
  ])
}

/**
 * 拓扑里的每一份文档 + 它扮演的角色 —— **变更清单与「一条路径一个角色」同源于此**。
 *
 * 判决（第九轮）：`edit` 过去自己把 `[project, ...scenes, ...prefabs, assets]` 平铺一遍去算
 * 变更，而文本来自按**路径**收敛的 {@link serializeWorkspace}。两处键法不同，路径重合时就产出
 * 两条同路径 change（实测：`set_project({assets:'prefabs/player.prefab.json'})`），真实宿主把
 * 「同批重复路径」当硬错整批拒，模型拿到的是一句内部实现口吻、无自救动作的话。
 * 收口成一份带角色标签的清单：判读与提交读同一张表，`assertOneRolePerPath` 于是**结构上**
 * 覆盖得住喂给提交的每一格。
 */
function topologyDocuments(
  workspace: LoadedWorkspace,
): ReadonlyArray<{ readonly role: string; readonly document: GameManifestDocument }> {
  return [
    { role: '工程清单', document: workspace.project.document },
    ...workspace.scenes.map((entry) => ({
      role: `scene:${entry.value.id}`,
      document: entry.document,
    })),
    ...workspace.prefabs.map((entry) => ({
      role: `prefab:${entry.value.id}`,
      document: entry.document,
    })),
    { role: '资产清单', document: workspace.assets.document },
  ]
}

/** 一次 `edit` 能落在的四种清单文档之一。 */
type GameManifestTargetEntry =
  | ParsedDocument<GameAssetsManifest>
  | ParsedDocument<GamePrefabManifest>
  | ParsedDocument<GameProjectManifest>
  | ParsedDocument<GameSceneManifest>

/** 已经在拓扑里的目标；不在就回 null（由 {@link GameManifestWorkspaceEditor.resolveTarget} 决定采纳/创建/报错）。 */
function loadedManifestEntry(
  workspace: LoadedWorkspace,
  target: GameManifestEditTarget,
): Nullable<GameManifestTargetEntry> {
  if (target === 'project') return workspace.project
  if (target === 'assets') return workspace.assets
  const id = gameReferenceId(target)
  const loaded: readonly GameManifestTargetEntry[] =
    target.startsWith('scene:') ? workspace.scenes : workspace.prefabs
  return toNullable(loaded.find((candidate) => candidate.value.id === id))
}

/** 落点路径上已有一份清单，但它自报的 id 与目标对不上——这是真冲突，不能悄悄改名或覆盖。 */
function throwManifestIdMismatch(
  target: GameManifestEditTarget,
  path: string,
  actualId: string,
): never {
  throw new GameManifestError(
    'INVALID_MANIFEST',
    `${path} 已存在，但它声明的 id 是 ${actualId}，与编辑目标 ${target} 对不上。`,
    {
      path,
      hint: `改用 ${target.slice(0, target.indexOf(':'))}:${actualId} 作为 target，或把该文件的 id 改成目标 id。`,
    },
  )
}

/**
 * 扫描结果里一份清单**自称**的稳定 id：清单自己写的 `id` 优先，缺席时按文件名推。
 *
 * 与解析器 `withIdFromSourceName` 是同一条规则（那边也是「没写 id 就按文件名补」），
 * 所以「工程里已经有谁携带这个 id」这个问题在扫描期与解析期得到同一个答案。
 * 内容坏到 JSON 都解析不了时只剩文件名这一个依据——那足够让我们**不去覆盖它**。
 */
function scannedManifestId(
  document: GameManifestDocument,
  kind: 'prefab' | 'scene',
): Nullable<string> {
  if (!document.path.endsWith(`.${kind}.json`)) return null
  return declaredManifestId(document.text) ?? gameManifestIdFromPath(document.path)
}

function declaredManifestId(text: string): Nullable<string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // arch-guard:silent-catch-ok 坏 JSON 在这一层只意味着「问不出它的 id」，由文件名兜底。
    return null
  }
  if (!isPlainObject(parsed)) return null
  const id = parsed.id
  if (!isString(id)) return null
  const trimmed = id.trim()
  return GameSlugSchema.safeParse(trimmed).success ? trimmed : null
}

export class GameManifestWorkspaceEditor implements GameSceneEditorPort {
  public constructor(private readonly store: GameManifestDocumentStore) {}

  public isAvailable(): boolean {
    return true
  }

  public async edit(request: GameManifestEditRequest): Promise<GameManifestEditResult> {
    const workspace = await this.loadWorkspace()
    const before = workspace.canonicalAtLoad

    if (isEmpty(request.operations)) {
      // 空批次是「确保这份清单存在并被工程登记」的探路手势——`target` 本身就是显式意图。
      await this.resolveTarget(workspace, request.target, null)
    }
    for (const operation of request.operations) {
      await this.applyOperation(workspace, request.target, operation, workspace.summaries)
    }

    this.reparseProjectManifest(workspace)
    this.assertNoSilentUndeclare(workspace)
    await this.activateDeclaredManifests(workspace)
    this.reparseManifests(workspace)
    this.validateDocumentTopology(workspace)
    new GameManifestResolver(sourceSet(workspace)).validate()

    const after = serializeWorkspace(workspace)
    const changes = topologyDocuments(workspace).flatMap((
      { document },
    ): GameManifestDocumentChange[] => {
      const next = after.get(document.path)
      if (!isPresent(next)) return []
      // 自举路径无条件提交：它在磁盘上还不存在，「文本没变」不代表「不用写」。
      // 少了这一条，首次编辑只会落下 game.project.json，而它指向的资产清单仍缺席。
      if (workspace.bootstrapPaths.has(document.path))
        return [
          { path: document.path, text: next, expectedRevision: document.revision, create: true },
        ]
      // 基线：装载逐份记下的那份（见 LoadedWorkspace.canonicalAtLoad）；本批才进入拓扑的文档
      // （磁盘上已有、被指名为目标或由 set_project 声明）不在账里，用它自己的原文当基线。
      // **不能沿用旧的 `!before.has(path) → 跳过`**：那条在「同一批里采纳一份草稿并接着改它」
      // 上会把改动整批静默丢掉。
      const baseline = before.get(document.path) ?? document.text
      if (next === baseline) return []
      return [{ path: document.path, text: next, expectedRevision: document.revision }]
    })

    if (!request.dryRun && !isEmpty(changes)) {
      await this.store.writeBatch(changes)
    }

    return {
      ok: true,
      target: request.target,
      changedFiles: changes.map((change) => change.path),
      operationsApplied: request.operations.length,
      diffSummary: workspace.summaries,
      warnings: [...new Set(workspace.warnings)],
      appliedAdjustments: workspace.adjustments,
      dryRun: !!request.dryRun,
    }
  }

  /**
   * 惰性解析编辑目标 —— **闭集的层级语义与创建时机都收口在这一个方法上**。
   *
   * ## 三条不变量
   *  1. **采纳是无条件的**：工程里已经有一份文件自称是这个 id（不管声明没声明、放在哪个目录），
   *     一律采纳它并登记进 `project`，绝不另起一份。「文件在那儿，模型没说错」。
   *  2. **创建是意图门控的，而且是惰性的**：只有 `set_*`（{@link GameEditTargetIntentByAction}）
   *     真的到达时才创建；`remove_*` / `rename_*` 先跑就报 {@link throwMissingEditTarget}。
   *     判据是**操作顺序本身**，不是对整批的预测——第七轮那条「批次里出现 remove 就不创建」
   *     的前置判据把 `[set_entity, rename_entity]` 这种合法批次一起判死了。
   *  3. **一个 id 只许有一个载体**：创建前先扫工程（见 {@link scanProjectManifests}）。
   *
   * ## 第六轮的 P0 不许退回
   * 空目录 + 一次 `target:'scene:main'` + 任意 `set_*` 必须建出工程清单 / 资产清单 / 入口场景。
   * 闭集里没有 `create_scene` 动作是刻意的：`set_` 本来就读作 upsert，而模型撞墙的时刻恰恰是
   * 它**不知道要先建**的时候。
   */
  private async resolveTarget(
    workspace: LoadedWorkspace,
    target: GameManifestEditTarget,
    /** 触发这次解析的操作；`null` = 空批次（显式的「把它建出来」手势）。 */
    action: Nullable<GameManifestEditOperation['action']>,
  ): Promise<GameManifestTargetEntry> {
    // 这两份在 loadWorkspace 里一定已经就位（缺席即自举）。
    if (target === 'project') return workspace.project
    if (target === 'assets') return workspace.assets
    const loaded = loadedManifestEntry(workspace, target)
    if (loaded) return loaded
    const kind = target.startsWith('scene:') ? 'scene' : 'prefab'
    const id = gameReferenceId(target)
    const adopted = await this.findManifestCarryingId(workspace, kind, id)
    const document =
      adopted ??
      (action && GameEditTargetIntentByAction[action] === 'assert'
        ? throwMissingEditTarget(workspace, target, action)
        : await this.bootstrapDocument(
            workspace,
            kind === 'scene' ? gameSceneManifestPath(id) : gamePrefabManifestPath(id),
            kind,
          ))
    const parsed =
      kind === 'scene'
        ? parseGameSceneManifestText(document.text, document.path)
        : parseGamePrefabManifestText(document.text, document.path)
    if (parsed.value.id !== id) throwManifestIdMismatch(target, document.path, parsed.value.id)
    collectParseResult(workspace, parsed)
    // 「创建」那一行由 bootstrapDocument 统一写（所有自举站点同源）；这里只记采纳。
    if (adopted) {
      workspace.summaries.push(summary(`declared ${kind}`, `${target} → ${document.path}`))
    }
    if (kind === 'scene') {
      const entry = { document, value: cloneRecord(parsed.value as GameSceneManifest) }
      workspace.scenes.push(entry)
      if (!workspace.project.value.scenes.includes(document.path)) {
        workspace.project.value.scenes = [...workspace.project.value.scenes, document.path]
      }
      // 入口场景只在「工程还没有入口 + 这是第一条场景」时补：解析器的 `scenes[0]` 缺省规则本来
      // 就是这么定的，而它只在**清单里没写 entryScene 这个键**时生效——自举出来的工程写盘后
      // 那一格是显式 `null`，缺省规则从此不再触发，于是 game_run 只会说「没有 entryScene」。
      if (!workspace.project.value.entryScene && workspace.project.value.scenes.length === 1) {
        workspace.project.value.entryScene = `scene:${id}`
        workspace.summaries.push(summary('set entry scene', target))
      }
      return entry
    }
    const entry = { document, value: cloneRecord(parsed.value as GamePrefabManifest) }
    workspace.prefabs.push(entry)
    if (!workspace.project.value.prefabs.includes(document.path)) {
      workspace.project.value.prefabs = [...workspace.project.value.prefabs, document.path]
    }
    return entry
  }

  /**
   * 工程内清单扫描（单次 `edit` 记忆一份）—— **不变量 I3 的取证通道**。
   *
   * 只在「要采纳或要创建一份清单」时才真的走盘：编辑一份已声明的清单一次都不扫。
   */
  private async scanProjectManifests(
    workspace: LoadedWorkspace,
  ): Promise<readonly GameManifestDocument[]> {
    workspace.manifestScan ??= await this.store.listManifests()
    for (const document of workspace.manifestScan) {
      assertProjectDocumentPath(document.path)
    }
    return workspace.manifestScan
  }

  /**
   * 携带这个稳定 id 的全部载体 —— **扫描到的文件 ∪ 已经进拓扑的清单**，按路径去重。
   *
   * 两个来源必须并起来问：`assertBootstrapIdIsFree` 过去自己在本地并了一次、`resolveTarget`
   * 没并，同一个问题于是能得到两个答案。并进这一个口子之后，「谁携带这个 id」在编辑器里
   * 只有一份实现，装载期的修复（{@link loadDeclaredManifest}）与运行期的报错读同一份事实。
   */
  private async carriersOfId(
    workspace: LoadedWorkspace,
    kind: 'prefab' | 'scene',
    id: string,
  ): Promise<readonly GameManifestDocument[]> {
    const loaded = (kind === 'scene' ? workspace.scenes : workspace.prefabs)
      .filter((entry) => entry.value.id === id)
      .map((entry) => entry.document)
    const scanned = (await this.scanProjectManifests(workspace)).filter(
      (document) => scannedManifestId(document, kind) === id,
    )
    return [
      ...new Map(
        [...scanned, ...loaded].map((document) => [document.path, document] as const),
      ).values(),
    ]
  }

  /**
   * 工程里有没有文件已经携带这个稳定 id。
   *
   * 两份同 id 时**不猜**：报出全部候选，让模型删掉一份或改一个 id。「一个 id 一个载体」唯一
   * 可能在磁盘上被打破的入口是 `ws_edit`（它不过编辑器，拦不住），既然打破了就必须当面说，
   * 不许挑一份继续跑。
   */
  private async findManifestCarryingId(
    workspace: LoadedWorkspace,
    kind: 'prefab' | 'scene',
    id: string,
  ): Promise<Nullable<GameManifestDocument>> {
    const carriers = await this.carriersOfId(workspace, kind, id)
    if (isEmpty(carriers)) return null
    if (carriers.length === 1) return carriers[0]
    throw new GameManifestError(
      'INVALID_MANIFEST',
      `${kind}:${id} 在工程里有 ${carriers.length} 份载体：${carriers
        .map((document) => document.path)
        .join(', ')}。`,
      {
        hint:
          '稳定 id 在同一命名空间内必须唯一，编辑器不会替你挑一份。' +
          '用工作区工具删掉多余的那份，或把它的 id 与文件名一起改成别的 slug，再重试。',
      },
    )
  }

  /** 缺席的资产清单 → 空清单基线（不需要 id，路径由 `project.assets` 自己声明）。 */
  private bootstrapAssetsDocument(
    workspace: LoadedWorkspace,
    path: string,
  ): GameManifestDocument {
    return this.recordBootstrap(
      workspace,
      path,
      summary('created assets manifest', path),
      GameAssetsBootstrapText,
    )
  }

  /**
   * 按路径自举一份空清单。
   *
   * 路径推不出合法 slug（`My Scene.json` / `01.json`）时**不自举**：硬编一个非法 id 只会在下一步
   * 校验里炸成一句更难懂的话。这一档如实报「这个文件名当不了稳定 id」，并给出可执行的两条出路。
   */
  private async bootstrapDocument(
    workspace: LoadedWorkspace,
    path: string,
    kind: 'prefab' | 'scene',
  ): Promise<GameManifestDocument> {
    const id = gameManifestIdFromPath(path)
    if (!id) {
      throw new GameManifestError(
        'INVALID_MANIFEST',
        `${path} 还不存在，且它的文件名推不出稳定 id，无法自举一份空${kind === 'scene' ? '场景' : ' prefab'}清单。`,
        {
          path,
          hint: `把文件名改成 kebab-case slug（如 ${
            kind === 'scene' ? 'scenes/main.scene.json' : 'prefabs/player.prefab.json'
          }），或先用工作区工具把该文件建出来。`,
        },
      )
    }
    await this.assertBootstrapIdIsFree(workspace, kind, id, path)
    // 落点被别的清单占着（同后缀、自称别的 id）：绝不覆盖。宿主的 create 写入也会拒，
    // 但那句话说的是宿主的事；在这里报能点名占位者的 id 与两条出路。
    const occupant = (await this.scanProjectManifests(workspace)).find(
      (document) => document.path === path,
    )
    if (occupant) {
      throwManifestIdMismatch(
        `${kind}:${id}`,
        path,
        scannedManifestId(occupant, kind) ?? '（读不出 id）',
      )
    }
    return this.recordBootstrap(
      workspace,
      path,
      summary(`created ${kind}`, `${kind}:${id} → ${path}`),
      (kind === 'scene' ? gameSceneBootstrapText : gamePrefabBootstrapText)(id),
    )
  }

  /**
   * 自举前的最后一道门：这个稳定 id 是不是已经有载体了 —— **不变量 I3 的唯一执行点**。
   *
   * ## 判决（第八轮）：「一个 id 一个载体」不是假设，是自举的前置条件
   * 自举的正当性完全建立在「一个稳定 id 在工程里只有一个载体」上，而第七轮只查
   * **已声明并装载**的那批。于是文档明确保留的那条路——模型先用 `ws_edit` 手写
   * `levels/main.scene.json`（id=main）——照样在 `scenes/main.scene.json` 另起一份空清单，
   * 手写那份连同两个实体被跳过，全程零提示，磁盘上从此有两份 id=main。
   *
   * 现在取证面是整个工程（{@link scanProjectManifests}），而且这条门只管一件事：
   * **不创建第二个载体**。已经有载体时的正解不是报错而是采纳它，那一半在
   * {@link resolveTarget} 里；只有「声明指向 A、载体却在 B」这种模型自己指错落点的形态
   * 才走到这里报错，并点名 B。
   *
   * 于是文档可以老实写：这条不变量被强制的时机，是「编辑器创建清单」那一刻；`ws_edit` 事后手写出的第二份
   * 会在下一次触碰该 id 时被当面报出（{@link findManifestCarryingId} 的多载体分支）。
   */
  private async assertBootstrapIdIsFree(
    workspace: LoadedWorkspace,
    kind: 'prefab' | 'scene',
    id: string,
    path: string,
  ): Promise<void> {
    const occupantPath = (await this.findManifestCarryingId(workspace, kind, id))?.path
    if (!isPresent(occupantPath) || occupantPath === path) return
    throw new GameManifestError(
      'INVALID_REFERENCE',
      `${path} 还不存在，而 ${kind}:${id} 已经住在 ${occupantPath}。`,
      {
        path,
        hint:
          `自举一份同 id 的空清单会让 ${occupantPath} 被孤立（工程里再没有指向它的声明），` +
          `所以这次拒绝创建。只想编辑它就用 target="${kind}:${id}" 且不要改 project.${
            kind === 'scene' ? 'scenes' : 'prefabs'
          }；` +
          `真要换落点就先用工作区工具把文件移到 ${path}，再改声明。`,
      },
    )
  }

  /**
   * 登记一次自举：进 `bootstrapPaths`（提交时按创建写盘）+ 进 diffSummary（模型当轮看得见）。
   *
   * 摘要行不是装饰：第六轮把自举摊到三个站点后只有一个站点记账，于是
   * 「`set_project` 顺手建了一份空场景」在结果里完全看不见。创建必须永远留痕。
   */
  private recordBootstrap(
    ledger: GameBootstrapLedger,
    path: string,
    summaryLine: string,
    text: string,
  ): GameManifestDocument {
    ledger.bootstrapPaths.add(path)
    ledger.summaries.push(summaryLine)
    return { path, text, revision: GameBootstrapRevision }
  }

  /**
   * 装载一条**已声明**的场景 / prefab 路径 —— 采纳优先、创建其次、**永不致命**。
   *
   * ## 判决（第九轮）：I3 的采纳那一半过去够不着装载站点
   * `resolveTarget` 早就是「先找载体、找到就采纳」，而装载站点直接走 `bootstrapDocument`，
   * 于是同一条不变量在两个入口给出相反的结果。实测链条：手写 `levels/main.scene.json` →
   * 被采纳并登记 → 模型照 usage 又手写一份 `scenes/main.scene.json` → 清理时删掉
   * `levels/main.scene.json`。此后声明指向一条不存在的路径、而 `scene:main` 的载体就在
   * 隔壁，装载站点却只会「创建第二个载体 → 撞 I3 → 抛错」，**整个工程从此编辑不动**，
   * 连报错正文自己开的 `set_project` 药方也抛同一句。
   *
   * 正解不是把 I3 放宽，而是让装载站点走完整的 I3：**载体在哪，声明就跟到哪**。
   * 声明被就地改写成载体的真实路径（`redeclared` 摘要行），这既是唯一不新增载体的出路，
   * 也正是模型移动文件后期望的结果。
   *
   * 剩下真的解析不出来的两档（同 id 有两份载体、文件名推不出 slug）走
   * {@link dropDanglingDeclaration}：那条声明指向的文件**根本不在磁盘上**，留着它只会让
   * 每一次编辑都在同一处炸，摘掉它什么都不会丢。
   */
  private async loadDeclaredManifest(
    workspace: LoadedWorkspace,
    declaredPath: string,
    kind: 'prefab' | 'scene',
  ): Promise<Nullable<GameManifestDocument>> {
    const stored = await this.store.read(declaredPath)
    if (stored) return requireDocument(stored, declaredPath)
    const id = gameManifestIdFromPath(declaredPath)
    if (!isPresent(id)) {
      this.dropDanglingDeclaration(
        workspace,
        kind,
        declaredPath,
        null,
        '文件不在磁盘上，而它的文件名推不出稳定 id，编辑器无法替它自举一份空清单。' +
          `想要这份清单就用 target="${kind}:<kebab-case slug>" 重新建（落点会是 ${
            kind === 'scene'
              ? `${GameProjectDirectories.scenes}/<slug>.scene.json`
              : `${GameProjectDirectories.prefabs}/<slug>.prefab.json`
          }）。`,
      )
      return null
    }
    const carriers = await this.carriersOfId(workspace, kind, id)
    if (carriers.length > 1) {
      this.dropDanglingDeclaration(
        workspace,
        kind,
        declaredPath,
        id,
        `文件不在磁盘上，而 ${kind}:${id} 在工程里有 ${carriers.length} 份载体：${carriers
          .map((document) => document.path)
          .join(', ')}——编辑器不会替你挑一份。` +
          '用工作区工具删掉多余的那份（或把它的 id 与文件名一起改成别的 slug），' +
          `再用 target="${kind}:${id}" 触碰它，声明会自动接回去。`,
      )
      return null
    }
    const adopted = carriers[0]
    if (!adopted) return this.bootstrapDocument(workspace, declaredPath, kind)
    this.redeclareManifestPath(workspace, kind, declaredPath, adopted.path)
    workspace.summaries.push(
      summary(`redeclared ${kind}`, `${declaredPath}（已不在磁盘上）→ ${adopted.path}`),
    )
    return adopted
  }

  /** 声明就地跟随载体：把 `from` 换成 `to`，并保持声明数组不出现重复项。 */
  private redeclareManifestPath(
    workspace: LoadedWorkspace,
    kind: 'prefab' | 'scene',
    from: string,
    to: string,
  ): void {
    const declared = kind === 'scene'
      ? workspace.project.value.scenes
      : workspace.project.value.prefabs
    const next = [...new Set(declared.map((path) => (path === from ? to : path)))]
    if (kind === 'scene') workspace.project.value.scenes = next
    else workspace.project.value.prefabs = next
  }

  /**
   * 摘掉一条**悬空声明**：指向的文件不在磁盘上，而编辑器又造不出它来。
   *
   * ## 判决（第九轮）：装载期的失败不许是致命的
   * 装载是每一次编辑的公共前置，在那里抛错就是把「一条声明坏了」放大成「整个工具族不可用」
   * ——实测一次 id 冲突让 `target:'assets'` 的空批次、乃至报错正文自己开出的那条 `set_project`
   * 药方全部抛同一句话。code-standard §2.8 的分档正是为这一格写的：**装载路径上的失败要降级
   * 并记账**，运行路径上的不变量破损才 fail-fast——真的去触碰那个 id 时（`resolveTarget`）
   * 一条都没放宽。
   *
   * 为什么是「摘掉」而不是「隔离但保留」：这条声明指向的文件**不存在**，所以摘它不丢任何内容
   * （与 I1 空壳那一档同判据）；留着它则要在装载 / 声明激活 / 拓扑校验 / 引用校验四处各加一个
   * 「跳过它」的分支，而 `entryScene` 指向它时照样把每一次编辑打死——那是把一个致命点换成四个
   * 分支再加一个致命点。摘掉之后工程自洽，模型下一步做什么都通。
   *
   * 摘除永远留痕（摘要行 + warning 带完整出路），并且 `entryScene` 指着它时一并撤下来——
   * 留一个指向已摘场景的入口，等于把刚修好的工程重新判死。
   */
  private dropDanglingDeclaration(
    workspace: LoadedWorkspace,
    kind: 'prefab' | 'scene',
    path: string,
    id: Nullable<string>,
    reason: string,
  ): void {
    const declared = kind === 'scene'
      ? workspace.project.value.scenes
      : workspace.project.value.prefabs
    if (!declared.includes(path)) return
    const next = declared.filter((candidate) => candidate !== path)
    if (kind === 'scene') workspace.project.value.scenes = next
    else workspace.project.value.prefabs = next
    workspace.summaries.push(
      summary(`dropped dangling ${kind}`, `${path}（声明已摘除，磁盘上本就没有这份文件）`),
    )
    workspace.warnings.push(
      `game.project.json 声明的 ${path} 已被摘除，工程其余部分照常可编辑：${reason}`,
    )
    if (isPresent(id) && workspace.project.value.entryScene === `scene:${id}`) {
      workspace.project.value.entryScene = null
      workspace.summaries.push(
        summary('cleared entry scene', `scene:${id}（入口场景随悬空声明一并撤下）`),
      )
    }
  }

  /** 读一份清单；缺席时回自举基线并登记（见 {@link recordBootstrap}）。 */
  private async readOrBootstrap(
    ledger: GameBootstrapLedger,
    path: string,
    summaryLine: string,
    bootstrapText: string,
  ): Promise<GameManifestDocument> {
    const stored = await this.store.read(path)
    if (stored) return requireDocument(stored, path)
    return this.recordBootstrap(ledger, path, summaryLine, bootstrapText)
  }

  private async loadWorkspace(): Promise<LoadedWorkspace> {
    // 工程清单要在 workspace 组装出来之前就读到，所以自举账先立、随后原样并进 workspace
    // （Set / 数组按引用共享，装载期写的行与后续操作行落在同一份摘要里）。
    const ledger: GameBootstrapLedger = {
      bootstrapPaths: new Set<string>(),
      summaries: [],
    }
    const projectDocument = await this.readOrBootstrap(
      ledger,
      'game.project.json',
      summary('created project manifest', 'game.project.json'),
      GameProjectBootstrapText,
    )
    const projectResult = parseGameProjectManifestText(
      projectDocument.text,
      projectDocument.path,
    )
    const workspace: LoadedWorkspace = {
      project: { document: projectDocument, value: cloneRecord(projectResult.value) },
      scenes: [],
      prefabs: [],
      assets: {} as ParsedDocument<GameAssetsManifest>,
      declaredAtLoad: new Map(),
      manifestScan: null,
      // 工程清单的基线在这里就定死：下面的循环可能就地修复声明，那是本次编辑的产出，不是基线。
      canonicalAtLoad: new Map([
        [projectDocument.path, formatGameManifest(projectResult.value)],
      ]),
      warnings: [...projectResult.warnings],
      adjustments: [...projectResult.appliedAdjustments],
      ...ledger,
    }

    const loadedPaths = new Set<string>()
    for (const scenePath of projectResult.value.scenes) {
      // 声明了却还没落文件 = 半成品，不是损坏：采纳既有载体，一个都没有才补一份合法空场景。
      // 旧行为在这里抛 `找不到游戏清单 <path>` 并让模型「用工作区工具创建」——那正是把模型
      // 从语义 API 推回手写 JSON 的那道墙。
      const document = await this.loadDeclaredManifest(workspace, scenePath, 'scene')
      if (!document || loadedPaths.has(document.path)) continue
      loadedPaths.add(document.path)
      const parsed = parseGameSceneManifestText(document.text, document.path)
      workspace.scenes.push({ document, value: cloneRecord(parsed.value) })
      workspace.canonicalAtLoad.set(document.path, formatGameManifest(parsed.value))
      workspace.declaredAtLoad.set(document.path, {
        kind: 'scene',
        hasContent: !isEmptySceneManifest(parsed.value),
      })
      collectParseResult(workspace, parsed)
    }

    for (const prefabPath of projectResult.value.prefabs) {
      // 与 scenes 同判据：声明了却还没落文件是半成品。第七轮这里靠 `list('prefabs')` 的全目录
      // 扫描顺带解决，于是每一次编辑都要走一趟盘、而且只覆盖 `prefabs/` 一个目录。
      const document = await this.loadDeclaredManifest(workspace, prefabPath, 'prefab')
      if (!document || loadedPaths.has(document.path)) continue
      loadedPaths.add(document.path)
      const parsed = parseGamePrefabManifestText(document.text, document.path)
      workspace.prefabs.push({ document, value: cloneRecord(parsed.value) })
      workspace.canonicalAtLoad.set(document.path, formatGameManifest(parsed.value))
      workspace.declaredAtLoad.set(document.path, {
        kind: 'prefab',
        hasContent: !isEmptyPrefabManifest(parsed.value),
      })
      collectParseResult(workspace, parsed)
    }

    // 资产清单缺席即自举，**不再要求「工程本身也是自举出来的」**。
    //
    // 判决（真机第一手，第六轮）：原来的条件把「工程已存在却缺资产清单」判成损坏并抛
    // `找不到游戏清单 assets/assets.json`。但那既不是损坏也无从下手——文件已经不在了，
    // 一份空清单不会覆盖掉任何东西（真丢了内容，随后的引用校验会精确报出缺哪个 asset），
    // 而错误提示唯一给得出的自救动作就是「手写这份 JSON」，也就是把模型推回踩坑起点。
    // 与场景/prefab 同一条判据：**缺席是半成品，不是损坏。**
    const assetsDocument = await this.readOrBootstrap(
      workspace,
      projectResult.value.assets,
      summary('created assets manifest', projectResult.value.assets),
      GameAssetsBootstrapText,
    )
    const assetsResult = parseGameAssetsManifestText(
      assetsDocument.text,
      assetsDocument.path,
    )
    workspace.assets = {
      document: assetsDocument,
      value: cloneRecord(assetsResult.value),
    }
    workspace.canonicalAtLoad.set(
      assetsDocument.path,
      formatGameManifest(assetsResult.value),
    )
    workspace.declaredAtLoad.set(assetsDocument.path, {
      kind: 'assets',
      hasContent: !isEmptyAssetsManifest(assetsResult.value),
    })
    collectParseResult(workspace, assetsResult)
    return workspace
  }

  /**
   * 不变量 I1：**一次编辑不许静默地让一份有内容的清单退出工程声明**。
   *
   * ## 判决（第八轮）：守「移除」那一半
   * 前三轮的守卫全加在「创建」那一半（`assertBootstrapIdIsFree` / `throwManifestIdMismatch` /
   * 批次意图门），于是每换一种打错方式就漏一格。而 `set_project` 用 merge patch、
   * **数组整体替换**，所以重发整份数组是正常操作方式；一次打错同时发生两件事：
   * 一条声明消失（那份有内容的文档被孤立）＋ 一条新声明出现（自举一份空的诱饵）。
   * 实测三格全是这个形状：`scenes` 里 basename 打错一字母、`assets` 目录写错一格、
   * prefab 的孪生站点——第三格里资产清单**根本没有稳定 id**，创建侧的守卫结构上够不着它。
   *
   * 所以判据换到**转移**上：装载时声明过、现在不声明了 = 一次移除。三种清单同一条判据，
   * 因为它们都只是「`game.project.json` 里的一条路径」，与 id 能不能派生无关。
   *
   * **有内容就硬失败**（没有任何一种意图会想在打错的同时丢掉内容，而这一档丢的是唯一副本）；
   * **空壳就放行**并留痕——那一档什么都没丢，拦下来只是仪式。
   */
  private assertNoSilentUndeclare(workspace: LoadedWorkspace): void {
    const declaredNow = new Set<string>([
      ...workspace.project.value.scenes,
      ...workspace.project.value.prefabs,
      workspace.project.value.assets,
    ])
    for (const [path, snapshot] of workspace.declaredAtLoad) {
      if (declaredNow.has(path)) continue
      if (!snapshot.hasContent) {
        workspace.summaries.push(
          summary(`undeclared ${snapshot.kind}`, `${path}（空清单，文件保留在磁盘上）`),
        )
        workspace.warnings.push(
          `${path} 已退出 project 声明；它是一份空清单，文件本身仍留在磁盘上。`,
        )
        continue
      }
      throw new GameManifestError(
        'INVALID_MANIFEST',
        `本次编辑把 ${path} 从 game.project.json 的声明里摘掉了，而它在磁盘上是有内容的。`,
        {
          path: 'game.project.json',
          hint:
            `${
              snapshot.kind === 'assets' ? 'project.assets' : `project.${snapshot.kind === 'scene' ? 'scenes' : 'prefabs'}`
            } 是 merge patch 里的整体替换项：重发整份声明时漏掉一条，那份文档就此被孤立，` +
            `运行时再也加载不到它。` +
            `只是想改别的字段就别重发这一项；只是路径写错了就把 ${path} 加回去；` +
            `确实要弃用它，先用工作区工具把文件删掉或移出工程，再改声明。`,
        },
      )
    }
  }


  /**
   * 一条工程内路径在拓扑里只许扮演一个角色。
   *
   * 判据：`game.project.json` 的四类声明各自指向一份文档，而**同一份文件不可能既是 prefab
   * 又是资产清单**——那种状态下两个解析器都「接受」它（未知键原样保留），落盘却只剩最后一个
   * 角色的 canonical 形态，运行时读到的是一份四不像。它与 I3 是同一句话的两个投影：
   * I3 说「一个 (kind,id) 至多一个载体」，这里说「一个载体至多一个角色」。
   *
   * 只在**角色去重后仍有两个**时报：`scenes:['a','a']` 那种「同一角色声明两遍」由解析器的
   * `assertUniqueNames` 用更贴切的话报（「scene manifest path 重复声明 a」），别在这里抢答。
   */
  private assertOneRolePerPath(workspace: LoadedWorkspace): void {
    const rolesByPath = new Map<string, Set<string>>()
    for (const { role, document } of topologyDocuments(workspace)) {
      const roles = rolesByPath.get(document.path) ?? new Set<string>()
      roles.add(role)
      rolesByPath.set(document.path, roles)
    }
    for (const [path, roles] of rolesByPath) {
      if (roles.size < 2) continue
      throw new GameManifestError(
        'INVALID_MANIFEST',
        `${path} 在工程拓扑里同时扮演 ${roles.size} 个角色：${[...roles].join('、')}。`,
        {
          path: 'game.project.json',
          hint:
            '一条路径在 game.project.json 里只能有一种角色（工程清单 / 场景 / prefab / 资产清单），' +
            '否则落盘时只剩最后一个角色的格式，另一个角色的内容就再也读不回来。' +
            `重发那一项时把它指向一条没被占用的路径：资产清单默认 ${GameProjectDirectories.assets}/assets.json，` +
            `场景默认 ${GameProjectDirectories.scenes}/<id>.scene.json，prefab 默认 ${GameProjectDirectories.prefabs}/<id>.prefab.json。`,
        },
      )
    }
  }

  private validateDocumentTopology(workspace: LoadedWorkspace): void {
    this.assertOneRolePerPath(workspace)
    const loadedScenePaths = new Set(
      workspace.scenes.map((entry) => entry.document.path),
    )
    for (const scenePath of workspace.project.value.scenes) {
      if (loadedScenePaths.has(scenePath)) continue
      throw new GameManifestError(
        'INVALID_REFERENCE',
        `project.scenes 新增了尚不存在的清单 ${scenePath}。`,
        {
          path: 'game.project.json',
          hint: '先用工作区工具创建并校验新场景文件，再把它加入 project.scenes。',
        },
      )
    }
    if (workspace.project.value.assets !== workspace.assets.document.path) {
      throw new GameManifestError(
        'INVALID_REFERENCE',
        `project.assets 指向尚未加载的 ${workspace.project.value.assets}。`,
        {
          path: 'game.project.json',
          hint: '先用工作区工具创建资产清单，再修改 project.assets。',
        },
      )
    }
    const loadedPrefabPaths = new Set(
      workspace.prefabs.map((entry) => entry.document.path),
    )
    for (const prefabPath of workspace.project.value.prefabs) {
      if (loadedPrefabPaths.has(prefabPath)) continue
      throw new GameManifestError(
        'INVALID_REFERENCE',
        `project.prefabs 新增了尚不存在的清单 ${prefabPath}。`,
        {
          path: 'game.project.json',
          hint: '先用工作区工具创建并校验 prefab 文件，再把它加入 project.prefabs。',
        },
      )
    }
  }

  /** 工程清单归一化 —— 声明集合的判读（I1）必须发生在它之后、自举站点之前。 */
  private reparseProjectManifest(workspace: LoadedWorkspace): void {
    const project = parseGameProjectManifestText(
      formatGameManifest(workspace.project.value),
      workspace.project.document.path,
    )
    workspace.project.value = project.value
    collectParseResult(workspace, project)
  }

  private async activateDeclaredManifests(workspace: LoadedWorkspace): Promise<void> {
    await this.activateDeclaredScenesAndAssets(workspace)
    await this.activateDeclaredPrefabs(workspace)
  }

  private reparseManifests(workspace: LoadedWorkspace): void {
    for (const entry of workspace.scenes) {
      const parsed = parseGameSceneManifestText(
        formatGameManifest(entry.value),
        entry.document.path,
      )
      entry.value = parsed.value
      collectParseResult(workspace, parsed)
    }
    for (const entry of workspace.prefabs) {
      const parsed = parseGamePrefabManifestText(
        formatGameManifest(entry.value),
        entry.document.path,
      )
      entry.value = parsed.value
      collectParseResult(workspace, parsed)
    }
    const assets = parseGameAssetsManifestText(
      formatGameManifest(workspace.assets.value),
      workspace.assets.document.path,
    )
    workspace.assets.value = assets.value
    collectParseResult(workspace, assets)
  }

  private async activateDeclaredScenesAndAssets(
    workspace: LoadedWorkspace,
  ): Promise<void> {
    const activeScenesByPath = new Map(
      workspace.scenes.map((entry) => [entry.document.path, entry]),
    )
    const scenes: Array<ParsedDocument<GameSceneManifest>> = []
    for (const scenePath of workspace.project.value.scenes) {
      const active = activeScenesByPath.get(scenePath)
      if (active) {
        scenes.push(active)
        continue
      }
      // `set_project` 把一条新场景路径写进 `scenes[]` 同样是 upsert：登记一份还不存在的清单，
      // 意图就是「这个场景应该有」。旧行为抛 `project.scenes 新增了尚不存在的清单` 并让模型
      // 「先用工作区工具创建」——与 `resolveTarget` 同一条判据，这里一并拉平。
      const document =
        (await this.store.read(scenePath)) ??
        (await this.bootstrapDocument(workspace, scenePath, 'scene'))
      assertProjectDocumentPath(document.path)
      if (document.path !== scenePath) {
        throw new GameManifestError(
          'INVALID_MANIFEST',
          `文档存储读取 ${scenePath} 时返回了不匹配的路径 ${document.path}。`,
          {
            path: scenePath,
            hint: '宿主文档端口必须保持请求路径与返回路径一一对应。',
          },
        )
      }
      const parsed = parseGameSceneManifestText(document.text, document.path)
      collectParseResult(workspace, parsed)
      scenes.push({ document, value: cloneRecord(parsed.value) })
    }
    workspace.scenes = scenes

    const assetsPath = workspace.project.value.assets
    if (workspace.assets.document.path === assetsPath) return
    // 把 `project.assets` 改到一条还不存在的路径同样是 upsert（与 scenes / prefabs 同判据）。
    const document =
      (await this.store.read(assetsPath)) ?? this.bootstrapAssetsDocument(workspace, assetsPath)
    assertProjectDocumentPath(document.path)
    if (document.path !== assetsPath) {
      throw new GameManifestError(
        'INVALID_MANIFEST',
        `文档存储读取 ${assetsPath} 时返回了不匹配的路径 ${document.path}。`,
        {
          path: assetsPath,
          hint: '宿主文档端口必须保持请求路径与返回路径一一对应。',
        },
      )
    }
    const parsed = parseGameAssetsManifestText(document.text, document.path)
    collectParseResult(workspace, parsed)
    workspace.assets = { document, value: cloneRecord(parsed.value) }
  }

  private async activateDeclaredPrefabs(workspace: LoadedWorkspace): Promise<void> {
    const activeByPath = new Map(
      workspace.prefabs.map((entry) => [entry.document.path, entry]),
    )
    const prefabs: Array<ParsedDocument<GamePrefabManifest>> = []
    for (const prefabPath of workspace.project.value.prefabs) {
      const active = activeByPath.get(prefabPath)
      if (active) {
        prefabs.push(active)
        continue
      }
      // 与 scenes 逐字同形（第七轮这里走 `prefabCandidates` 那份预扫描 Map，是同一件事的第二种写法）：
      // `set_project` 声明一条还不存在的 prefab 路径即自举一份空 prefab。
      const document =
        (await this.store.read(prefabPath)) ??
        (await this.bootstrapDocument(workspace, prefabPath, 'prefab'))
      assertProjectDocumentPath(document.path)
      if (document.path !== prefabPath) {
        throw new GameManifestError(
          'INVALID_MANIFEST',
          `文档存储读取 ${prefabPath} 时返回了不匹配的路径 ${document.path}。`,
          {
            path: prefabPath,
            hint: '宿主文档端口必须保持请求路径与返回路径一一对应。',
          },
        )
      }
      const parsed = parseGamePrefabManifestText(document.text, document.path)
      collectParseResult(workspace, parsed)
      prefabs.push({ document, value: cloneRecord(parsed.value) })
    }
    workspace.prefabs = prefabs
  }

  private async applyOperation(
    workspace: LoadedWorkspace,
    target: GameManifestEditTarget,
    operation: GameManifestEditOperation,
    summaries: string[],
  ): Promise<void> {
    // 目标在这一刻才被物化：`set_*` 到达即创建，`remove_*` / `rename_*` 到达时目标还不在就报错。
    // 行为由**操作顺序**决定，不由对整批的预测决定（判决见 GameEditTargetIntentByAction）。
    const targetEntry = await this.resolveTarget(workspace, target, operation.action)

    switch (operation.action) {
      case 'set_entity': {
        if (!target.startsWith('scene:')) {
          throw new GameManifestError(
            'INVALID_MANIFEST',
            'set_entity 只能用于 scene:<id>。',
          )
        }
        const scene = targetEntry.value as GameSceneManifest
        const index = scene.entities.findIndex(
          (entity) => entity.id === operation.entityId,
        )
        const patch = {
          id: operation.entityId,
          // `from` 的 undefined（未提供、保持原值）与 null（显式清除继承）语义不同：isPresent
          // 会把两者并成一个分支，等于把「清除继承」这条操作静默吞掉。缺席即整键不出现，
          // 因此也不能改成 optionalWhen（那会留下一个 `from: undefined` 的键进 merge patch）。
          // @arch-guard:suspend code-style/forbid-redundant-strict-literal-comparison 理由：undefined 与 null 语义不同，见上。
          ...(operation.from === undefined ? {} : { from: operation.from }),
          // @arch-guard:suspend code-style/forbid-redundant-strict-literal-comparison 理由：缺席须整键不出现，不能留 undefined 键进 merge patch。
          ...(operation.components === undefined ? {} : { components: operation.components }),
        }
        if (index < 0) scene.entities.push(patch)
        else {
          scene.entities[index] = applyGameMergePatch(
            scene.entities[index],
            { ...patch, remove: null },
          ) as GameEntityManifest
        }
        summaries.push(
          summary(
            index < 0 ? 'added entity' : 'updated entity',
            `entity:${operation.entityId}`,
          ),
        )
        return
      }
      case 'remove_entity': {
        if (!target.startsWith('scene:')) {
          throw new GameManifestError(
            'INVALID_MANIFEST',
            'remove_entity 只能用于 scene:<id>。',
          )
        }
        const sceneEntry = targetEntry as ParsedDocument<GameSceneManifest>
        const scene = sceneEntry.value
        const index = scene.entities.findIndex(
          (entity) => entity.id === operation.entityId,
        )
        const inheritedEntity = scene.extends
          ? new GameManifestResolver(sourceSet(workspace))
              .resolveScene(gameReferenceId(scene.extends))
              .entities.some((entity) => entity.id === operation.entityId)
          : false
        if (inheritedEntity) {
          const tombstone: GameEntityManifest = {
            id: operation.entityId,
            remove: true,
          }
          if (index < 0) scene.entities.push(tombstone)
          else scene.entities[index] = tombstone
        } else {
          if (index < 0) requireSceneEntity(workspace, sceneEntry, operation.entityId)
          scene.entities.splice(index, 1)
        }
        summaries.push(summary('removed entity', `entity:${operation.entityId}`))
        return
      }
      case 'rename_entity': {
        if (!target.startsWith('scene:')) {
          throw new GameManifestError(
            'INVALID_MANIFEST',
            'rename_entity 只能用于 scene:<id>。',
          )
        }
        this.renameEntity(
          workspace,
          targetEntry as ParsedDocument<GameSceneManifest>,
          operation.entityId,
          operation.newId,
        )
        summaries.push(
          summary(
            'renamed entity',
            `entity:${operation.entityId} -> entity:${operation.newId}`,
          ),
        )
        return
      }
      case 'set_component': {
        if (target.startsWith('scene:')) {
          const scene = targetEntry.value as GameSceneManifest
          const entity = this.upsertSceneEntity(
            scene,
            requireEntityId(operation, target),
            summaries,
          )
          const current = entity.components?.[operation.component]
          const next = applyGameMergePatch(current ?? {}, operation.values)
          entity.components = {
            ...(entity.components ?? {}),
            // @arch-guard:suspend code-style/forbid-redundant-strict-literal-comparison 理由：缺席须整键不出现，不能留 undefined 键进组件表。
            ...(next === undefined ? {} : { [operation.component]: next }),
          }
          summaries.push(
            summary(
              'updated component',
              `${target}/entity:${entity.id}/${operation.component}`,
            ),
          )
          return
        }
        if (target.startsWith('prefab:')) {
          if (isPresent(operation.entityId)) {
            throw new GameManifestError(
              'INVALID_MANIFEST',
              'prefab 的 set_component 不接收 entityId；target 已唯一指定 prefab。',
            )
          }
          const prefab = targetEntry.value as GamePrefabManifest
          const next = applyGameMergePatch(
            prefab.components[operation.component] ?? {},
            operation.values,
          )
          if (isPresent(next)) {
            prefab.components = {
              ...prefab.components,
              [operation.component]: next,
            }
          }
          summaries.push(
            summary('updated component', `${target}/${operation.component}`),
          )
          return
        }
        throw new GameManifestError(
          'INVALID_MANIFEST',
          'set_component 只能用于 scene:<id> 或 prefab:<id>。',
        )
      }
      case 'remove_component': {
        if (target.startsWith('scene:')) {
          const sceneEntry = targetEntry as ParsedDocument<GameSceneManifest>
          const entity = requireSceneEntity(
            workspace,
            sceneEntry,
            requireEntityId(operation, target),
          )
          if (entity.components) {
            entity.components = withoutKey(
              entity.components,
              operation.component,
            )
          }
          summaries.push(
            summary(
              'removed component',
              `${target}/entity:${entity.id}/${operation.component}`,
            ),
          )
          return
        }
        if (target.startsWith('prefab:')) {
          if (isPresent(operation.entityId)) {
            throw new GameManifestError(
              'INVALID_MANIFEST',
              'prefab 的 remove_component 不接收 entityId；target 已唯一指定 prefab。',
            )
          }
          const prefab = targetEntry.value as GamePrefabManifest
          prefab.components = withoutKey(prefab.components, operation.component)
          summaries.push(
            summary('removed component', `${target}/${operation.component}`),
          )
          return
        }
        throw new GameManifestError(
          'INVALID_MANIFEST',
          'remove_component 只能用于 scene:<id> 或 prefab:<id>。',
        )
      }
      case 'set_scene_meta': {
        if (!target.startsWith('scene:')) {
          throw new GameManifestError(
            'INVALID_MANIFEST',
            'set_scene_meta 只能用于 scene:<id>。',
          )
        }
        const scene = targetEntry.value as GameSceneManifest
        scene.meta = applyGameMergePatch(
          scene.meta ?? {},
          operation.values,
        ) as GameSceneManifest['meta']
        summaries.push(summary('updated scene meta', target))
        return
      }
      case 'set_asset': {
        if (target !== 'assets') {
          throw new GameManifestError(
            'INVALID_MANIFEST',
            'set_asset 只能用于 assets。',
          )
        }
        const assets = (targetEntry.value as GameAssetsManifest).assets
        const index = assets.findIndex((asset) => asset.id === operation.assetId)
        const next = applyGameMergePatch(
          index < 0 ? { id: operation.assetId } : assets[index],
          operation.values,
        ) as GameAssetManifest
        if (index < 0) assets.push(next)
        else assets[index] = next
        summaries.push(
          summary(
            index < 0 ? 'added asset' : 'updated asset',
            `asset:${operation.assetId}`,
          ),
        )
        return
      }
      case 'remove_asset': {
        if (target !== 'assets') {
          throw new GameManifestError(
            'INVALID_MANIFEST',
            'remove_asset 只能用于 assets。',
          )
        }
        const assets = (targetEntry.value as GameAssetsManifest).assets
        const index = assets.findIndex((asset) => asset.id === operation.assetId)
        if (index < 0) {
          throw new GameManifestError(
            'INVALID_REFERENCE',
            `找不到 asset:${operation.assetId}。`,
            {
              hint: `可用 asset id：${
                assets.map((asset) => asset.id).join(', ') || '当前为空'
              }`,
            },
          )
        }
        assets.splice(index, 1)
        summaries.push(summary('removed asset', `asset:${operation.assetId}`))
        return
      }
      case 'set_project': {
        if (target !== 'project') {
          throw new GameManifestError(
            'INVALID_MANIFEST',
            'set_project 只能用于 project。',
          )
        }
        workspace.project.value = applyGameMergePatch(
          workspace.project.value,
          operation.values,
        ) as GameProjectManifest
        summaries.push(summary('updated project', 'game.project.json'))
      }
    }
  }

  /**
   * scene 上的实体 upsert —— `set_component` 与 `set_entity` 在这一级必须同语义。
   *
   * ## 判决（第七轮）
   * `set_component` 是闭集里**唯一没被摊平**的一级：它对不存在的实体抛
   * `scene:main 中找不到 entity:hero`，而同一份用法文字告诉模型「`set_*` 都是 upsert」。
   * 选摊平而不是改文字，是因为这一格根本不是一条独立语义——
   * `set_component(entityId:'hero', component:'transform', values)` 与
   * `set_entity(entityId:'hero', components:{transform: values})` 落盘结果逐字节相同；
   * 打错 id 的代价也与 `set_entity` 打错 id 完全同级（上一层早已接受，并会在摘要里点名）。
   *
   * 顺带修掉第二个真缺陷：**继承场景里改一个继承来的实体**过去也撞这堵墙
   * （`requireSceneEntity` 只看本地 `entities`），而正解恰恰是在子场景里建一条本地覆盖——
   * 也就是这里创建的那条。
   *
   * 反过来 `remove_component` / `rename_entity` **不**走这里：它们断言目标已存在，
   * 与 {@link GameManifestContentAssertingActions} 同一条判据。
   */
  private upsertSceneEntity(
    scene: GameSceneManifest,
    entityId: string,
    summaries: string[],
  ): GameEntityManifest {
    const existing = scene.entities.find((candidate) => candidate.id === entityId)
    if (existing) return existing
    const created: GameEntityManifest = { id: entityId }
    scene.entities.push(created)
    summaries.push(summary('added entity', `entity:${entityId}`))
    return created
  }

  private renameEntity(
    workspace: LoadedWorkspace,
    targetEntry: ParsedDocument<GameSceneManifest>,
    entityId: string,
    nextId: string,
  ): void {
    const targetScene = targetEntry.value
    const target = requireSceneEntity(workspace, targetEntry, entityId)
    if (targetScene.entities.some((entity) => entity.id === nextId)) {
      throw new GameManifestError(
        'INVALID_MANIFEST',
        `scene:${targetScene.id} 已存在 entity:${nextId}，不能重命名为重复 id。`,
      )
    }

    const sceneIndex = new Map(
      workspace.scenes.map((entry) => [entry.value.id, entry.value]),
    )
    const affectedScenes = workspace.scenes
      .map((entry) => entry.value)
      .filter(
        (scene) =>
          scene.id === targetScene.id ||
          sceneDescendsFrom(scene, targetScene.id, sceneIndex),
      )
    const oldReference = `entity:${entityId}` as const
    const nextReference = `entity:${nextId}` as const

    target.id = nextId
    for (const scene of affectedScenes) {
      const replaced = replaceEntityReferences(
        scene,
        oldReference,
        nextReference,
      ) as GameSceneManifest
      scene.meta = replaced.meta
      scene.entities = replaced.entities.map((entity) =>
        scene !== targetScene && entity.id === entityId
          ? { ...entity, id: nextId }
          : entity,
      )
    }
  }
}
