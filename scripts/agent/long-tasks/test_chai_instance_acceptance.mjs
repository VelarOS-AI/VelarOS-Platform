import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'

const root = process.cwd()
const source = await import(pathToFileURL(join(root, 'index.js')))
const bundle = await import(pathToFileURL(join(root, 'chai.js')))
const failure = (fn) => {
  let caught
  try {
    fn()
  } catch (error) {
    caught = error
  }
  assert(caught, 'An assertion must fail')
  return caught
}
const fresh = (api, options) => {
  assert.equal(typeof api.create, 'function', 'Independent Chai instances must be available')
  return api.create(options)
}
const longValue = { firstProperty: 'abcdefghij'.repeat(15), secondProperty: [1, 2, 3] }

for (const [label, api] of [
  ['source', source],
  ['bundle', bundle],
]) {
  const check = (name, fn) => test(`${label}: ${name}`, fn)
  check('default assertions retain their established behavior', () => {
    api
      .expect({ value: [1, 2] })
      .to.have.property('value')
      .that.deep.equals([1, 2])
    api.assert.deepEqual({ a: 1 }, { a: 1 })
    assert(failure(() => api.expect(1).equal(2)) instanceof api.AssertionError)
  })
  check('factory exposes independent compatible assertion surfaces', () => {
    const a = fresh(api),
      b = fresh(api)
    for (const name of ['expect', 'assert', 'Assertion', 'use'])
      assert.equal(typeof a[name], 'function')
    assert.equal(a.AssertionError, api.AssertionError)
    for (const key of ['config', 'util', 'Assertion']) assert.notEqual(a[key], b[key])
    assert.notEqual(a.Assertion.prototype, b.Assertion.prototype)
    assert.notEqual(a.Assertion.prototype, api.Assertion.prototype)
    a.expect([1, 2]).to.have.lengthOf(2)
    a.assert.strictEqual(1, 1)
    new a.Assertion({ a: 1 }).to.deep.equal({ a: 1 })
    assert(failure(() => a.assert.strictEqual(1, 2)) instanceof api.AssertionError)
  })
  check('configuration and override arrays are copied without mutating inputs', () => {
    const comparator = (a, b) => Object.is(a, b)
    const keys = ['safeKey'],
      config = Object.freeze({ showDiff: false, proxyExcludedKeys: keys, deepEqual: comparator })
    const options = Object.freeze({ config, plugins: Object.freeze([]) })
    const a = fresh(api, options),
      b = fresh(api)
    assert.equal(a.config.deepEqual, comparator)
    assert.notEqual(a.config, config)
    assert.notEqual(a.config.proxyExcludedKeys, keys)
    a.config.proxyExcludedKeys.push('privateKey')
    assert.deepEqual(keys, ['safeKey'])
    assert(!b.config.proxyExcludedKeys.includes('privateKey'))
    assert.equal(a.expect(1).safeKey, undefined)
    assert.throws(() => b.expect(1).safeKey)
  })
  check('built-in defaults are independent of default-export mutations', () => {
    const saved = { ...api.config, proxyExcludedKeys: [...api.config.proxyExcludedKeys] }
    try {
      api.config.showDiff = false
      api.config.useProxy = false
      api.config.proxyExcludedKeys.push('defaultOnly')
      const a = fresh(api)
      assert.equal(a.config.showDiff, true)
      assert.equal(a.config.useProxy, true)
      assert(!a.config.proxyExcludedKeys.includes('defaultOnly'))
      a.config.proxyExcludedKeys.push('instanceOnly')
      assert(!api.config.proxyExcludedKeys.includes('instanceOnly'))
    } finally {
      Object.assign(api.config, saved)
    }
  })
  check('explicit undefined options and fields use defaults', () => {
    const a = fresh(api, undefined),
      b = fresh(api, { config: undefined, plugins: undefined })
    assert.equal(a.config.showDiff, b.config.showDiff)
    a.expect(1).equal(1)
    b.assert.equal(1, 1)
  })
  for (const [name, options] of [
    ['null options', null],
    ['array options', []],
    ['primitive options', 1],
    ['null config', { config: null }],
    ['array config', { config: [] }],
    ['primitive config', { config: 'bad' }],
    ['null plugins', { plugins: null }],
    ['non-array plugins', { plugins: {} }],
    ['invalid plugin', { plugins: [null] }],
  ])
    check(`validates ${name}`, () => {
      assert.throws(() => fresh(api, options), { name: 'TypeError' })
    })
  check('validates all plugins before executing the first', () => {
    let calls = 0
    assert.throws(
      () =>
        fresh(api, {
          plugins: [
            () => {
              calls++
            },
            7,
          ],
        }),
      { name: 'TypeError' }
    )
    assert.equal(calls, 0)
  })
  check('showDiff is local in expect, assert and direct assertions', () => {
    const a = fresh(api, { config: { showDiff: false } }),
      b = fresh(api)
    for (const invoke of [
      (c) => c.expect(1).equal(2),
      (c) => c.assert.equal(1, 2),
      (c) => new c.Assertion(1).equal(2),
    ]) {
      assert.equal(failure(() => invoke(a)).showDiff, false)
      assert.equal(failure(() => invoke(b)).showDiff, true)
    }
  })
  check('proxy settings stay local on detached expect and util.proxify', () => {
    const a = fresh(api, { config: { useProxy: false } }),
      b = fresh(api)
    const expect = a.expect,
      proxify = a.util.proxify
    assert.equal(expect(1).unknownAssertion, undefined)
    assert.equal(proxify({}).unknownAssertion, undefined)
    assert.throws(() => b.expect(1).unknownAssertion)
    assert.throws(() => b.util.proxify({}).unknownAssertion)
  })
  check('deep comparator is retained through both interfaces and property chains', () => {
    const comparator = (a, b) =>
      typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 5 : api.util.eql(a, b)
    const a = fresh(api, { config: { deepEqual: comparator } }),
      b = fresh(api)
    const expect = a.expect,
      deepEqual = a.assert.deepEqual
    expect(1).deep.equal(3)
    deepEqual(1, 3)
    new a.Assertion(1).eql(3)
    a.expect({ n: 1 }).property('n').deep.equal(3)
    assert.throws(() => b.expect(1).deep.equal(3))
    assert.equal(a.config.deepEqual, comparator)
  })
  check('formatting utilities and assertion messages use owning truncation settings', () => {
    const a = fresh(api, { config: { truncateThreshold: 0 } }),
      b = fresh(api, { config: { truncateThreshold: 12 } })
    for (const name of ['inspect', 'objDisplay']) {
      const long = a.util[name],
        short = b.util[name]
      assert(long(longValue).length > short(longValue).length)
      assert(long(longValue).includes('abcdefghij'.repeat(5)))
    }
    const messageA = a.util.getMessage(new a.Assertion(longValue), [
      false,
      'actual #{act} expected #{exp}',
      '',
      0,
    ])
    const messageB = b.util.getMessage(new b.Assertion(longValue), [
      false,
      'actual #{act} expected #{exp}',
      '',
      0,
    ])
    assert(messageA.length > messageB.length)
    assert(
      failure(() => a.expect(longValue).equal(0)).message.length >
        failure(() => b.expect(longValue).equal(0)).message.length
    )
  })
  check('deprecated accessors bind to owning config', () => {
    const a = fresh(api),
      b = fresh(api)
    a.Assertion.includeStack = true
    a.Assertion.showDiff = false
    assert.equal(a.config.includeStack, true)
    assert.equal(a.config.showDiff, false)
    assert.equal(b.Assertion.includeStack, false)
    assert.equal(b.Assertion.showDiff, true)
  })
  check('includeStack controls implementation frames independently', () => {
    const a = fresh(api, { config: { includeStack: true } }),
      b = fresh(api)
    for (const owner of [a, b])
      owner.Assertion.addMethod('stackProbe', function configurationStackMarker() {
        this.assert(false, 'stack probe', 'negative stack probe')
      })
    assert.match(failure(() => a.expect(1).stackProbe()).stack, /configurationStackMarker/)
    assert.doesNotMatch(failure(() => b.expect(1).stackProbe()).stack, /configurationStackMarker/)
  })
  check('retained chains keep ownership across another instance and an await', async () => {
    const a = fresh(api, { config: { showDiff: false } }),
      b = fresh(api)
    const pending = a.expect(1)
    b.expect([1]).lengthOf(1)
    await Promise.resolve()
    assert.equal(failure(() => pending.equal(2)).showDiff, false)
    assert.equal(failure(() => b.expect(1).equal(2)).showDiff, true)
  })
  check('plugin callbacks receive the actual instance and run once per owner', () => {
    const a = fresh(api),
      b = fresh(api),
      seen = []
    function plugin(owner, utils) {
      seen.push(owner)
      assert.equal(utils, owner.util)
    }
    assert.equal(a.use(plugin), a)
    assert.equal(a.use(plugin), a)
    assert.equal(b.use(plugin), b)
    assert.deepEqual(seen, [a, b])
    api.use(plugin)
    const c = fresh(api)
    c.use(plugin)
    assert.equal(seen.length, 4)
    assert.equal(seen[3], c)
  })
  check('initial plugin order and failure retry follow the instance registry', () => {
    const calls = []
    const first = (owner) => {
      calls.push(1)
      owner.config.showDiff = false
    }
    const second = (owner) => {
      calls.push(2)
      assert.equal(owner.config.showDiff, false)
    }
    const a = fresh(api, { plugins: [first, second, first] })
    assert.deepEqual(calls, [1, 2])
    let count = 0
    const retry = () => {
      if (++count === 1) throw new Error('install failed')
    }
    assert.throws(() => a.use(retry), /install failed/)
    assert.equal(a.use(retry), a)
    a.use(retry)
    assert.equal(count, 2)
  })
  check('plugins added to default and existing instances do not enter new instances', () => {
    const a = fresh(api)
    a.Assertion.addProperty('ownerOnly', function () {
      return this
    })
    api.use((owner) =>
      owner.Assertion.addProperty('defaultOnly', function () {
        return this
      })
    )
    const b = fresh(api)
    a.expect(1).ownerOnly
    api.expect(1).defaultOnly
    assert.throws(() => b.expect(1).ownerOnly)
    assert.throws(() => b.expect(1).defaultOnly)
    assert.throws(() => api.expect(1).ownerOnly)
  })
  for (const mechanism of ['Assertion', 'util']) {
    for (const form of [
      'addProperty',
      'addMethod',
      'addChainableMethod',
      'overwriteProperty',
      'overwriteMethod',
      'overwriteChainableMethod',
    ]) {
      check(
        `${mechanism}.${form} preserves extension locality and returned chain ownership`,
        () => {
          const a = fresh(api),
            b = fresh(api)
          a.Assertion.addProperty('ownerMarker', function () {
            return 'owner-a'
          })
          const add = (...args) =>
            mechanism === 'Assertion'
              ? a.Assertion[form](...args)
              : a.util[form](a.Assertion.prototype, ...args)
          let calls = 0,
            chain
          if (form === 'addProperty') {
            add('localExtension', function () {
              calls++
            })
            chain = a.expect(1).localExtension
            assert.throws(() => b.expect(1).localExtension)
          } else if (form === 'addMethod') {
            add('localExtension', function (value) {
              calls++
              this.assert(a.util.flag(this, 'object') === value, 'wrong value', 'wrong negative')
            })
            chain = a.expect(1).localExtension(1)
            assert.throws(() => b.expect(1).localExtension)
          } else if (form === 'addChainableMethod') {
            add(
              'localExtension',
              function () {
                calls++
              },
              function () {
                a.util.flag(this, 'localChain', true)
              }
            )
            chain = a.expect(1).localExtension()
            assert.throws(() => b.expect(1).localExtension)
          } else if (form === 'overwriteProperty') {
            add(
              'ok',
              (original) =>
                function () {
                  calls++
                  return original.call(this)
                }
            )
            chain = a.expect(true).ok
            b.expect(true).ok
          } else if (form === 'overwriteMethod') {
            add(
              'equal',
              (original) =>
                function (...args) {
                  calls++
                  return original.apply(this, args)
                }
            )
            chain = a.expect(1).equal(1)
            b.expect(1).equal(1)
          } else {
            add(
              'lengthOf',
              (original) =>
                function (...args) {
                  calls++
                  return original.apply(this, args)
                },
              (original) =>
                function () {
                  return original.call(this)
                }
            )
            chain = a.expect([1]).lengthOf(1)
            b.expect([1]).lengthOf(1)
          }
          assert.equal(chain.ownerMarker, 'owner-a')
          assert.equal(calls, 1)
        }
      )
    }
  }
  check('reentrant plugin assertions retain separate config and nested constructors', () => {
    const a = fresh(api, { config: { showDiff: false } }),
      b = fresh(api)
    a.use((owner) =>
      owner.Assertion.addMethod('reentrant', function () {
        assert.equal(failure(() => b.expect(1).equal(2)).showDiff, true)
        assert.equal(failure(() => new owner.Assertion(1).equal(2)).showDiff, false)
        this.assert(false, 'local failure', 'local negative', 2, 1, true)
      })
    )
    assert.equal(failure(() => a.expect(1).reentrant()).showDiff, false)
    assert.equal(failure(() => b.expect(1).equal(2)).showDiff, true)
  })
}

test('browser bundle creates isolated instances without Node globals', async () => {
  const require = createRequire(join(root, 'package.json'))
  const { transformSync } = require('esbuild')
  const compiled = transformSync(await readFile(join(root, 'chai.js'), 'utf8'), {
    format: 'cjs',
    platform: 'browser',
  })
  const sandbox = { module: { exports: {} } }
  vm.runInNewContext(compiled.code, sandbox, { timeout: 5000 })
  const api = sandbox.module.exports
  const a = fresh(api, { config: { showDiff: false, useProxy: false } }),
    b = fresh(api)
  assert.equal(failure(() => a.expect(1).equal(2)).showDiff, false)
  assert.equal(failure(() => b.expect(1).equal(2)).showDiff, true)
  a.use((owner) =>
    owner.Assertion.addProperty('localBrowser', function () {
      return true
    })
  )
  assert.equal(a.expect(1).localBrowser, true)
  assert.throws(() => b.expect(1).localBrowser)
})
