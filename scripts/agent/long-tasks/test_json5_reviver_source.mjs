import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'

const root = resolve(process.argv[2] ?? process.cwd())
const require = createRequire(import.meta.url)
const JSON5 = require(root)

function inspect(source, mutate) {
  const calls = []
  const value = JSON5.parse(source, function (key, value, context) {
    calls.push({
      key,
      value,
      context,
      holder: this,
      source: context?.source,
      own: context != null && Object.hasOwn(context, 'source'),
    })
    return mutate ? mutate.call(this, key, value, context, calls) : value
  })
  return { value, calls }
}

const primitives = [
  ['0', 0],
  ['-0', -0],
  ['+0', 0],
  ['true', true],
  ['false', false],
  ['null', null],
  ['NaN', NaN],
  ['-NaN', NaN],
  ['+Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['0xFf', 255],
  ['-0XfF', -255],
  ['+.5', 0.5],
  ['5.', 5],
  ['1.20e+03', 1200],
  ['9007199254740993', 9007199254740992],
  ['""', ''],
  ["'single'", 'single'],
  [String.raw`"a\u0062\x63"`, 'abc'],
  ['"𝌆"', '𝌆'],
  ["'ab\\\ncd'", 'abcd'],
  ["'ab\\\r\ncd'", 'abcd'],
]
for (const [token, expected] of primitives)
  test(`primitive source preserves token ${JSON.stringify(token)}`, () => {
    const result = inspect('\ufeff // leading\r\n ' + token + ' \t/* trailing */')
    assert(Object.is(result.value, expected))
    assert.equal(result.calls.length, 1)
    assert.equal(result.calls[0].source, token)
    assert.equal(result.calls[0].own, true)
  })

test('nested primitive tokens exclude comments, keys and separators', () => {
  const result = inspect("{/*🙂*/ list: [ 0x10, 'a\\x62', null, ], object: { n: +.5, }, }")
  assert.deepEqual(
    result.calls.filter((call) => call.own).map((call) => [call.key, call.source]),
    [
      ['0', '0x10'],
      ['1', "'a\\x62'"],
      ['2', 'null'],
      ['n', '+.5'],
    ]
  )
  assert.deepEqual(
    result.calls.filter((call) => !call.own).map((call) => call.key),
    ['list', 'object', '']
  )
  for (const call of result.calls)
    assert(call.context && Object.getPrototypeOf(call.context) === Object.prototype)
})

test('duplicate and escaped keys retain the final token even for equal values', () => {
  const result = inspect('{ a: 1, "\\u0061": +1, "": 0, \'\': -0, __proto__: 7, constructor: 3 }')
  assert.equal(result.calls.find((call) => call.key === 'a').source, '+1')
  assert.equal(result.calls.find((call) => call.key === '' && call.own).source, '-0')
  assert.equal(result.calls.find((call) => call.key === '__proto__').source, '7')
  assert.equal(result.calls.find((call) => call.key === 'constructor').source, '3')
  assert.equal(Object.getPrototypeOf(result.value), Object.prototype)
  assert.equal(Object.hasOwn(result.value, '__proto__'), true)
})

test('earlier sibling mutation removes source for the changed primitive', () => {
  const result = inspect('{ trigger: 1, target: 2 }', function (key, value) {
    if (key === 'trigger') this.target = 20
    return value
  })
  const target = result.calls.find((call) => call.key === 'target')
  assert(target.context)
  assert.equal(target.value, 20)
  assert.equal(target.own, false)
})

test('SameValue distinguishes signed zero while retaining NaN and equal primitives', () => {
  const result = inspect('{ trigger: 1, zero: 0, nan: NaN, equal: 2 }', function (key, value) {
    if (key === 'trigger') {
      this.zero = -0
      this.nan = NaN
      this.equal = 2
    }
    return value
  })
  assert.equal(result.calls.find((call) => call.key === 'zero').own, false)
  assert.equal(result.calls.find((call) => call.key === 'nan').source, 'NaN')
  assert.equal(result.calls.find((call) => call.key === 'equal').source, '2')
})

test('replacement object and array children do not inherit old token metadata', () => {
  const result = inspect('{ trigger: 0, obj: { n: 41 }, list: [42] }', function (key, value) {
    if (key === 'trigger') {
      this.obj = { n: 41 }
      this.list = [42]
    }
    return value
  })
  for (const key of ['n', '0', 'obj', 'list', '']) {
    const call = result.calls.find((call) => call.key === key)
    assert(call.context)
    assert.equal(call.own, false, key)
  }
})

test('an originally parsed object moved to a different location does not borrow the old location source', () => {
  const result = inspect(
    '{ trigger: 0, left: { n: 11 }, right: { n: 22 } }',
    function (key, value) {
      if (key === 'trigger') this.right = this.left
      return value
    }
  )
  const children = result.calls.filter((call) => call.key === 'n')
  assert.equal(children.length, 2)
  assert.equal(children[0].source, '11')
  assert(children[1].context)
  assert.equal(children[1].own, false)
})

test('contexts are fresh and own-property mutations cannot leak to other calls', () => {
  const result = inspect('[1,2,{a:3}]', function (key, value, context) {
    assert(context)
    context.source = 'changed by consumer'
    context.custom = true
    return value
  })
  assert.equal(new Set(result.calls.map((call) => call.context)).size, result.calls.length)
  assert.deepEqual(
    result.calls.filter((call) => call.own).map((call) => call.source),
    ['1', '2', '3']
  )
  assert(result.calls.filter((call) => !call.own).every((call) => call.source === undefined))
})

test('nested parse calls inside revivers preserve the outer remaining tokens', () => {
  let inner
  const result = inspect('{first:0x10, second:1.50, third:"outer"}', function (key, value) {
    if (key === 'first') inner = inspect('{ first:"inner", second:-Infinity }')
    return value
  })
  assert.deepEqual(
    result.calls.filter((call) => call.own).map((call) => call.source),
    ['0x10', '1.50', '"outer"']
  )
  assert.deepEqual(
    inner.calls.filter((call) => call.own).map((call) => call.source),
    ['"inner"', '-Infinity']
  )
})

test('source coercion happens once and nested coercion parses do not corrupt token capture', () => {
  let coerced = 0
  const source = {
    toString() {
      coerced++
      JSON5.parse('[1,2]')
      return '{ n:0x20 }'
    },
  }
  const result = inspect(source)
  assert.equal(coerced, 1)
  assert.equal(result.calls.find((call) => call.key === 'n').source, '0x20')
})

test('raw source permits lossless precision recovery in a real reviver', () => {
  const result = JSON5.parse('{exact:900719925474099312345}', (key, value, context) =>
    key === 'exact' ? BigInt(context.source) : value
  )
  assert.equal(result.exact, 900719925474099312345n)
})

test('deletion, replacement, traversal order and root holder remain compatible', () => {
  const calls = []
  const result = JSON5.parse('{a:[1,2],drop:3}', function (key, value, context) {
    calls.push({ key, context, holder: this })
    if (key === '0') return undefined
    if (key === '1') return 20
    if (key === 'drop') return undefined
    return value
  })
  assert.deepEqual(
    calls.map((call) => call.key),
    ['0', '1', 'a', 'drop', '']
  )
  assert.equal(result.a.length, 2)
  assert.equal(0 in result.a, false)
  assert.equal(result.a[1], 20)
  assert.equal(Object.hasOwn(result, 'drop'), false)
  assert.equal(calls.at(-1).holder[''], result)
  assert(calls.every((call) => call.context && typeof call.context === 'object'))
})

test('no-reviver and non-function-reviver parsing keeps existing behavior', () => {
  for (const reviver of [undefined, null, 1, {}, 'ignored'])
    assert.deepEqual(JSON5.parse('{x:0x10,y:[true,null,],}', reviver), { x: 16, y: [true, null] })
})

test('syntax errors happen before any reviver invocation', () => {
  let calls = 0
  assert.throws(
    () =>
      JSON5.parse('{a:1} trailing', () => {
        calls++
        return 0
      }),
    SyntaxError
  )
  assert.equal(calls, 0)
})

test('ordinary JSON tokens and contexts match the native source-aware parser', () => {
  const text = '{"n":9007199254740993,"z":-0,"s":"a\\u0062","a":[null,true,{"x":1.5e2}]}'
  const snapshot = (parse) => {
    const result = []
    parse(text, function (key, value, context) {
      result.push([key, context && Object.hasOwn(context, 'source'), context?.source])
      return value
    })
    return result
  }
  const expected = snapshot(JSON.parse)
  assert(
    expected.some((call) => call[1]),
    'The frozen Node runtime must support native primitive-source contexts'
  )
  assert.deepEqual(snapshot(JSON5.parse), expected)
})

function publicTokens(api) {
  const seen = []
  const value = api.parse(
    '{big:9007199254740993,hex:+0x10,s:"a\\u0062"}',
    function (key, value, context) {
      assert(context && typeof context === 'object')
      if (Object.hasOwn(context, 'source')) seen.push([key, context.source])
      if (key === 'big') return BigInt(context.source)
      return value
    }
  )
  assert.equal(value.big, 9007199254740993n)
  assert.equal(value.hex, 16)
  assert.equal(value.s, 'ab')
  assert.deepEqual(seen, [
    ['big', '9007199254740993'],
    ['hex', '+0x10'],
    ['s', '"a\\u0062"'],
  ])
}

for (const name of ['index.mjs', 'index.min.mjs'])
  test(`built ESM distribution preserves public source context: ${name}`, async () => {
    const module = await import(pathToFileURL(resolve(root, 'dist', name)))
    publicTokens(module.default)
  })

for (const name of ['index.js', 'index.min.js'])
  test(`built browser distribution preserves public source context: ${name}`, () => {
    const context = vm.createContext({})
    vm.runInContext(readFileSync(resolve(root, 'dist', name), 'utf8'), context)
    publicTokens(context.JSON5)
  })

test('ordinary CLI conversion and validation remain compatible', () => {
  const input = '{hex:+0x10, list:[true,null,],}'
  const convert = spawnSync(process.execPath, [resolve(root, 'lib/cli.js')], {
    input,
    encoding: 'utf8',
    timeout: 5000,
  })
  assert.equal(convert.status, 0, convert.stderr)
  assert.deepEqual(JSON.parse(convert.stdout), { hex: 16, list: [true, null] })
  const validate = spawnSync(process.execPath, [resolve(root, 'lib/cli.js'), '--validate'], {
    input,
    encoding: 'utf8',
    timeout: 5000,
  })
  assert.equal(validate.status, 0, validate.stderr)
  assert.equal(validate.stdout, '')
})
