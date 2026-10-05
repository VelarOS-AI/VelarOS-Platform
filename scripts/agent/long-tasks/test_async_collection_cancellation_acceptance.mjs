import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { runInNewContext } from 'node:vm'

const root = process.cwd()
const require = createRequire(join(root, 'package.json'))
const api = require('./dist/async.js')
require('babel-register')()
const source = require('./lib/index.js')
const families = [
  'each',
  'eachOf',
  'map',
  'concat',
  'filter',
  'reject',
  'detect',
  'some',
  'every',
  'mapValues',
  'groupBy',
]
const variants = ['', 'Limit', 'Series']
const entries = families.flatMap((family) =>
  variants.map((variant) => ({ family, variant, name: family + variant }))
)

function controller() {
  const listeners = new Set()
  let added = 0,
    removed = 0
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener(type, fn) {
      assert.equal(type, 'abort')
      added++
      listeners.add(fn)
    },
    removeEventListener(type, fn) {
      assert.equal(type, 'abort')
      removed++
      listeners.delete(fn)
    },
  }
  return {
    signal,
    abort(reason) {
      if (signal.aborted) return
      signal.aborted = true
      signal.reason = reason
      for (const fn of [...listeners]) fn.call(signal, { type: 'abort', target: signal })
    },
    get count() {
      return listeners.size
    },
    get added() {
      return added
    },
    get removed() {
      return removed
    },
  }
}

function argumentsFor(entry, collection, iteratee, tail = []) {
  return [collection, ...(entry.variant === 'Limit' ? [2] : []), iteratee, ...tail]
}

function collectionFor(entry) {
  return entry.family === 'mapValues' ? { a: 1, b: 2, c: 3 } : [1, 2, 3]
}

function valueFor(family, value) {
  if (['map', 'mapValues'].includes(family)) return value * 10
  if (family === 'concat') return [value, value + 10]
  if (['filter', 'reject'].includes(family)) return value % 2 === 1
  if (['detect', 'some'].includes(family)) return value === 2
  if (family === 'every') return value > 0
  if (family === 'groupBy') return value % 2 ? 'odd' : 'even'
  return undefined
}

function expected(family) {
  return {
    each: undefined,
    eachOf: undefined,
    map: [10, 20, 30],
    concat: [1, 11, 2, 12, 3, 13],
    filter: [1, 3],
    reject: [2],
    detect: 2,
    some: true,
    every: true,
    mapValues: { a: 10, b: 20, c: 30 },
    groupBy: { odd: [1, 3], even: [2] },
  }[family]
}

function callbackIteratee(family) {
  return (value, ...rest) => rest.at(-1)(null, valueFor(family, value))
}

function observeCallback(fn, args) {
  let returned,
    count = 0
  const promise = new Promise((resolve, reject) => {
    try {
      returned = fn(...args, (...values) => {
        count++
        resolve(values)
      })
      // Broken overload handling must be an assertion failure, not a leaked rejection.
      returned?.catch?.(() => {})
    } catch (error) {
      reject(error)
    }
  })
  return {
    promise,
    get count() {
      return count
    },
    get returned() {
      return returned
    },
  }
}

async function prompt(promise) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error('Per-call cancellation must be available without waiting for user work')
            ),
          250
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function abortError(error, reason) {
  assert.equal(error?.name, 'AbortError', 'Per-call cancellation must be available')
  assert.equal(typeof error.message, 'string')
  if (reason !== undefined) assert.equal(error.cause, reason)
  return true
}

for (const entry of entries) {
  test(`${entry.name}: source module rejects before starting work`, async () => {
    const control = controller(),
      reason = { operation: entry.name }
    control.abort(reason)
    let calls = 0
    const fn = require(`./lib/${entry.name}.js`).default
    const result = fn(
      ...argumentsFor(
        entry,
        collectionFor(entry),
        (...args) => {
          calls++
          args.at(-1)(null, valueFor(entry.family, args[0]))
        },
        [{ signal: control.signal }]
      )
    )
    assert.equal(typeof result?.then, 'function')
    await assert.rejects(prompt(result), (error) => abortError(error, reason))
    assert.equal(calls, 0)
    assert.equal(control.count, 0)
  })

  test(`${entry.name}: callback cancellation settles while work is retained`, async () => {
    const control = controller(),
      reason = { name: entry.name },
      pending = [],
      started = []
    const operation = observeCallback(
      api[entry.name],
      argumentsFor(
        entry,
        collectionFor(entry),
        (...args) => {
          started.push(args[0])
          pending.push(args.at(-1))
        },
        [{ signal: control.signal }]
      )
    )
    control.abort(reason)
    try {
      const [error, partial] = await prompt(operation.promise)
      abortError(error, reason)
      assert.equal(typeof operation.returned?.then, 'undefined')
      const before = JSON.stringify(partial)
      const count = started.length
      for (const cb of [...pending]) {
        cb(null, 7)
        cb(new Error('late'))
      }
      await delay(0)
      assert.equal(JSON.stringify(partial), before)
      assert.equal(started.length, count)
      assert.equal(operation.count, 1)
      assert.equal(control.count, 0)
    } finally {
      // Release retained callbacks in the unchanged baseline without hanging the runner.
      if (operation.count === 0)
        for (const cb of [...pending]) {
          try {
            cb(null, 7)
          } catch {}
        }
    }
  })

  test(`${entry.name}: options retain Promise and callback result contracts`, async () => {
    const control = controller()
    const result = await prompt(
      api[entry.name](
        ...argumentsFor(
          entry,
          collectionFor(entry),
          async (value) => valueFor(entry.family, value),
          [{ signal: control.signal }]
        )
      )
    )
    assert.deepEqual(result, expected(entry.family))
    assert.equal(control.count, 0)
    assert(control.added > 0, 'an active operation must observe its signal')
    const observed = observeCallback(
      source[entry.name],
      argumentsFor(entry, collectionFor(entry), callbackIteratee(entry.family), [
        { signal: control.signal },
      ])
    )
    const [error, value] = await prompt(observed.promise)
    assert.equal(error, null)
    assert.deepEqual(value, expected(entry.family))
    assert.equal(typeof observed.returned?.then, 'undefined')
    assert.equal(control.count, 0)
    const legacy = await api[entry.name](
      ...argumentsFor(entry, collectionFor(entry), callbackIteratee(entry.family))
    )
    assert.deepEqual(legacy, expected(entry.family))
    const explicit = observeCallback(
      api[entry.name],
      argumentsFor(entry, collectionFor(entry), callbackIteratee(entry.family), [undefined])
    )
    assert.deepEqual((await prompt(explicit.promise))[1], expected(entry.family))
  })

  test(`${entry.name}: invalid options reject before reading collection`, async () => {
    let reads = 0
    const collection = new Proxy(
      {},
      {
        get() {
          reads++
          throw new Error('collection read')
        },
        ownKeys() {
          reads++
          throw new Error('collection keys')
        },
      }
    )
    for (const options of [null, [], true, 3, 'invalid', { signal: {} }]) {
      await assert.rejects(
        prompt(api[entry.name](...argumentsFor(entry, collection, () => {}, [options]))),
        { name: 'TypeError' }
      )
      const observed = observeCallback(
        api[entry.name],
        argumentsFor(entry, collection, () => {}, [options])
      )
      const [error] = await prompt(observed.promise)
      assert.equal(error?.name, 'TypeError')
    }
    assert.equal(reads, 0)
  })
}

for (const [alias, family] of [
  ['forEach', 'each'],
  ['forEachOf', 'eachOf'],
  ['select', 'filter'],
  ['find', 'detect'],
  ['any', 'some'],
  ['all', 'every'],
  ['flatMap', 'concat'],
]) {
  test(`aliases: ${alias} ordinary, Limit and Series support options`, async () => {
    for (const variant of variants) {
      const control = controller(),
        reason = { alias, variant }
      control.abort(reason)
      const entry = { family, variant }
      await assert.rejects(
        prompt(
          api[alias + variant](
            ...argumentsFor(entry, [1], callbackIteratee(family), [{ signal: control.signal }])
          )
        ),
        (error) => abortError(error, reason)
      )
    }
  })
}

test('pre-abort does not read properties or acquire either iterator', async () => {
  const control = controller()
  control.abort('pre-aborted')
  for (const coll of [
    new Proxy(
      {},
      {
        get() {
          assert.fail('read pre-aborted collection')
        },
        ownKeys() {
          assert.fail('enumerated pre-aborted collection')
        },
      }
    ),
    {
      [Symbol.iterator]() {
        assert.fail('acquired synchronous iterator')
      },
    },
    {
      [Symbol.asyncIterator]() {
        assert.fail('acquired asynchronous iterator')
      },
    },
  ])
    await assert.rejects(
      prompt(api.mapLimit(coll, 2, async (x) => x, { signal: control.signal })),
      (error) => abortError(error, 'pre-aborted')
    )
})

for (const reason of [undefined, null, false, 0, '', 'cancel', new Error('reason'), { task: 1 }]) {
  test(`abort cause preserves ${reason === null ? 'null' : typeof reason} reason`, async () => {
    const control = controller()
    const result = api.mapSeries([1], () => {}, { signal: control.signal })
    control.abort(reason)
    await assert.rejects(prompt(result), (error) => abortError(error, reason))
    assert.equal(control.count, 0)
  })
}

for (const kind of ['array', 'object', 'iterable', 'async-iterable']) {
  test(`collection ${kind}: stable order, keys and concurrency with a signal`, async () => {
    const control = controller(),
      keys = [],
      held = []
    let active = 0,
      maximum = 0
    const collection =
      kind === 'array'
        ? [1, 2, 3, 4]
        : kind === 'object'
          ? { a: 1, b: 2, c: 3, d: 4 }
          : kind === 'iterable'
            ? new Set([1, 2, 3, 4])
            : (async function* () {
                yield* [1, 2, 3, 4]
              })()
    const result = api.mapLimit(
      collection,
      2,
      (value, cb) => {
        active++
        maximum = Math.max(maximum, active)
        held.push(() => {
          active--
          cb(null, value * 3)
        })
      },
      { signal: control.signal }
    )
    await delay(0)
    assert.equal(held.length, 2)
    held.splice(1, 1)[0]()
    await delay(0)
    while (held.length) {
      held.shift()()
      await delay(0)
    }
    assert.deepEqual(await prompt(result), [3, 6, 9, 12])
    assert.equal(maximum, 2)
    assert.equal(control.count, 0)
    await api.eachOfSeries(
      { a: 1, b: 2 },
      (value, key, cb) => {
        keys.push([value, key])
        cb()
      },
      { signal: control.signal }
    )
    assert.deepEqual(keys, [
      [1, 'a'],
      [2, 'b'],
    ])
  })
}

test('synchronous abort inside an array iteratee stops the optimized traversal', async () => {
  const control = controller(),
    visited = []
  const result = api.eachOf(
    [1, 2, 3],
    (value, key, cb) => {
      visited.push([value, key])
      control.abort('inside')
      cb()
    },
    { signal: control.signal }
  )
  await assert.rejects(prompt(result), (error) => abortError(error, 'inside'))
  assert.deepEqual(visited, [[1, 0]])
})

for (const asynchronous of [false, true]) {
  test(`${asynchronous ? 'async' : 'sync'} iterator is closed once without waiting for cleanup`, async () => {
    const control = controller()
    let next = 0,
      closed = 0,
      lateNext
    const iterator = {
      next() {
        next++
        if (asynchronous)
          return new Promise((resolve) => {
            lateNext = resolve
          })
        return { value: next, done: false }
      },
      return() {
        closed++
        return new Promise(() => {})
      },
      [asynchronous ? Symbol.asyncIterator : Symbol.iterator]() {
        return this
      },
    }
    let work = 0
    const result = api.eachSeries(
      iterator,
      () => {
        work++
      },
      { signal: control.signal }
    )
    await delay(0)
    control.abort('close')
    await assert.rejects(prompt(result), (error) => abortError(error, 'close'))
    lateNext?.({ value: 99, done: false })
    await delay(0)
    assert.equal(next, 1)
    assert.equal(closed, 1)
    assert.equal(work, asynchronous ? 0 : 1)
    assert.equal(control.count, 0)
  })
}

test('iterator cleanup exceptions and late next rejection preserve cancellation', async () => {
  for (const cleanup of ['throw', 'reject']) {
    const control = controller()
    let rejectNext,
      closed = 0
    const iterable = {
      [Symbol.asyncIterator]() {
        return this
      },
      next() {
        return new Promise((_, reject) => {
          rejectNext = reject
        })
      },
      return() {
        closed++
        if (cleanup === 'throw') throw new Error('cleanup')
        return Promise.reject(new Error('cleanup'))
      },
    }
    const result = api.mapLimit(iterable, 2, async (x) => x, { signal: control.signal })
    await delay(0)
    control.abort('original')
    await assert.rejects(prompt(result), (error) => abortError(error, 'original'))
    rejectNext(new Error('late next'))
    await delay(5)
    assert.equal(closed, 1)
  }
})

test('ordinary errors retain identity and remove listeners', async () => {
  for (const callbackStyle of [true, false]) {
    const control = controller(),
      error = new Error('ordinary iteratee failure')
    if (callbackStyle) {
      const operation = observeCallback(api.filterLimit, [
        [1, 2],
        2,
        (_, cb) => cb(error),
        { signal: control.signal },
      ])
      assert.equal((await prompt(operation.promise))[0], error)
    } else
      await assert.rejects(
        api.filterLimit(
          [1, 2],
          2,
          async () => {
            throw error
          },
          { signal: control.signal }
        ),
        (value) => value === error
      )
    assert.equal(control.count, 0)
    control.abort('after failure')
  }
})

for (const name of ['detectSeries', 'someSeries', 'everySeries']) {
  test(`${name}: early completion removes its listener`, async () => {
    const control = controller(),
      visited = []
    const result = await api[name](
      [1, 2, 3],
      (x, cb) => {
        visited.push(x)
        cb(null, name !== 'everySeries')
      },
      { signal: control.signal }
    )
    assert.deepEqual(visited, [1])
    assert.equal(result, name === 'detectSeries' ? 1 : name === 'someSeries')
    assert.equal(control.count, 0)
  })
}

for (const promiseStyle of [false, true]) {
  test(`callback(false) stays silent and detaches listener in ${promiseStyle ? 'Promise' : 'callback'} mode`, async () => {
    const control = controller(),
      visited = []
    let settled = false
    const args = [
      [1, 2, 3],
      (x, cb) => {
        visited.push(x)
        cb(false)
      },
      { signal: control.signal },
    ]
    if (promiseStyle)
      api.mapSeries(...args).then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )
    else
      api.mapSeries(...args, () => {
        settled = true
      })
    await delay(0)
    assert.deepEqual(visited, [1])
    assert.equal(control.count, 0)
    control.abort('later')
    await delay(5)
    assert.equal(settled, false)
  })
}

test('shared signal cancels independent operations and a subsequent traversal succeeds', async () => {
  const control = controller(),
    callbacks = []
  const a = api.mapSeries([1, 2], (_, cb) => callbacks.push(cb), { signal: control.signal })
  const b = api.filterSeries([1, 2], (_, cb) => callbacks.push(cb), { signal: control.signal })
  control.abort('shared')
  await assert.rejects(prompt(a), (error) => abortError(error, 'shared'))
  await assert.rejects(prompt(b), (error) => abortError(error, 'shared'))
  callbacks.forEach((cb) => cb(null, true))
  assert.equal(control.count, 0)
  assert.deepEqual(await api.mapSeries([3], async (x) => x * 2, {}), [6])
})

test('reentrant and overlapping traversals retain local cancellation state', async () => {
  const outer = controller(),
    inner = controller()
  let innerResult, finishInner
  const result = api.mapSeries(
    [1, 2],
    () => {
      innerResult = api.mapSeries(
        [7],
        (_, cb) => {
          finishInner = cb
        },
        { signal: inner.signal }
      )
      outer.abort('outer')
    },
    { signal: outer.signal }
  )
  await assert.rejects(prompt(result), (error) => abortError(error, 'outer'))
  finishInner(null, 21)
  assert.deepEqual(await prompt(innerResult), [21])
  assert.equal(inner.count, 0)
  assert.equal(outer.count, 0)
})

test('browser UMD accepts duck-typed cancellation without AbortController', async () => {
  const context = { setTimeout, clearTimeout, setImmediate, console }
  runInNewContext(await readFile(join(root, 'dist/async.js'), 'utf8'), context)
  assert.equal(context.AbortController, undefined)
  for (const entry of entries) {
    const control = controller()
    control.abort('browser')
    await assert.rejects(
      prompt(
        context.async[entry.name](
          ...argumentsFor(entry, collectionFor(entry), callbackIteratee(entry.family), [
            { signal: control.signal },
          ])
        )
      ),
      (error) => abortError(error, 'browser')
    )
  }
})
