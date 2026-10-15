import assert from 'node:assert/strict'
import { createHook } from 'node:async_hooks'
import { spawnSync } from 'node:child_process'
import { getEventListeners } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'

const root = resolve(process.argv[2] ?? process.cwd())
const require = createRequire(join(root, 'package.json'))
const EventEmitter = require(join(root, 'index.js'))
const esm = await import(pathToFileURL(join(root, 'index.mjs')))
const nativeSetTimeout = globalThis.setTimeout
const nativeClearTimeout = globalThis.clearTimeout
async function bounded(promise) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = nativeSetTimeout(() => reject(new Error('wait did not settle')), 1500)
      }),
    ])
  } finally {
    nativeClearTimeout(timer)
  }
}
function wait(emitter, event, options) {
  let value
  assert.doesNotThrow(() => {
    value = emitter.waitFor(event, options)
  }, 'waitFor must return a rejected Promise for invalid input')
  assert(value instanceof Promise)
  return value
}
function observedSignal(controller) {
  const signal = controller.signal
  const add = signal.addEventListener.bind(signal)
  let additions = 0
  signal.addEventListener = (type, listener, options) => {
    if (type === 'abort') additions++
    return add(type, listener, options)
  }
  return {
    signal,
    get active() {
      return new Set(getEventListeners(signal, 'abort'))
    },
    get additions() {
      return additions
    },
  }
}
async function withObservedTimers(run) {
  const timers = new Map()
  const hook = createHook({
    init(id, type, _, resource) {
      if (type === 'Timeout') timers.set(id, resource)
    },
    destroy(id) {
      timers.delete(id)
    },
  })
  hook.enable()
  try {
    const result = await run(timers)
    // Native timer destruction is reported asynchronously, including a timer
    // captured by the implementation before this observer was installed.
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(timers.size, 0, 'settled waits must not retain pending timers')
    return result
  } finally {
    hook.disable()
    for (const timer of timers.values()) nativeClearTimeout(timer)
  }
}

test('waitFor exists on both public entrypoints', () => {
  assert.equal(typeof EventEmitter.prototype.waitFor, 'function')
  assert.equal(esm.default, EventEmitter)
  assert.equal(esm.EventEmitter, EventEmitter)
})
test('synchronous emission preserves all arguments, symbols and ordinary special names', async () => {
  for (const event of ['', '__proto__', 'error', Symbol('ready')]) {
    const emitter = new EventEmitter(),
      object = { event }
    const promise = wait(emitter, event)
    assert.equal(emitter.listenerCount(event), 1)
    emitter.emit(event, object, undefined, null, 0, false)
    const result = await bounded(promise)
    assert.deepEqual(result, [object, undefined, null, 0, false])
    assert.equal(result[0], object)
    assert.equal(emitter.listenerCount(event), 0)
  }
})
test('concurrent waits produce fresh arrays and leave unrelated listeners intact', async () => {
  const emitter = new EventEmitter(),
    seen = []
  emitter.on('ready', (value) => seen.push(value))
  const first = wait(emitter, 'ready'),
    second = wait(emitter, 'ready')
  emitter.emit('ready', 1)
  emitter.emit('ready', 2)
  const [a, b] = await bounded(Promise.all([first, second]))
  assert.deepEqual(a, [1])
  assert.deepEqual(b, [1])
  assert.notEqual(a, b)
  assert.deepEqual(seen, [1, 2])
  assert.equal(emitter.listenerCount('ready'), 1)
})
test('invalid events and options reject instead of synchronously throwing or registering', async () => {
  for (const event of [null, undefined, 1, {}, [], false]) {
    const emitter = new EventEmitter()
    await assert.rejects(bounded(wait(emitter, event)), TypeError)
    assert.deepEqual(emitter.eventNames(), [])
  }
  for (const options of [
    null,
    [],
    false,
    1,
    'x',
    () => {},
    { unknown: 1 },
    { timeout: -1 },
    { timeout: 0.5 },
    { timeout: '1' },
    { timeout: NaN },
    { timeout: Infinity },
    { timeout: 2147483648 },
    { signal: null },
    { signal: {} },
    { signal: { aborted: true } },
  ]) {
    const emitter = new EventEmitter()
    await assert.rejects(bounded(wait(emitter, 'ready', options)), TypeError)
    assert.equal(emitter.listenerCount('ready'), 0)
  }
})
test('event validation precedes reading options and null-prototype options are accepted', async () => {
  const emitter = new EventEmitter()
  const options = {
    get signal() {
      throw new Error('options read before event validation')
    },
  }
  await assert.rejects(bounded(wait(emitter, 0, options)), TypeError)
  const p = wait(
    emitter,
    'ready',
    Object.assign(Object.create(null), { timeout: undefined, signal: undefined })
  )
  emitter.emit('ready')
  assert.deepEqual(await bounded(p), [])
})
test('unknown own option keys are rejected regardless of enumerability or symbol identity', async () => {
  for (const key of ['unexpected', Symbol('unexpected')]) {
    for (const enumerable of [false, true]) {
      const options = Object.defineProperty({}, key, { value: true, enumerable })
      const emitter = new EventEmitter()
      const promise = wait(emitter, 'ready', options)
      emitter.emit('ready', 1)
      await assert.rejects(bounded(promise), TypeError)
      assert.equal(emitter.listenerCount('ready'), 0)
    }
  }
})
test('an already-aborted signal preserves reason without allocating listeners or timers', async () => {
  for (const reason of [null, { cancelled: true }]) {
    const controller = new AbortController()
    controller.abort(reason)
    const observed = observedSignal(controller),
      emitter = new EventEmitter()
    await withObservedTimers(async (timers) => {
      const promise = wait(emitter, 'ready', { signal: observed.signal, timeout: 50 })
      assert.equal(timers.size, 0)
      const error = await bounded(promise).then(
        () => assert.fail('resolved aborted wait'),
        (error) => error
      )
      assert.equal(error, reason)
      assert.equal(observed.additions, 0)
      assert.equal(emitter.listenerCount('ready'), 0)
    })
  }
})
test('active cancellation removes only its own event and abort listener and timer', async () => {
  const emitter = new EventEmitter(),
    controller = new AbortController(),
    reason = { cancel: true }
  const observed = observedSignal(controller),
    original = () => {}
  emitter.on('ready', original)
  await withObservedTimers(async () => {
    const promise = wait(emitter, 'ready', { signal: observed.signal, timeout: 50 })
    const result = promise.catch((error) => error)
    assert.equal(observed.active.size, 1)
    controller.abort(reason)
    assert.equal(await bounded(result), reason)
    assert.deepEqual(emitter.listeners('ready'), [original])
    assert.equal(observed.active.size, 0)
  })
})
test('success clears cancellation and every pending timeout including the largest valid timeout', async () => {
  for (const timeout of [0, 5, 2147483647]) {
    const emitter = new EventEmitter(),
      observed = observedSignal(new AbortController())
    await withObservedTimers(async () => {
      const promise = wait(emitter, 'ready', { signal: observed.signal, timeout })
      emitter.emit('ready', timeout)
      assert.deepEqual(await bounded(promise), [timeout])
      assert.equal(observed.active.size, 0)
      assert.equal(emitter.listenerCount('ready'), 0)
    })
  }
})
test('timeout rejects with the documented code and removes both listener kinds', async () => {
  const emitter = new EventEmitter(),
    observed = observedSignal(new AbortController())
  await withObservedTimers(async () => {
    const promise = wait(emitter, 'ready', { signal: observed.signal, timeout: 7 })
    const result = promise.catch((error) => error)
    const error = await bounded(result)
    assert(error instanceof Error)
    assert.equal(error.code, 'ERR_EVENTEMITTER_TIMEOUT')
    assert(error.message)
    assert.equal(emitter.listenerCount('ready'), 0)
    assert.equal(observed.active.size, 0)
  })
})
test('real zero timeout runs after synchronous emit and actually expires an unfulfilled wait', async () => {
  const emitter = new EventEmitter(),
    first = wait(emitter, 'ready', { timeout: 0 })
  emitter.emit('ready', 42)
  assert.deepEqual(await bounded(first), [42])
  await assert.rejects(
    bounded(wait(emitter, 'later', { timeout: 0 })),
    (error) => error.code === 'ERR_EVENTEMITTER_TIMEOUT'
  )
  assert.equal(emitter.listenerCount('later'), 0)
})
test('cancelling one of two waits does not cancel or remove the other wait', async () => {
  const emitter = new EventEmitter(),
    controller = new AbortController(),
    reason = { first: true }
  const first = wait(emitter, 'ready', { signal: controller.signal }).catch((error) => error)
  const second = wait(emitter, 'ready')
  controller.abort(reason)
  assert.equal(await bounded(first), reason)
  assert.equal(emitter.listenerCount('ready'), 1)
  emitter.emit('ready', 8)
  assert.deepEqual(await bounded(second), [8])
  assert.equal(emitter.listenerCount('ready'), 0)
})
test('an AbortSignal-compatible object does not require a DOM or Node signal class', async () => {
  const listeners = new Map()
  const signal = {
    aborted: false,
    reason: { structural: true },
    addEventListener(type, listener, options) {
      assert.equal(type, 'abort')
      listeners.set(listener, options?.once === true)
    },
    removeEventListener(type, listener) {
      assert.equal(type, 'abort')
      listeners.delete(listener)
    },
  }
  const emitter = new EventEmitter()
  const promise = wait(emitter, 'ready', { signal }).catch((error) => error)
  assert.equal(listeners.size, 1)
  signal.aborted = true
  for (const [listener, once] of [...listeners]) {
    if (once) listeners.delete(listener)
    listener()
  }
  assert.equal(await bounded(promise), signal.reason)
  assert.equal(listeners.size, 0)
  assert.equal(emitter.listenerCount('ready'), 0)
})
test('public declarations infer tuple and function arguments without DOM dependencies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eventemitter3-types-'))
  try {
    const entry = join(directory, 'check.ts')
    const source = `import EventEmitter from ${JSON.stringify(join(root, 'index'))};\nconst emitter = new EventEmitter<{ready: [number, string]; empty: []; error: (error: Error) => void}>();\nconst a: Promise<[number, string]> = emitter.waitFor('ready');\nconst b: Promise<[]> = emitter.waitFor('empty');\nconst c: Promise<[Error]> = emitter.waitFor('error');\nconst options: EventEmitter.WaitForOptions = {timeout: 1};\nemitter.waitFor('ready', options);\n// @ts-expect-error unknown event\nemitter.waitFor('missing');\n// @ts-expect-error wrong tuple\nconst wrong: Promise<[string]> = emitter.waitFor('ready');\nvoid [a, b, c, wrong];\n`
    await writeFile(entry, source)
    for (const dom of [false, true]) {
      if (dom)
        await writeFile(
          entry,
          source + "emitter.waitFor('ready', {signal: new AbortController().signal});\n"
        )
      const result = spawnSync(
        process.execPath,
        [
          join(root, 'node_modules/typescript/bin/tsc'),
          '--noEmit',
          '--strict',
          '--target',
          'ES2020',
          '--module',
          'commonjs',
          '--lib',
          dom ? 'ES2020,DOM' : 'ES2020',
          entry,
        ],
        { cwd: directory, encoding: 'utf8', timeout: 20000 }
      )
      assert.equal(result.status, 0, result.stdout + result.stderr)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
test('normal and minified UMD bundles work with dynamic code generation disabled', async () => {
  for (const name of ['eventemitter3.umd.js', 'eventemitter3.umd.min.js']) {
    const context = vm.createContext(
      { setTimeout: nativeSetTimeout, clearTimeout: nativeClearTimeout, AbortController },
      { codeGeneration: { strings: false, wasm: false } }
    )
    vm.runInContext(await readFile(join(root, 'dist', name), 'utf8'), context, {
      filename: name,
      timeout: 1000,
    })
    const emitter = new context.EventEmitter3(),
      promise = emitter.waitFor('ready', vm.runInContext('({timeout:100})', context))
    emitter.emit('ready', 3, 'x')
    assert.deepEqual(Array.from(await bounded(promise)), [3, 'x'])
  }
})
