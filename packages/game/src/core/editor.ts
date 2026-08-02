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
  type GameManifestParseResult,
  parseGameAssetsManifestText,
  parseGamePrefabManifestText,
  parseGameProjectManifestText,
  parseGameSceneManifestText,
} from './manifest-parser.js'
import {
  GameDefaultAssetsManifestPath,
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
      readonly action: 'set_extends'
      /**
       * `scene:<slug>` / `prefab:<slug>`，或 `null` = 清除继承。
       *
       * 也接受裸 slug：target 已经唯一确定了种类，按它补前缀是无歧义的（钳制不拒绝）。
       */
      readonly extends: Nullable<string>
    }
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
 * diffSummary 的一行 —— **带着它说的是哪几份文件**。
 *
 * ## 判决（第十一轮）：报告与磁盘的对应关系必须是结构事实，不是「我检查过了」
 * 摘要行过去是裸字符串，与最终 `changedFiles` 之间没有任何机械关系，于是两个方向都能撒谎：
 *  - 报告说做了、磁盘上没做（写盘保护把 `game.project.json` 挡掉，`set_project` 仍回
 *    `updated project`；自举行 `created scene: …` 后来那份清单又被同批摘出声明，一个字节没落）；
 *  - 磁盘上做了、报告里没有（中途采纳的资产清单被 canonical 重写，摘要一个字不提）。
 *
 * 带上 `paths` 之后，{@link GameManifestProjectEditor.reconcileSummary} 能拿变更清单当权威
 * 逐条对账：没落盘的「创建」行被撤掉，没被任何行认领的落盘路径自动补一行。
 */
interface GameEditSummary {
  readonly text: string
  /** 这一行说的是哪几份文件；空 = 与具体文件无关。 */
  readonly paths: readonly string[]
  /** `paths` 真的落了盘这一行才成立（自举的「created …」行）。 */
  readonly onlyIfWritten: boolean
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
  readonly summaries: GameEditSummary[]
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
   * {@link GameManifestProjectEditor.loadDeclaredManifest}）与它自己相等，
   * `changedFiles` 空、修复永不落盘、下一次调用再修一遍——摘要行说做了、磁盘上没做。
   * 基线必须在**修复之前**取，所以由装载逐份记账，而不是事后整体现算。
   */
  readonly canonicalAtLoad: Map<string, string>
  /**
   * 装载完成那一刻的**整体诊断**——不变量 I4 的唯一状态位。
   *
   * 非 null = 这个工程在本次编辑动手之前就已经不自洽。见
   * {@link GameManifestProjectEditor.acceptDiagnosis}。
   */
  diagnosisAtLoad: Nullable<GameManifestError>
  /**
   * **已声明但这次读不出来**的文档：路径 → 那条解析错误。
   *
   * 判决（第十轮）：装载一份坏掉的子清单过去直接抛，于是 `project:edit` 写坏 `scenes/a.scene.json`
   * 之后连 `target='project'` 都动不了。它们现在只是**退出本次工作集**：声明保留（I1 因此仍
   * 拦得住「顺手把它摘掉」）、文件保留、永不被写盘（见 `edit` 的变更计算），并每次都在
   * warnings 里点名。真的去触碰它们时仍然当场抛同一条解析错误——不许静默吞。
   */
  readonly unreadable: Map<string, GameManifestError>
  /**
   * 拓扑里**值是占位的**那些路径（当前只有一档：资产清单读不出来时顶上的空清单）。
   *
   * 判决（第十一轮）：写盘保护过去直接查 {@link LoadedWorkspace.unreadable}，而那张表是按
   * **路径**记的「某个角色这次读不出来」。工程清单被误声明成场景时，它自己的路径就会进那张表，
   * 于是拿着权威工程值的写入被自己挡掉（第十一轮 P0 的直接机制）。判据必须精确到
   * 「我手里这份值是不是占位的」——只有占位值写下去才会盖掉真内容。
   */
  readonly placeholderPaths: Set<string>
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
 * 一个载体」（见 {@link GameManifestProjectEditor.assertBootstrapIdIsFree}），
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

/**
 * 往 diffSummary 里写一行。
 *
 * `paths` 不是装饰：它是这一行与真实写盘之间**唯一**的机械纽带
 * （见 {@link GameEditSummary} 与 {@link GameManifestProjectEditor.reconcileSummary}）。
 * 新增写行的站点必须给出它说的是哪几份文件；确实与文件无关的行传空数组。
 */
function pushSummary(
  summaries: GameEditSummary[],
  paths: readonly string[],
  action: string,
  target: string,
  options: { readonly onlyIfWritten?: boolean } = {},
): void {
  summaries.push({
    text: `${action}: ${target}`,
    paths,
    onlyIfWritten: !!options.onlyIfWritten,
  })
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
  set_extends: 'upsert',
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

/**
 * `set_extends` 的入参归一：`scene:<slug>` / `prefab:<slug>` 原样，裸 slug 按 target 的种类补
 * 前缀，`null`（含缺席）= 清除继承，跨种类当场拒绝并说清两条命名空间的规矩。
 */
function normalizedExtendsReference(
  workspace: LoadedWorkspace,
  kind: 'prefab' | 'scene',
  target: GameManifestEditTarget,
  requested: Nullable<string>,
): Nullable<GameReference<'prefab' | 'scene'>> {
  if (!isPresent(requested)) return null
  const trimmed = requested.trim()
  if (!trimmed) return null
  if (trimmed.startsWith(`${kind}:`)) return trimmed as GameReference<'prefab' | 'scene'>
  if (trimmed.includes(':')) {
    throw new GameManifestError(
      'INVALID_REFERENCE',
      `${target} 只能继承同类清单，而 extends 给的是 ${trimmed}。`,
      {
        hint: '场景只能 extends scene:<slug>，prefab 只能 extends prefab:<slug>；'
          + '要清除继承就传 extends: null。',
      },
    )
  }
  const normalized = `${kind}:${trimmed}` as GameReference<'prefab' | 'scene'>
  workspace.adjustments.push({
    field: 'operations[].extends',
    action: 'aliased',
    detail: `裸 slug ${JSON.stringify(trimmed)} 已按 target 归一为 ${normalized}。`,
  })
  return normalized
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

/**
 * 拓扑里每一条路径被哪几个角色占着（>1 个 = 冲突）—— **读的是声明，不是装载结果**。
 *
 * 判决（第十一轮）：上一版从 {@link topologyDocuments} 反推角色，于是「一条路径被声明成两个
 * 角色、但其中一个角色这次解析不出来」会缩水成一个角色，那份文件被按另一个角色 canonical 重写，
 * 而模型只看到一条「某某读不出来」的 warning——它读不出「你那次编辑写的是同一个文件」。
 * 角色是 `game.project.json` 声明出来的事实，与我们这次读不读得懂它无关。
 * 已经装载的角色带上稳定 id（`scene:a`），没装载的只报角色名。
 */
function rolesByPath(workspace: LoadedWorkspace): Map<string, Set<string>> {
  const roles = new Map<string, Set<string>>()
  const claim = (path: string, role: string): void => {
    const bucket = roles.get(path) ?? new Set<string>()
    bucket.add(role)
    roles.set(path, bucket)
  }
  // 两张表分开建：同一条路径同时是场景与 prefab 时，一张按路径收敛的表只会留下后写的那个标签，
  // 于是两个角色在 Set 里并成一个、冲突凭空消失（本轮自己踩过一次）。
  const sceneIds = new Map(workspace.scenes.map((entry) => [entry.document.path, entry.value.id]))
  const prefabIds = new Map(
    workspace.prefabs.map((entry) => [entry.document.path, entry.value.id]),
  )
  claim(workspace.project.document.path, '工程清单')
  for (const path of workspace.project.value.scenes) {
    const id = sceneIds.get(path)
    claim(path, isPresent(id) ? `scene:${id}` : '场景')
  }
  for (const path of workspace.project.value.prefabs) {
    const id = prefabIds.get(path)
    claim(path, isPresent(id) ? `prefab:${id}` : 'prefab')
  }
  claim(workspace.project.value.assets, '资产清单')
  return roles
}

/**
 * diffSummary 的最终形态 —— **由变更清单对账生成，不是由「我检查过了」保证**（原则甲）。
 *
 * 两个方向各一条规则，合起来就是「一次编辑的报告与它对磁盘做的事逐字对应」：
 *  1. 声称创建了某份文件的行（`onlyIfWritten`），那份文件没进变更清单就**撤掉**——
 *     实测过的形态：`set_project({scenes:[], entryScene:null})` 会先自举一份声明缺失的场景、
 *     再把它摘出声明，摘要于是留下一句 `created scene: …`，而磁盘上从来没有过这份文件。
 *  2. 变更清单里没被任何一行认领的路径，**补一行**——实测过的形态：中途采纳的资产清单被
 *     canonical 重写，`changedFiles` 里凭空多出一份模型没听说改过的文件（第十一轮 P3）。
 *
 * 这不是一道检查（检查会漏掉下一种形状），而是一次投影：行与写入之间的对应关系由
 * {@link GameEditSummary.paths} 承载，两端都得从这里过。
 */
function reconcileSummary(
  workspace: LoadedWorkspace,
  changes: readonly GameManifestDocumentChange[],
): string[] {
  const written = new Set(changes.map((change) => change.path))
  const lines = workspace.summaries.filter(
    (line) => !line.onlyIfWritten || line.paths.every((path) => written.has(path)),
  )
  const claimed = new Set(lines.flatMap((line) => line.paths))
  return [
    ...lines.map((line) => line.text),
    ...[...written]
      .filter((path) => !claimed.has(path))
      .map((path) => `wrote: ${path}（本次落盘，上面没有单独说明它的行）`),
  ]
}

/**
 * 一条工程内路径在拓扑里只许扮演一个角色。
 *
 * 判据：`game.project.json` 的四类声明各自指向一份文档，而**同一份文件不可能既是 prefab
 * 又是资产清单**——那种状态下两个解析器都「接受」它（未知键原样保留），落盘却只剩最后一个
 * 角色的 canonical 形态，运行时读到的是一份四不像。它与 I3 是同一句话的两个投影：
 * I3 说「一个 (kind,id) 至多一个载体」，这里说「一个载体至多一个角色」。
 *
 * 第十轮起它是 {@link diagnoseWorkspace} 的一员，因此**装载时就成立的角色冲突不再拦编辑**
 * （拦了就等于让 `set_project`——唯一能改这条声明的动作——先要求一个没有冲突的工程）。
 * 冲突期间那条路径**一个字节都不写**，所以「只剩最后一个角色的格式」这件事结构上发生不了。
 */
function assertOneRolePerPath(workspace: LoadedWorkspace): void {
  for (const [path, roles] of rolesByPath(workspace)) {
    if (roles.size < 2) continue
    throw new GameManifestError(
      'INVALID_MANIFEST',
      `${path} 在工程拓扑里同时扮演 ${roles.size} 个角色：${[...roles].join('、')}。`,
      {
        path: 'game.project.json',
        hint:
          '一条路径在 game.project.json 里只能有一种角色（工程清单 / 场景 / prefab / 资产清单），' +
          '冲突期间编辑器不会写这条路径（免得只剩最后一个角色的格式）。' +
          `用 set_project 把那一项指向一条没被占用的路径：资产清单默认 ${GameDefaultAssetsManifestPath}，` +
          `场景默认 ${GameProjectDirectories.scenes}/<id>.scene.json，prefab 默认 ${GameProjectDirectories.prefabs}/<id>.prefab.json。`,
      },
    )
  }
}

/**
 * `game.project.json` 在自己的声明里出现了几次、都出现在哪几项 —— **拓扑的根不能是拓扑的一员**。
 *
 * ## 判决（第十一轮 P0）：写盘保护不适用于工程清单本身
 * 一次 `project:edit` 把 `scenes` 写成 `[…, 'game.project.json']`（`prefabs` / `assets` 同形），
 * 工程清单于是拿到第二个角色、或干脆因为「按场景解析不出来」进 `unreadable`。此后写盘保护
 * 对**工程清单自己**返回不可写：`target='project'` + `set_project` 回 `ok:true`、
 * `diffSummary` 写着 `updated project`，而 `changedFiles` 是空的、磁盘一个字节没动——
 * 三种变体实测全同，且三条闭集出路（改声明 / 改 assets / 重发整份数组）全被 I1 封死，
 * 因为把这条自指声明摘掉在 I1 眼里就是「摘掉一份有内容的清单」。
 *
 * 保护本身是对的（读不出来的路径永不写、一路径两角色一个字节都不动），错的是**它罩住了
 * 拓扑的唯一来源**：工程清单被保护掉 = 整个工具族失效，而这正是 I4 要禁止的那件事。
 * 正解不是给保护开一个例外，而是让这个状态**结构上不存在**：自指声明在装载期就地摘除
 * （见 {@link GameManifestProjectEditor.repairProjectSelfDeclaration}），本次编辑新写进来的
 * 当场抛（同 `throwIfDeclaredByThisEdit` 的归因判据）。工程清单于是永远只有「工程清单」
 * 一个角色，也永远不会被当成子清单去解析。
 */
function projectSelfDeclaredFields(
  project: GameProjectManifest,
  projectPath: string,
): ReadonlyArray<'assets' | 'prefabs' | 'scenes'> {
  return [
    ...(project.scenes.includes(projectPath) ? (['scenes'] as const) : []),
    ...(project.prefabs.includes(projectPath) ? (['prefabs'] as const) : []),
    ...(project.assets === projectPath ? (['assets'] as const) : []),
  ]
}

const GameProjectSelfDeclarationRoles: Readonly<
  Record<'assets' | 'prefabs' | 'scenes', string>
> = {
  assets: '资产清单',
  prefabs: 'prefab',
  scenes: '场景',
}

function projectSelfDeclarationDetail(
  projectPath: string,
  fields: ReadonlyArray<'assets' | 'prefabs' | 'scenes'>,
): string {
  return `${projectPath} 被 project.${fields.join(' / project.')} 声明成了${
    fields.map((field) => GameProjectSelfDeclarationRoles[field]).join(' / ')
  }，而它是工程拓扑的根。`
}

const GameProjectSelfDeclarationHint =
  '工程清单不能同时是自己的场景 / prefab / 资产清单：它一旦拿到第二个角色，'
  + '写盘保护就会把它挡下来，于是连 set_project 都改不动工程——那是唯一能修拓扑的动作。'
  + `场景放 ${GameProjectDirectories.scenes}/<id>.scene.json，`
  + `prefab 放 ${GameProjectDirectories.prefabs}/<id>.prefab.json，`
  + `资产清单放 ${GameDefaultAssetsManifestPath}。`

/**
 * 同一个稳定 id 有两份载体 —— **一句话，两个发现时机**。
 *
 * `findManifestCarryingId` 在「要采纳或要创建」时问这个问题（扫描面 = 整个工程目录），
 * {@link assertOneCarrierPerId} 在每次编辑收尾时问同一个问题（面 = 已装载的拓扑）。
 * 两处共用这一条正文，否则同一件事会有两种说法——解析器 `indexUnique` 那句
 * 「scene id 重复：a」就是第三种，而且它连文件都点不出来（真机第十轮：6/6 个 target 全死）。
 */
function throwAmbiguousCarrier(
  kind: 'prefab' | 'scene',
  id: string,
  paths: readonly string[],
): never {
  throw new GameManifestError(
    'INVALID_MANIFEST',
    `${kind}:${id} 在工程里有 ${paths.length} 份载体：${paths.join(', ')}。`,
    {
      hint:
        '稳定 id 在同一命名空间内必须唯一，编辑器不会替你挑一份。' +
        '用工作区工具删掉多余的那份，或把它的 id 与文件名一起改成别的 slug，再重试。',
    },
  )
}

/**
 * I3 在**已装载拓扑**上的投影。
 *
 * 为什么编辑器要自己再问一遍、而不是等解析器的 `indexUnique`：解析器拿到的是一组**值**，
 * 路径不在它的世界里，所以它只说得出「scene id 重复：a」——真机第十轮实测，那句话既点不出
 * 是哪两份文件，也没有可执行动作，而 6/6 个 target 都因它而死。这里跑在解析器**之前**，
 * 于是模型拿到的是带两条路径、带出路的那一句（{@link throwAmbiguousCarrier}）。
 */
function assertOneCarrierPerId(workspace: LoadedWorkspace): void {
  const namespaces = [
    ['scene', workspace.scenes],
    ['prefab', workspace.prefabs],
  ] as const
  for (const [kind, entries] of namespaces) {
    const pathsById = new Map<string, string[]>()
    for (const entry of entries) {
      pathsById.set(entry.value.id, [
        ...(pathsById.get(entry.value.id) ?? []),
        entry.document.path,
      ])
    }
    for (const [id, paths] of pathsById) {
      if (paths.length > 1) throwAmbiguousCarrier(kind, id, paths)
    }
  }
}

/** {@link diagnoseWorkspace} 的结果：要么给出解析器，要么给出那条说明「为什么解析不动」的错误。 */
interface GameWorkspaceDiagnosis {
  readonly resolver: Nullable<GameManifestResolver>
  readonly error: Nullable<GameManifestError>
}

/**
 * 「这个工程此刻自不自洽」—— **从不抛**，把整体校验从「门」降级成「可报告的状态」。
 *
 * ## 判决（第十轮）：不变量 I4 的机器
 * 整体校验是一条**后置条件**，而后置条件对「它在编辑之前就已经为假」这件事是无能为力的：
 * 它只会把「工程某处坏了」放大成「所有编辑都做不了」。真机第十轮实测：一次 `project:edit` 造出的
 * 继承环 / 同 id 双载体 / 坏 JSON 子清单 / 路径角色冲突 / prefab 环 / 继承超深 / 悬空引用，
 * **每一种都让六个 target 全死**——包括 `set_project`，也就是唯一能修工程拓扑的那条路。
 *
 * 所以这里只**求值**不判决：谁致命由 {@link GameManifestProjectEditor.acceptDiagnosis} 按
 * 「这条诊断是不是本次编辑引入的」来定。非 `GameManifestError`（真正的实现 bug）原样抛出——
 * 降级的是清单层的判据，不是我们自己的崩溃。
 *
 * 顺序：先跑编辑器自己那两条（它们点得出文件路径），再跑解析器（它只有值，点不出路径）。
 */
function diagnoseWorkspace(workspace: LoadedWorkspace): GameWorkspaceDiagnosis {
  try {
    assertOneRolePerPath(workspace)
    assertOneCarrierPerId(workspace)
    const resolver = new GameManifestResolver(sourceSet(workspace))
    resolver.validate()
    return { resolver, error: null }
  } catch (error) {
    if (error instanceof GameManifestError) return { resolver: null, error }
    throw error
  }
}

/** 一次 `edit` 能落在的四种清单文档之一。 */
type GameManifestTargetEntry =
  | ParsedDocument<GameAssetsManifest>
  | ParsedDocument<GamePrefabManifest>
  | ParsedDocument<GameProjectManifest>
  | ParsedDocument<GameSceneManifest>

/**
 * 已经在拓扑里的目标；不在就回 null（由 {@link GameManifestProjectEditor.resolveTarget}
 * 决定采纳 / 创建 / 报错）。
 *
 * ## 判决（第十一轮 P2）：拓扑里有两份载体时**不许挑一份继续跑**
 * 上一版用 `find` 取第一条，于是 `scenes:['scenes/a.scene.json','levels/a.scene.json']`
 * （两份都自称 `id:a`）下 `game:scene_edit(target='scene:a', [set_entity z])` 回 `ok:true`，
 * 实体只落进数组里**靠前**的那一份，摘要一个字不提写的是哪一份；把声明顺序对调，同一条调用
 * 改写另一份。它与失败语义表那一行「触碰一个有两份载体的稳定 id → 失败，列出全部载体路径；
 * 编辑器不挑一份继续跑」直接矛盾。第十轮之前这一格由解析器 `indexUnique` 在装载期抛死，
 * I4 把它降级成 warning 之后，「抛错」就退化成了「静默挑一份」——
 * **该降级的是「打死无关 target」，不是「说实话」。**
 *
 * 这不违反 I4：I4 禁止的是既存破损打死**无关**的编辑（`target='project'` 与其余 target 照常
 * 可用，那也是修好它的唯一通道）；这里被拒的正是**坏在那一点上的那个 target**，报错点名两条
 * 载体路径并给出出路——与 {@link GameManifestProjectEditor.requireReadableAssets}
 * （触碰读不出来的资产清单当场抛）同一条判据，也是第十轮自己立的规矩。
 */
function loadedManifestEntry(
  workspace: LoadedWorkspace,
  target: GameManifestEditTarget,
): Nullable<GameManifestTargetEntry> {
  if (target === 'project') return workspace.project
  if (target === 'assets') return workspace.assets
  const id = gameReferenceId(target)
  const kind = target.startsWith('scene:') ? 'scene' : 'prefab'
  const carriers: readonly GameManifestTargetEntry[] = (
    kind === 'scene' ? workspace.scenes : workspace.prefabs
  ).filter((candidate) => candidate.value.id === id)
  if (carriers.length > 1) {
    throwAmbiguousCarrier(kind, id, carriers.map((entry) => entry.document.path))
  }
  return toNullable(carriers[0])
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

/** {@link parseOrReport} 的结果：解析成功，或那条说明「为什么读不出来」的错误。 */
type GameManifestParseOutcome<T> =
  | { readonly parsed: GameManifestParseResult<T>; readonly failure: null }
  | { readonly parsed: null; readonly failure: GameManifestError }

/**
 * 解析一份**已声明**的子清单：读得出就返回，读不出就出一条 warning 并把错误交回调用方。
 *
 * 判决（第十轮）：装载与声明激活都是每一次编辑的公共前置，在那里抛错就是把「一份文件坏了」
 * 放大成「整个工具族不可用」——`project:edit` 写坏 `scenes/a.scene.json`、或者把一份场景误声明成
 * prefab，之后连 `target='project'` 都动不了（code-standard §2.8：装载路径上的失败要降级并记账）。
 *
 * 降级不是遗忘：路径与那条解析错误每次都在 warnings 里点名；它不进工作集，所以
 * {@link serializeWorkspace} 里根本没有它的文本，**结构上写不到它头上**；而真的以它为 target 时
 * 照旧当场抛同一条错（scene / prefab 走采纳时重解，assets 见
 * {@link GameManifestProjectEditor.requireReadableAssets}）。
 *
 * 工程清单本身**不走这条路**，见 {@link parseProjectManifestOrFail}。
 */
function parseOrReport<T>(
  workspace: LoadedWorkspace,
  document: GameManifestDocument,
  parse: (text: string, sourceName: string) => GameManifestParseResult<T>,
): GameManifestParseOutcome<T> {
  try {
    return { parsed: parse(document.text, document.path), failure: null }
  } catch (error) {
    if (!(error instanceof GameManifestError)) throw error
    workspace.warnings.push(
      `game.project.json 声明的 ${document.path} 这次读不出来，已被排除在本次编辑之外`
        + `（声明与文件都原样保留，编辑器不会覆盖它）：${error.message}`,
    )
    return { parsed: null, failure: error }
  }
}

/**
 * 声明激活期读不出来一条路径 —— **谁的锅，判据与 I1 同形：这条声明是不是本次编辑加的**。
 *
 * - 装载时就声明着（`declaredAtLoad` 里有它）→ 既存破损，降级：这条声明这次不生效，
 *   warning 已经点过名，编辑照常完成（不变量 I4）。
 * - 本次编辑刚加的（`set_project` 把一份坏文件声明了进来）→ **抛**，零文件落盘。
 *   这是第七轮就立下的回归锁「declaring a malformed draft is rejected」，不许放宽：
 *   模型刚刚指的那条路，当场告诉它指错了，比留一条 warning 有用得多。
 *
 * 这不是「对这次请求的谓词」——它问的是编辑前后两个声明集合之间的差，和 I1 问的是同一类问题。
 */
function throwIfDeclaredByThisEdit(
  workspace: LoadedWorkspace,
  path: string,
  failure: GameManifestError,
): void {
  if (!workspace.declaredAtLoad.has(path)) throw failure
}

/**
 * **装载期**读不出来的一条声明：进 `unreadable`（不写盘、`target` 到它时当场抛）+ 进
 * `declaredAtLoad` 且按「有内容」记（I1 因此仍然拦得住「顺手把它摘掉」——它在磁盘上有内容，
 * 只是我们这次读不懂）。
 *
 * 只在装载期用。声明激活期的同一件事**不登记**，判据见 `activateDeclaredScenesAndAssets`
 * 里的注释：那时同一路径可能正被另一个角色正常读着。
 */
function excludeUnreadableDeclaration(
  workspace: LoadedWorkspace,
  path: string,
  kind: DeclaredManifestSnapshot['kind'],
  failure: GameManifestError,
): void {
  workspace.unreadable.set(path, failure)
  rememberDeclaredAtLoad(workspace, path, kind, true)
}

/**
 * 记一条「装载时它是这样」的 I1 基线；同一条路径被两个角色声明时 **`hasContent` 取或**。
 *
 * 判决（第十一轮）：这张表按路径记账，而一条路径可以既是场景又是 prefab（第十一轮 P1 之后
 * 两个角色都会真的装载）。后写的那条过去会把前一条整个覆盖掉——一份**有实体的场景**被同时
 * 声明成 prefab（按 prefab 读是空的）时，`hasContent` 会从 true 塌成 false，于是同时摘掉两条
 * 声明就成了 I1 眼里的「空壳放行」，那份有内容的文件被静默孤立。丢不丢内容与角色无关。
 */
function rememberDeclaredAtLoad(
  workspace: LoadedWorkspace,
  path: string,
  kind: DeclaredManifestSnapshot['kind'],
  hasContent: boolean,
): void {
  const previous = workspace.declaredAtLoad.get(path)
  workspace.declaredAtLoad.set(path, {
    kind: previous?.kind ?? kind,
    hasContent: !!previous?.hasContent || hasContent,
  })
}

/**
 * 变更判定的基线，**先到先得**。
 *
 * 判决（第十轮，结清第九轮登记的欠账）：同一条路径被两个角色声明时，后装载的那个角色会把
 * 前一个的 canonical 基线覆盖掉（两个角色格式化同一份原文得到的文本不同），于是角色冲突修好
 * 之后那份文件被顺手重写——`changedFiles` 里有它、`diffSummary` 里没有对应行。
 * 基线是「这份**文件**装载时长什么样」，与谁声明了它无关，所以第一条写进去的就是它。
 */
function rememberCanonicalBaseline(
  workspace: LoadedWorkspace,
  path: string,
  canonical: string,
): void {
  if (workspace.canonicalAtLoad.has(path)) return
  workspace.canonicalAtLoad.set(path, canonical)
}

/**
 * `game.project.json` —— **唯一一份读不出来就没得编辑的文档**。
 *
 * 不变量 I4 的边界，写在这里而不是留给读者推：拓扑的唯一来源坏了，就没有「工程」可以 target；
 * 而拿自举基线顶上等于抹掉用户已经写下的配置（那比报错糟得多）。
 *
 * 这不是「产品自己造得出、自己修不了」的状态：编辑器写盘前一定先解析过自己要写的文本，
 * 所以它**造不出**一份读不回来的工程清单；能造出这个状态的只有 `project:edit`，而它也能改回去。
 * 正文点名文件与逐条问题，出路只有一步。
 */
function parseProjectManifestOrFail(
  document: GameManifestDocument,
): GameManifestParseResult<GameProjectManifest> {
  try {
    return parseGameProjectManifestText(document.text, document.path)
  } catch (error) {
    if (!(error instanceof GameManifestError)) throw error
    const boundary = 'game.project.json 是工程拓扑的唯一来源，也是唯一一份编辑器无法降级处理的清单'
      + '（其余清单读不出来只会被排除在本次编辑之外，不影响 target=project）。'
      + '用工作区编辑工具按上面的逐条问题把它改回合法，game:scene_edit 随即恢复；'
      + '编辑器不会拿一份空白工程覆盖它。'
    throw new GameManifestError(error.code, error.detail, {
      path: document.path,
      hint: isPresent(error.hint) ? `${error.hint}\n${boundary}` : boundary,
    })
  }
}

export class GameManifestProjectEditor implements GameSceneEditorPort {
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
    this.assertNoProjectSelfDeclaration(workspace)
    this.assertNoSilentUndeclare(workspace)
    await this.activateDeclaredManifests(workspace)
    this.reparseManifests(workspace)
    this.acceptDiagnosis(workspace)

    const after = serializeWorkspace(workspace)
    const roles = rolesByPath(workspace)
    const emitted = new Set<string>()
    const changes = topologyDocuments(workspace).flatMap((
      { document },
    ): GameManifestDocumentChange[] => {
      // 同一路径在拓扑里可能出现两次（角色冲突）；变更清单按**路径**唯一，否则宿主把
      // 「同批重复路径」当硬错整批拒。
      if (emitted.has(document.path)) return []
      emitted.add(document.path)
      const next = after.get(document.path)
      if (!isPresent(next)) return []
      // 自举路径的基线是 null：它在磁盘上还不存在，「文本没变」不代表「不用写」。
      // 少了这一条，首次编辑只会落下 game.project.json，而它指向的资产清单仍缺席。
      // 其余路径的基线取装载逐份记下的那份（见 LoadedWorkspace.canonicalAtLoad）；本批才进入
      // 拓扑的文档（磁盘上已有、被指名为目标或由 set_project 声明）不在账里，用它自己的原文。
      // **不能沿用旧的 `!before.has(path) → 跳过`**：那条在「同一批里采纳一份草稿并接着改它」
      // 上会把改动整批静默丢掉。
      const baseline = workspace.bootstrapPaths.has(document.path)
        ? null
        : (before.get(document.path) ?? document.text)
      const pending = !isPresent(baseline) || next !== baseline
      // 写盘保护先判、再看有没有东西被它挡下来：**被挡掉的改动必须出现在报告里**，
      // 否则模型读到的是一次「成功但什么也没发生」（第十一轮 P0 的表征）。
      const veto = this.writeVetoReason(workspace, roles, document.path)
      if (isPresent(veto)) {
        if (pending) this.recordSuppressedWrite(workspace, document.path, veto)
        return []
      }
      if (!pending) return []
      return [
        {
          path: document.path,
          text: next,
          expectedRevision: document.revision,
          // 宿主按真值分档（`if (change.create)`），所以显式 false 与缺席等价；写成常规字段
          // 而不是单属性条件展开。
          create: !isPresent(baseline),
        },
      ]
    })

    if (!request.dryRun && !isEmpty(changes)) {
      await this.store.writeBatch(changes)
    }

    return {
      ok: true,
      target: request.target,
      changedFiles: changes.map((change) => change.path),
      operationsApplied: request.operations.length,
      diffSummary: reconcileSummary(workspace, changes),
      warnings: [...new Set(workspace.warnings)],
      appliedAdjustments: workspace.adjustments,
      dryRun: !!request.dryRun,
    }
  }

  /**
   * 不变量 I4：**一次编辑只为它自己造成的破损负责**。
   *
   * ## 判决（第十轮）：整体校验不能是一道无条件的门
   * > 装载时就已经成立的整体诊断，永不阻断这次编辑；只有**本次编辑新引入**的诊断才 fail-fast。
   *
   * 前九轮所有的守卫都长在「编辑之后工程必须自洽」上，而这句后置条件对「它在编辑之前就已经
   * 为假」束手无策——它只会把「某处坏了」放大成「所有编辑都做不了」。第十轮实测的七种坏状态
   * （继承环 / prefab 环 / 继承超深 / 同 id 双载体 / 声明数组重复项 / 坏 JSON 子清单 /
   * 路径角色冲突 / 悬空 asset 与 extends 引用）**每一种都让六个 target 全死**，包括
   * `set_project`——唯一能修工程拓扑的那条路。把恢复放在致命点的下游，恢复就永远跑不到。
   *
   * 于是判据换成**归因**：诊断是不是这次编辑带来的。
   *  - 装载时自洽（`diagnosisAtLoad === null`）→ 现在出诊断只可能是这批操作造成的 → **抛**，
   *    零文件落盘，工程停在编辑前那个健康状态（模型换一批操作即可，永远有路）。
   *  - 装载时已坏 → 这里**结构上没有 throw**：写盘照常，诊断随 warnings 原文送达（含 hint）。
   *    工程本来就是坏的，拦下来只会把它锁死；而每一次编辑都会把「还坏在哪」重新说一遍。
   *
   * 这条不变量是**对状态空间全称的**：它不认识环、不认识重复 id、也不需要认识下一种坏法。
   */
  private acceptDiagnosis(workspace: LoadedWorkspace): void {
    const { error } = diagnoseWorkspace(workspace)
    if (!error) return
    if (!workspace.diagnosisAtLoad) {
      // 归因与「零文件落盘」在这里都是**已知事实**，不说出来就等于让模型自己猜「是我这批干的，
      // 还是工程本来就这样？成功了一半没有？」。一条光秃秃的校验错误读起来像半成功（原则甲）。
      throw new GameManifestError(error.code, error.detail, {
        path: error.path,
        hint:
          `${isPresent(error.hint) ? `${error.hint}\n` : ''}`
          + '这个问题是本次编辑引入的（工程在编辑开始之前是自洽的），所以整批操作已被拒绝：'
          + '零文件落盘，磁盘停在编辑前那个状态。换一批操作重试即可。',
      })
    }
    workspace.warnings.push(
      // 「已经写入」这句话在「该写的都被写盘保护挡下了」那一档是假的（changedFiles 会是空的）：
      // 落盘情况只有一个权威陈述，就是 changedFiles，这里指过去而不是替它下结论（原则甲）。
      '本次编辑照常完成（具体落了哪些盘见 changedFiles）；但这个工程在编辑开始之前就已经不自洽了'
        + `（所以没有拦它），修好之前 game:run / game:query_state 读到的仍是坏的工程：${error.message}`,
    )
  }

  /**
   * 这条路径这次为什么不能写；`null` = 能写。
   *
   * 两档都是「写下去一定丢内容」，与「工程自不自洽」无关，所以不归 I4 管：
   *  - **占位值**：这份文档这次解析不出来，内存里顶着的是空基线，写 = 用空的盖掉真内容；
   *  - **角色冲突**：`serializeWorkspace` 按路径收敛，两个角色只会留下最后一个的 canonical 形态。
   *
   * 判决（第十一轮）：判据从「这条路径在 `unreadable` 里」收窄成「我手里这份值是占位的」。
   * 上一版按路径记账，于是**工程清单被误声明成场景**时它自己的路径进了那张表，拿着权威工程值
   * 的写入被自己挡掉——那正是 P0 那次「ok:true、零落盘」的机制。
   * 判「能不能写」与判「谁跟谁冲突」现在都只有一个执行点，且都不再依赖解析成功与否。
   */
  private writeVetoReason(
    workspace: LoadedWorkspace,
    roles: ReadonlyMap<string, ReadonlySet<string>>,
    path: string,
  ): Nullable<string> {
    if (workspace.placeholderPaths.has(path))
      return '这份文件这次读不出来，内存里顶着的是一份空的占位清单'
    const occupied = roles.get(path)
    if (occupied && occupied.size > 1)
      return `game.project.json 里同时把它声明成 ${[...occupied].join('、')}`
    return null
  }

  /**
   * 这次有改动落在一条写不得的路径上 —— **必须说出来**（原则甲）。
   *
   * 「抛错」比「撒谎」好：抛错模型还能重试，撒谎它以为成了。保护本身不改（写下去一定丢内容），
   * 改的是它不再静默：摘要出一条 `skipped write` 行、warnings 给出恢复动作。
   */
  private recordSuppressedWrite(
    workspace: LoadedWorkspace,
    path: string,
    reason: string,
  ): void {
    pushSummary(
      workspace.summaries,
      [path],
      'skipped write',
      `${path}（${reason}；本次对它的改动没有落盘，磁盘上一个字节都没动）`,
    )
    workspace.warnings.push(
      `${path} 这次没有写盘：${reason}——写下去会丢内容。`
        + '本次编辑里落在它头上的改动因此没有生效；'
        + '先把那份文件改回可解析、或用 set_project 把冲突的那一项改指到别的路径，再重发这批操作。',
    )
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
    // `target='project'` 的**窄路径**（不变量 I4 的第三个执行点）：第一行返回，不走扫描、
    // 不走自举、不碰任何别的文档。工程清单在 loadWorkspace 里一定已经就位（缺席即自举，
    // 读不出来则整次编辑已经在那里以点名的方式失败了），所以这一行结构上抛不出来。
    if (target === 'project') return workspace.project
    if (target === 'assets') return this.requireReadableAssets(workspace)
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
      pushSummary(
        workspace.summaries,
        [document.path, workspace.project.document.path],
        `declared ${kind}`,
        `${target} → ${document.path}`,
      )
    }
    if (kind === 'scene') {
      const entry = { document, value: cloneRecord(parsed.value as GameSceneManifest) }
      workspace.scenes.push(entry)
      if (!workspace.project.value.scenes.includes(document.path)) {
        workspace.project.value.scenes = [...workspace.project.value.scenes, document.path]
      }
      // 入口场景只在「工程还没有入口 + 这是第一条场景」时补：解析器的 `scenes[0]` 缺省规则本来
      // 就是这么定的，而它只在**清单里没写 entryScene 这个键**时生效——自举出来的工程写盘后
      // 那一格是显式 `null`，缺省规则从此不再触发，于是 game:run 只会说「没有 entryScene」。
      if (!workspace.project.value.entryScene && workspace.project.value.scenes.length === 1) {
        workspace.project.value.entryScene = `scene:${id}`
        pushSummary(
          workspace.summaries,
          [workspace.project.document.path],
          'set entry scene',
          target,
        )
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
   * `target='assets'`：资产清单这次读不出来时当场抛那条解析错误。
   *
   * scene / prefab 不需要这一格——它们读不出来就不在工作集里，`resolveTarget` 会走采纳分支
   * 重解一遍，自然抛同一条错。资产清单没有「按 id 采纳」这条路（它根本没有稳定 id），
   * 所以显式挡一道：**触碰坏文件要当场知道它坏了，不触碰它则什么都不影响**。
   */
  private requireReadableAssets(
    workspace: LoadedWorkspace,
  ): ParsedDocument<GameAssetsManifest> {
    const failure = workspace.unreadable.get(workspace.assets.document.path)
    if (failure) throw failure
    return workspace.assets
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
   * 可能在磁盘上被打破的入口是 `project:edit`（它不过编辑器，拦不住），既然打破了就必须当面说，
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
    return throwAmbiguousCarrier(kind, id, carriers.map((document) => document.path))
  }

  /** 缺席的资产清单 → 空清单基线（不需要 id，路径由 `project.assets` 自己声明）。 */
  private bootstrapAssetsDocument(
    workspace: LoadedWorkspace,
    path: string,
  ): GameManifestDocument {
    return this.recordBootstrap(
      workspace,
      path,
      'created assets manifest',
      path,
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
      `created ${kind}`,
      `${kind}:${id} → ${path}`,
      (kind === 'scene' ? gameSceneBootstrapText : gamePrefabBootstrapText)(id),
    )
  }

  /**
   * 自举前的最后一道门：这个稳定 id 是不是已经有载体了 —— **不变量 I3 的唯一执行点**。
   *
   * ## 判决（第八轮）：「一个 id 一个载体」不是假设，是自举的前置条件
   * 自举的正当性完全建立在「一个稳定 id 在工程里只有一个载体」上，而第七轮只查
   * **已声明并装载**的那批。于是文档明确保留的那条路——模型先用 `project:edit` 手写
   * `levels/main.scene.json`（id=main）——照样在 `scenes/main.scene.json` 另起一份空清单，
   * 手写那份连同两个实体被跳过，全程零提示，磁盘上从此有两份 id=main。
   *
   * 现在取证面是整个工程（{@link scanProjectManifests}），而且这条门只管一件事：
   * **不创建第二个载体**。已经有载体时的正解不是报错而是采纳它，那一半在
   * {@link resolveTarget} 里；只有「声明指向 A、载体却在 B」这种模型自己指错落点的形态
   * 才走到这里报错，并点名 B。
   *
   * 于是文档可以老实写：这条不变量被强制的时机，是「编辑器**要采纳或要创建**一份清单」那一刻，
   * 且只有那一刻会扫工程目录。
   *
   * **不许再写「下一次触碰该 id 时会被当面报出」**（第九轮实测证伪、第十轮把这处代码注释也改实）：
   * 编辑一份**已经被声明**的清单短路在 `loadedManifestEntry`，一次盘都不走（`manifestScans === 0`
   * 有回归锁），所以 `project:edit` 事后手写出的第二份在那条路径上**发现不了**——它也不会被工程加载，
   * 只是一份无人读的死文件。它会在下一次**需要采纳或创建**该 id 时（声明被摘掉后重新触碰、
   * 换一个落点）被 {@link findManifestCarryingId} 报出；如果它被声明进了工程，
   * 收尾的 {@link assertOneCarrierPerId} 也会在诊断里点名两份载体。
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
    action: string,
    target: string,
    text: string,
  ): GameManifestDocument {
    ledger.bootstrapPaths.add(path)
    // `onlyIfWritten`：自举出来的清单可能在同一批里又被摘出声明（实测：
    // `set_project({scenes:[], entryScene:null})` 会先补一份声明缺失的空场景、再把它摘掉），
    // 那时磁盘上从来没有过这份文件，「created …」就是一句假话。这一行的真伪由变更清单裁定。
    pushSummary(ledger.summaries, [path], action, target, { onlyIfWritten: true })
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
    pushSummary(
      workspace.summaries,
      [workspace.project.document.path],
      `redeclared ${kind}`,
      `${declaredPath}（已不在磁盘上）→ ${adopted.path}`,
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
   *
   * **`id` 为 null 那一支不撤 `entryScene`，这不是漏而是空集**（第十轮把第九轮登记的这条欠账
   * 结清）：走到这里的前提是 `store.read(path)` 回了空——文件**不在磁盘上**，因此它没有声明
   * 任何 id；而 `entryScene` 只能是 `scene:<合法 slug>`，那个 slug 不可能来自一份不存在、
   * 文件名又推不出 slug 的清单。真出现「entryScene 指向谁都不携带的 id」时，它由 I4 当成
   * 装载期诊断报出来（一条 warning，不拦编辑），出路是 `set_project({entryScene:'scene:<现有>'})`
   * 或直接 `target='scene:<那个 id>'` 把它建出来。
   *
   * 另半条欠账（「warning 结构上送不到模型手里，因为 warnings 只随成功结果返回」）由 I4 结构性
   * 解决：装载期修复之后残留的诊断不再抛，这次编辑照常成功，警告随结果送达。
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
    pushSummary(
      workspace.summaries,
      [workspace.project.document.path],
      `dropped dangling ${kind}`,
      `${path}（声明已摘除，磁盘上本就没有这份文件）`,
    )
    workspace.warnings.push(
      `game.project.json 声明的 ${path} 已被摘除，工程其余部分照常可编辑：${reason}`,
    )
    if (isPresent(id) && workspace.project.value.entryScene === `scene:${id}`) {
      workspace.project.value.entryScene = null
      pushSummary(
        workspace.summaries,
        [workspace.project.document.path],
        'cleared entry scene',
        `scene:${id}（入口场景随悬空声明一并撤下）`,
      )
    }
  }

  /**
   * 装载一个命名空间下**全部已声明**的清单 —— scenes 与 prefabs 逐字同形，所以只有一份实现。
   *
   * ## 判决（第十一轮 P1）：装载与收尾必须用同一份拓扑计算
   * 上一版是两个近似孪生的循环，共用**一个**跨种类的 `loadedPaths` 去重集：同一条路径被
   * scenes 抢先认领之后，prefabs 循环直接 `continue`，第二个角色对 `diagnosisAtLoad` **隐身**；
   * 而 `activateDeclaredPrefabs` 没有同一条去重，于是那个角色在收尾时**凭空出现**，
   * {@link GameManifestProjectEditor.acceptDiagnosis} 按 `diagnosisAtLoad === null` 判成
   * 「本次编辑引入」并抛——实测 `scenes:[…,'shared/thing.json']` +
   * `prefabs:[…,'shared/thing.json']` 让六个 target 全死。
   *
   * 这不是又一种坏法，而是 I4 的**归因基准**本身错了：I4 依赖 `diagnosisAtLoad` 忠实快照编辑前
   * 的拓扑，两套规则算出两个拓扑，归因就失去意义。所以去重集**按种类各持一份、且由本方法自己
   * 拥有**——跨种类泄漏从此不是「别忘了」，而是作用域上不可能。种类内的去重仍然必要：
   * 一条声明可能被 {@link loadDeclaredManifest} 就地改指到另一条已装载的路径上。
   *
   * 迭代的是**声明数组的快照**：`loadDeclaredManifest` 会就地改写 / 摘除声明。
   */
  private async loadDeclaredManifestsOfKind(
    workspace: LoadedWorkspace,
    kind: 'prefab' | 'scene',
  ): Promise<void> {
    const declared = [
      ...(kind === 'scene'
        ? workspace.project.value.scenes
        : workspace.project.value.prefabs),
    ]
    const loadedPaths = new Set<string>()
    for (const declaredPath of declared) {
      // 声明了却还没落文件 = 半成品，不是损坏：采纳既有载体，一个都没有才补一份合法空清单。
      // 旧行为在这里抛 `找不到游戏清单 <path>` 并让模型「用工作区工具创建」——那正是把模型
      // 从语义 API 推回手写 JSON 的那道墙。
      const document = await this.loadDeclaredManifest(workspace, declaredPath, kind)
      if (!document || loadedPaths.has(document.path)) continue
      loadedPaths.add(document.path)
      // 显式标注联合返回：三元表达式的类型是两个函数类型的联合，泛型推断只会认下第一个。
      const parse: (
        text: string,
        sourceName: string,
      ) => GameManifestParseResult<GamePrefabManifest | GameSceneManifest> =
        kind === 'scene' ? parseGameSceneManifestText : parseGamePrefabManifestText
      const { parsed, failure } = parseOrReport(workspace, document, parse)
      if (!parsed) {
        excludeUnreadableDeclaration(workspace, document.path, kind, failure)
        continue
      }
      rememberCanonicalBaseline(workspace, document.path, formatGameManifest(parsed.value))
      if (kind === 'scene') {
        const value = parsed.value as GameSceneManifest
        workspace.scenes.push({ document, value: cloneRecord(value) })
        rememberDeclaredAtLoad(workspace, document.path, kind, !isEmptySceneManifest(value))
      } else {
        const value = parsed.value as GamePrefabManifest
        workspace.prefabs.push({ document, value: cloneRecord(value) })
        rememberDeclaredAtLoad(workspace, document.path, kind, !isEmptyPrefabManifest(value))
      }
      collectParseResult(workspace, parsed)
    }
  }

  /** 读一份清单；缺席时回自举基线并登记（见 {@link recordBootstrap}）。 */
  private async readOrBootstrap(
    ledger: GameBootstrapLedger,
    path: string,
    action: string,
    bootstrapText: string,
  ): Promise<GameManifestDocument> {
    const stored = await this.store.read(path)
    if (stored) return requireDocument(stored, path)
    return this.recordBootstrap(ledger, path, action, path, bootstrapText)
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
      'created project manifest',
      GameProjectBootstrapText,
    )
    const projectResult = parseProjectManifestOrFail(projectDocument)
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
      diagnosisAtLoad: null,
      unreadable: new Map(),
      placeholderPaths: new Set<string>(),
      warnings: [...projectResult.warnings],
      adjustments: [...projectResult.appliedAdjustments],
      ...ledger,
    }

    // 自指声明先摘：它让工程清单拿到第二个角色 / 进 unreadable，随后写盘保护会把工程清单
    // 自己挡掉——整个工具族失效（第十一轮 P0）。摘在这里，下面的装载看到的就是一份干净拓扑。
    this.repairProjectSelfDeclaration(workspace)
    await this.loadDeclaredManifestsOfKind(workspace, 'scene')
    await this.loadDeclaredManifestsOfKind(workspace, 'prefab')

    // 资产清单缺席即自举，**不再要求「工程本身也是自举出来的」**。
    //
    // 判决（真机第一手，第六轮）：原来的条件把「工程已存在却缺资产清单」判成损坏并抛
    // `找不到游戏清单 assets/assets.json`。但那既不是损坏也无从下手——文件已经不在了，
    // 一份空清单不会覆盖掉任何东西（真丢了内容，随后的引用校验会精确报出缺哪个 asset），
    // 而错误提示唯一给得出的自救动作就是「手写这份 JSON」，也就是把模型推回踩坑起点。
    // 与场景/prefab 同一条判据：**缺席是半成品，不是损坏。**
    const assetsPath = workspace.project.value.assets
    const assetsDocument = await this.readOrBootstrap(
      workspace,
      assetsPath,
      'created assets manifest',
      GameAssetsBootstrapText,
    )
    const assets = parseOrReport(workspace, assetsDocument, parseGameAssetsManifestText)
    // 读不出来时用空清单占位：拓扑里必须有一份资产清单，而这条路径同时进了 `placeholderPaths`
    // ——它既不会被写盘（writeVetoReason），也不会被 `target='assets'` 悄悄编辑
    // （requireReadableAssets 当场抛那条解析错）。
    workspace.assets = {
      document: assetsDocument,
      value: cloneRecord(assets.parsed?.value ?? { assets: [] }),
    }
    if (assets.parsed) {
      rememberCanonicalBaseline(
        workspace,
        assetsDocument.path,
        formatGameManifest(assets.parsed.value),
      )
      rememberDeclaredAtLoad(
        workspace,
        assetsDocument.path,
        'assets',
        !isEmptyAssetsManifest(assets.parsed.value),
      )
      collectParseResult(workspace, assets.parsed)
    } else {
      excludeUnreadableDeclaration(workspace, assetsDocument.path, 'assets', assets.failure)
      workspace.placeholderPaths.add(assetsDocument.path)
    }
    // 不变量 I4 的基线：装载期的就地修复（redeclare / drop / 排除读不出来的文档）已经全部做完，
    // 此刻还剩下的诊断就是「这个工程在本次编辑动手之前就已经不自洽」。
    workspace.diagnosisAtLoad = diagnoseWorkspace(workspace).error
    return workspace
  }

  /**
   * 装载期就地摘掉工程清单的自指声明 —— 判据与 {@link dropDanglingDeclaration} 同族。
   *
   * 摘它不丢任何东西：`game.project.json` 本来就在磁盘上、本来就被工程清单这个角色读着，
   * 少的只是一条**结构上不可能成立**的声明（工程清单不是场景，按场景解析必然失败）。
   * 留着它的代价则是整个工具族失效，见 {@link projectSelfDeclaredFields} 的判决。
   * 摘除永远留痕（摘要行 + warning），`entryScene` 不需要跟着撤——工程清单的文件名
   * 推不出合法 slug，没有任何 `scene:<slug>` 能指向它。
   */
  private repairProjectSelfDeclaration(workspace: LoadedWorkspace): void {
    const path = workspace.project.document.path
    const fields = projectSelfDeclaredFields(workspace.project.value, path)
    if (isEmpty(fields)) return
    workspace.project.value.scenes = workspace.project.value.scenes.filter(
      (candidate) => candidate !== path,
    )
    workspace.project.value.prefabs = workspace.project.value.prefabs.filter(
      (candidate) => candidate !== path,
    )
    if (workspace.project.value.assets === path) {
      workspace.project.value.assets = GameDefaultAssetsManifestPath
    }
    pushSummary(
      workspace.summaries,
      [path],
      'dropped self-declaration',
      `${path}（project.${fields.join(' / project.')}；工程清单不能同时是自己的子清单）`,
    )
    workspace.warnings.push(
      `${projectSelfDeclarationDetail(path, fields)}这条声明已被摘除，`
      + `工程其余部分照常可编辑：${GameProjectSelfDeclarationHint}`,
    )
  }

  /**
   * 本次编辑把工程清单声明成了自己的子清单 —— **抛**，零文件落盘。
   *
   * 归因与 {@link throwIfDeclaredByThisEdit} 同形：装载期已经把既存的那条摘掉了，所以走到这里
   * 的自指声明只可能是这批操作刚写进来的。刚指错的那条路，当场告诉模型比留一条 warning 有用。
   */
  private assertNoProjectSelfDeclaration(workspace: LoadedWorkspace): void {
    const path = workspace.project.document.path
    const fields = projectSelfDeclaredFields(workspace.project.value, path)
    if (isEmpty(fields)) return
    throw new GameManifestError(
      'INVALID_MANIFEST',
      projectSelfDeclarationDetail(path, fields),
      { path, hint: GameProjectSelfDeclarationHint },
    )
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
        // 「文件保留在磁盘上」对**本次编辑刚自举出来**的那一档是假话：那份清单是声明缺文件时
        // 补出来的基线，摘掉声明之后它一个字节都不会落盘（实测：先删文件、再
        // `set_project({scenes:[], entryScene:null})`）。两档分开说，别把半真的话说满。
        const fate = workspace.bootstrapPaths.has(path)
          ? '磁盘上本就没有这份文件，本次也没有把它建出来'
          : '文件保留在磁盘上'
        pushSummary(
          workspace.summaries,
          [workspace.project.document.path],
          `undeclared ${snapshot.kind}`,
          `${path}（空清单，${fate}）`,
        )
        workspace.warnings.push(`${path} 已退出 project 声明；它是一份空清单，${fate}。`)
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
            `确实要弃用它，先用工作区工具把文件删掉或移出工程，再改声明${
              this.entrySceneRidesOn(workspace, path)
            }。`,
        },
      )
    }
  }

  /**
   * 「顺手把 `entryScene` 也带上」—— **药方必须整条走得通，不能只走到一半**。
   *
   * 判决（第十一轮 P2）：I1 开出的第三条出路（「先用工作区工具把文件删掉或移出工程，再改声明」）
   * 在**最常见的形态**下走不通：被摘的那份正是入口场景时，删完文件重发同一条 `set_project`
   * 会撞上一条悬空 `entryScene`，报错正文只说「找不到 scene:a。可用 scene id：当前为空。」
   * ——既不点名 `entryScene` 也不点名 `game.project.json`，读起来是条死胡同。
   * 药方在开出来的那一刻就得把这一步带上；这句话只在**确实指着它**时出现，不制造噪音。
   */
  private entrySceneRidesOn(workspace: LoadedWorkspace, path: string): string {
    const carried = workspace.scenes.find((entry) => entry.document.path === path)?.value.id
    if (!isPresent(carried) || workspace.project.value.entryScene !== `scene:${carried}`) return ''
    return (
      `（注意 game.project.json 的 entryScene 正指着 scene:${carried}，`
      + '删掉文件后要在同一批里把它一起改：'
      + 'set_project({scenes:[…], entryScene:null}) 或指到另一个仍然存在的场景，'
      + '否则下一次会撞上一条悬空入口）'
    )
  }

  /**
   * 拓扑校验的三条老门（`project.scenes` / `project.assets` / `project.prefabs`
   * 「新增了尚不存在的清单」）**已在第十轮删除**，不要再加回来。
   *
   * 第六轮把「声明一条还不存在的路径」改成了 upsert（自举），从那以后 `activateDeclared*`
   * 会把每一条声明都变成拓扑里的一员，这三条于是**结构上不可达**；而它们留下的药方
   * （「先用工作区工具创建并校验，再把它加入 project.scenes」）与现在的行为完全相反——
   * 正是第六轮拆掉的那堵墙。死代码 + 误导，一起清掉。
   *
   * 现在收尾只剩一条 {@link GameManifestProjectEditor.acceptDiagnosis}，它把
   * {@link assertOneRolePerPath} / {@link assertOneCarrierPerId} / 解析器全量校验
   * 一起当成**可归因的诊断**处理。
   */
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
      // 装载时就读不出来的那几份：声明保留、文件保留、不进工作集。少了这一句就会在这里
      // 重读并重抛同一条解析错误，把「一份文件坏了」又变回「整个工具族不可用」。
      if (workspace.unreadable.has(scenePath)) continue
      // `set_project` 把一条新场景路径写进 `scenes[]` 同样是 upsert：登记一份还不存在的清单，
      // 意图就是「这个场景应该有」。旧行为抛 `project.scenes 新增了尚不存在的清单` 并让模型
      // 「先用工作区工具创建」——与 `resolveTarget` 同一条判据，这里一并拉平。
      const stored = await this.store.read(scenePath)
      const document = stored ?? (await this.bootstrapDocument(workspace, scenePath, 'scene'))
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
      // 读不出来只让这条声明这次不生效（warning 已由 parseOrReport 出），不阻断整次编辑：
      // 「一份场景被误声明成 prefab」之类的状态，声明与文件都还在，模型下一步用 set_project
      // 或工作区工具都改得动。这里**不进 `unreadable`**——那份文件可能正被另一个角色
      // 正常读着（同一路径两个角色时），进了就会把那个角色的正常写盘也一起挡掉。
      const { parsed, failure } = parseOrReport(workspace, document, parseGameSceneManifestText)
      if (!parsed) {
        throwIfDeclaredByThisEdit(workspace, document.path, failure)
        continue
      }
      collectParseResult(workspace, parsed)
      // 中途采纳：磁盘上本来就有这份草稿，本次编辑把它登记进工程并按 canonical 重写。
      // 少了这一行，模型会在 changedFiles 里看到一份自己没听说改过的文件（第十一轮 P3）。
      if (stored) {
        pushSummary(
          workspace.summaries,
          [document.path],
          'declared scene',
          `scene:${parsed.value.id} → ${document.path}（磁盘上已有的草稿，已登记并规范化）`,
        )
      }
      scenes.push({ document, value: cloneRecord(parsed.value) })
    }
    workspace.scenes = scenes

    const assetsPath = workspace.project.value.assets
    if (workspace.assets.document.path === assetsPath) return
    // 把 `project.assets` 改到一条还不存在的路径同样是 upsert（与 scenes / prefabs 同判据）。
    const storedAssets = await this.store.read(assetsPath)
    const document = storedAssets ?? this.bootstrapAssetsDocument(workspace, assetsPath)
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
    // 资产清单不能像 scenes / prefabs 那样「这次不生效」——`project.assets` 已经指向新路径，
    // 拓扑里必须跟着换过去，否则落盘的工程清单说 A、写下去的资产清单还是 B。
    // 所以照装载期那一档处理：占位 + 进 `unreadable`/`placeholderPaths`
    // （不写盘、target='assets' 当场抛）。
    const { parsed, failure } = parseOrReport(workspace, document, parseGameAssetsManifestText)
    if (!parsed) {
      throwIfDeclaredByThisEdit(workspace, document.path, failure)
      workspace.assets = { document, value: { assets: [] } }
      workspace.unreadable.set(document.path, failure)
      workspace.placeholderPaths.add(document.path)
      return
    }
    collectParseResult(workspace, parsed)
    if (storedAssets) {
      pushSummary(
        workspace.summaries,
        [document.path],
        'declared assets manifest',
        `${document.path}（磁盘上已有的清单，已登记并规范化）`,
      )
    }
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
      // 装载时就读不出来的那几份：声明保留、文件保留、不进工作集。少了这一句就会在这里
      // 重读并重抛同一条解析错误，把「一份文件坏了」又变回「整个工具族不可用」。
      if (workspace.unreadable.has(prefabPath)) continue
      // 与 scenes 逐字同形（第七轮这里走 `prefabCandidates` 那份预扫描 Map，是同一件事的第二种写法）：
      // `set_project` 声明一条还不存在的 prefab 路径即自举一份空 prefab。
      const stored = await this.store.read(prefabPath)
      const document = stored ?? (await this.bootstrapDocument(workspace, prefabPath, 'prefab'))
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
      // 与 scenes 同判据（见那边的注释）：读不出来只让这条声明这次不生效。
      const { parsed, failure } = parseOrReport(workspace, document, parseGamePrefabManifestText)
      if (!parsed) {
        throwIfDeclaredByThisEdit(workspace, document.path, failure)
        continue
      }
      collectParseResult(workspace, parsed)
      // 与 scenes 同形：中途采纳的草稿必须在摘要里出现（第十一轮 P3）。
      if (stored) {
        pushSummary(
          workspace.summaries,
          [document.path],
          'declared prefab',
          `prefab:${parsed.value.id} → ${document.path}（磁盘上已有的草稿，已登记并规范化）`,
        )
      }
      prefabs.push({ document, value: cloneRecord(parsed.value) })
    }
    workspace.prefabs = prefabs
  }

  private async applyOperation(
    workspace: LoadedWorkspace,
    target: GameManifestEditTarget,
    operation: GameManifestEditOperation,
    summaries: GameEditSummary[],
  ): Promise<void> {
    // 目标在这一刻才被物化：`set_*` 到达即创建，`remove_*` / `rename_*` 到达时目标还不在就报错。
    // 行为由**操作顺序**决定，不由对整批的预测决定（判决见 GameEditTargetIntentByAction）。
    const targetEntry = await this.resolveTarget(workspace, target, operation.action)
    // 一条语义行说的就是它写进去的那份清单——摘要与写盘的对账全靠这条归属（原则甲）。
    const at = [targetEntry.document.path]

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
        pushSummary(
          summaries,
          at,
          index < 0 ? 'added entity' : 'updated entity',
          `entity:${operation.entityId}`,
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
        // 继承链解析不动时（环 / 超深 / 悬空 extends —— 全是**编辑之前**就存在的破损）只能得出
        // 「证明不了它是继承来的」，那就按本地实体删；本地也没有时 `requireSceneEntity` 会带着
        // 可用清单报出来。这里不许抛：抛了就等于让一处坏继承把 remove_entity 也变成不可用
        // （不变量 I4）。那处破损本身由 acceptDiagnosis 在收尾报出。
        const inheritedEntity = scene.extends
          ? diagnoseWorkspace(workspace)
              .resolver?.resolveScene(gameReferenceId(scene.extends))
              .entities.some((entity) => entity.id === operation.entityId) === true
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
        pushSummary(summaries, at, 'removed entity', `entity:${operation.entityId}`)
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
        pushSummary(
          summaries,
          // rename 连带改所有继承链下游场景的引用，不止 target 那一份。
          workspace.scenes.map((entry) => entry.document.path),
          'renamed entity',
          `entity:${operation.entityId} -> entity:${operation.newId}`,
        )
        return
      }
      case 'set_component': {
        if (target.startsWith('scene:')) {
          const scene = targetEntry.value as GameSceneManifest
          const entity = this.upsertSceneEntity(
            scene,
            at,
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
          pushSummary(
            summaries,
            at,
            'updated component',
            `${target}/entity:${entity.id}/${operation.component}`,
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
          pushSummary(summaries, at, 'updated component', `${target}/${operation.component}`)
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
          pushSummary(
            summaries,
            at,
            'removed component',
            `${target}/entity:${entity.id}/${operation.component}`,
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
          pushSummary(summaries, at, 'removed component', `${target}/${operation.component}`)
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
        pushSummary(summaries, at, 'updated scene meta', target)
        return
      }
      case 'set_extends': {
        this.applySetExtends(workspace, target, targetEntry, at, operation.extends, summaries)
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
        pushSummary(
          summaries,
          at,
          index < 0 ? 'added asset' : 'updated asset',
          `asset:${operation.assetId}`,
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
        pushSummary(summaries, at, 'removed asset', `asset:${operation.assetId}`)
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
        pushSummary(summaries, at, 'updated project', workspace.project.document.path)
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
    at: readonly string[],
    entityId: string,
    summaries: GameEditSummary[],
  ): GameEntityManifest {
    const existing = scene.entities.find((candidate) => candidate.id === entityId)
    if (existing) return existing
    const created: GameEntityManifest = { id: entityId }
    scene.entities.push(created)
    pushSummary(summaries, at, 'added entity', `entity:${entityId}`)
    return created
  }

  /**
   * `extends` 的唯一写路径 —— **闭集必须写得了它自己读得懂的每一处拓扑**。
   *
   * ## 判决（第十轮）：补一个动作，而不是在报错里指路 project:edit
   * 闭集九个动作能写实体、组件、资产、工程拓扑，唯独 `scene.extends` / `prefab.extends`
   * 一个都写不了——而清单**读**它、解析器**按它**建继承链、`rename_entity` 还**沿着它**改引用。
   * 净效果是产品自己造得出、自己修不了：一次 `project:edit` 写出的继承环，用语义 API 解不开。
   * 「在报错里指路 project:edit」被否决：那等于承认语义 API 有一格永久缺口，而这一格恰恰是
   * 唯一能把工程锁死的那格（第六轮否决 `create_scene` 的理由在这里不成立——那条是
   * 「`set_` 本来就读作 upsert，不该逼模型记仪式」，而这里根本没有任何动作可用）。
   *
   * 一个动作覆盖两个命名空间（与 `set_component` 的 scene / prefab 二相同形）：种类由 target
   * 唯一确定，所以裸 slug 无歧义，按 target 的种类补前缀（钳制不拒绝）。
   *
   * **这里不查环、不查目标存不存在**：那两件事是「编辑后工程自不自洽」，归 I4 的
   * {@link GameManifestProjectEditor.acceptDiagnosis} 统一归因——工程原本健康就当场抛
   * （零文件落盘），原本就坏就随 warnings 报出来。在这里再补一条前置谓词，就又是五~八轮
   * 那条「每加一种打错方式补一条守卫」的老路。
   */
  private applySetExtends(
    workspace: LoadedWorkspace,
    target: GameManifestEditTarget,
    targetEntry: GameManifestTargetEntry,
    at: readonly string[],
    requested: Nullable<string>,
    summaries: GameEditSummary[],
  ): void {
    const kind = target.startsWith('scene:')
      ? 'scene'
      : target.startsWith('prefab:')
        ? 'prefab'
        : null
    if (!kind) {
      throw new GameManifestError(
        'INVALID_MANIFEST',
        'set_extends 只能用于 scene:<id> 或 prefab:<id>。',
        {
          hint: '工程清单与资产清单没有继承这个概念；'
            + '要改工程拓扑用 set_project，要改场景元数据用 set_scene_meta。',
        },
      )
    }
    const reference = normalizedExtendsReference(workspace, kind, target, requested)
    if (kind === 'scene') {
      (targetEntry.value as GameSceneManifest).extends = reference as Nullable<
        GameReference<'scene'>
      >
    } else {
      (targetEntry.value as GamePrefabManifest).extends = reference as Nullable<
        GameReference<'prefab'>
      >
    }
    pushSummary(summaries, at, 'set extends', `${target} -> ${reference ?? 'null（不再继承）'}`)
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
