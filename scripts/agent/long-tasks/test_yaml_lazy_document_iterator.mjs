// 冻结保留题：按需解析、上下文隔离、关闭和失败语义。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
const root = process.cwd()
const require = createRequire(root + '/package.json')
const yaml = require(root + '/index.js')
const iterator = (...args) => {
  assert.equal(typeof yaml.loadAllIterable, 'function', 'new public API must be exported')
  return yaml.loadAllIterable(...args)
}
test('new public API must be exported', () =>
  assert.equal(typeof iterator('')[Symbol.iterator], 'function'))
for (const source of [
  '',
  '\n# only comment\n',
  '---\n',
  '---\n---\n',
  'a: 1\n---\n- true\n- null\n...\n',
  '\uFEFF---\r\nx: yes\r\n---\r\ny: 2\r\n',
  'text: |\n  first\n  ---\n  last\n---\nx: >\n  next\n  ...\n',
  '%YAML 1.2\n---\nvalue: 1\n...\n%YAML 1.2\n---\nvalue: 2\n',
])
  test(`loadAll equivalence ${JSON.stringify(source)}`, () =>
    assert.deepEqual([...iterator(source)], yaml.loadAll(source)))
test('bad later document is lazy and the exact parser failure closes iteration', () => {
  const text = 'first: 1\n---\nbroken: [1,\n'
  let reference
  try {
    yaml.loadAll(text, { filename: 'fixture.yml' })
  } catch (error) {
    reference = error
  }
  const it = iterator(text, { filename: 'fixture.yml' })
  assert.deepEqual(it.next(), { done: false, value: { first: 1 } })
  assert.throws(
    () => it.next(),
    (error) =>
      error.name === reference.name &&
      error.message === reference.message &&
      error.mark.position === reference.mark.position
  )
  assert.equal(it.next().done, true)
})
test('listener calls are delayed until the corresponding document and stop on close', () => {
  let calls = 0
  const it = iterator('a: 1\n---\nb: 2\n', {
    listener: () => {
      calls++
    },
  })
  assert.equal(calls, 0)
  it.next()
  const firstCalls = calls
  assert(firstCalls > 0)
  assert.deepEqual(it.return('finished'), { done: true, value: 'finished' })
  assert.equal(it.next().done, true)
  assert.equal(calls, firstCalls)
})
test('early for-of exit and return before first next avoid later syntax failures', () => {
  const it = iterator('a: 1\n---\n[invalid')
  for (const value of it) {
    assert.deepEqual(value, { a: 1 })
    break
  }
  assert.equal(it.next().done, true)
  const untouched = iterator('[invalid', { listener: () => assert.fail('must stay lazy') })
  assert.deepEqual(untouched.return(7), { done: true, value: 7 })
  assert.equal(untouched.next().done, true)
})
test('anchors reset across documents and interleaved iterators have independent state', () => {
  const a = iterator('x: &item [1,2]\ny: *item\n---\nx: &item [3]\ny: *item\n')
  const b = iterator('other: 8\n---\nother: 9\n')
  const first = a.next().value
  assert.equal(first.x, first.y)
  assert.equal(b.next().value.other, 8)
  const second = a.next().value
  assert.equal(second.x, second.y)
  assert.notEqual(second.x, first.x)
  assert.equal(b.next().value.other, 9)
  const missing = iterator('x: &x 1\n---\ny: *x\n')
  missing.next()
  assert.throws(() => missing.next(), /alias/)
})
test('schema, json and reentrant user callbacks retain parser behavior', () => {
  const source = 'value: 12\n---\nvalue: true\n'
  assert.deepEqual(
    [...iterator(source, { schema: yaml.FAILSAFE_SCHEMA })],
    yaml.loadAll(source, { schema: yaml.FAILSAFE_SCHEMA })
  )
  assert.deepEqual([...iterator('x: 1\nx: 2\n', { json: true })], [{ x: 2 }])
  const b = iterator('b: 4\n---\nb: 5\n')
  let once = false
  const a = iterator('a: 1\n---\na: 2\n', {
    listener: () => {
      if (!once) {
        once = true
        assert.equal(b.next().value.b, 4)
      }
    },
  })
  assert.deepEqual([...a], [{ a: 1 }, { a: 2 }])
  assert.equal(b.next().value.b, 5)
})
test('many documents preserve their individual state without prefix reparsing', () => {
  let count = 0
  const docs = Array.from({ length: 128 }, (_, n) => `---\nindex: ${n}\ntext: |\n  ---\n`)
  const result = [...iterator(docs.join(''), { listener: () => count++ })]
  let referenceCount = 0
  yaml.loadAll(docs.join(''), { listener: () => referenceCount++ })
  assert.equal(result.length, 128)
  assert.equal(result[127].index, 127)
  assert.equal(count, referenceCount)
})
test('rebuilt ESM and browser exports can lazily stop', async () => {
  const module = await import(pathToFileURL(root + '/dist/js-yaml.mjs'))
  const context = vm.createContext({})
  vm.runInContext(readFileSync(root + '/dist/js-yaml.js', 'utf8'), context)
  for (const api of [module, context.jsyaml]) {
    assert.equal(typeof api.loadAllIterable, 'function')
    const it = api.loadAllIterable('ok: 1\n---\n[bad')
    assert.equal(it.next().value.ok, 1)
    assert.equal(it.return().done, true)
  }
})
