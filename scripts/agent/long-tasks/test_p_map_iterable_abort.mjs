// 独立验证公开异步迭代取消、资源释放与原有流控制行为，不读取被测实现。
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const { pMapIterable, pMapSkip, pMapStop } = await import(pathToFileURL(resolve('index.js')))
const tick = () => new Promise((done) => setImmediate(done))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const observe = (promise) =>
  Promise.resolve(promise).then(
    (value) => ({ ok: true, value }),
    (reason) => ({ ok: false, reason })
  )
async function bounded(promise) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error('Cancellation did not settle while user work was pending')),
          1000
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
async function until(condition) {
  const deadline = Date.now() + 1000
  while (!condition()) {
    assert(Date.now() < deadline, 'Expected user operation did not start')
    await tick()
  }
}
function source(
  next = (index) => ({ done: index >= 8, value: index }),
  close = () => ({ done: true })
) {
  const stats = { acquired: 0, pulls: 0, returns: 0 }
  return {
    stats,
    [Symbol.asyncIterator]() {
      stats.acquired++
      let index = 0
      return {
        next() {
          stats.pulls++
          return next(index++)
        },
        return() {
          stats.returns++
          return close()
        },
      }
    },
  }
}
const collect = async (iterable) => {
  const values = []
  for await (const value of iterable) values.push(value)
  return values
}
async function expectAbort(promise, reason) {
  const result = await bounded(observe(promise))
  assert.equal(result.ok, false, 'pMapIterable observes AbortSignal')
  assert.equal(result.reason, reason, 'Abort rejection preserves reason identity')
}
const listenerCount = (signal) => getEventListeners(signal, 'abort').length

for (const reason of [new Error('obsolete'), { revision: 2 }, 'cancelled', null, 0, false]) {
  test(`pMapIterable observes AbortSignal before first pull (${String(reason)})`, async () => {
    const control = new AbortController(),
      input = source()
    control.abort(reason)
    let mapped = 0
    const iterator = pMapIterable(
      input,
      (value) => {
        mapped++
        return value
      },
      { signal: control.signal, concurrency: 1 }
    )[Symbol.asyncIterator]()
    try {
      await expectAbort(iterator.next(), reason)
      assert.equal(input.stats.acquired, 0)
      assert.equal(input.stats.pulls, 0)
      assert.equal(input.stats.returns, 0)
      assert.equal(mapped, 0)
      assert.deepEqual(await bounded(iterator.next()), { done: true, value: undefined })
      assert.equal(listenerCount(control.signal), 0)
    } finally {
      await iterator.return?.()
    }
  })
}

test('invalid signals synchronously reject without acquiring or pulling input', () => {
  for (const signal of [
    null,
    false,
    0,
    'signal',
    {},
    { aborted: false },
    { aborted: false, addEventListener() {} },
  ]) {
    const input = source()
    assert.throws(() => pMapIterable(input, (value) => value, { signal }), TypeError)
    assert.equal(input.stats.acquired + input.stats.pulls, 0)
  }
})

test('result construction and iterator acquisition are lazy and do not retain listeners', async () => {
  const control = new AbortController(),
    input = source(),
    reason = { beforeConsumption: true }
  let mapped = 0
  const iterable = pMapIterable(
    input,
    (value) => {
      mapped++
      return value
    },
    { signal: control.signal }
  )
  const iterator = iterable[Symbol.asyncIterator]()
  assert.equal(input.stats.acquired + input.stats.pulls + mapped, 0)
  assert.equal(listenerCount(control.signal), 0)
  control.abort(reason)
  try {
    await expectAbort(iterator.next(), reason)
    assert.equal(input.stats.acquired, 0)
  } finally {
    await iterator.return?.()
  }
  assert.equal(listenerCount(control.signal), 0)
})

for (const preserveOrder of [true, false]) {
  for (const phase of ['pull', 'value', 'mapper']) {
    test(`abort interrupts a pending ${phase}, order=${preserveOrder}, and closes without replay`, async () => {
      const control = new AbortController(),
        gate = deferred(),
        reason = { phase, preserveOrder }
      const input = source((index) =>
        index >= 8
          ? { done: true }
          : phase === 'pull'
            ? gate.promise
            : { done: false, value: phase === 'value' ? gate.promise : index }
      )
      let mapped = 0
      const iterator = pMapIterable(
        input,
        (value) => {
          mapped++
          return phase === 'mapper' ? gate.promise : value
        },
        { signal: control.signal, concurrency: 2, backpressure: 3, preserveOrder }
      )[Symbol.asyncIterator]()
      const pending = observe(iterator.next())
      try {
        await until(() => (phase === 'mapper' ? mapped === 2 : input.stats.pulls > 0))
        const pulls = input.stats.pulls,
          calls = mapped
        control.abort(reason)
        const result = await bounded(pending)
        assert.equal(result.ok, false, 'pMapIterable observes AbortSignal')
        assert.equal(result.reason, reason)
        assert.equal(input.stats.returns, 1)
        assert.equal(listenerCount(control.signal), 0)
        gate.reject(Error('late user rejection'))
        await tick()
        await tick()
        assert.equal(input.stats.pulls, pulls)
        assert.equal(mapped, calls)
        assert.equal(input.stats.returns, 1)
        assert.deepEqual(await bounded(iterator.next()), { done: true, value: undefined })
      } finally {
        gate.resolve(phase === 'pull' ? { done: true } : 1)
        await pending
        await bounded(iterator.return?.())
      }
    })
  }

  test(`abort between yielded values drops already-buffered values, order=${preserveOrder}`, async () => {
    const control = new AbortController(),
      reason = { buffered: true },
      input = source()
    const iterator = pMapIterable(input, (value) => value, {
      signal: control.signal,
      concurrency: 2,
      backpressure: 3,
      preserveOrder,
    })[Symbol.asyncIterator]()
    try {
      const first = await bounded(iterator.next())
      assert.equal(first.done, false)
      await tick()
      const pulls = input.stats.pulls
      control.abort(reason)
      await expectAbort(iterator.next(), reason)
      assert.equal(input.stats.pulls, pulls)
      assert.equal(input.stats.returns, 1)
      assert.equal(listenerCount(control.signal), 0)
      assert.equal((await iterator.next()).done, true)
    } finally {
      await iterator.return?.()
    }
  })
}

test('unordered ready results remain available before cancellation of a slower mapper', async () => {
  const control = new AbortController(),
    slow = deferred(),
    reason = { stop: 'ready stream' },
    input = source()
  const iterator = pMapIterable(input, (value) => (value === 0 ? slow.promise : value), {
    signal: control.signal,
    concurrency: 2,
    backpressure: 3,
    preserveOrder: false,
  })[Symbol.asyncIterator]()
  try {
    assert.deepEqual(await bounded(iterator.next()), { value: 1, done: false })
    control.abort(reason)
    await expectAbort(iterator.next(), reason)
    assert.equal(input.stats.returns, 1)
    slow.reject(Error('late slower mapper'))
    await tick()
    await tick()
    assert.equal(listenerCount(control.signal), 0)
  } finally {
    slow.resolve(0)
    await iterator.return?.()
  }
})

test('iterators sharing a signal keep independent cleanup lifetimes', async () => {
  const control = new AbortController(),
    reason = { shared: true },
    input = source()
  const iterable = pMapIterable(input, (value) => value, { signal: control.signal, concurrency: 1 })
  const first = iterable[Symbol.asyncIterator](),
    second = iterable[Symbol.asyncIterator]()
  try {
    assert.equal((await first.next()).value, 0)
    assert.equal((await second.next()).value, 0)
    assert.equal(input.stats.acquired, 2)
    assert.equal(listenerCount(control.signal), 2)
    await first.return()
    assert.equal(input.stats.returns, 1)
    assert.equal(listenerCount(control.signal), 1)
    control.abort(reason)
    await expectAbort(second.next(), reason)
    assert.equal(input.stats.returns, 2)
    assert.equal(listenerCount(control.signal), 0)
  } finally {
    await first.return?.()
    await second.return?.()
  }
})

test('normal exhaustion removes its listener and late abort cannot change a completed iterator', async () => {
  const control = new AbortController(),
    input = source((index) => ({ done: index >= 3, value: index }))
  const iterator = pMapIterable(input, (value) => value * 2, {
    signal: control.signal,
    concurrency: 2,
  })[Symbol.asyncIterator]()
  assert.deepEqual(await collect({ [Symbol.asyncIterator]: () => iterator }), [0, 2, 4])
  assert.equal(input.stats.returns, 0)
  assert.equal(listenerCount(control.signal), 0)
  control.abort(Error('too late'))
  assert.equal((await iterator.next()).done, true)
})

for (const failure of ['mapper', 'input', 'consumer']) {
  test(`${failure} error preserves identity and removes the listener without an abort`, async () => {
    const control = new AbortController(),
      reason = { failure }
    const input = source((index) => {
      if (failure === 'input') throw reason
      return { done: false, value: index }
    })
    const iterator = pMapIterable(
      input,
      (value) => {
        if (failure === 'mapper') throw reason
        return value
      },
      { signal: control.signal, concurrency: 1 }
    )[Symbol.asyncIterator]()
    try {
      const result =
        failure === 'consumer'
          ? (await iterator.next(), observe(iterator.throw(reason)))
          : observe(iterator.next())
      const outcome = await bounded(result)
      assert.equal(outcome.ok, false)
      assert.equal(outcome.reason, reason)
      assert.equal(input.stats.returns, 1)
      assert.equal(listenerCount(control.signal), 0)
    } finally {
      await iterator.return?.()
    }
  })
}

test('consumer break closes once, removes the listener and stops further pulling', async () => {
  const control = new AbortController(),
    input = source()
  for await (const value of pMapIterable(input, (value) => value, {
    signal: control.signal,
    concurrency: 1,
  })) {
    assert.equal(value, 0)
    break
  }
  const pulls = input.stats.pulls
  assert.equal(input.stats.returns, 1)
  assert.equal(listenerCount(control.signal), 0)
  control.abort(Error('after break'))
  await tick()
  assert.equal(input.stats.pulls, pulls)
  assert.equal(input.stats.returns, 1)
})

test('skip and stop preserve ordered values and retire the abort listener', async () => {
  const control = new AbortController(),
    input = source()
  const values = await collect(
    pMapIterable(input, (value) => (value === 1 ? pMapSkip : value === 3 ? pMapStop : value), {
      signal: control.signal,
      concurrency: 1,
    })
  )
  assert.deepEqual(values, [0, 2])
  assert.equal(input.stats.returns, 1)
  assert.equal(listenerCount(control.signal), 0)
})

for (const cleanup of ['throw', 'reject', 'pending']) {
  test(`abort keeps its reason when source return is ${cleanup}`, async () => {
    const control = new AbortController(),
      pending = deferred(),
      closeGate = deferred(),
      reason = { cleanup }
    const input = source(
      () => pending.promise,
      () => {
        if (cleanup === 'throw') throw Error('close failed')
        if (cleanup === 'reject') return Promise.reject(Error('close failed'))
        return closeGate.promise
      }
    )
    const iterator = pMapIterable(input, (value) => value, {
      signal: control.signal,
      concurrency: 1,
    })[Symbol.asyncIterator]()
    const result = observe(iterator.next())
    try {
      await until(() => input.stats.pulls > 0)
      control.abort(reason)
      const outcome = await bounded(result)
      assert.equal(outcome.ok, false, 'pMapIterable observes AbortSignal')
      assert.equal(outcome.reason, reason)
      assert.equal(input.stats.returns, 1)
      assert.equal(listenerCount(control.signal), 0)
      pending.resolve({ done: true })
      if (cleanup === 'pending') closeGate.reject(Error('late close rejection'))
      await tick()
      await tick()
      assert.equal(input.stats.returns, 1)
    } finally {
      pending.resolve({ done: true })
      closeGate.resolve({ done: true })
      await result
      await bounded(iterator.return?.())
    }
  })
}

test('an AbortSignal-compatible cross-realm facade does not require instanceof', async () => {
  const control = new AbortController(),
    input = source(),
    reason = { foreign: true }
  const signal = {
    get aborted() {
      return control.signal.aborted
    },
    get reason() {
      return control.signal.reason
    },
    addEventListener: control.signal.addEventListener.bind(control.signal),
    removeEventListener: control.signal.removeEventListener.bind(control.signal),
  }
  control.abort(reason)
  const iterator = pMapIterable(input, (value) => value, { signal, concurrency: 1 })[
    Symbol.asyncIterator
  ]()
  try {
    await expectAbort(iterator.next(), reason)
    assert.equal(input.stats.acquired, 0)
  } finally {
    await iterator.return?.()
  }
})
