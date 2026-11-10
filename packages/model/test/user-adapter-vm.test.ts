import { spawnSync } from 'node:child_process'

import { expect, test } from 'bun:test'

function runNodeRegression(source: string, timeout: number): string {
  const result = spawnSync('node', ['--input-type=module', '--eval', source], {
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
  })
  if (result.error || result.status !== 0)
    throw new Error(`Node VM regression failed: ${result.error?.message ?? result.stderr}`)
  expect(result.signal).toBeNull()
  return result.stdout
}

test('user adapter Promise jobs remain inside the Node VM execution deadline', () => {
  const entry = new URL('../dist/index.js', import.meta.url).href
  const source = `
    import assert from 'node:assert/strict'
    import { createModelRuntimeComposition } from ${JSON.stringify(entry)}

    assert.equal(process.versions.bun, undefined)
    const composition = createModelRuntimeComposition({ providerScripts: { configPaths: [] } })
    const registry = composition.modelAdapterRegistry
    const config = (source) => ({
      provider: 'custom', apiKey: 'fixture-key', baseURL: 'https://fixture.invalid/v1',
      adapter: { kind: 'js', providerId: 'fixture', filename: 'fixture-user-adapter.js', source },
    })
    const loop = 'Promise.resolve().then(() => { while (true) {} });'
    const normal = [
      'module.exports = {',
      'createLanguageModelFactory({ helpers }) { return model => helpers.createOpenAI({})(model) },',
      'createEmbeddingRequest() {',
      'return { url: "https://fixture.invalid/embeddings", headers: {}, body: { input: ["fixture"] } }',
      '}',
      '}',
    ].join(' ')
    assert.equal(registry.createLanguageModelFactory(config(normal))('fixture-model').modelId, 'fixture-model')
    assert.deepEqual(registry.createEmbeddingRequest(config(normal), 'fixture-model', ['fixture']), {
      url: 'https://fixture.invalid/embeddings', headers: {}, body: { input: ['fixture'] },
    })
    const cases = [
      [loop + normal, 'source'],
      ['module.exports = { createLanguageModelFactory({ helpers }) {' + loop +
        'return model => helpers.createOpenAI({})(model) } }', 'factory'],
      ['module.exports = { createLanguageModelFactory({ helpers }) { return model => {' + loop +
        'return helpers.createOpenAI({})(model) } } }', 'model'],
      ['module.exports = { createEmbeddingRequest() {' + loop +
        'return { url: "https://fixture.invalid/embeddings", headers: {} } } }', 'embedding'],
    ]
    for (const [source, seam] of cases) {
      assert.throws(() => {
        if (seam === 'embedding') registry.createEmbeddingRequest(config(source), 'fixture-model', ['fixture'])
        else {
          const factory = registry.createLanguageModelFactory(config(source))
          if (seam === 'model') factory('fixture-model')
        }
      }, error => error?.code === 'MODEL_CUSTOM_ADAPTER_INVALID' && /timed out|超时/.test(error.message), seam)
    }
    console.log('node-vm-deadlines-ok')
  `
  const result = spawnSync('node', ['--input-type=module', '--eval', source], {
    encoding: 'utf8',
    timeout: 12_000,
    killSignal: 'SIGKILL',
  })
  if (result.error || result.status !== 0) {
    throw new Error(`Node VM regression failed: ${result.error?.message ?? result.stderr}`)
  }
  expect(result.signal).toBeNull()
  expect(result.stdout).toContain('node-vm-deadlines-ok')
}, 15_000)

test('user adapter export, result and diagnostic seams execute only inside the VM wall', () => {
  const entry = new URL('../dist/index.js', import.meta.url).href
  const guardedExports = `
    const counts = { module: 0, exports: 0, helpers: 0, named: 0, default: 0, model: 0, embedding: 0 }
    const originalModule = module
    const originalHelpers = helpers
    function create({ helpers }) {
      requireWall()
      if (this.fn !== create || Object.getPrototypeOf(this) !== null) throw Error('hook receiver changed')
      let modelFactory
      modelFactory = new Proxy(function(model) {
        requireWall()
        counts.model++
        return helpers.createOpenAI({})(model)
      }, { apply(target, receiver, args) {
        requireWall()
        if (receiver.fn !== modelFactory) throw Error('model receiver changed')
        return Reflect.apply(target, receiver, args)
      } })
      return modelFactory
    }
    function embedding() {
      requireWall()
      if (this.fn !== embedding) throw Error('embedding receiver changed')
      counts.embedding++
      return { url: 'https://fixture.invalid/embeddings', headers: {}, body: { ...counts } }
    }
    const exported = new Proxy({
      get createLanguageModelFactory() { requireWall(); counts.named++; return create },
      createEmbeddingRequest: embedding,
      get default() { counts.default++; throw Error('named export must win') },
    }, { get(target, key, receiver) { requireWall(); return Reflect.get(target, key, receiver) } })
    Object.defineProperty(originalModule, 'exports', { get() { requireWall(); counts.exports++; return exported } })
    Object.defineProperty(globalThis, 'module', { get() { requireWall(); counts.module++; return originalModule } })
    Object.defineProperty(globalThis, 'helpers', { get() { requireWall(); counts.helpers++; return originalHelpers } })
  `
  const defaultExports = `
    function create({ helpers }) {
      requireWall()
      return model => { requireWall(); return helpers.createOpenAI({})(model) }
    }
    module.exports = new Proxy({ get default() {
      requireWall()
      return new Proxy({ createLanguageModelFactory: create }, {
        get(target, key, receiver) { requireWall(); return Reflect.get(target, key, receiver) },
      })
    } }, { get(target, key, receiver) { requireWall(); return Reflect.get(target, key, receiver) } })
  `
  const fixedSlots = `
    let blocked = 0
    let touched = 0
    for (const key of ['__velarosUserAdapterCall__', '__velarosUserAdapterJson__', '__velarosUserAdapterValue__']) {
      try { Object.defineProperty(globalThis, key, { get() { touched++; return undefined }, set() { touched++ } }) }
      catch { blocked++ }
    }
    module.exports = {
      createLanguageModelFactory({ helpers }) {
        requireWall()
        try { Object.defineProperty(this, 'result', { get() { touched++; return undefined } }) }
        catch { blocked++ }
        return model => helpers.createOpenAI({})(model)
      },
      createEmbeddingRequest() {
        return { url: 'https://fixture.invalid/embeddings', headers: {}, body: { blocked, touched } }
      },
    }
  `
  const primitiveJson = `
    let coerced = 0
    const stringify = JSON.stringify
    JSON.stringify = () => {
      JSON.stringify = stringify
      return { toString() { coerced++; requireWall(); return '{}' } }
    }
    module.exports = {
      createLanguageModelFactory({ helpers }) { return model => helpers.createOpenAI({})(model) },
      createEmbeddingRequest() {
        return { url: 'https://fixture.invalid/embeddings', headers: {}, body: { coerced } }
      },
    }
  `
  const thrownValue = `
    let reads = 0
    module.exports = {
      createLanguageModelFactory() { return () => { throw new Proxy({}, { get(_target, key) {
        if (key !== 'message') return undefined
        reads++
        requireWall()
        return 'bounded diagnostic'
      } }) } },
      createEmbeddingRequest() {
        return { url: 'https://fixture.invalid/embeddings', headers: {}, body: { reads } }
      },
    }
  `
  const failedDiagnostic = `
    let first = 0
    let second = 0
    module.exports = {
      createLanguageModelFactory() { return () => { throw { get message() {
        first++
        requireWall()
        throw { get message() { second++; return 'must not inspect this value' } }
      } } } },
      createEmbeddingRequest() {
        return { url: 'https://fixture.invalid/embeddings', headers: {}, body: { first, second } }
      },
    }
  `
  const primitiveConsole = `
    let formatted = 0
    let inspected = 0
    const value = { toJSON() { requireWall(); formatted++; return 'primitive log' } }
    console.info(value)
    const rejected = new Proxy({}, { get() { inspected++; throw Error('host inspected console object') } })
    globalThis.__velarosUserAdapterLog__('info', rejected)
    globalThis.__velarosUserAdapterLog__(rejected, 'ignored')
    module.exports = {
      createLanguageModelFactory({ helpers }) { return model => helpers.createOpenAI({})(model) },
      createEmbeddingRequest() {
        return { url: 'https://fixture.invalid/embeddings', headers: {}, body: { formatted, inspected } }
      },
    }
  `
  const source = `
    import assert from 'node:assert/strict'
    import { Script } from 'node:vm'
    import { createModelRuntimeComposition } from ${JSON.stringify(entry)}

    assert.equal(process.versions.bun, undefined)
    const originalRun = Script.prototype.runInContext
    Script.prototype.runInContext = function(...args) {
      const context = args[0]
      Object.defineProperty(context, '__insideUserAdapterTestWall__', { value: true, writable: true })
      try { return Reflect.apply(originalRun, this, args) }
      finally { Object.defineProperty(context, '__insideUserAdapterTestWall__', { value: false }) }
    }
    try {
      const composition = createModelRuntimeComposition({ providerScripts: { configPaths: [] } })
      const registry = composition.modelAdapterRegistry
      const guard = 'const requireWall = () => { if (globalThis.__insideUserAdapterTestWall__ !== true) throw Error("outside VM execution wall") };'
      const config = source => ({
        provider: 'custom', apiKey: 'fixture-key', baseURL: 'https://fixture.invalid/v1',
        adapter: { kind: 'js', providerId: 'fixture', filename: 'fixture-user-adapter.js', source: guard + source },
      })
      const embedding = input => registry.createEmbeddingRequest(input, 'fixture-model', ['fixture']).body
      const guarded = config(${JSON.stringify(guardedExports)})
      assert.equal(registry.createLanguageModelFactory(guarded)('fixture-model').modelId, 'fixture-model')
      assert.deepEqual(embedding(guarded), { module: 1, exports: 1, helpers: 1, named: 1, default: 0, model: 1, embedding: 1 })
      assert.equal(registry.createLanguageModelFactory(config(${JSON.stringify(defaultExports)}))('fixture-default').modelId, 'fixture-default')
      const slots = config(${JSON.stringify(fixedSlots)})
      registry.createLanguageModelFactory(slots)('fixture-model')
      assert.deepEqual(embedding(slots), { blocked: 4, touched: 0 })
      const json = config(${JSON.stringify(primitiveJson)})
      const jsonFactory = registry.createLanguageModelFactory(json)
      assert.throws(() => jsonFactory('fixture-model'), error => error?.code === 'MODEL_CUSTOM_ADAPTER_INVALID' && /JSON 字符串/.test(error.message))
      assert.deepEqual(embedding(json), { coerced: 0 })
      const thrown = config(${JSON.stringify(thrownValue)})
      assert.throws(() => registry.createLanguageModelFactory(thrown)('fixture-model'), error => error?.code === 'MODEL_CUSTOM_ADAPTER_INVALID' && /bounded diagnostic/.test(error.message))
      assert.deepEqual(embedding(thrown), { reads: 1 })
      const diagnostic = config(${JSON.stringify(failedDiagnostic)})
      assert.throws(() => registry.createLanguageModelFactory(diagnostic)('fixture-model'), error => error?.code === 'MODEL_CUSTOM_ADAPTER_INVALID' && /无法在执行预算内读取/.test(error.message))
      assert.deepEqual(embedding(diagnostic), { first: 1, second: 0 })
      assert.deepEqual(embedding(config(${JSON.stringify(primitiveConsole)})), { formatted: 1, inspected: 0 })
      console.log('node-vm-boundaries-ok')
    } finally {
      Script.prototype.runInContext = originalRun
    }
  `
  expect(runNodeRegression(source, 8_000)).toContain('node-vm-boundaries-ok')
}, 10_000)

test('user adapter diagnostics never send foreign errors back into the VM', () => {
  const entry = new URL('../dist/index.js', import.meta.url).href
  const source = `
    import assert from 'node:assert/strict'
    import { Script } from 'node:vm'
    import { Logger } from '@velaros-ai/core/logger'
    import { createModelRuntimeComposition } from ${JSON.stringify(entry)}

    const originalRun = Script.prototype.runInContext
    const originalInfo = Logger.prototype.info
    let context
    let injectHostFailure = false
    Script.prototype.runInContext = function(...args) {
      context = args[0]
      const result = Reflect.apply(originalRun, this, args)
      if (injectHostFailure && Object.getOwnPropertyDescriptor(context, '__injectHostVmFailure__')?.value === true) {
        Object.defineProperty(context, '__injectHostVmFailure__', { value: false })
        throw new Error('fixture host VM failure')
      }
      return result
    }
    const inspect = () => {
      const script = new Script('JSON.stringify({ foreign: globalThis.__foreignErrors__, trims: globalThis.__diagnosticTrims__, rawReads: globalThis.__rawErrorReads__, consoleRealm: globalThis.__consoleErrorVm__ })')
      const serialized = Reflect.apply(originalRun, script, [context, { timeout: 100 }])
      assert.equal(typeof serialized, 'string')
      return JSON.parse(serialized)
    }
    const probe = \`
      globalThis.__foreignErrors__ = 0
      globalThis.__diagnosticTrims__ = 0
      const originalTrim = String.prototype.trim
      String.prototype.trim = function() {
        globalThis.__diagnosticTrims__++
        const value = globalThis.__velarosUserAdapterCall__?.arg0
        if (value && (typeof value === 'object' || typeof value === 'function')) {
          const constructor = value.constructor
          if (constructor && constructor.constructor !== Function) globalThis.__foreignErrors__++
        }
        return originalTrim.call(this)
      }
    \`
    const normal = 'module.exports = { createLanguageModelFactory({helpers}) { return model => helpers.createOpenAI({})(model) } }'
    const config = source => ({
      provider: 'custom', apiKey: 'fixture-key', baseURL: 'https://fixture.invalid/v1',
      adapter: { kind: 'js', providerId: 'fixture', filename: 'fixture-user-adapter.js', source },
    })
    try {
      const composition = createModelRuntimeComposition({ providerScripts: { configPaths: [] } })
      const registry = composition.modelAdapterRegistry
      const cases = [
        probe + 'const stringify = JSON.stringify; JSON.stringify = () => { JSON.stringify = stringify; return "{" };' + normal,
        probe + 'const stringify = JSON.stringify; JSON.stringify = () => { JSON.stringify = stringify; return { toString() { throw Error("must not coerce") } } };' + normal,
        probe + 'Object.defineProperty(globalThis, "__velarosUserAdapterJson__", { writable: false });' + normal,
        probe + 'module.exports = { createLanguageModelFactory({helpers}) { return model => { globalThis.__injectHostVmFailure__ = true; return helpers.createOpenAI({})(model) } } }',
      ]
      for (let index = 0; index < cases.length; index++) {
        injectHostFailure = index === 3
        assert.throws(() => registry.createLanguageModelFactory(config(cases[index]))('fixture-model'),
          error => error?.code === 'MODEL_CUSTOM_ADAPTER_INVALID')
        injectHostFailure = false
        assert.deepEqual(inspect(), { foreign: 0, trims: 0 })
      }

      const vmFailure = config(probe + 'module.exports = { createLanguageModelFactory() { return () => { throw Error("fixture VM failure") } } }')
      assert.throws(() => registry.createLanguageModelFactory(vmFailure)('fixture-model'),
        error => error?.code === 'MODEL_CUSTOM_ADAPTER_INVALID' && /fixture VM failure/.test(error.message))
      assert.equal(inspect().foreign, 0)
      assert(inspect().trims > 0)

      const rawProxy = probe + \`
        globalThis.__rawErrorReads__ = 0
        throw new Proxy({}, {
          get() { globalThis.__rawErrorReads__++; return undefined },
          getOwnPropertyDescriptor() { globalThis.__rawErrorReads__++; return undefined },
          getPrototypeOf() { globalThis.__rawErrorReads__++; return null },
        })
      \`
      assert.throws(() => registry.createLanguageModelFactory(config(rawProxy)),
        error => error?.code === 'MODEL_CUSTOM_ADAPTER_INVALID')
      assert.deepEqual(inspect(), { foreign: 0, trims: 0, rawReads: 0 })

      const rawAccessor = probe + \`
        globalThis.__rawErrorReads__ = 0
        const error = new Error('fixture source error')
        Object.defineProperty(error, 'message', { get() { globalThis.__rawErrorReads__++; return 'must not read accessor' } })
        throw error
      \`
      assert.throws(() => registry.createLanguageModelFactory(config(rawAccessor)),
        error => error?.code === 'MODEL_CUSTOM_ADAPTER_INVALID' && /无法在执行预算内读取/.test(error.message))
      assert.deepEqual(inspect(), { foreign: 0, trims: 0, rawReads: 0 })

      Logger.prototype.info = () => { throw new Error('fixture host logger failure') }
      const logger = config(probe + \`
        module.exports = { createLanguageModelFactory({helpers}) {
          try { console.info('fixture') }
          catch (error) { globalThis.__consoleErrorVm__ = error.constructor === Error && error.constructor.constructor === Function }
          return model => helpers.createOpenAI({})(model)
        } }
      \`)
      assert.equal(registry.createLanguageModelFactory(logger)('fixture-model').modelId, 'fixture-model')
      assert.deepEqual(inspect(), { foreign: 0, trims: 1, consoleRealm: true })
      Logger.prototype.info = originalInfo

      const topLevel = config('function topLevelFactory({helpers}) { return model => helpers.createOpenAI({})(model) }; module.exports = { createLanguageModelFactory: globalThis.topLevelFactory }')
      assert.equal(registry.createLanguageModelFactory(topLevel)('fixture-model').modelId, 'fixture-model')
      console.log('node-vm-no-foreign-errors-ok')
    } finally {
      Script.prototype.runInContext = originalRun
      Logger.prototype.info = originalInfo
    }
  `
  expect(runNodeRegression(source, 8_000)).toContain('node-vm-no-foreign-errors-ok')
}, 10_000)

test('user adapter export getters and console Promise jobs retain Node VM deadlines', () => {
  const entry = new URL('../dist/index.js', import.meta.url).href
  const source = `
    import assert from 'node:assert/strict'
    import { createModelRuntimeComposition } from ${JSON.stringify(entry)}
    const composition = createModelRuntimeComposition({ providerScripts: { configPaths: [] } })
    const registry = composition.modelAdapterRegistry
    const config = source => ({
      provider: 'custom', apiKey: 'fixture-key', baseURL: 'https://fixture.invalid/v1',
      adapter: { kind: 'js', providerId: 'fixture', filename: 'fixture-user-adapter.js', source },
    })
    const cases = [
      'Object.defineProperty(module, "exports", { get() { while (true) {} } })',
      'module.exports = { createLanguageModelFactory({ helpers }) { console.info({ toJSON() { Promise.resolve().then(() => { while (true) {} }); return "fixture" } }); return model => helpers.createOpenAI({})(model) } }',
    ]
    for (const candidate of cases)
      assert.throws(() => registry.createLanguageModelFactory(config(candidate)), error => error?.code === 'MODEL_CUSTOM_ADAPTER_INVALID' && /timed out|超时/.test(error.message))
    console.log('node-vm-accessor-deadlines-ok')
  `
  expect(runNodeRegression(source, 8_000)).toContain('node-vm-accessor-deadlines-ok')
}, 10_000)
