import { createHash } from 'node:crypto'

import {
  isArray,
  isBoolean,
  isEmpty,
  isFiniteNumber,
  isNotNull,
  isNull,
  isNumber,
  isObject,
  isPlainObject,
  isRecord,
  isString,
  isUndefined,
  toNullable,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

/**
 * 第六轮修订模型的 TreeDiff 链纯函数层（WS3 重构地基件，尚未接线）。
 *
 * 与 v1（`../TreeProjection.ts`）的四点决裂，均为第六轮修订的冻结方向：
 * 1. **零明文**：结构事件只携带 `contentRef`（blob 引用 + 随机化承诺），没有 title/summary
 *    明文字段——③ 类语义正文按列级分类矩阵外置为加密 blob，类型层面写不进来。
 * 2. **九操作词表**：add / update / move / merge / split / dormant / reactivate / remove / redact；
 *    redact 是一种结构事件（Erasure Saga 第一段提交只含 redact 的新版本，版本必然推进）。
 * 3. **自包含可逆放**：每个 op 携带受影响节点的完整前后结构 payload，链可从空树正向重放，
 *    也可从当前视图沿链逆向重建，两个方向命中同一 `tree_hash` 锚点；apply 严格校验
 *    before/after 与现场一致，重放本身就是完整性自检。
 * 4. **双哈希各司其职**：`tree_hash = H(domain ‖ canonical_state)` 状态锚点；
 *    `event_hash = H(canonical({domain, prev, version, baseVersion, identityChange, ops}))`
 *    链式审计哈希，domain separation 防跨用途碰撞。同库存放承诺的是完整性自检，不是防篡改。
 *
 * canonical 序列化规范（实施前问题 #11）已由 [docs/memory-tree-spec-freeze.md](../../../../../docs/memory-tree-spec-freeze.md)
 * 冻结（WS3-S0）。本文件即规范的参考实现；相对 v0 草案的四点修订（规范 §8 差异表）：
 * D1 节点排序从 localeCompare 改 UTF-16 码元序（locale 不得影响哈希）；
 * D2 canonical 值域收紧为 JSON 值域（拒绝 Date/bigint/symbol/function/非纯对象/数组内 undefined）；
 * D3 新增创世事件哈希哨兵 `TreeDiffGenesisEventHashV2`（64 个 '0'）；
 * D4 event_hash 纳入 baseVersion 与 identityChange（缺省 null 恒序列化，S3 落库时免二次冻结）。
 * 跨版本 fixture 见规范附录 A，探针逐字节断言。
 */

export const MemoryTreeDiffOpTypesV2 = [
  'add',
  'update',
  'move',
  'merge',
  'split',
  'dormant',
  'reactivate',
  'remove',
  'redact',
] as const

export type MemoryTreeDiffOpTypeV2 = (typeof MemoryTreeDiffOpTypesV2)[number]

/** ③ 类语义正文的结构层引用：结构历史永不内嵌明文。 */
export interface MemoryTreeContentRefV2 {
  /** 加密内容 blob 引用；crypto-shred 销毁后为 null（结构位置保留）。 */
  blobRef: Nullable<string>
  /** 随机化承诺（nonce 封装于加密信封内，非明文派生哈希）；redact 后保留但不可验证。 */
  commitment: string
  /** 彻底清除占位标记：true 时渲染 redacted 占位，不声称能验证已删原文。 */
  redacted: boolean
}

export type MemoryTreeVisibilityStateV2 = 'active' | 'dormant' | 'pruned' | 'redacted'

/**
 * 结构事件里的节点 payload：只含 ① 纯结构字段 + ③ 类内容引用。
 * 节点身份 = stableKey；父链接用 parentKey（同为 stableKey），使 diff 自包含、
 * 不依赖任何存储层生成的行 id。
 */
export interface MemoryTreeNodeStructV2 {
  stableKey: string
  parentKey: Nullable<string>
  nodeType: string
  namespace: string
  subjectType: string
  subjectId: string
  content: MemoryTreeContentRefV2
  mainlineScore: number
  confidence: number
  activation: number
  firstSeenAt: number
  lastActiveAt: number
  visibilityState: MemoryTreeVisibilityStateV2
}

/**
 * 自包含可逆结构事件：before = 事件前受影响节点的完整结构，after = 事件后。
 * 正向 apply：删 before 键、插 after 节点；逆向 apply：对换。
 */
export interface MemoryTreeDiffOpV2 {
  type: MemoryTreeDiffOpTypeV2
  before: readonly MemoryTreeNodeStructV2[]
  after: readonly MemoryTreeNodeStructV2[]
}

export interface MemoryTreeDiffV2 {
  version: number
  baseVersion: number
  ops: readonly MemoryTreeDiffOpV2[]
}

const StateHashDomainV2 = 'velaros.memory.tree-state.v2'
const EventHashDomainV2 = 'velaros.memory.tree-diff.v2'
const BaseEventHashDomainV2 = 'velaros.memory.tree-base.v2'

/**
 * 创世事件的 previousEventHash 哨兵：定宽（64 hex 位形）、非法哈希值（全零），
 * 与"字段缺失/空串"可区分，可加 NOT NULL + 长度约束（规范 §2.3）。
 */
export const TreeDiffGenesisEventHashV2 = '0'.repeat(64)

/** UTF-16 码元序比较：canonical 排序唯一合法比较器，禁 localeCompare（环境 locale 不得影响哈希）。 */
function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** 评分字段的确定性量化（进入结构事件前由生产者调用），消除浮点漂移对哈希的影响。 */
export function quantizeTreeScoreV2(value: number): number {
  if (!Number.isFinite(value)) {
    throw new AppError('VALIDATION', 'TreeDiff v2 评分字段必须是有限数。')
  }
  return Number(value.toFixed(6))
}

/**
 * canonical 序列化 v2（规范 §1，已冻结）：值域 = JSON 值域（null / boolean / 有限数 /
 * string / 数组 / 纯对象）；对象键按 UTF-16 码元序重排、undefined 成员视同缺席；
 * 数组内 undefined 拒绝；Date/Map/Set/类实例/bigint/symbol/function 一律拒绝
 * （v0 草案会把 Date 静默序列化成 `{}`、把数组内 undefined 变 null——都是哈希毒药）。
 */
export function canonicalStringifyV2(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (isNull(value) || isBoolean(value) || isString(value)) return value
  if (isNumber(value)) {
    if (!Number.isFinite(value)) {
      throw new AppError('VALIDATION', 'canonical 序列化拒绝非有限数。')
    }
    return value
  }
  if (isArray(value))
    return value.map((item) => {
      if (isUndefined(item)) {
        throw new AppError('VALIDATION', 'canonical 序列化拒绝数组中的 undefined。')
      }
      return sortValue(item)
    })
  if (isRecord(value) && isPlainRecord(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareCodeUnit)
        .filter((key) => !isUndefined(value[key]))
        .map((key) => [key, sortValue(value[key])])
    )
  throw new AppError(
    'VALIDATION',
    `canonical 序列化只接受 JSON 值域（null/boolean/有限数/string/数组/纯对象），拒绝 ${describeValueKind(value)}。`
  )
}

/** 纯数据对象判定：原型必须是 Object.prototype 或 null，挡住 Date/Map/类实例的静默降级。 */
function isPlainRecord(value: Record<string, unknown>): boolean {
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || isNull(prototype)
}

function describeValueKind(value: unknown): string {
  if (isUndefined(value)) return 'undefined'
  if (isObject(value)) return `非纯对象 ${Object.prototype.toString.call(value)}`
  return typeof value
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** 状态哈希（规范 §2.1）：节点按 stableKey UTF-16 码元序排序后整体 canonical 哈希。 */
export function hashTreeStateV2(nodes: readonly MemoryTreeNodeStructV2[]): string {
  const canonical = [...nodes].sort((left, right) =>
    compareCodeUnit(left.stableKey, right.stableKey)
  )
  return sha256(canonicalStringifyV2({ domain: StateHashDomainV2, nodes: canonical }))
}

/**
 * 链式审计哈希（规范 §2.2）：规范文档形 = canonical({domain, previousEventHash, version,
 * baseVersion, identityChange, ops})。identityChange 缺省恒序列化为 null（缺席≠null 的
 * 歧义在冻结时一次性关死，S3 落 identity_change payload 时无需二次冻结哈希公式）。
 */
export function hashTreeEventV2(input: {
  previousEventHash: string
  version: number
  baseVersion: number
  ops: readonly MemoryTreeDiffOpV2[]
  identityChange?: unknown
}): string {
  return sha256(
    canonicalStringifyV2({
      domain: EventHashDomainV2,
      previousEventHash: input.previousEventHash,
      version: input.version,
      baseVersion: input.baseVersion,
      identityChange: toNullable(input.identityChange),
      ops: input.ops,
    })
  )
}

/** 物化基点的链再锚定哈希（规范 §2.4）。 */
export function hashTreeBaseEventV2(input: {
  baseVersion: number
  treeHash: string
  priorSegmentEventHead: string
  manifestHash: string
}): string {
  return sha256(
    canonicalStringifyV2({
      domain: BaseEventHashDomainV2,
      baseVersion: input.baseVersion,
      treeHash: input.treeHash,
      priorSegmentEventHead: input.priorSegmentEventHead,
      manifestHash: input.manifestHash,
    })
  )
}

function nodeEquals(left: MemoryTreeNodeStructV2, right: MemoryTreeNodeStructV2): boolean {
  return canonicalStringifyV2(left) === canonicalStringifyV2(right)
}

function keysOf(nodes: readonly MemoryTreeNodeStructV2[]): string[] {
  return nodes.map((node) => node.stableKey)
}

/** 单个结构事件的自洽校验（不含跨事件树形约束；那属于提交期 validator）。 */
export function validateTreeDiffOpV2(op: MemoryTreeDiffOpV2): void {
  const beforeKeys = new Set(keysOf(op.before))
  const afterKeys = new Set(keysOf(op.after))
  if (beforeKeys.size !== op.before.length || afterKeys.size !== op.after.length) {
    throw new AppError('VALIDATION', `TreeDiff v2 ${op.type} 事件内存在重复 stableKey。`)
  }
  const sameSingleKey = (): void => {
    if (
      op.before.length !== 1 ||
      op.after.length !== 1 ||
      op.before[0].stableKey !== op.after[0].stableKey
    ) {
      throw new AppError('VALIDATION', `TreeDiff v2 ${op.type} 事件必须且只能改写同一个节点。`)
    }
  }
  switch (op.type) {
    case 'add':
      if (!isEmpty(op.before) || op.after.length !== 1) {
        throw new AppError('VALIDATION', 'TreeDiff v2 add 事件形状必须是 0 → 1。')
      }
      return
    case 'remove':
      if (op.before.length !== 1 || !isEmpty(op.after)) {
        throw new AppError('VALIDATION', 'TreeDiff v2 remove 事件形状必须是 1 → 0。')
      }
      return
    case 'update':
      sameSingleKey()
      if (op.before[0].parentKey !== op.after[0].parentKey) {
        throw new AppError('VALIDATION', 'TreeDiff v2 update 不得变更父节点；请使用 move。')
      }
      return
    case 'move':
      sameSingleKey()
      if (op.before[0].parentKey === op.after[0].parentKey) {
        throw new AppError('VALIDATION', 'TreeDiff v2 move 必须变更父节点。')
      }
      return
    case 'dormant':
      sameSingleKey()
      if (op.after[0].visibilityState !== 'dormant') {
        throw new AppError('VALIDATION', 'TreeDiff v2 dormant 事件的 after 必须处于 dormant。')
      }
      return
    case 'reactivate':
      sameSingleKey()
      if (op.before[0].visibilityState !== 'dormant' || op.after[0].visibilityState === 'dormant') {
        throw new AppError('VALIDATION', 'TreeDiff v2 reactivate 必须从 dormant 转出。')
      }
      return
    case 'merge':
      if (op.before.length < 2 || op.after.length !== 1) {
        throw new AppError('VALIDATION', 'TreeDiff v2 merge 事件形状必须是 N(≥2) → 1。')
      }
      return
    case 'split':
      if (op.before.length !== 1 || op.after.length < 2) {
        throw new AppError('VALIDATION', 'TreeDiff v2 split 事件形状必须是 1 → N(≥2)。')
      }
      return
    case 'redact': {
      if (isEmpty(op.before) || op.before.length !== op.after.length) {
        throw new AppError('VALIDATION', 'TreeDiff v2 redact 必须逐节点成对改写。')
      }
      const afterByKey = new Map(op.after.map((node) => [node.stableKey, node]))
      for (const before of op.before) {
        const after = afterByKey.get(before.stableKey)
        if (!after) {
          throw new AppError('VALIDATION', 'TreeDiff v2 redact 的 before/after 节点集必须同键。')
        }
        if (isNotNull(after.content.blobRef) || !after.content.redacted) {
          throw new AppError(
            'VALIDATION',
            'TreeDiff v2 redact 后节点必须销毁 blob 引用并落 redacted 占位。'
          )
        }
        if (after.content.commitment !== before.content.commitment) {
          throw new AppError(
            'VALIDATION',
            'TreeDiff v2 redact 不得改写随机化承诺（结构历史 append-only）。'
          )
        }
      }
      return
    }
  }
}

/**
 * 正向应用一个结构事件。strict 模式（默认）逐节点核对 before 与现场逐字节一致——
 * 重放即自检，链上任何损坏在命中锚点前就会在事件粒度暴露。
 */
export function applyTreeDiffOpV2(
  current: ReadonlyMap<string, MemoryTreeNodeStructV2>,
  op: MemoryTreeDiffOpV2,
  options: { strict?: boolean } = {}
): Map<string, MemoryTreeNodeStructV2> {
  const strict = options.strict ?? true
  const next = new Map(current)
  for (const before of op.before) {
    const found = next.get(before.stableKey)
    if (strict) {
      if (!found) {
        throw new AppError(
          'INTERNAL',
          `TreeDiff v2 重放失配：${op.type} 期望节点 ${before.stableKey} 存在。`
        )
      }
      if (!nodeEquals(found, before)) {
        throw new AppError(
          'INTERNAL',
          `TreeDiff v2 重放失配：${before.stableKey} 的现场状态与事件 before 不一致。`
        )
      }
    }
    next.delete(before.stableKey)
  }
  for (const after of op.after) {
    if (strict && next.has(after.stableKey)) {
      throw new AppError(
        'INTERNAL',
        `TreeDiff v2 重放失配：${op.type} 插入的 ${after.stableKey} 已存在。`
      )
    }
    next.set(after.stableKey, cloneTreeNodeV2(after))
  }
  return next
}

/**
 * 事件求逆：before/after 对换，语义标签映射到反向词（add↔remove、dormant↔reactivate、
 * merge↔split）。redact 的逆仅服务结构层逆向重建——blob 已销毁，内容不可恢复，
 * 逆放得到的节点结构携带悬空 blobRef，渲染层仍呈现 redacted 占位。
 */
export function invertTreeDiffOpV2(op: MemoryTreeDiffOpV2): MemoryTreeDiffOpV2 {
  const inverseType: Record<MemoryTreeDiffOpTypeV2, MemoryTreeDiffOpTypeV2> = {
    add: 'remove',
    remove: 'add',
    update: 'update',
    move: 'move',
    merge: 'split',
    split: 'merge',
    dormant: 'reactivate',
    reactivate: 'dormant',
    redact: 'redact',
  }
  return { type: inverseType[op.type], before: op.after, after: op.before }
}

export function invertTreeDiffV2(diff: MemoryTreeDiffV2): MemoryTreeDiffV2 {
  return {
    version: diff.baseVersion,
    baseVersion: diff.version,
    ops: [...diff.ops].reverse().map(invertTreeDiffOpV2),
  }
}

export interface MemoryTreeReplayResultV2 {
  nodes: MemoryTreeNodeStructV2[]
  stateHash: string
  /** INV-BR 运行时来源标记；持久化只接受 forward。 */
  direction: 'forward' | 'backward'
}

/**
 * 重放结果值对象。
 *
 * 持久化资格保存在实例私有槽位中，不依赖模块级身份表，也不会被对象展开、
 * JSON 序列化或伪造同形普通对象复制。该实现类不从包入口导出。
 */
class MemoryTreeReplayResultValueV2 implements MemoryTreeReplayResultV2 {
  readonly #persistenceEligible: boolean

  constructor(
    public readonly nodes: MemoryTreeNodeStructV2[],
    public readonly stateHash: string,
    public readonly direction: 'forward' | 'backward',
    persistenceEligible: boolean
  ) {
    this.#persistenceEligible = persistenceEligible
  }

  public isEligibleForForwardPersistence(): boolean {
    return this.direction === 'forward' && this.#persistenceEligible
  }
}

function isEligibleForwardReplayResultV2(
  result: MemoryTreeReplayResultV2
): result is MemoryTreeReplayResultValueV2 {
  return result instanceof MemoryTreeReplayResultValueV2 && result.isEligibleForForwardPersistence()
}

function toSortedNodes(map: ReadonlyMap<string, MemoryTreeNodeStructV2>): MemoryTreeNodeStructV2[] {
  return [...map.values()].sort((left, right) => compareCodeUnit(left.stableKey, right.stableKey))
}

/**
 * 从任意起点沿 diff 链正向重放；strict 校验每个事件的现场一致性。
 * `validateOps=false` 供逆向重建使用：求逆后的 redact 事件在结构层"恢复"了 blobRef
 * （blob 本体已销毁、内容仍不可恢复），不满足正向创作事件的语义不变量——语义校验
 * 只约束已提交链上的原始事件，机械求逆产物只做现场一致性核对。
 */
export function replayTreeDiffsForwardV2(
  initial: readonly MemoryTreeNodeStructV2[],
  diffs: readonly MemoryTreeDiffV2[],
  options: {
    strict?: boolean
    validateOps?: boolean
    /**
     * 非空 initial 要进入持久化链时，必须同时提交其原始 forward 结果作来源证明。
     * 省略时仍可做内存重放，但结果不能通过 INV-BR 持久化断言。
     */
    persistenceBase?: MemoryTreeReplayResultV2
  } = {}
): MemoryTreeReplayResultV2 {
  const persistenceBaseMatches =
    initial.length === 0 ||
    (!isUndefined(options.persistenceBase) &&
      isEligibleForwardReplayResultV2(options.persistenceBase) &&
      canonicalStringifyV2(initial) === canonicalStringifyV2(options.persistenceBase.nodes))
  let state: ReadonlyMap<string, MemoryTreeNodeStructV2> = new Map(
    initial.map((node) => [node.stableKey, cloneTreeNodeV2(node)])
  )
  let expectedBase: Nullable<number> = null
  for (const diff of diffs) {
    if (isNotNull(expectedBase) && diff.baseVersion !== expectedBase) {
      throw new AppError(
        'INTERNAL',
        `TreeDiff v2 链断裂：v${diff.version} 基线为 ${diff.baseVersion}，期望 ${expectedBase}。`
      )
    }
    for (const op of diff.ops) {
      if (options.validateOps ?? true) validateTreeDiffOpV2(op)
      state = applyTreeDiffOpV2(state, op, { strict: options.strict })
    }
    expectedBase = diff.version
  }
  const nodes = toSortedNodes(state)
  return new MemoryTreeReplayResultValueV2(
    nodes,
    hashTreeStateV2(nodes),
    'forward',
    persistenceBaseMatches
  )
}

/** 从当前视图沿链逆向重建历史状态（第六轮：当前树是物化视图，历史可双向重建）。 */
export function replayTreeDiffsBackwardV2(
  current: readonly MemoryTreeNodeStructV2[],
  diffs: readonly MemoryTreeDiffV2[],
  options: { strict?: boolean } = {}
): MemoryTreeReplayResultV2 {
  const inverted = [...diffs]
    .sort((left, right) => right.version - left.version)
    .map((diff) => invertTreeDiffV2(diff))
  const result = replayTreeDiffsForwardV2(current, inverted, {
    ...options,
    validateOps: false,
  })
  return new MemoryTreeReplayResultValueV2(result.nodes, result.stateHash, 'backward', false)
}

/**
 * INV-BR：任何物化视图、checkpoint、基点或候选写回都必须消费本进程正向重放产生的
 * 原始值对象；伪造 `direction: "forward"` 或复制一个普通对象都不能通过私有来源证明。
 */
export function assertForwardReplayResultForPersistenceV2(result: MemoryTreeReplayResultV2): void {
  if (!isEligibleForwardReplayResultV2(result)) {
    throw new AppError('INVARIANT', 'INV-BR：逆向重建或来源不明的树状态禁止进入持久化写路径。')
  }
}

/**
 * 两状态间的基础结构 diff 推导：add / remove / move / update + dormant / reactivate 推断。
 * merge / split / redact 是生产者声明性事件（携带语义意图），不可能从状态对推断，
 * 由 Dream 提案链与 Erasure Saga 分别显式构造。
 */
export function buildBasicTreeDiffOpsV2(
  previous: readonly MemoryTreeNodeStructV2[],
  next: readonly MemoryTreeNodeStructV2[]
): MemoryTreeDiffOpV2[] {
  const previousByKey = new Map(previous.map((node) => [node.stableKey, node]))
  const nextByKey = new Map(next.map((node) => [node.stableKey, node]))
  const ops: MemoryTreeDiffOpV2[] = []
  for (const node of next) {
    const before = previousByKey.get(node.stableKey)
    if (!before) {
      ops.push({ type: 'add', before: [], after: [node] })
      continue
    }
    if (nodeEquals(before, node)) continue
    const type: MemoryTreeDiffOpTypeV2 =
      before.parentKey !== node.parentKey
        ? 'move'
        : before.visibilityState !== 'dormant' && node.visibilityState === 'dormant'
          ? 'dormant'
          : before.visibilityState === 'dormant' && node.visibilityState !== 'dormant'
            ? 'reactivate'
            : 'update'
    ops.push({ type, before: [before], after: [node] })
  }
  for (const node of previous) {
    if (!nextByKey.has(node.stableKey)) ops.push({ type: 'remove', before: [node], after: [] })
  }
  return ops
}

/** 为一组节点构造 redact 结构事件（Erasure Saga 第一段的树版本 payload）。 */
export function buildRedactTreeDiffOpV2(
  targets: readonly MemoryTreeNodeStructV2[]
): MemoryTreeDiffOpV2 {
  if (targets.length === 0) {
    throw new AppError('VALIDATION', 'TreeDiff v2 redact 事件至少包含一个目标节点。')
  }
  return {
    type: 'redact',
    before: targets,
    after: targets.map((node) => ({
      ...node,
      content: {
        blobRef: null,
        commitment: node.content.commitment,
        redacted: true,
      },
      visibilityState: 'redacted',
    })),
  }
}

/** 结构事件的运行时守卫（存储层读回 ops_json 时使用）。 */
export function isMemoryTreeDiffOpV2(value: unknown): value is MemoryTreeDiffOpV2 {
  if (!isPlainObject(value)) return false
  const record = value
  if (
    !isString(record.type) ||
    !(MemoryTreeDiffOpTypesV2 as readonly string[]).includes(record.type)
  )
    return false
  if (!isArray(record.before) || !isArray(record.after)) return false
  return [...record.before, ...record.after].every(isMemoryTreeNodeStructV2)
}

export function isMemoryTreeNodeStructV2(value: unknown): value is MemoryTreeNodeStructV2 {
  if (!isRecord(value)) return false
  const record = value
  const expectedKeys = [
    'activation',
    'confidence',
    'content',
    'firstSeenAt',
    'lastActiveAt',
    'mainlineScore',
    'namespace',
    'nodeType',
    'parentKey',
    'stableKey',
    'subjectId',
    'subjectType',
    'visibilityState',
  ]
  const actualKeys = Object.keys(record).sort()
  if (
    actualKeys.length !== expectedKeys.length ||
    !actualKeys.every((key, index) => key === expectedKeys[index])
  )
    return false
  if (
    !isString(record.stableKey) ||
    isEmpty(record.stableKey) ||
    (!isString(record.parentKey) && isNotNull(record.parentKey)) ||
    !isString(record.nodeType) ||
    isEmpty(record.nodeType) ||
    !isString(record.namespace) ||
    isEmpty(record.namespace) ||
    !isString(record.subjectType) ||
    isEmpty(record.subjectType) ||
    !isString(record.subjectId) ||
    isEmpty(record.subjectId) ||
    !isFiniteTreeNumberV2(record.mainlineScore) ||
    !isFiniteTreeNumberV2(record.confidence) ||
    !isFiniteTreeNumberV2(record.activation) ||
    !isSafeTreeTimestampV2(record.firstSeenAt) ||
    !isSafeTreeTimestampV2(record.lastActiveAt) ||
    !isString(record.visibilityState) ||
    !(['active', 'dormant', 'pruned', 'redacted'] as const).includes(
      record.visibilityState as MemoryTreeVisibilityStateV2
    ) ||
    !isRecord(record.content)
  )
    return false
  const content = record.content as Record<string, unknown>
  const contentKeys = Object.keys(content).sort()
  return (
    contentKeys.length === 3 &&
    contentKeys[0] === 'blobRef' &&
    contentKeys[1] === 'commitment' &&
    contentKeys[2] === 'redacted' &&
    (isNull(content.blobRef) ||
      (isString(content.blobRef) && /^[0-9a-f]{32}$/.test(content.blobRef))) &&
    isString(content.commitment) &&
    /^c2:[0-9a-f]{64}$/.test(content.commitment) &&
    isBoolean(content.redacted)
  )
}

function isFiniteTreeNumberV2(value: unknown): value is number {
  return isFiniteNumber(value)
}

function isSafeTreeTimestampV2(value: unknown): value is number {
  return isNumber(value) && Number.isSafeInteger(value) && value >= 0
}

function cloneTreeNodeV2(node: MemoryTreeNodeStructV2): MemoryTreeNodeStructV2 {
  return {
    ...node,
    content: { ...node.content },
  }
}
