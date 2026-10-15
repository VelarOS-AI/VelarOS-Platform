// 独立验证逐项排队取消的公开行为；不读取被测实现或修改原测试。
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawnSync } from 'node:child_process'
import { getEventListeners } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const { default: pLimit, limitFunction } = await import(pathToFileURL(resolve('index.js')))
const tick = () => new Promise((done) => setImmediate(done))
const gate = () => {
  let release
  const promise = new Promise((resolve) => {
    release = resolve
  })
  return { promise, release }
}
const observe = (promise) =>
  promise.then(
    (value) => ({ ok: true, value }),
    (reason) => ({ ok: false, reason })
  )
const bounded = async (promise) => {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('queued operation did not settle')), 2000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
const feature = (options = 1) => {
  const limit = pLimit(options)
  assert.equal(typeof limit.withSignal, 'function', 'exports per-call queued cancellation')
  return limit
}

test('exports per-call queued cancellation', () => {
  feature()
})

test('pre-aborted calls preserve arbitrary reason identity without queue side effects', async () => {
  for (const reason of [new Error('stop'), { obsolete: 1 }, 'superseded', null, 0]) {
    const limit = feature(),
      control = new AbortController()
    control.abort(reason)
    let invoked = false
    const answer = await bounded(
      observe(
        limit.withSignal(control.signal, () => {
          invoked = true
        })
      )
    )
    assert.equal(answer.ok, false)
    assert.equal(answer.reason, reason)
    assert.equal(invoked, false)
    assert.equal(limit.activeCount, 0)
    assert.equal(limit.pendingCount, 0)
  }
})

test('same-turn abort prevents invocation after a slot has been reserved', async () => {
  const limit = feature(),
    control = new AbortController(),
    reason = { version: 2 }
  let invoked = false
  const cancelled = observe(
    limit.withSignal(control.signal, () => {
      invoked = true
    })
  )
  control.abort(reason)
  const successor = limit(() => 42)
  assert.deepEqual(await bounded(cancelled), { ok: false, reason })
  assert.equal(await bounded(successor), 42)
  await tick()
  assert.equal(invoked, false)
  assert.equal(limit.activeCount, 0)
  assert.equal(limit.pendingCount, 0)
})

test('cancellation remains effective in every deferred stage before actual invocation', async () => {
  const limit = feature(),
    control = new AbortController(),
    reason = { phase: 'microtask' }
  let invoked = false,
    abortedBeforeInvocation = false
  const pending = observe(
    limit.withSignal(control.signal, () => {
      invoked = true
      return 17
    })
  )
  queueMicrotask(() => {
    if (!invoked) {
      abortedBeforeInvocation = true
      control.abort(reason)
    }
  })
  const answer = await bounded(pending)
  if (abortedBeforeInvocation) {
    assert.equal(invoked, false)
    assert.deepEqual(answer, { ok: false, reason })
  } else assert.deepEqual(answer, { ok: true, value: 17 })
})

test('invalid signal or function rejects before queue mutation', async () => {
  const limit = feature()
  for (const signal of [undefined, null, {}, false, { aborted: false }]) {
    await assert.rejects(
      limit.withSignal(signal, () => 1),
      TypeError
    )
    assert.equal(limit.activeCount + limit.pendingCount, 0)
  }
  for (const fn of [undefined, null, 4, {}]) {
    await assert.rejects(limit.withSignal(new AbortController().signal, fn), TypeError)
    assert.equal(limit.activeCount + limit.pendingCount, 0)
  }
})

test('middle and head cancellations update pending count and retain survivor FIFO order', async () => {
  const limit = feature(),
    blocker = gate(),
    order = []
  const running = limit(() => blocker.promise)
  await tick()
  const controls = Array.from({ length: 7 }, () => new AbortController())
  const results = controls.map((control, i) =>
    observe(
      limit.withSignal(control.signal, () => {
        order.push(i)
        return i
      })
    )
  )
  assert.equal(limit.pendingCount, 7)
  for (const index of [3, 0, 6]) controls[index].abort(index)
  await tick()
  assert.equal(limit.pendingCount, 4)
  assert.equal(limit.activeCount, 1)
  blocker.release()
  await bounded(Promise.all([running, ...results]))
  assert.deepEqual(order, [1, 2, 4, 5])
  for (const index of [3, 0, 6])
    assert.deepEqual(await results[index], { ok: false, reason: index })
  assert.equal(limit.pendingCount, 0)
})

test('after-start abort keeps the running result and original argument tuple', async () => {
  const limit = feature(),
    control = new AbortController(),
    entered = gate(),
    finish = gate()
  const args = [{ id: 1 }, 'second', 7]
  let received
  const result = limit.withSignal(
    control.signal,
    (...values) => {
      received = values
      entered.release()
      return finish.promise
    },
    ...args
  )
  await entered.promise
  assert.equal(getEventListeners(control.signal, 'abort').length, 0)
  control.abort(new Error('too late'))
  assert.equal(limit.activeCount, 1)
  finish.release('committed')
  assert.equal(await bounded(result), 'committed')
  assert.deepEqual(received, args)
})

test('after-start rejection wins over a later abort', async () => {
  const limit = feature(),
    control = new AbortController(),
    entered = gate()
  let reject
  const failure = new Error('job failure')
  const result = observe(
    limit.withSignal(control.signal, () => {
      entered.release()
      return new Promise((_, fail) => {
        reject = fail
      })
    })
  )
  await entered.promise
  control.abort('late')
  reject(failure)
  assert.deepEqual(await bounded(result), { ok: false, reason: failure })
  assert.equal(await bounded(limit(() => 'next')), 'next')
})

test('dynamic concurrency interleaves ordinary jobs and cancelled jobs without oversubscription', async () => {
  const limit = feature(),
    blocker = gate(),
    order = []
  let active = 0,
    peak = 0
  const first = limit(() => blocker.promise)
  await tick()
  const controls = Array.from({ length: 18 }, () => new AbortController())
  const jobs = controls.map((control, i) => {
    const fn = async () => {
      order.push(i)
      peak = Math.max(peak, ++active)
      await tick()
      active--
      return i
    }
    return observe(i % 2 ? limit(fn) : limit.withSignal(control.signal, fn))
  })
  for (const i of [2, 8, 14]) controls[i].abort(i)
  limit.concurrency = 3
  blocker.release()
  await bounded(Promise.all([first, ...jobs]))
  assert.deepEqual(
    order,
    Array.from({ length: 18 }, (_, i) => i).filter((i) => ![2, 8, 14].includes(i))
  )
  assert(peak <= 3)
  await tick()
  assert.equal(limit.activeCount + limit.pendingCount, 0)
})

test('sync throws and rejected thenables release capacity exactly once', async () => {
  const limit = feature(),
    signal = new AbortController().signal
  const failure = new Error('sync')
  const bad = observe(
    limit.withSignal(signal, () => {
      throw failure
    })
  )
  const thenable = observe(
    limit.withSignal(signal, () => ({
      then(_resolve, reject) {
        reject('thenable')
      },
    }))
  )
  const good = limit.withSignal(signal, (value) => value, 23)
  assert.deepEqual(await bounded(bad), { ok: false, reason: failure })
  assert.deepEqual(await bounded(thenable), { ok: false, reason: 'thenable' })
  assert.equal(await bounded(good), 23)
  await tick()
  assert.equal(limit.activeCount, 0)
})

test('reentrant scheduling joins the shared queue', async () => {
  const limit = feature(),
    signal = new AbortController().signal,
    order = []
  let nested
  const first = limit.withSignal(signal, () => {
    order.push(1)
    nested = limit.withSignal(signal, () => {
      order.push(3)
      return 3
    })
    return 1
  })
  const second = limit(() => {
    order.push(2)
    return 2
  })
  await bounded(Promise.all([first, second]))
  assert.equal(await bounded(nested), 3)
  assert.deepEqual(order, [1, 2, 3])
})

test('AsyncLocalStorage belongs to each submitter across queue and cancellation', async () => {
  const storage = new AsyncLocalStorage(),
    limit = feature(),
    blocker = gate()
  const first = limit(() => blocker.promise)
  await tick()
  const cancel = new AbortController()
  const results = ['alice', 'bob', 'carol'].map((name) =>
    storage.run(name, () =>
      observe(
        limit.withSignal(
          name === 'bob' ? cancel.signal : new AbortController().signal,
          async () => {
            const before = storage.getStore()
            await tick()
            return [before, storage.getStore()]
          }
        )
      )
    )
  )
  cancel.abort('obsolete')
  blocker.release()
  await bounded(first)
  assert.deepEqual(await bounded(Promise.all(results)), [
    { ok: true, value: ['alice', 'alice'] },
    { ok: false, reason: 'obsolete' },
    { ok: true, value: ['carol', 'carol'] },
  ])
})

test('clearQueue with rejection discards both call kinds and detaches listeners', async () => {
  const limit = feature({ concurrency: 1, rejectOnClear: true }),
    blocker = gate()
  const active = limit(() => blocker.promise)
  await tick()
  const control = new AbortController()
  let ran = false
  const pending = [
    observe(
      limit.withSignal(control.signal, () => {
        ran = true
      })
    ),
    observe(
      limit(() => {
        ran = true
      })
    ),
  ]
  limit.clearQueue()
  assert.equal(limit.pendingCount, 0)
  assert.equal(getEventListeners(control.signal, 'abort').length, 0)
  control.abort('after clear')
  for (const result of await bounded(Promise.all(pending))) {
    assert.equal(result.ok, false)
    assert.equal(result.reason.name, 'AbortError')
  }
  blocker.release()
  await bounded(active)
  assert.equal(await bounded(limit(() => 5)), 5)
  assert.equal(ran, false)
})

test('default clearQueue leaves discarded promises pending even after their signals abort', async () => {
  const limit = feature(),
    blocker = gate(),
    control = new AbortController()
  const active = limit(() => blocker.promise)
  await tick()
  let settled = false,
    invoked = false
  const discarded = observe(
    limit.withSignal(control.signal, () => {
      invoked = true
    })
  )
  discarded.then(() => {
    settled = true
  })
  limit.clearQueue()
  assert.equal(getEventListeners(control.signal, 'abort').length, 0)
  control.abort('after clear')
  blocker.release()
  await bounded(active)
  await new Promise((done) => setTimeout(done, 30))
  assert.equal(settled, false)
  assert.equal(invoked, false)
  assert.equal(await bounded(limit(() => 6)), 6)
})

test('aborting queued jobs detaches their listeners', async () => {
  const limit = feature(),
    blocker = gate(),
    control = new AbortController()
  const active = limit(() => blocker.promise)
  await tick()
  const pending = observe(limit.withSignal(control.signal, () => 9))
  control.abort('withdrawn')
  await bounded(pending)
  assert.equal(getEventListeners(control.signal, 'abort').length, 0)
  blocker.release()
  await bounded(active)
})

test('map and limitFunction retain their original result behavior', async () => {
  const limit = feature(2)
  assert.deepEqual(await limit.map([3, 5, 8], (value, index) => value + index), [3, 6, 10])
  const fn = limitFunction(async (a, b) => a + b, { concurrency: 2 })
  assert.deepEqual(await Promise.all([fn(2, 3), fn(4, 5)]), [5, 9])
})

test('public types infer tuples and awaited return values and reject invalid calls', async () => {
  feature()
  const require = createRequire(resolve('package.json'))
  const ts = require('@tsd/typescript')
  const directory = await mkdtemp(resolve('.queued-abort-types-'))
  try {
    const file = join(directory, 'consumer.mts')
    await writeFile(
      file,
      `import pLimit from '../index.js';
const limit = pLimit(2);
const signal = new AbortController().signal;
const a: Promise<string> = limit.withSignal(signal, (name: string, n: number) => name.repeat(n), 'x', 2);
const b: Promise<number> = limit.withSignal(signal, async (n: number) => n + 1, 4);
const c: Promise<boolean> = limit.withSignal(signal, () => true);
// @ts-expect-error signal is required
limit.withSignal(null, () => 1);
// @ts-expect-error argument tuple must match
limit.withSignal(signal, (n: number) => n, 'wrong');
// @ts-expect-error function is required
limit.withSignal(signal, 4);
void [a, b, c];
`
    )
    const program = ts.createProgram([file], {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    })
    assert.deepEqual(
      ts
        .getPreEmitDiagnostics(program)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
      []
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('original public declaration tests remain compatible', () => {
  feature()
  const result = spawnSync(process.execPath, ['node_modules/tsd/dist/cli.js'], {
    cwd: process.cwd(),
    timeout: 20000,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('README documents the API and the offline example executes', async () => {
  feature()
  const readme = await readFile(resolve('readme.md'), 'utf8')
  assert.match(readme, /withSignal/u)
  const result = spawnSync(process.execPath, ['examples/queued-abort.js'], {
    cwd: process.cwd(),
    timeout: 10000,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
})
