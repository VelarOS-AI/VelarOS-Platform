import assert from 'node:assert/strict'

import { test } from 'bun:test'

import {
  BrowserEvaluateScriptBuilder,
  BrowserEvaluateSimplifyMaxDepth,
  BrowserEvaluateSimplifyMaxEntries,
  simplifyBrowserEvaluatedValue,
} from '../../dist/core/index.js'

/**
 * `simplify` 是所有 evaluateScript 的公共出口（browser 工具族 + game 的 query/input/screenshot
 * 探针都从这里出结果）。它曾经把嵌套对象吃成 `'[object Object]'`、把 DAG 共享引用误判成
 * `'[Circular]'`，导致 game:query_state 读不出实体坐标。这三组用例就是把那两条判决钉死。
 */

// ── ① 深层嵌套的真值必须活着 ──────────────────────────────────

void test('simplify keeps real values at the depth that used to be truncated', () => {
  // 复现原始事故形状：root → entity → components → transform → position → {x, y}
  const snapshot = {
    select: 'entity',
    entity: {
      id: 'player',
      components: {
        transform: {
          position: { x: 220.5, y: -18 },
          rotation: 0,
          scale: { x: 1, y: 1 },
        },
      },
    },
  }

  const simplified = simplifyBrowserEvaluatedValue(snapshot)

  assert.deepEqual(simplified.entity.components.transform.position, { x: 220.5, y: -18 })
  assert.deepEqual(simplified.entity.components.transform.scale, { x: 1, y: 1 })
  assert.equal(simplified.entity.components.transform.rotation, 0)
  // 整棵树里不许再出现那个假值
  assert.doesNotMatch(JSON.stringify(simplified), /\[object Object\]/u)
})

void test('simplify truncates exactly at the documented max depth', () => {
  // 造一条恰好 MaxDepth 层的链，叶子是容器：第 MaxDepth 层的容器应当被截断标记替换。
  const buildChain = (levels) => {
    let node = { leaf: 'bottom' }
    for (let index = 0; index < levels; index += 1) node = { next: node }
    return node
  }

  const readDepth = (value, levels) => {
    let cursor = value
    for (let index = 0; index < levels; index += 1) cursor = cursor.next
    return cursor
  }

  // 深度刚好在上限之内：容器仍是真对象。
  const shallow = simplifyBrowserEvaluatedValue(buildChain(BrowserEvaluateSimplifyMaxDepth - 1))
  assert.deepEqual(readDepth(shallow, BrowserEvaluateSimplifyMaxDepth - 1), { leaf: 'bottom' })

  // 再深一层：这一层的容器被换成一眼可辨的截断标记，而不是伪装成值的 '[object Object]'。
  const deep = simplifyBrowserEvaluatedValue(buildChain(BrowserEvaluateSimplifyMaxDepth))
  assert.equal(readDepth(deep, BrowserEvaluateSimplifyMaxDepth), '[Truncated Object]')
})

void test('simplify returns scalars faithfully even below the depth ceiling', () => {
  // 标量分支排在深度检查之前：深处的数字必须还是数字，不能变成截断标记。
  let node = 42
  for (let index = 0; index < BrowserEvaluateSimplifyMaxDepth + 4; index += 1) node = { next: node }

  let cursor = simplifyBrowserEvaluatedValue(node)
  let hops = 0
  while (typeof cursor === 'object' && cursor !== null) {
    cursor = cursor.next
    hops += 1
    if (hops > BrowserEvaluateSimplifyMaxDepth + 8) break
  }
  // 走到截断标记为止都不该看到被改写的标量；截断标记本身是字符串。
  assert.equal(cursor, '[Truncated Object]')
})

// ── ② DAG 共享引用不是环 ──────────────────────────────────────

void test('simplify does not mistake shared references for cycles', () => {
  // 事故原形：entity.tags 与 entity.components.tags 是同一个数组引用。
  const tags = ['player', 'controllable']
  const snapshot = { entity: { tags, components: { tags, layer: 'background' } } }

  const simplified = simplifyBrowserEvaluatedValue(snapshot)

  assert.deepEqual(simplified.entity.tags, ['player', 'controllable'])
  assert.deepEqual(simplified.entity.components.tags, ['player', 'controllable'])
  assert.doesNotMatch(JSON.stringify(simplified), /\[Circular\]/u)
})

void test('simplify keeps the same object repeated across sibling branches', () => {
  const shared = { kind: 'vector', x: 1, y: 2 }
  const simplified = simplifyBrowserEvaluatedValue({
    a: shared,
    b: shared,
    list: [shared, shared],
  })

  assert.deepEqual(simplified.a, shared)
  assert.deepEqual(simplified.b, shared)
  assert.deepEqual(simplified.list, [shared, shared])
})

// ── ③ 真环仍然要被拦住 ────────────────────────────────────────

void test('simplify still marks genuine cycles', () => {
  const node = { name: 'root' }
  node.self = node

  const simplified = simplifyBrowserEvaluatedValue(node)

  assert.equal(simplified.name, 'root')
  assert.equal(simplified.self, '[Circular]')
})

void test('simplify still marks indirect cycles through arrays', () => {
  const parent = { name: 'parent', children: [] }
  const child = { name: 'child', parent }
  parent.children.push(child)

  const simplified = simplifyBrowserEvaluatedValue(parent)

  assert.equal(simplified.children[0].name, 'child')
  assert.equal(simplified.children[0].parent, '[Circular]')
})

void test('simplify terminates on cycles instead of overflowing the stack', () => {
  const a = { name: 'a' }
  const b = { name: 'b', a }
  a.b = b

  assert.doesNotThrow(() => JSON.stringify(simplifyBrowserEvaluatedValue(a)))
})

// ── 边界与内联一致性 ──────────────────────────────────────────

void test('simplify caps entry counts on objects and arrays', () => {
  const overflowing = Array.from({ length: BrowserEvaluateSimplifyMaxEntries + 25 }, (_, i) => i)
  assert.equal(
    simplifyBrowserEvaluatedValue(overflowing).length,
    BrowserEvaluateSimplifyMaxEntries,
  )

  const wide = {}
  for (let index = 0; index < BrowserEvaluateSimplifyMaxEntries + 25; index += 1) {
    wide[`k${index}`] = index
  }
  assert.equal(
    Object.keys(simplifyBrowserEvaluatedValue(wide)).length,
    BrowserEvaluateSimplifyMaxEntries,
  )
})

void test('simplify handles errors and nullish values', () => {
  assert.equal(simplifyBrowserEvaluatedValue(null), null)
  assert.equal(simplifyBrowserEvaluatedValue(undefined), undefined)

  const simplified = simplifyBrowserEvaluatedValue(new TypeError('boom'))
  assert.equal(simplified.name, 'TypeError')
  assert.equal(simplified.message, 'boom')
})

void test('the generated page script inlines the very function under test', () => {
  // 页面里跑的必须是同一份实现——否则单测锁的行为与线上行为会各走各的。
  const script = new BrowserEvaluateScriptBuilder().buildEvaluateScript({
    script: 'document.title',
  })

  assert.match(script, /const simplifyBrowserEvaluatedValue = function simplifyBrowserEvaluatedValue/u)
  assert.match(script, /const describeBrowserEvaluatedElement = function describeBrowserEvaluatedElement/u)
  // 内联体里的字面量上限必须与导出的常量一致（函数被 toString 内联，引用不到模块常量）。
  assert.match(script, new RegExp(`depth >= ${BrowserEvaluateSimplifyMaxDepth}`, 'u'))
  // 旧的失效实现不许残留。
  assert.doesNotMatch(script, /new WeakSet\(\)/u)
  assert.doesNotMatch(script, /depth >= 4/u)
})
