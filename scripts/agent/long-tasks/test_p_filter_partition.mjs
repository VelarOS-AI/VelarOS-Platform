import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { runTsdConsumer } from './type-consumer.mjs'

const api = await import(pathToFileURL(resolve('index.js')))
const partition = (...args) => {
  assert.equal(typeof api.pPartition, 'function', 'exports pPartition')
  return api.pPartition(...args)
}
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
async function bounded(promise) {
  const timeout = new AbortController()
  try {
    return await Promise.race([
      promise,
      delay(1500, null, { signal: timeout.signal }).then(() => {
        throw new Error('partition did not settle')
      }),
    ])
  } finally {
    timeout.abort()
  }
}

test('exports pPartition and preserves resolved identity, duplicates and truthiness', async () => {
  const object = { tag: 1 },
    symbol = Symbol('entry')
  const input = [Promise.resolve(undefined), null, false, 0, NaN, symbol, object, object]
  const copy = [...input],
    calls = []
  const options = Object.freeze({ concurrency: 3 })
  const result = await partition(
    input,
    (value, index) => {
      calls.push([value, index])
      return Promise.resolve([true, false, 1, '', {}, null, 'yes', 0][index])
    },
    options
  )
  assert.deepEqual(result, {
    matched: [undefined, false, NaN, object],
    unmatched: [null, 0, symbol, object],
  })
  assert.equal(result.matched[3], object)
  assert.equal(result.unmatched[3], object)
  assert.deepEqual(input, copy)
  assert.deepEqual(
    calls.map(([, index]) => index).sort((a, b) => a - b),
    [0, 1, 2, 3, 4, 5, 6, 7]
  )
  assert.equal(calls.find(([, index]) => index === 0)[0], undefined)
})

test('settlement order does not change either group input order', async () => {
  const ready = deferred(),
    decisions = Array.from({ length: 6 }, deferred)
  let started = 0
  const done = partition([1, 2, 3, 4, 5, 6], async (_, index) => {
    if (++started === 6) ready.resolve()
    return decisions[index].promise
  })
  Promise.resolve(done).catch(() => {})
  try {
    await bounded(ready.promise)
    for (let index = 5; index >= 0; index--) {
      decisions[index].resolve(index % 2 === 0)
      await delay(0)
    }
    assert.deepEqual(await done, { matched: [1, 3, 5], unmatched: [2, 4, 6] })
  } finally {
    for (const decision of decisions) decision.resolve(false)
    await bounded(done).catch(() => {})
  }
})

test('one-shot sync and async sources are consumed once and filters see resolved values', async () => {
  for (const asynchronous of [false, true]) {
    let iterations = 0,
      pulls = 0,
      calls = 0
    const values = [Promise.resolve(2), 3, Promise.resolve(4)]
    const iterator = {
      next() {
        const index = pulls++
        const value = index < values.length ? { value: values[index], done: false } : { done: true }
        return asynchronous ? Promise.resolve(value) : value
      },
    }
    const source = {
      [asynchronous ? Symbol.asyncIterator : Symbol.iterator]() {
        assert.equal(++iterations, 1)
        return iterator
      },
    }
    const result = await partition(
      source,
      (value, index) => {
        calls++
        assert.equal(typeof value, 'number')
        assert.equal(value, index + 2)
        return value % 2 === 0
      },
      { concurrency: 2 }
    )
    assert.deepEqual(result, { matched: [2, 4], unmatched: [3] })
    assert.equal(calls, 3)
    assert.equal(iterations, 1)
  }
})

test('concurrency bounds real simultaneous filters without forcing serial work', async () => {
  const initial = deferred(),
    release = deferred()
  let active = 0,
    peak = 0,
    started = 0
  const done = partition(
    [1, 2, 3, 4, 5, 6],
    async (value) => {
      started++
      active++
      peak = Math.max(peak, active)
      assert(active <= 2)
      if (started <= 2) {
        if (started === 2) initial.resolve()
        await release.promise
      } else await delay(1)
      active--
      return value <= 3
    },
    { concurrency: 2 }
  )
  Promise.resolve(done).catch(() => {})
  try {
    await bounded(initial.promise)
    assert.equal(started, 2)
    release.resolve()
    assert.deepEqual(await done, { matched: [1, 2, 3], unmatched: [4, 5, 6] })
    assert.equal(peak, 2)
  } finally {
    release.resolve()
    await bounded(done).catch(() => {})
  }
})

test('empty inputs return independent arrays and existing filters stay compatible', async () => {
  let calls = 0
  const result = await partition([], () => {
    calls++
    return true
  })
  assert.deepEqual(result, { matched: [], unmatched: [] })
  assert.notEqual(result.matched, result.unmatched)
  assert.equal(calls, 0)
  result.matched.push(1)
  assert.deepEqual(result.unmatched, [])
  assert.deepEqual(await api.default([Promise.resolve(1), 2, 3], (x) => x % 2), [1, 3])
  const values = []
  for await (const value of api.pFilterIterable([1, 2, 3], async (x) => x % 2)) values.push(value)
  assert.deepEqual(values, [1, 3])
})

test('default rejection retains the exact input, synchronous and asynchronous filter errors', async () => {
  for (const kind of ['input', 'sync-filter', 'async-filter']) {
    const error = new Error(kind)
    const input = kind === 'input' ? [Promise.reject(error)] : [1, 2]
    if (kind === 'input') input[0].catch(() => {})
    await assert.rejects(
      partition(input, () => {
        if (kind === 'sync-filter') throw error
        if (kind === 'async-filter') return Promise.reject(error)
        return true
      }),
      (value) => value === error
    )
  }
})

test('aggregate mode processes eligible work once and retains every original error', async () => {
  const one = new Error('one'),
    two = new Error('two'),
    inputFailure = new Error('input')
  const rejected = Promise.reject(inputFailure)
  rejected.catch(() => {})
  const calls = []
  await assert.rejects(
    partition(
      [1, 2, rejected, 4, 5],
      async (value, index) => {
        calls.push(index)
        if (value === 2) throw one
        if (value === 4) throw two
        return true
      },
      { concurrency: 2, stopOnError: false }
    ),
    (error) => {
      assert(error instanceof AggregateError)
      assert.equal(error.errors.length, 3)
      assert.deepEqual(new Set(error.errors), new Set([one, two, inputFailure]))
      return true
    }
  )
  assert.deepEqual(
    calls.sort((a, b) => a - b),
    [0, 1, 3, 4]
  )
})

test('cancellation preserves reason, is prompt and prevents future filter starts', async () => {
  const before = new AbortController(),
    reason = new Error('stop before work')
  before.abort(reason)
  let calls = 0
  await assert.rejects(
    partition(
      [1, 2],
      () => {
        calls++
        return true
      },
      { signal: before.signal }
    ),
    (error) => error === reason
  )
  assert.equal(calls, 0)
  const controller = new AbortController(),
    started = deferred(),
    release = deferred(),
    during = new Error('stop during work')
  const done = partition(
    [1, 2, 3],
    async () => {
      calls++
      started.resolve()
      await release.promise
      return true
    },
    { concurrency: 1, signal: controller.signal }
  )
  const rejected = assert.rejects(bounded(done), (error) => error === during)
  rejected.catch(() => {})
  try {
    await bounded(started.promise)
    controller.abort(during)
    await rejected
    release.resolve()
    await delay(10)
    assert.equal(calls, 1)
  } finally {
    release.resolve()
    await rejected.catch(() => {})
  }
})

test('invalid concurrency rejects consistently instead of being ignored', async () => {
  for (const concurrency of [0, -1, 1.5, NaN, '2', null])
    await assert.rejects(
      partition([1, 2], () => true, { concurrency }),
      TypeError
    )
})

test('public declarations infer both groups, async sources and synchronous type guards', async () => {
  const result = await runTsdConsumer(
    `import {expectType,expectError} from ${JSON.stringify(resolve('node_modules/tsd/dist/index.js'))};
import pFilter,{pPartition,pFilterIterable,type Options} from ${JSON.stringify(resolve('index.js'))};
expectType<Promise<{matched:number[];unmatched:number[]}>>(pPartition([Promise.resolve(1),2] as const,async value=>value>0,{concurrency:2,stopOnError:false}));
async function* source():AsyncGenerator<number,void,unknown>{yield 1;yield 2;}
expectType<Promise<{matched:number[];unmatched:number[]}>>(pPartition(source(),async value=>value===1));
type A={kind:'a';a:number};type B={kind:'b';b:string};declare const mixed:ReadonlyArray<A|B|PromiseLike<A|B>>;
const isA=(value:A|B,_index:number):value is A=>value.kind==='a';
expectType<Promise<{matched:A[];unmatched:B[]}>>(pPartition(mixed,isA));
declare const options:Options;expectType<Promise<{matched:string[];unmatched:string[]}>>(pPartition(new Set(['a','b']),value=>Promise.resolve(value==='a'),options));
expectType<Promise<number[]>>(pFilter([1,2],value=>value>0));expectType<AsyncIterable<number>>(pFilterIterable(source(),value=>value>0));
expectError(pPartition(42,()=>true));expectError(pPartition([1,2],(value:string)=>value.length>0));expectError(pPartition([1],()=>true,{concurrency:'2'}));expectError(pPartition([1],()=>Promise.resolve('yes')));
`
  )
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('documented offline example runs against the actual package', async () => {
  assert.match(await readFile('readme.md', 'utf8'), /pPartition/u)
  const result = spawnSync(process.execPath, ['examples/partition.js'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 10000,
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
