import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test as nodeTest } from 'node:test'
import { runInNewContext } from 'node:vm'

const require = createRequire(join(process.cwd(), 'package.json'))
const api = require(join(process.cwd(), 'index.js'))
const tick = () => new Promise((resolve) => setImmediate(resolve))
const test = (name, body) => nodeTest(name, { timeout: 6000 }, body)

function environment(templates = {}, options = {}) {
  const calls = []
  const loader = {
    getSource(name) {
      calls.push(name)
      return Object.hasOwn(templates, name)
        ? { src: templates[name], path: name, noCache: false }
        : null
    },
  }
  return { env: new api.Environment(loader, options), loader, calls }
}

function promiseCall(target, name, ...args) {
  assert.equal(typeof target[name], 'function', 'Promise rendering must be available')
  let result
  assert.doesNotThrow(() => {
    result = target[name](...args)
  }, 'Promise APIs must reject rather than throw synchronously')
  assert(result instanceof Promise, 'rendering must return a native Promise')
  return result
}

function observe(promise) {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason })
  )
}

async function settled(promise) {
  let timer
  try {
    return await Promise.race([
      observe(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('render did not settle promptly')), 1500)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function rejected(promise, expected) {
  const result = await settled(promise)
  assert.equal(result.status, 'rejected')
  if (expected !== undefined) assert.equal(result.reason, expected)
  return result.reason
}

async function resolved(promise) {
  const result = await settled(promise)
  assert.equal(result.status, 'fulfilled', 'an independent render must still complete')
  return result.value
}

async function until(predicate) {
  const deadline = Date.now() + 1500
  while (!predicate()) {
    assert(Date.now() < deadline, 'expected asynchronous work did not begin')
    await tick()
  }
}

function signal() {
  const listeners = new Set()
  return {
    aborted: false,
    reason: undefined,
    added: 0,
    removed: 0,
    addEventListener(type, listener) {
      assert.equal(type, 'abort')
      this.added++
      listeners.add(listener)
    },
    removeEventListener(type, listener) {
      assert.equal(type, 'abort')
      this.removed++
      listeners.delete(listener)
    },
    abort(reason) {
      this.aborted = true
      this.reason = reason
      for (const listener of [...listeners]) listener.call(this, { type: 'abort', target: this })
    },
    get listeners() {
      return listeners.size
    },
  }
}

function filters(env) {
  const pending = []
  const touches = []
  env.addFilter(
    'hold',
    function (value, callback) {
      pending.push({ value, callback, receiver: this })
    },
    true
  )
  env.addFilter('touch', (value) => {
    touches.push(value)
    return value
  })
  return { pending, touches }
}

function extension(env, pending) {
  const value = {
    tags: ['waitValue'],
    parse(parser, nodes) {
      const token = parser.nextToken()
      const args = parser.parseSignature(null, true)
      parser.advanceAfterBlockEnd(token.value)
      return new nodes.CallExtensionAsync(this, 'run', args)
    },
    run(context, value, callback) {
      pending.push({ context, value, callback, receiver: this })
    },
  }
  env.addExtension('WaitValue', value)
  return value
}

test('baseline: synchronous and callback rendering remain usable', async () => {
  const { env } = environment({ hello: 'Hello {{ name }}' })
  assert.equal(env.render('hello', { name: 'world' }), 'Hello world')
  assert.equal(
    await new Promise((resolve, reject) =>
      env.render('hello', { name: 'cb' }, (error, value) =>
        error ? reject(error) : resolve(value)
      )
    ),
    'Hello cb'
  )
})

test('Environment.renderAsync resolves loaded template content', async () => {
  const { env } = environment({ hello: 'Hello {{ name }}' })
  assert.equal(await promiseCall(env, 'renderAsync', 'hello', { name: 'world' }), 'Hello world')
})

test('Environment.renderStringAsync preserves context, escaping and SafeString', async () => {
  const { env } = environment()
  assert.equal(
    await promiseCall(env, 'renderStringAsync', '{{ x }}|{{ y }}', {
      x: '<b>',
      y: new api.runtime.SafeString('<i>'),
    }),
    '&lt;b&gt;|<i>'
  )
})

test('Template.renderAsync uses the template environment', async () => {
  const { env } = environment()
  env.addGlobal('prefix', 'P')
  const template = new api.Template('{{ prefix }}:{{ value }}', env, 'direct.njk')
  assert.equal(await promiseCall(template, 'renderAsync', { value: 4 }), 'P:4')
})

test('module renderAsync uses the configured environment', async () => {
  const env = api.configure({ autoescape: false })
  env.loaders = [environment({ top: '{{ x }}' }).loader]
  env._initLoaders()
  try {
    assert.equal(await promiseCall(api, 'renderAsync', 'top', { x: '<b>' }), '<b>')
  } finally {
    api.reset()
  }
})

test('module renderStringAsync uses configured filters and options', async () => {
  const env = api.configure({ autoescape: false })
  env.addFilter('decorate', (value) => `<${value}>`)
  try {
    assert.equal(
      await promiseCall(api, 'renderStringAsync', '{{ x | decorate }}', { x: 'a' }),
      '<a>'
    )
  } finally {
    api.reset()
  }
})

test('optional context and options have useful defaults', async () => {
  const { env } = environment({ plain: 'ok' })
  assert.equal(await promiseCall(env, 'renderAsync', 'plain'), 'ok')
  assert.equal(await promiseCall(env, 'renderStringAsync', 'ok'), 'ok')
  assert.equal(await promiseCall(new api.Template('ok', env), 'renderAsync'), 'ok')
})

test('async filter retains context receiver and output ordering', async () => {
  const { env } = environment()
  const state = filters(env)
  const result = promiseCall(env, 'renderStringAsync', 'A{{ value | hold }}Z', {
    value: 'B',
    flag: 7,
  })
  await until(() => state.pending.length === 1)
  assert.equal(state.pending[0].receiver.lookup('flag'), 7)
  state.pending[0].callback(null, 'B')
  assert.equal(await result, 'ABZ')
})

test('async extension retains its receiver and render context', async () => {
  const { env } = environment()
  const pending = []
  const ext = extension(env, pending)
  const result = promiseCall(env, 'renderStringAsync', 'A{% waitValue value %}Z', {
    value: 'B',
    flag: 7,
  })
  await until(() => pending.length === 1)
  assert.equal(pending[0].receiver, ext)
  assert.equal(pending[0].context.lookup('flag'), 7)
  pending[0].callback(null, new api.runtime.SafeString('<B>'))
  assert.equal(await result, 'A<B>Z')
})

test('async loaders and template caches remain usable', async () => {
  let count = 0
  const loader = {
    async: true,
    getSource(name, callback) {
      count++
      setImmediate(() => callback(null, { src: '{{ x }}', path: name }))
    },
  }
  const env = new api.Environment(loader)
  assert.equal(await promiseCall(env, 'renderAsync', 'cached', { x: 'A' }), 'A')
  assert.equal(await promiseCall(env, 'renderAsync', 'cached', { x: 'B' }), 'B')
  assert.equal(count, 1)
})

test('syntax errors reject with the supplied diagnostic path', async () => {
  const { env } = environment()
  const error = await rejected(
    promiseCall(env, 'renderStringAsync', '{% if %}', {}, { path: 'broken.njk' })
  )
  assert.match(String(error), /broken\.njk/)
  assert.match(String(error), /Line|line/)
})

test('runtime errors reject with template location', async () => {
  const { env } = environment({ broken: '{{ absent() }}' })
  assert.match(String(await rejected(promiseCall(env, 'renderAsync', 'broken'))), /broken/)
})

test('missing templates reject instead of throwing', async () => {
  const { env } = environment()
  assert.match(
    String(await rejected(promiseCall(env, 'renderAsync', 'missing'))),
    /template not found/
  )
})

test('invalid source and template names reject', async () => {
  const { env } = environment()
  await rejected(promiseCall(env, 'renderStringAsync', 42))
  await rejected(promiseCall(env, 'renderAsync', 42))
})

test('asynchronous filter failure rejects and releases the listener', async () => {
  const { env } = environment()
  const s = signal()
  env.addFilter(
    'bad',
    (value, callback) => setImmediate(() => callback(new Error('filter failed'))),
    true
  )
  assert.match(
    String(
      await rejected(promiseCall(env, 'renderStringAsync', '{{ 1 | bad }}', {}, { signal: s }))
    ),
    /filter failed/
  )
  assert.equal(s.listeners, 0)
})

test('asynchronous loader failure rejects and releases the listener', async () => {
  const s = signal()
  const env = new api.Environment({
    async: true,
    getSource(name, callback) {
      setImmediate(() => callback(new Error('loader failed')))
    },
  })
  assert.match(
    String(await rejected(promiseCall(env, 'renderAsync', 'x', {}, { signal: s }))),
    /loader failed/
  )
  assert.equal(s.listeners, 0)
})

for (const [name, value] of Object.entries({
  null: null,
  array: [],
  string: 'x',
  number: 1,
  function: () => {},
})) {
  test(`invalid ${name} options reject with TypeError before work`, async () => {
    const { env, calls } = environment({ x: 'ok' })
    const error = await rejected(promiseCall(env, 'renderAsync', 'x', {}, value))
    assert(error instanceof TypeError)
    assert.deepEqual(calls, [])
  })
}

for (const [name, value] of Object.entries({
  null: null,
  boolean: false,
  object: {},
  abortedType: {
    aborted: 1,
    addEventListener() {},
    removeEventListener() {},
  },
  noAdd: { aborted: false, removeEventListener() {} },
  noRemove: { aborted: false, addEventListener() {} },
})) {
  test(`invalid ${name} signal rejects with TypeError before work`, async () => {
    const { env, calls } = environment({ x: 'ok' })
    assert(
      (await rejected(promiseCall(env, 'renderAsync', 'x', {}, { signal: value }))) instanceof
        TypeError
    )
    assert.deepEqual(calls, [])
  })
}

test('an explicitly undefined signal follows normal rendering', async () => {
  const { env } = environment()
  assert.equal(await promiseCall(env, 'renderStringAsync', 'ok', {}, { signal: undefined }), 'ok')
})

for (const [name, reason] of Object.entries({
  object: { why: 'stop' },
  string: 'stop',
  null: null,
  false: false,
  zero: 0,
})) {
  test(`pre-abort preserves ${name} reason and starts no loader`, async () => {
    const { env, calls } = environment({ x: 'ok' })
    const s = signal()
    s.abort(reason)
    const result = await settled(promiseCall(env, 'renderAsync', 'x', {}, { signal: s }))
    assert.equal(result.status, 'rejected')
    assert.equal(result.reason, reason)
    assert.deepEqual(calls, [])
    assert.equal(s.listeners, 0)
  })
}

test('pre-abort without a reason creates an AbortError', async () => {
  const { env } = environment()
  const s = signal()
  s.abort()
  const error = await rejected(promiseCall(env, 'renderStringAsync', 'ok', {}, { signal: s }))
  assert.equal(error.name, 'AbortError')
})

test('pre-abort prevents template code execution', async () => {
  const { env } = environment()
  let touched = 0
  const controller = new AbortController()
  controller.abort('before')
  await rejected(
    promiseCall(
      new api.Template('{{ touch() }}', env),
      'renderAsync',
      {
        touch() {
          touched++
          return ''
        },
      },
      { signal: controller.signal }
    ),
    'before'
  )
  assert.equal(touched, 0)
})

test('cancel while an async filter never calls back settles promptly', async () => {
  const { env } = environment()
  const state = filters(env)
  const s = signal()
  const result = promiseCall(env, 'renderStringAsync', '{{ 1 | hold }}', {}, { signal: s })
  const observed = observe(result)
  await until(() => state.pending.length === 1)
  s.abort('pending')
  await rejected(result, 'pending')
  assert.equal(s.listeners, 0)
  assert.equal((await observed).status, 'rejected')
})

test('late filter callbacks cannot resume subsequent template work', async () => {
  const { env } = environment()
  const state = filters(env)
  const s = signal()
  const result = promiseCall(
    env,
    'renderStringAsync',
    '{{ 1 | hold }}{{ 2 | touch }}',
    {},
    { signal: s }
  )
  observe(result)
  await until(() => state.pending.length === 1)
  s.abort('late')
  await rejected(result, 'late')
  state.pending[0].callback(null, 1)
  await tick()
  assert.deepEqual(state.touches, [])
})

test('pending and late async loader callbacks are cancelled', async () => {
  let callback
  const env = new api.Environment({
    async: true,
    getSource(name, cb) {
      callback = cb
    },
  })
  const state = filters(env)
  const s = signal()
  const result = promiseCall(env, 'renderAsync', 'x', {}, { signal: s })
  observe(result)
  await until(() => callback)
  s.abort('loader')
  await rejected(result, 'loader')
  callback(null, { src: '{{ 1 | touch }}', path: 'x' })
  await tick()
  assert.deepEqual(state.touches, [])
  assert.equal(s.listeners, 0)
})

test('pending and late extension callbacks are cancelled', async () => {
  const { env } = environment()
  const state = filters(env)
  const pending = []
  extension(env, pending)
  const s = signal()
  const result = promiseCall(
    env,
    'renderStringAsync',
    '{% waitValue 1 %}{{ 2 | touch }}',
    {},
    { signal: s }
  )
  observe(result)
  await until(() => pending.length === 1)
  s.abort('extension')
  await rejected(result, 'extension')
  pending[0].callback(null, 'value')
  await tick()
  assert.deepEqual(state.touches, [])
})

test('successful rendering removes all abort listeners', async () => {
  const { env } = environment()
  const s = signal()
  assert.equal(await promiseCall(env, 'renderStringAsync', 'done', {}, { signal: s }), 'done')
  assert.equal(s.listeners, 0)
  s.abort('after')
  assert.equal(s.listeners, 0)
})

test('compilation failure removes abort listeners', async () => {
  const { env } = environment()
  const s = signal()
  await rejected(promiseCall(env, 'renderStringAsync', '{% if %}', {}, { signal: s }))
  assert.equal(s.listeners, 0)
})

test('concurrent cached-template renders keep cancellation isolated', async () => {
  const { env } = environment({ cached: '{{ value | hold }}{{ value | touch }}' })
  const template = env.getTemplate('cached')
  const state = filters(env)
  const left = signal()
  const right = signal()
  const one = promiseCall(template, 'renderAsync', { value: 'A' }, { signal: left })
  const two = promiseCall(template, 'renderAsync', { value: 'B' }, { signal: right })
  observe(one)
  observe(two)
  await until(() => state.pending.length === 2)
  left.abort('A stopped')
  await rejected(one, 'A stopped')
  state.pending.find((entry) => entry.value === 'A').callback(null, 'A')
  state.pending.find((entry) => entry.value === 'B').callback(null, 'B')
  assert.equal(await resolved(two), 'BB')
  assert.deepEqual(state.touches, ['B'])
  assert.equal(left.listeners + right.listeners, 0)
  assert.equal(env.getTemplate('cached'), template)
})

test('ordinary callback rendering survives cancellation of a concurrent Promise', async () => {
  const { env } = environment({ cached: '{{ value | hold }}{{ value | touch }}' })
  const state = filters(env)
  const s = signal()
  const one = promiseCall(env, 'renderAsync', 'cached', { value: 'A' }, { signal: s })
  observe(one)
  const two = new Promise((resolve, reject) =>
    env.render('cached', { value: 'B' }, (error, value) => (error ? reject(error) : resolve(value)))
  )
  await until(() => state.pending.length === 2)
  s.abort('stop')
  await rejected(one, 'stop')
  for (const entry of state.pending) entry.callback(null, entry.value)
  assert.equal(await resolved(two), 'BB')
  assert.deepEqual(state.touches, ['B'])
})

test('a new render works after a cancelled cached render', async () => {
  const { env } = environment({ cached: '{{ value | hold }}' })
  const state = filters(env)
  const s = signal()
  const first = promiseCall(env, 'renderAsync', 'cached', { value: 'A' }, { signal: s })
  observe(first)
  await until(() => state.pending.length === 1)
  s.abort('stop')
  await rejected(first, 'stop')
  const second = promiseCall(env, 'renderAsync', 'cached', { value: 'B' })
  await until(() => state.pending.length === 2)
  state.pending[1].callback(null, 'B')
  assert.equal(await second, 'B')
})

test('reentrant Promise rendering does not inherit the outer cancellation', async () => {
  const { env } = environment()
  const state = filters(env)
  let inner
  env.addFilter(
    'start',
    (value, callback) => {
      inner = promiseCall(env, 'renderStringAsync', '{{ "inner" | hold }}{{ "inner" | touch }}')
      state.pending.push({ value: 'outer', callback })
    },
    true
  )
  const s = signal()
  const outer = promiseCall(
    env,
    'renderStringAsync',
    '{{ 1 | start }}{{ "outer" | touch }}',
    {},
    { signal: s }
  )
  observe(outer)
  await until(() => state.pending.length === 2)
  s.abort('outer stopped')
  await rejected(outer, 'outer stopped')
  for (const entry of state.pending) entry.callback(null, entry.value)
  assert.equal(await resolved(inner), 'innerinner')
  assert.deepEqual(state.touches, ['inner'])
})

const nestedCases = {
  include: {
    main: '{% include "part" %}{{ "after" | touch }}',
    part: '{{ "held" | hold }}{{ "inside" | touch }}',
  },
  inheritance: {
    main: '{% extends "base" %}{% block body %}{{ "held" | hold }}{{ "inside" | touch }}{% endblock %}',
    base: 'B{% block body %}default{% endblock %}{{ "after" | touch }}',
  },
  super: {
    main: '{% extends "base" %}{% block body %}{{ super() }}{{ "inside" | touch }}{% endblock %}',
    base: '{% block body %}{{ "held" | hold }}{% endblock %}{{ "after" | touch }}',
  },
  import: {
    main: '{% import "macros" as m %}{{ m.value() }}{{ "after" | touch }}',
    macros: '{% set v = "held" | hold %}{% macro value() %}{{ v | touch }}{% endmacro %}',
  },
  fromImport: {
    main: '{% from "macros" import value %}{{ value() }}{{ "after" | touch }}',
    macros: '{% set v = "held" | hold %}{% macro value() %}{{ v | touch }}{% endmacro %}',
  },
  caller: {
    main: '{% import "macros" as m %}{% call m.wrap() %}{{ "caller" | touch }}{% endcall %}',
    macros: '{% set v = "held" | hold %}{% macro wrap() %}{{ v }}{{ caller() }}{% endmacro %}',
  },
  asyncEach: {
    main: '{% asyncEach x in [1, 2] %}{{ x | hold }}{{ x | touch }}{% endeach %}{{ "after" | touch }}',
  },
  asyncAll: {
    main: '{% asyncAll x in [1, 2] %}{{ x | hold }}{{ x | touch }}{% endall %}{{ "after" | touch }}',
  },
}

for (const [name, templates] of Object.entries(nestedCases)) {
  test(`successful Promise rendering matches callback behavior through ${name}`, async () => {
    const run = async (usePromise) => {
      const { env } = environment(templates)
      const touches = []
      env.addFilter('hold', (value, callback) => setImmediate(() => callback(null, value)), true)
      env.addFilter('touch', (value) => {
        touches.push(value)
        return value
      })
      const result = usePromise
        ? promiseCall(env, 'renderAsync', 'main')
        : new Promise((resolve, reject) =>
            env.render('main', {}, (error, value) => (error ? reject(error) : resolve(value)))
          )
      return { value: await resolved(result), touches }
    }
    assert.deepEqual(await run(true), await run(false))
  })

  test(`cancellation stops continuations through ${name}`, async () => {
    const { env } = environment(templates)
    const state = filters(env)
    const s = signal()
    const result = promiseCall(env, 'renderAsync', 'main', {}, { signal: s })
    observe(result)
    await until(() => state.pending.length > 0)
    s.abort(name)
    await rejected(result, name)
    for (const entry of [...state.pending]) entry.callback(null, entry.value)
    await tick()
    assert.deepEqual(state.touches, [])
    assert.equal(s.listeners, 0)
  })
}

test('precompiled templates execute successfully through the Promise API', async () => {
  const { env: compilerEnv } = environment()
  compilerEnv.addFilter('later', (value, callback) => callback(null, value), true)
  const window = {}
  runInNewContext(
    api.precompileString('A{{ value | later }}Z', { name: 'compiled', env: compilerEnv }),
    { window }
  )
  const env = new api.Environment(new api.PrecompiledLoader(window.nunjucksPrecompiled))
  env.addFilter('later', (value, callback) => setImmediate(() => callback(null, value)), true)
  assert.equal(await promiseCall(env, 'renderAsync', 'compiled', { value: 'B' }), 'ABZ')
})

test('precompiled templates respect render-local cancellation', async () => {
  const { env: compilerEnv } = environment()
  filters(compilerEnv)
  const window = {}
  runInNewContext(
    api.precompileString('{{ 1 | hold }}{{ 2 | touch }}', { name: 'compiled', env: compilerEnv }),
    { window }
  )
  const env = new api.Environment(new api.PrecompiledLoader(window.nunjucksPrecompiled))
  const state = filters(env)
  const s = signal()
  const result = promiseCall(env, 'renderAsync', 'compiled', {}, { signal: s })
  observe(result)
  await until(() => state.pending.length === 1)
  s.abort('precompiled')
  await rejected(result, 'precompiled')
  state.pending[0].callback(null, 'value')
  await tick()
  assert.deepEqual(state.touches, [])
})

test('module facades forward cancellation options', async () => {
  const controller = new AbortController()
  controller.abort('module')
  api.configure()
  try {
    await rejected(
      promiseCall(api, 'renderAsync', 'unneeded', {}, { signal: controller.signal }),
      'module'
    )
    await rejected(
      promiseCall(api, 'renderStringAsync', '{{ unused() }}', {}, { signal: controller.signal }),
      'module'
    )
  } finally {
    api.reset()
  }
})
