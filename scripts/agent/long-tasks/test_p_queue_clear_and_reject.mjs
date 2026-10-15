// 以公开可观察行为核对停队承诺；不依赖被测实现的私有数据结构。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { getEventListeners } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const PQueue = (await import(pathToFileURL(resolve('dist/index.js')).href)).default
const feature = () =>
  assert.equal(typeof PQueue.prototype.clearAndReject, 'function', 'exports clearAndReject')
const outcome = (p) =>
  p.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason })
  )
const deferred = () => {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}
async function within(promise) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('queued promise or waiter did not settle')), 1000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
function paused(options = {}) {
  feature()
  return new PQueue({ autoStart: false, ...options })
}
function checkReason(result, reason) {
  assert.equal(result.status, 'rejected')
  assert.equal(result.reason, reason)
}

test('exports clearAndReject', feature)
for (const [label, reason] of [
  ['object', { why: 'shutdown' }],
  ['null', null],
  ['false', false],
  ['zero', 0],
  ['string', 'stop'],
  ['symbol', Symbol('stop')],
]) {
  test(`rejects every queued promise with exact ${label} reason`, async () => {
    const q = paused()
    let runs = 0
    const promises = [
      outcome(q.add(() => ++runs, { id: 'same' })),
      outcome(q.add(() => ++runs, { id: 'same' })),
      outcome(q.add(() => ++runs)),
    ]
    assert.equal(q.clearAndReject(reason), 3)
    assert.equal(q.size, 0)
    assert.equal(q.pending, 0)
    for (const result of await within(Promise.all(promises))) checkReason(result, reason)
    q.start()
    await q.onIdle()
    assert.equal(runs, 0)
    assert.equal(q.clearAndReject(reason), 0)
  })
}
for (const explicit of [false, true])
  test(`default error is shared per call (${explicit ? 'undefined' : 'omitted'})`, async () => {
    const q = paused()
    const a = outcome(q.add(() => 1))
    const b = outcome(q.add(() => 2))
    assert.equal(explicit ? q.clearAndReject(undefined) : q.clearAndReject(), 2)
    const [x, y] = await within(Promise.all([a, b]))
    assert.equal(x.status, 'rejected')
    assert(x.reason instanceof Error)
    assert(x.reason.message.length > 0)
    assert.equal(x.reason, y.reason)
    const c = outcome(q.add(() => 3))
    q.clearAndReject()
    const z = await within(c)
    assert.notEqual(z.reason, x.reason)
  })

test('running work and idle waiters finish normally after waiting work rejects', async (t) => {
  feature()
  const q = new PQueue({ concurrency: 1 })
  const gate = deferred()
  t.after(() => gate.resolve(42))
  const running = q.add(() => gate.promise, { id: 'running' })
  let ran = false
  const waiting = outcome(
    q.add(
      () => {
        ran = true
        return 7
      },
      { id: 'waiting' }
    )
  )
  const empty = q.onEmpty()
  const size = q.onSizeLessThan(1)
  let idle = false
  const idlePromise = q.onIdle().then(() => {
    idle = true
  })
  const before = q.runningTasks
  const reason = new Error('shutdown')
  assert.equal(q.clearAndReject(reason), 1)
  assert.equal(q.size, 0)
  assert.equal(q.pending, 1)
  assert.deepEqual(q.runningTasks, before)
  await within(Promise.all([empty, size]))
  await Promise.resolve()
  assert.equal(idle, false)
  checkReason(await within(waiting), reason)
  gate.resolve(42)
  assert.equal(await within(running), 42)
  await within(idlePromise)
  assert.equal(ran, false)
  assert.equal(q.pending, 0)
})

test('queue cleanup removes only waiting AbortSignal listeners', async (t) => {
  feature()
  const q = new PQueue({ concurrency: 1 })
  const gate = deferred()
  t.after(() => gate.resolve(9))
  const activeController = new AbortController()
  const waitingController = new AbortController()
  const active = q.add(() => gate.promise, { signal: activeController.signal })
  const waiting = outcome(q.add(() => 5, { signal: waitingController.signal }))
  assert.equal(getEventListeners(waitingController.signal, 'abort').length, 1)
  const activeCount = getEventListeners(activeController.signal, 'abort').length
  const reason = { stop: true }
  q.clearAndReject(reason)
  assert.equal(getEventListeners(waitingController.signal, 'abort').length, 0)
  assert.equal(getEventListeners(activeController.signal, 'abort').length, activeCount)
  let events = 0
  for (const name of ['next', 'active', 'error', 'completed']) q.on(name, () => events++)
  waitingController.abort(new Error('later'))
  await Promise.resolve()
  assert.equal(events, 0)
  assert.equal(q.pending, 1)
  checkReason(await within(waiting), reason)
  gate.resolve(9)
  assert.equal(await within(active), 9)
  await q.onIdle()
})

test('paused state, concurrency, waiter and clear notification semantics remain', async () => {
  const q = paused({ concurrency: 3 })
  const events = []
  for (const name of ['empty', 'idle', 'next', 'active', 'completed', 'error'])
    q.on(name, () => events.push(name))
  const p = outcome(q.add(() => 1))
  const waiters = [q.onEmpty(), q.onSizeLessThan(1), q.onIdle()]
  assert.equal(q.clearAndReject('stop'), 1)
  assert.equal(q.isPaused, true)
  assert.equal(q.concurrency, 3)
  await within(Promise.all(waiters))
  checkReason(await within(p), 'stop')
  for (const name of ['empty', 'idle', 'next']) assert(events.includes(name))
  for (const name of ['active', 'completed', 'error']) assert(!events.includes(name))
  let ran = false
  const fresh = q.add(() => {
    ran = true
    return 4
  })
  await Promise.resolve()
  assert.equal(ran, false)
  q.start()
  assert.equal(await within(fresh), 4)
})

test('queued aborted promises are not counted a second time', async () => {
  const q = paused()
  const controller = new AbortController()
  const a = outcome(q.add(() => 1, { signal: controller.signal }))
  const b = outcome(q.add(() => 2))
  const aborted = { aborted: true }
  controller.abort(aborted)
  checkReason(await within(a), aborted)
  assert.equal(q.clearAndReject('shutdown'), 1)
  checkReason(await within(b), 'shutdown')
  assert.equal(q.size, 0)
})

class FIFO {
  items = []
  get size() {
    return this.items.length
  }
  enqueue(run, options) {
    this.items.push({ run, options })
  }
  dequeue() {
    return this.items.shift()?.run
  }
  filter() {
    return this.items.map((item) => item.run)
  }
  setPriority() {}
}

test('custom queues without remove retain no unresolved live work after shutdown', async () => {
  const q = paused({ queueClass: FIFO })
  const controller = new AbortController()
  let runs = 0
  const first = outcome(q.add(() => ++runs, { signal: controller.signal, id: 'dup' }))
  const second = outcome(q.add(() => ++runs, { id: 'dup' }))
  const third = outcome(q.add(() => ++runs))
  controller.abort('aborted')
  checkReason(await within(first), 'aborted')
  assert.equal(q.size, 3)
  assert.equal(q.clearAndReject('clear'), 2)
  assert.equal(q.size, 0)
  for (const result of await within(Promise.all([second, third]))) checkReason(result, 'clear')
  q.start()
  const fresh = q.add(() => ++runs)
  assert.equal(await within(fresh), 1)
  await q.onIdle()
})

test('legacy clear keeps its discarded promises pending across later shutdown', async () => {
  const q = paused()
  const controller = new AbortController()
  let oldSettled = false
  q.add(() => 1, { signal: controller.signal }).then(
    () => {
      oldSettled = true
    },
    () => {
      oldSettled = true
    }
  )
  q.clear()
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  const fresh = outcome(q.add(() => 2))
  assert.equal(q.clearAndReject('new'), 1)
  checkReason(await within(fresh), 'new')
  controller.abort('late')
  await delay(15)
  assert.equal(oldSettled, false)
  assert.equal(q.clearAndReject(), 0)
})

test('reentrant additions from empty notification survive original-set rejection', async () => {
  const q = paused()
  const original = [outcome(q.add(() => 1)), outcome(q.add(() => 2))]
  let fresh
  q.once('empty', () => {
    fresh = q.add(() => 3)
  })
  assert.equal(q.clearAndReject('original'), 2)
  assert.equal(q.size, 1)
  for (const result of await within(Promise.all(original))) checkReason(result, 'original')
  q.start()
  assert.equal(await within(fresh), 3)
  await q.onIdle()
})

test('priority, task IDs and addAll remain usable after shutdown', async () => {
  const q = paused()
  const cancelled = outcome(q.add(() => 0))
  q.clearAndReject('old')
  await within(cancelled)
  const order = []
  const low = q.add(
    () => {
      order.push('low')
      return 1
    },
    { id: 'low', priority: 0 }
  )
  const high = q.add(
    () => {
      order.push('high')
      return 2
    },
    { id: 'high', priority: 2 }
  )
  q.setPriority('low', 3)
  q.start()
  assert.deepEqual(await within(Promise.all([low, high])), [1, 2])
  assert.deepEqual(order, ['low', 'high'])
  assert.deepEqual(await within(q.addAll([() => 3, () => 4])), [3, 4])
  q.pause()
  const batch = outcome(q.addAll([() => 5, () => 6]))
  assert.equal(q.clearAndReject('batch'), 2)
  checkReason(await within(batch), 'batch')
})

test('running rejection and later queued abort retain their own reasons', async (t) => {
  feature()
  const q = new PQueue({ concurrency: 1 })
  const controller = new AbortController()
  const gate = deferred()
  t.after(() => gate.resolve())
  const active = outcome(q.add(() => gate.promise, { signal: controller.signal }))
  const queued = outcome(q.add(() => 2))
  q.clearAndReject('queue')
  checkReason(await within(queued), 'queue')
  const activeReason = new Error('running')
  controller.abort(activeReason)
  checkReason(await within(active), activeReason)
  await q.onIdle()
  q.pause()
  const later = new AbortController()
  const fresh = outcome(q.add(() => 3, { signal: later.signal }))
  later.abort('later')
  checkReason(await within(fresh), 'later')
  assert.equal(q.clearAndReject(), 0)
})

test('strict rate history survives clearing and still delays fresh work', async () => {
  feature()
  const q = new PQueue({ strict: true, interval: 160, intervalCap: 1 })
  const started = performance.now()
  await q.add(() => 0)
  const waiting = outcome(q.add(() => 1))
  assert.equal(q.clearAndReject('clear'), 1)
  checkReason(await within(waiting), 'clear')
  await within(q.add(() => 2))
  assert(performance.now() - started >= 130, 'clearing must not reset strict rate history')
  await q.onIdle()
})

test('normal TypeScript build declares the API with unknown reason and number result', async () => {
  feature()
  const root = await mkdtemp(resolve('.shutdown-typecheck-'))
  try {
    const file = join(root, 'consumer.mts')
    await writeFile(
      file,
      "import PQueue from '../dist/index.js';\nconst q = new PQueue();\nconst reason: unknown = { stop: true };\nconst a: number = q.clearAndReject(reason);\nconst b: number = q.clearAndReject();\nvoid [a,b];\n"
    )
    execFileSync(
      process.execPath,
      [
        resolve('node_modules/typescript/bin/tsc'),
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--module',
        'nodenext',
        '--target',
        'es2022',
        file,
      ],
      { cwd: process.cwd(), timeout: 20000, stdio: 'pipe' }
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('offline zero-argument example executes current built code', async () => {
  feature()
  const example = resolve('examples/clear-and-reject.mjs')
  assert((await readFile(example, 'utf8')).length > 0)
  execFileSync(process.execPath, [example], { cwd: process.cwd(), timeout: 10000, stdio: 'pipe' })
})
