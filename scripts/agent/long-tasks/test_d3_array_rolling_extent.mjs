import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const root = resolve(process.argv[2] ?? process.cwd())
const { rollingExtent } = await import(pathToFileURL(resolve(root, 'src/index.js')))
const expected = (values, width) =>
  Array.from({ length: Math.max(0, values.length - width + 1) }, (_, start) => {
    let lo, hi
    for (let i = start; i < start + width; i++) {
      const value = values[i]
      if (value == null || Number.isNaN(value)) continue
      if (lo === undefined) lo = hi = value
      else {
        if (value < lo) lo = value
        if (value > hi) hi = value
      }
    }
    return [lo, hi]
  })

test('rollingExtent is publicly exported', () => assert.equal(typeof rollingExtent, 'function'))
test('complete windows retain positional boundaries around ignored values', () => {
  for (const data of [
    [4, 2, 7, 1, 6],
    [null, 5, undefined, NaN, 2],
    [NaN, null, undefined, NaN],
    [],
  ])
    for (const width of [1, 2, 3, 5, 9])
      assert.deepEqual(rollingExtent(data, width), expected(data, width))
})
test('fresh pairs do not alias across windows or calls', () => {
  const values = [2, 2, 2, 2]
  const first = rollingExtent(values, 2),
    second = rollingExtent(values, 2)
  assert.equal(new Set([...first, ...second]).size, 6)
  first[0][0] = 9
  assert.deepEqual(first.slice(1), [
    [2, 2],
    [2, 2],
  ])
  assert.deepEqual(second, [
    [2, 2],
    [2, 2],
    [2, 2],
  ])
})
test('signed zero tie order survives expiry of the earliest equal value', () => {
  for (const values of [
    [0, -0, -0, 0, 0],
    [-0, 0, 1, -0, 0, -0],
    [Infinity, -Infinity, NaN, Infinity],
  ])
    for (const width of [1, 2, 3, 4])
      assert.deepEqual(rollingExtent(values, width), expected(values, width))
})
test('typed arrays and frozen arrays stay unchanged', () => {
  for (const values of [new Float64Array([3, -0, 7, NaN, 2]), Object.freeze([3, -0, 7, NaN, 2])]) {
    const before = Array.from(values)
    assert.deepEqual(rollingExtent(values, 3), expected(before, 3))
    assert.deepEqual(Array.from(values), before)
  }
})
test('an accessor is called once per item with exact index and original one-shot iterable', () => {
  const objects = [
    Object.freeze({ n: 4 }),
    Object.freeze({ n: null }),
    Object.freeze({ n: 1 }),
    Object.freeze({ n: 3 }),
  ]
  let opens = 0,
    reads = 0
  const iterable = {
    [Symbol.iterator]() {
      assert.equal(++opens, 1)
      return objects[Symbol.iterator]()
    },
  }
  const calls = []
  const result = rollingExtent(iterable, 2, (item, index, original) => {
    assert.equal(original, iterable)
    assert.equal(item, objects[index])
    calls.push(index)
    reads++
    return item.n
  })
  assert.deepEqual(result, [
    [4, 4],
    [1, 1],
    [1, 3],
  ])
  assert.deepEqual(calls, [0, 1, 2, 3])
  assert.equal(reads, 4)
})
test('invalid window validation precedes any iterator access and accessor validation', () => {
  const iterable = {
    get [Symbol.iterator]() {
      assert.fail('iterator accessed before validation')
    },
  }
  for (const width of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    '2',
    null,
    undefined,
    true,
    2n,
    new Number(2),
  ])
    assert.throws(() => rollingExtent(iterable, width, null), RangeError)
})
test('invalid accessors reject before iterator access while undefined preserves numeric input', () => {
  const iterable = {
    get [Symbol.iterator]() {
      assert.fail('iterator accessed before validation')
    },
  }
  for (const accessor of [null, true, 1, 'x', {}, []])
    assert.throws(() => rollingExtent(iterable, 2, accessor), TypeError)
  assert.deepEqual(rollingExtent([1, 2, 3], 2, undefined), [
    [1, 2],
    [2, 3],
  ])
})
test('very large valid windows do not preallocate or skip accessor validation of a short input', () => {
  let calls = 0
  assert.deepEqual(
    rollingExtent([1, 2, 3], Number.MAX_SAFE_INTEGER, (v) => {
      calls++
      return v
    }),
    []
  )
  assert.equal(calls, 3)
  assert.throws(() => rollingExtent([1, 'bad'], Number.MAX_SAFE_INTEGER), TypeError)
})
test('non-number candidates are rejected without coercion', () => {
  for (const invalid of ['2', false, 1n, {}, [], new Number(3), Symbol('value')]) {
    assert.throws(() => rollingExtent([1, invalid, 2], 2), TypeError)
    assert.throws(() => rollingExtent([1], 1, () => invalid), TypeError)
  }
})
test('invalid candidates close the iterator once without letting close failure replace TypeError', () => {
  for (const useAccessor of [false, true]) {
    let closed = 0,
      reads = 0
    const iterable = {
      [Symbol.iterator]() {
        return {
          next() {
            reads++
            return { done: reads > 2, value: useAccessor ? 1 : 'invalid' }
          },
          return() {
            closed++
            throw { closing: true }
          },
        }
      },
    }
    assert.throws(
      () => rollingExtent(iterable, 2, useAccessor ? () => 'invalid' : undefined),
      TypeError
    )
    assert.equal(closed, 1)
    assert.equal(reads, 1)
  }
})
test('accessor failures preserve identity and close a suspended generator', () => {
  for (const reason of [null, undefined, 0, false, { sentinel: true }]) {
    let closed = 0,
      caught = false
    function* values() {
      try {
        yield 1
        yield 2
      } finally {
        closed++
      }
    }
    try {
      rollingExtent(values(), 2, () => {
        throw reason
      })
    } catch (error) {
      caught = true
      assert.equal(error, reason)
    }
    assert(caught)
    assert.equal(closed, 1)
  }
})
test('iterator failures propagate their exact thrown value', () => {
  for (const reason of [null, undefined, 0, { iterator: true }]) {
    let caught = false
    const iterable = {
      [Symbol.iterator]() {
        return {
          next() {
            throw reason
          },
        }
      },
    }
    try {
      rollingExtent(iterable, 1)
    } catch (error) {
      caught = true
      assert.equal(error, reason)
    }
    assert(caught)
  }
})
test('a nested rollingExtent call in the accessor does not corrupt outer state', () => {
  assert.deepEqual(
    rollingExtent([4, 1, 7, 2], 2, (v) => {
      assert.deepEqual(rollingExtent([9, 2, 6], 2), [
        [2, 9],
        [2, 6],
      ])
      return v
    }),
    [
      [1, 4],
      [1, 7],
      [2, 7],
    ]
  )
})
test('frozen varied numeric sequences match an independent window scan oracle', () => {
  let seed = 0x91ac42
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0)
  const domain = [null, undefined, NaN, 0, -0, Infinity, -Infinity, -1, 2, 2, 9, -8]
  for (let trial = 0; trial < 256; trial++) {
    const values = Array.from({ length: next() % 79 }, () => domain[next() % domain.length])
    const width = 1 + (next() % 85)
    assert.deepEqual(rollingExtent(values, width), expected(values, width), `trial ${trial}`)
  }
})
test('large wide windows complete without quadratic rescanning or eager width allocation', () => {
  assert.equal(typeof rollingExtent, 'function')
  const script = `import assert from 'node:assert/strict';import {rollingExtent} from ${JSON.stringify(pathToFileURL(resolve(root, 'src/index.js')).href)};const n=160000,w=80000;for(const descending of [false,true]){let reads=0;function* input(){for(let i=0;i<n;i++){reads++;yield descending?n-i:i}}const r=rollingExtent(input(),w);assert.equal(reads,n);assert.equal(r.length,n-w+1);assert.deepEqual(r[0],descending?[n-w+1,n]:[0,w-1]);assert.deepEqual(r.at(-1),descending?[1,w]:[n-w,n-1]);}console.log('wide-window-complete');`
  const result = spawnSync(
    process.execPath,
    ['--max-old-space-size=256', '--input-type=module', '-e', script],
    {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 65536,
    }
  )
  assert.equal(result.status, 0, String(result.error ?? result.stderr))
  assert.match(result.stdout, /wide-window-complete/)
})
