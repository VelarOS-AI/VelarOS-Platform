// 冻结公开行为验收：监听顺序、发射快照、重入和现有入口兼容。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

const require = createRequire(join(process.cwd(), 'package.json'))
const EventEmitter = require(join(process.cwd(), 'index.js'))

test('prependListener is a chainable public method with reverse insertion order', () => {
  class Child extends EventEmitter {}
  const ee = new Child()
  const seen = []
  const last = () => seen.push('last')
  const first = () => seen.push('first')
  const middle = () => seen.push('middle')
  assert.equal(ee.prependListener('x', last), ee)
  assert.equal(ee.prependListener('x', middle), ee)
  assert.equal(ee.prependListener('x', first), ee)
  assert.deepEqual(ee.listeners('x'), [first, middle, last])
  ee.emit('x')
  assert.deepEqual(seen, ['first', 'middle', 'last'])
})

test('existing append methods keep their order and all listener arguments', () => {
  const ee = new EventEmitter()
  const seen = []
  ee.on('x', (...args) => seen.push(['on', ...args]))
  ee.once('x', (...args) => seen.push(['once', ...args]))
  ee.prependListener('x', (...args) => seen.push(['prepend', ...args]))
  ee.addListener('x', (...args) => seen.push(['add', ...args]))
  const values = [0, false, null, undefined, Symbol('value'), {}, 7]
  assert.equal(ee.emit('x', ...values), true)
  assert.deepEqual(
    seen,
    ['prepend', 'on', 'once', 'add'].map((name) => [name, ...values])
  )
  assert.equal(ee.listenerCount('x'), 3)
})

test('prependOnceListener is removed before recursion and keeps context', () => {
  const ee = new EventEmitter()
  const seen = []
  const context = { label: 'context' }
  ee.on('x', (depth) => seen.push(['tail', depth]))
  ee.prependOnceListener(
    'x',
    function (depth) {
      assert.equal(this, context)
      seen.push(['once', depth])
      assert.equal(ee.listenerCount('x'), 1)
      ee.emit('x', depth + 1)
    },
    context
  )
  ee.emit('x', 0)
  assert.deepEqual(seen, [
    ['once', 0],
    ['tail', 1],
    ['tail', 0],
  ])
})

test('prepends during emission start on the next emission', () => {
  for (const count of [1, 3]) {
    const ee = new EventEmitter()
    const seen = []
    const added = () => seen.push('new')
    let install = true
    ee.on('x', () => {
      seen.push('first')
      if (install) {
        install = false
        ee.prependListener('x', added)
      }
    })
    for (let i = 1; i < count; i++) ee.on('x', () => seen.push(`tail${i}`))
    ee.emit('x')
    const original = ['first', ...Array.from({ length: count - 1 }, (_, i) => `tail${i + 1}`)]
    assert.deepEqual(seen, original)
    seen.length = 0
    ee.emit('x')
    assert.deepEqual(seen, ['new', ...original])
  }
})

test('symbol and prototype-looking names retain event accounting and removals', () => {
  for (const name of [Symbol('event'), '__proto__', 'constructor', 'toString', '']) {
    const ee = new EventEmitter()
    const context = {}
    const listener = () => {}
    ee.prependListener(name, listener, context)
    ee.prependOnceListener(name, listener, context)
    assert.deepEqual(ee.eventNames(), [name])
    assert.equal(ee.listenerCount(name), 2)
    ee.removeListener(name, listener, context, true)
    assert.equal(ee.listenerCount(name), 1)
    ee.off(name, listener, context)
    assert.deepEqual(ee.eventNames(), [])
    ee.prependListener(name, listener)
    ee.removeAllListeners(name)
    assert.equal(ee.emit(name), false)
  }
})

test('invalid handlers fail without registering an event and errors keep identity', () => {
  const ee = new EventEmitter()
  for (const method of ['prependListener', 'prependOnceListener']) {
    for (const invalid of [undefined, null, false, 4, {}, 'fn']) {
      assert.throws(() => ee[method]('x', invalid), TypeError)
      assert.equal(ee.listenerCount('x'), 0)
    }
  }
  const error = new Error('original')
  ee.prependOnceListener('x', () => {
    throw error
  })
  assert.throws(
    () => ee.emit('x'),
    (value) => value === error
  )
  assert.equal(ee.listenerCount('x'), 0)
})

test('context fallback and existing ESM entry share the implementation', async () => {
  const esm = await import(pathToFileURL(join(process.cwd(), 'index.mjs')))
  assert.equal(esm.default, EventEmitter)
  const ee = new esm.default()
  for (const context of [undefined, null, false, 0]) {
    ee.prependOnceListener(
      'x',
      function () {
        assert.equal(this, ee)
      },
      context
    )
    ee.emit('x')
  }
})

test('public declarations infer listener arguments, context and subclass chaining', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'prepend-consumer-'))
  try {
    const source = join(directory, 'consumer.ts')
    await writeFile(
      source,
      `import EventEmitter from ${JSON.stringify(join(process.cwd(), 'index'))};
const emitter = new EventEmitter<{ready: [number, string]}, {tag: string}>();
emitter.prependListener('ready', (count, label) => { count.toFixed(); label.toUpperCase(); }, {tag: 'ok'});
emitter.prependOnceListener('ready', (count, label) => { count.toFixed(); label.toUpperCase(); });
// @ts-expect-error unknown event
emitter.prependListener('other', () => {});
// @ts-expect-error incompatible callback arguments
emitter.prependOnceListener('ready', (count: string) => {});
// @ts-expect-error incompatible context
emitter.prependListener('ready', () => {}, {tag: 3});
class Child extends EventEmitter<{ready: [number]}> { childOnly() {} }
new Child().prependListener('ready', value => value.toFixed()).childOnly();
new Child().prependOnceListener('ready', value => value.toFixed()).childOnly();
`
    )
    execFileSync(
      process.execPath,
      [
        join(process.cwd(), 'node_modules/typescript/bin/tsc'),
        '--strict',
        '--noEmit',
        '--target',
        'es2020',
        '--module',
        'commonjs',
        '--moduleResolution',
        'node',
        source,
      ],
      { cwd: directory, timeout: 30000, stdio: 'pipe', encoding: 'utf8' }
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
