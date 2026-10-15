// 独立行为验收：预期结果由公开合同与原生 JSON 语义决定，不读取实现细节。
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'

const stringify = createRequire(resolve('package.json'))('./index.js')
const identity = function (key, value) {
  return value
}

test('replacer transforms root and nested values', () => {
  assert.equal(
    stringify(
      { b: 1, a: [2, undefined] },
      { replacer: (_k, v) => (typeof v === 'number' ? v + 10 : v) }
    ),
    '{' + '"a":[12,null],"b":11}'
  )
  assert.equal(
    stringify(7, { replacer: (key, value) => (key === '' ? { z: 2, a: 1 } : value) }),
    '{"a":1,"z":2}'
  )
})
test('root holder, member holders and string keys preserve identity', () => {
  const row = { z: 1, a: [{ b: 2, a: 3 }] },
    seen = []
  const result = stringify(row, {
    replacer: function (k, v) {
      assert.equal(typeof k, 'string')
      assert.equal(this[k], v)
      seen.push(k)
      if (k === '') assert.notEqual(this, row)
      if (k === '0') assert.equal(this, row.a)
      if (k === 'b') assert.equal(this, row.a[0])
      return v
    },
  })
  assert.equal(result, '{"a":[{"a":3,"b":2}],"z":1}')
  assert.deepEqual(seen, ['', 'a', '0', 'a', 'b', 'z'])
})
test('every primitive root is visited once through its root holder', () => {
  for (const data of [undefined, null, false, 0, 'x']) {
    let count = 0
    assert.equal(
      stringify(data, {
        replacer: function (k, v) {
          count++
          assert.equal(k, '')
          assert.equal(v, data)
          assert.equal(this[''], data)
          return 73
        },
      }),
      '73'
    )
    assert.equal(count, 1)
  }
})
test('undefined replacement omits members, fills array nulls and omits the root', () => {
  const replacer = (k, v) => (k === 'secret' || k === '1' ? undefined : v)
  assert.equal(
    stringify({ secret: 'password', items: [1, 2, 3] }, { replacer }),
    '{"items":[1,null,3]}'
  )
  assert.equal(stringify({ a: 1 }, { replacer: () => undefined }), undefined)
})
test('toJSON runs before the callback with the exact property key and holder', () => {
  const calls = [],
    original = {
      toJSON(k) {
        assert.equal(this, original)
        calls.push(['json', k])
        return 9
      },
    }
  const root = { child: original }
  assert.equal(
    stringify(root, {
      replacer: function (k, v) {
        calls.push(['replace', k])
        if (k === 'child') {
          assert.equal(v, 9)
          assert.equal(this, root)
          assert.equal(this.child, original)
        }
        return v
      },
    }),
    '{"child":9}'
  )
  assert.deepEqual(calls, [
    ['replace', ''],
    ['json', 'child'],
    ['replace', 'child'],
  ])
})
test('root and array toJSON receive their string keys in replacer mode', () => {
  const keys = []
  assert.equal(
    stringify(
      {
        toJSON(k) {
          keys.push(k)
          return [
            {
              toJSON(k) {
                keys.push(k)
                return 4
              },
            },
          ]
        },
      },
      { replacer: identity }
    ),
    '[4]'
  )
  assert.deepEqual(keys, ['', '0'])
})
test('objects returned by the replacer are traversed without a second toJSON', () => {
  let jsonCalls = 0
  const replacement = {
    a: 3,
    toJSON() {
      jsonCalls++
      throw new Error('must not be called')
    },
  }
  assert.equal(stringify(1, { replacer: (k, v) => (k === '' ? replacement : v) }), '{"a":3}')
  assert.equal(jsonCalls, 0)
})
test('replaced dates, boxed values and nonfinite numbers follow native JSON semantics', () => {
  const value = [
    new Date('2024-04-03T00:00:00Z'),
    new Number(4),
    new String('x'),
    new Boolean(false),
    NaN,
    Infinity,
    -Infinity,
  ]
  assert.equal(stringify(value, { replacer: identity }), JSON.stringify(value))
})
test('invalid replacers reject before any data getter or toJSON lookup', () => {
  for (const invalid of [null, false, true, 0, 7, '', 'function', [], {}]) {
    let reads = 0
    const data = {
      get toJSON() {
        reads++
        return () => ({ a: 1 })
      },
      get a() {
        reads++
        return 1
      },
    }
    assert.throws(() => stringify(data, { replacer: invalid }), TypeError)
    assert.equal(reads, 0)
  }
  assert.equal(stringify({ a: 1 }, { replacer: undefined }), stringify({ a: 1 }))
})
test('replacer, getter and toJSON exceptions preserve the exact thrown identity', () => {
  const sentinel = { kind: 'intentional' }
  for (const [value, replacer] of [
    [
      { a: 1 },
      () => {
        throw sentinel
      },
    ],
    [
      {
        get a() {
          throw sentinel
        },
      },
      identity,
    ],
    [
      {
        toJSON() {
          throw sentinel
        },
      },
      identity,
    ],
  ])
    assert.throws(
      () => stringify(value, { replacer }),
      (e) => e === sentinel
    )
})
test('comparator order observes current properties before child callbacks', () => {
  const seen = []
  assert.equal(
    stringify(
      { a: 2, b: 1 },
      {
        cmp: (a, b) => a.value - b.value,
        replacer: (k, v) => {
          seen.push(k)
          return typeof v === 'number' ? -v : v
        },
      }
    ),
    '{"b":-1,"a":-2}'
  )
  assert.deepEqual(seen, ['', 'b', 'a'])
  assert.equal(
    stringify({ a: 2, b: 1 }, (a, b) => b.key.localeCompare(a.key)),
    '{"b":1,"a":2}'
  )
})
test('object key snapshots do not visit later additions and still visit deleted keys', () => {
  const value = { a: 1, b: 2 },
    seen = []
  const actual = stringify(value, {
    replacer: function (k, v) {
      seen.push(k)
      if (k === 'a') {
        this.c = 3
        delete this.b
      }
      return v
    },
  })
  assert.equal(actual, '{"a":1}')
  assert.deepEqual(seen, ['', 'a', 'b'])
})
test('array length snapshots ignore appended items and visit deleted indices', () => {
  const value = [1, 2],
    seen = []
  const actual = stringify(value, {
    replacer: function (k, v) {
      seen.push(k)
      if (k === '0') {
        this.push(3)
        delete this[1]
      }
      return v
    },
  })
  assert.equal(actual, '[1,null]')
  assert.deepEqual(seen, ['', '0', '1'])
})
test('array holes are visited and missing replacements remain null', () => {
  const value = new Array(3),
    seen = []
  value[1] = undefined
  assert.equal(
    stringify(value, {
      replacer: (k, v) => {
        seen.push(k)
        return v
      },
    }),
    '[null,null,null]'
  )
  assert.deepEqual(seen, ['', '0', '1', '2'])
})
test('filtering an object or array cycle occurs before ancestor detection', () => {
  const object = { a: 1 }
  object.self = object
  assert.equal(stringify(object, { replacer: (k, v) => (k === 'self' ? undefined : v) }), '{"a":1}')
  const array = []
  array.push(array)
  assert.equal(stringify(array, { replacer: (k, v) => (k === '0' ? undefined : v) }), '[null]')
})
test('cycles across arrays and objects fail or use the established marker', () => {
  const array = []
  array.push(array)
  const object = { array: [] }
  object.array.push(object)
  for (const value of [array, object]) {
    assert.throws(() => stringify(value), TypeError)
    assert.throws(() => stringify(value, { replacer: identity }), TypeError)
  }
  assert.equal(stringify(array, { cycles: true }), '["__cycle__"]')
  assert.equal(stringify(object, { cycles: true, replacer: identity }), '{"array":["__cycle__"]}')
})
test('a replacer-created ancestor cycle is checked after the callback', () => {
  const value = { a: 1 }
  const replacer = function (k, v) {
    return k === 'a' ? this : v
  }
  assert.throws(() => stringify(value, { replacer }), TypeError)
  assert.equal(stringify(value, { replacer, cycles: true }), '{"a":"__cycle__"}')
})
test('shared sibling references remain independent traversals', () => {
  const child = { v: 2 },
    seen = []
  assert.equal(
    stringify(
      { b: child, a: child },
      {
        cycles: true,
        replacer: (k, v) => {
          seen.push(k)
          return v
        },
      }
    ),
    '{"a":{"v":2},"b":{"v":2}}'
  )
  assert.deepEqual(seen, ['', 'a', 'v', 'b', 'v'])
})
test('own enumerable string members are selected and other primitive kinds may be replaced', () => {
  const symbol = Symbol('private'),
    value = Object.create({ inherited: 1 })
  Object.assign(value, { fn() {}, symbol, a: 1 })
  value[symbol] = 2
  Object.defineProperty(value, 'hidden', { value: 4, enumerable: false })
  const seen = []
  assert.equal(
    stringify(value, {
      replacer: (k, v) => {
        seen.push(k)
        return typeof v === 'function' ? 'callable' : typeof v === 'symbol' ? 'symbol' : v
      },
    }),
    '{"a":1,"fn":"callable","symbol":"symbol"}'
  )
  assert.deepEqual(seen, ['', 'a', 'fn', 'symbol'])
})
test('escaping and deterministic secret redaction preserve immutable input', () => {
  const replacer = (k, v) => (k === 'secret' ? undefined : v)
  const a = Object.freeze({
    z: 'line\n"quote"\\tab\t',
    a: '中文😀',
    secret: 'first',
  })
  const b = { secret: 'second', a: '中文😀', z: 'line\n"quote"\\tab\t' }
  const expected = JSON.stringify({ a: a.a, z: a.z })
  assert.equal(stringify(a, { replacer }), expected)
  assert.equal(stringify(b, { replacer }), expected)
  assert.equal(a.secret, 'first')
})
