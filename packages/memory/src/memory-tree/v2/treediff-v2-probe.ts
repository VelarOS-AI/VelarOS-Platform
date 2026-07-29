import type {
  MemoryTreeDiffOpV2,
  MemoryTreeDiffV2,
  MemoryTreeNodeStructV2,
} from './DiffChain'
import {
  buildRedactTreeDiffOpV2,
  canonicalStringifyV2,
  hashTreeEventV2,
  hashTreeStateV2,
  invertTreeDiffOpV2,
  quantizeTreeScoreV2,
  replayTreeDiffsBackwardV2,
  replayTreeDiffsForwardV2,
  TreeDiffGenesisEventHashV2,
  validateTreeDiffOpV2,
} from './DiffChain'

/**
 * 记忆树 v2 逐字节回归探针（规范附录 A 的可执行兑现物 / S0 回归门）。
 *
 * 冻结档 [docs/memory-tree-spec-freeze.md](../../../../../docs/memory-tree-spec-freeze.md)
 * 声称"代码 = 规范 + 逐字节探针校验"。本文件是该主张的唯一在库兑现物：把附录 A 的
 * canonical 行为向量与 A.2 双锚点哈希固化成可复算 fixture + 断言，由
 * `scripts/checks/memoryTreeDiffProbe.mjs` 编入 `bun run check` 链机械复跑。
 *
 * 铁律（与规范附录 A 一致）：**任何触碰 §1/§2 的实现变更必须先过本 fixture；
 * fixture 失配 = 规范破坏，不是"更新期望值"的理由**。要改锚点值 = 走规范版本变更
 * （`.v2` → `.v3` 域字符串整体推进），不得原地改常数迁就代码漂移。
 *
 * fixture 全字段（root + leaf 两节点的 14 字段各一份）与本探针同源；规范附录 A.2 抄录
 * 同一 fixture 的全部字段值，使锚点可**纯从规范文档复算**（对抗校验批 A 的 D1 缺口整改）。
 */

const FIXTURE_ROOT_NODE: MemoryTreeNodeStructV2 = {
  stableKey: 'root',
  parentKey: null,
  nodeType: 'root',
  namespace: 'root',
  subjectType: 'root',
  subjectId: 'root',
  content: { blobRef: null, commitment: `c2:${'00'.repeat(32)}`, redacted: false },
  mainlineScore: 1,
  confidence: 1,
  activation: 1,
  firstSeenAt: 1700000000000,
  lastActiveAt: 1700000000000,
  visibilityState: 'active',
}

const FIXTURE_LEAF_NODE: MemoryTreeNodeStructV2 = {
  stableKey: 'concept:k2:00ff00ff00ff00ff00ff00ff00ff00ff',
  parentKey: 'root',
  nodeType: 'concept',
  namespace: 'concept',
  subjectType: 'concept',
  subjectId: 'k2:00ff00ff00ff00ff00ff00ff00ff00ff',
  content: {
    blobRef: '0011223344556677889900aabbccddee',
    commitment: `c2:${'ab'.repeat(32)}`,
    redacted: false,
  },
  mainlineScore: 0.5,
  confidence: 0.75,
  activation: 0.25,
  firstSeenAt: 1700000000000,
  lastActiveAt: 1700000000000,
  visibilityState: 'active',
}

/** 附录 A.2 的固定双节点树 fixture（root + leaf），全字段冻结。 */
export const TreeDiffV2ProbeFixture = {
  nodes: [FIXTURE_ROOT_NODE, FIXTURE_LEAF_NODE] as readonly MemoryTreeNodeStructV2[],
  genesisDiff: {
    version: 1,
    baseVersion: 0,
    ops: [
      { type: 'add', before: [], after: [FIXTURE_ROOT_NODE] },
      { type: 'add', before: [], after: [FIXTURE_LEAF_NODE] },
    ],
  } satisfies MemoryTreeDiffV2,
} as const

/**
 * 附录 A.2 冻结锚点。由本 fixture 经 `packages/memory/src/memory-tree/v2/DiffChain.ts`
 * 参考实现复算而得；改这两个值 = 规范破坏（见文件头铁律）。
 */
export const TreeDiffV2ProbeAnchors = {
  treeHash: '560d5c3c9fc1be42df6366f68ca3cd45ea3536a77789c4d021dd6bfe89bab988',
  eventHash: 'db13996682f4b41248df3e3bb7b34d9cc6f3a676ce6c10b8bc58432ac89a9d1e',
} as const

interface ProbeAssertion {
  readonly name: string
  readonly ok: boolean
  readonly detail?: string
}

export interface TreeDiffV2ProbeReport {
  readonly total: number
  readonly passed: number
  readonly failures: readonly ProbeAssertion[]
}

const HEX64 = /^[0-9a-f]{64}$/

function expectValidationReject(run: () => unknown): ProbeAssertion['detail'] {
  try {
    run()
    return '预期 VALIDATION 拒绝，但调用未抛错'
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (code === 'VALIDATION') return undefined
    return `预期 VALIDATION，实得 code=${String(code)}`
  }
}

/**
 * 复跑全部断言，返回结构化报告（纯函数，无副作用；由 check 运行器打印与判退）。
 * 断言基线 = 46（规范附录 A / §8 引用此数）。
 */
export function runTreeDiffV2Probe(): TreeDiffV2ProbeReport {
  const assertions: ProbeAssertion[] = []
  const check = (name: string, ok: boolean, detail?: string): void => {
    assertions.push({ name, ok, detail })
  }
  const checkReject = (name: string, run: () => unknown): void => {
    const detail = expectValidationReject(run)
    assertions.push({ name, ok: detail === undefined, detail })
  }

  // ── §1.1 值域拒绝（12）：静默转换是哈希毒药，一律 VALIDATION 炸在入口 ──
  checkReject('§1.1 拒绝 NaN', () => canonicalStringifyV2(Number.NaN))
  checkReject('§1.1 拒绝 +Infinity', () => canonicalStringifyV2(Number.POSITIVE_INFINITY))
  checkReject('§1.1 拒绝 -Infinity', () => canonicalStringifyV2(Number.NEGATIVE_INFINITY))
  checkReject('§1.1 拒绝 bigint', () => canonicalStringifyV2(10n))
  checkReject('§1.1 拒绝 symbol', () => canonicalStringifyV2(Symbol('x')))
  checkReject('§1.1 拒绝 function', () => canonicalStringifyV2(() => 1))
  checkReject('§1.1 拒绝 Date（非纯对象）', () => canonicalStringifyV2(new Date(0)))
  checkReject('§1.1 拒绝 Map', () => canonicalStringifyV2(new Map()))
  checkReject('§1.1 拒绝 Set', () => canonicalStringifyV2(new Set()))
  checkReject('§1.1 拒绝类实例', () => canonicalStringifyV2(new (class Foo {})()))
  checkReject('§1.1 拒绝 TypedArray', () => canonicalStringifyV2(new Uint8Array([1, 2])))
  checkReject('§1.1 拒绝数组内 undefined', () => canonicalStringifyV2([undefined]))

  // ── §1.1 错误可分类（1）：拒绝走 VALIDATION 而非裸 TypeError ──
  {
    let observedCode: unknown = 'NONE'
    try {
      canonicalStringifyV2(10n)
    } catch (error) {
      observedCode = (error as { code?: unknown }).code
    }
    check('§1.1 拒绝错误码为 VALIDATION', observedCode === 'VALIDATION', `code=${String(observedCode)}`)
  }

  // ── §1.2 / §1.3 canonical 行为向量（A.1，9）──
  check(
    '§1.2 A.1 向量一：键码元序 + 嵌套排序 + 数组保序 + -0→0',
    canonicalStringifyV2({ b: [1, { y: null, x: 'é' }], a: -0, Z: true }) ===
      '{"Z":true,"a":0,"b":[1,{"x":"é","y":null}]}'
  )
  check(
    '§1.2 A.1 向量二：undefined 成员视同缺席',
    canonicalStringifyV2({ a: 1, b: undefined }) === '{"a":1}'
  )
  check(
    '§1.2 Z 排在 a 前（码元序：大写 < 小写，非字典/locale 序）',
    canonicalStringifyV2({ a: 1, Z: 2 }).startsWith('{"Z":2,"a":1}')
  )
  check('§1.3 -0 序列化为 0', canonicalStringifyV2(-0) === '0')
  check(
    '§1.2 嵌套对象键排序（x 先于 y）',
    canonicalStringifyV2({ y: 1, x: 2 }) === '{"x":2,"y":1}'
  )
  check('§1.2 数组保序（顺序是语义）', canonicalStringifyV2([3, 1, 2]) === '[3,1,2]')
  check(
    '§1.2 null 是显著值（≠ 缺席）',
    canonicalStringifyV2({ a: null }) === '{"a":null}'
  )
  check(
    '§1.3 字符串最小转义（控制字符）',
    canonicalStringifyV2('a\nb') === '"a\\nb"'
  )
  check('§1.3 数字最短往返表示', canonicalStringifyV2(0.1) === '0.1' && canonicalStringifyV2(1e21) === '1e+21')

  // ── §1.3 评分量化（3）──
  check('§1.3 量化 0.1+0.2 → 0.3', quantizeTreeScoreV2(0.1 + 0.2) === 0.3)
  checkReject('§1.3 量化拒绝 NaN', () => quantizeTreeScoreV2(Number.NaN))
  checkReject('§1.3 量化拒绝 Infinity', () => quantizeTreeScoreV2(Number.POSITIVE_INFINITY))

  // ── §2.3 创世哨兵（2）──
  check('§2.3 创世哨兵 = 64 个 0', TreeDiffGenesisEventHashV2 === '0'.repeat(64))
  check('§2.3 创世哨兵定宽 64', TreeDiffGenesisEventHashV2.length === 64)

  // ── §2.1 tree_hash 锚点（5）──
  const treeHash = hashTreeStateV2(TreeDiffV2ProbeFixture.nodes)
  check('§2.1 tree_hash 锚点逐字节一致', treeHash === TreeDiffV2ProbeAnchors.treeHash, treeHash)
  check(
    '§2.1 节点顺序无关（内部按 stableKey 码元序）',
    hashTreeStateV2([FIXTURE_LEAF_NODE, FIXTURE_ROOT_NODE]) === TreeDiffV2ProbeAnchors.treeHash
  )
  check(
    '§2.1/§0 域绑进哈希文档（canonical 首成员为 domain）',
    canonicalStringifyV2({ domain: 'velaros.memory.tree-state.v2', nodes: [] }).startsWith(
      '{"domain":"velaros.memory.tree-state.v2"'
    )
  )
  check(
    '§2.1 任一节点字段变更翻转哈希',
    hashTreeStateV2([{ ...FIXTURE_ROOT_NODE, mainlineScore: 0.999999 }, FIXTURE_LEAF_NODE]) !==
      TreeDiffV2ProbeAnchors.treeHash
  )
  check('§2.1 tree_hash 为 64 位小写 hex', HEX64.test(treeHash))

  // ── §2.2 event_hash 锚点（7）──
  const eventInput = {
    previousEventHash: TreeDiffGenesisEventHashV2,
    version: 1,
    baseVersion: 0,
    ops: TreeDiffV2ProbeFixture.genesisDiff.ops,
  }
  const eventHash = hashTreeEventV2(eventInput)
  check('§2.2 event_hash 锚点逐字节一致', eventHash === TreeDiffV2ProbeAnchors.eventHash, eventHash)
  check(
    '§2.2 identityChange 缺省 ≡ 显式 null',
    hashTreeEventV2({ ...eventInput, identityChange: null }) === TreeDiffV2ProbeAnchors.eventHash
  )
  check(
    '§2.2 identityChange 非 null 翻转哈希',
    hashTreeEventV2({ ...eventInput, identityChange: { phase: 'x' } }) !==
      TreeDiffV2ProbeAnchors.eventHash
  )
  check(
    '§2.2 baseVersion 纳入哈希',
    hashTreeEventV2({ ...eventInput, baseVersion: 7 }) !== TreeDiffV2ProbeAnchors.eventHash
  )
  check(
    '§2.2 previousEventHash 纳入哈希',
    hashTreeEventV2({ ...eventInput, previousEventHash: 'f'.repeat(64) }) !==
      TreeDiffV2ProbeAnchors.eventHash
  )
  check(
    '§2.2 ops 顺序是语义（交换 add 翻转哈希）',
    hashTreeEventV2({ ...eventInput, ops: [...eventInput.ops].reverse() }) !==
      TreeDiffV2ProbeAnchors.eventHash
  )
  check(
    '§2.2 version 纳入哈希',
    hashTreeEventV2({ ...eventInput, version: 2 }) !== TreeDiffV2ProbeAnchors.eventHash
  )

  // ── §3/§8 重放 · 求逆 · redact 承诺保留（7）：把锚点绑定到正逆重放管线 ──
  const forward = replayTreeDiffsForwardV2([], [TreeDiffV2ProbeFixture.genesisDiff])
  check(
    '§8 正向重放 stateHash 命中 tree_hash 锚点（锚点↔管线绑定）',
    forward.stateHash === TreeDiffV2ProbeAnchors.treeHash,
    forward.stateHash
  )
  check('§8 正向重放节点数 = 2', forward.nodes.length === 2)
  const backward = replayTreeDiffsBackwardV2(
    TreeDiffV2ProbeFixture.nodes,
    [TreeDiffV2ProbeFixture.genesisDiff]
  )
  check('§8 逆向重建回到空树（0 节点）', backward.nodes.length === 0)
  check('§8 add 求逆为 remove', invertTreeDiffOpV2({ type: 'add', before: [], after: [FIXTURE_ROOT_NODE] }).type === 'remove')
  check(
    '§8 dormant 求逆为 reactivate',
    invertTreeDiffOpV2({ type: 'dormant', before: [FIXTURE_LEAF_NODE], after: [FIXTURE_LEAF_NODE] }).type ===
      'reactivate'
  )
  const redactOp = buildRedactTreeDiffOpV2([FIXTURE_LEAF_NODE])
  let redactOk = false
  try {
    validateTreeDiffOpV2(redactOp)
    redactOk =
      redactOp.after[0].content.blobRef === null &&
      redactOp.after[0].content.redacted &&
      redactOp.after[0].content.commitment === FIXTURE_LEAF_NODE.content.commitment
  } catch {
    redactOk = false
  }
  check('§3.3 redact 销毁 blobRef、落 redacted、逐字节保留承诺', redactOk)
  const rewriteCommitment: MemoryTreeDiffOpV2 = {
    type: 'redact',
    before: [FIXTURE_LEAF_NODE],
    after: [
      {
        ...FIXTURE_LEAF_NODE,
        content: { blobRef: null, commitment: `c2:${'cd'.repeat(32)}`, redacted: true },
        visibilityState: 'redacted',
      },
    ],
  }
  checkReject('§3.3 redact 改写承诺即非法', () => validateTreeDiffOpV2(rewriteCommitment))

  const failures = assertions.filter((assertion) => !assertion.ok)
  return { total: assertions.length, passed: assertions.length - failures.length, failures }
}
