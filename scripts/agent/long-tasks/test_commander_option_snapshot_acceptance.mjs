import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const { Command } = createRequire(join(root, 'package.json'))('./index.js')
const snapshot = (command, global = false) => {
  const method = global ? 'optsWithGlobalsAndSources' : 'optsWithSources'
  assert.equal(typeof command[method], 'function', 'option snapshots must be available')
  return command[method]()
}

test('local records preserve falsy values, references and source ownership', () => {
  const command = new Command().option('--port <n>', 'port', '8080').option('--verbose')
  command.parse(['--verbose'], { from: 'user' })
  const values = { off: false, zero: 0, empty: '', unset: undefined, absent: null, array: ['a'] }
  for (const [key, value] of Object.entries(values))
    command.setOptionValueWithSource(key, value, 'config')
  command.setOptionValue('plain', 5)
  const first = snapshot(command),
    second = snapshot(command)
  assert.notEqual(first, second)
  assert.deepEqual(Object.keys(first), Object.keys(command.opts()))
  for (const key of Object.keys(first)) {
    assert.notEqual(first[key], second[key])
    assert.equal(first[key].value, command.opts()[key])
    assert.equal(first[key].source, command.getOptionValueSource(key))
    assert(Object.hasOwn(first[key], 'source'))
  }
  first.port.value = 'changed'
  delete first.verbose
  assert.equal(snapshot(command).port.value, '8080')
  assert.equal(command.opts().verbose, true)
  command.setOptionValueWithSource('port', '9000', 'cli')
  assert.deepEqual(snapshot(command).port, { value: '9000', source: 'cli' })
})

test('ancestor keys override local values and sources together, including undefined', () => {
  const root = new Command(),
    middle = root.command('mid'),
    leaf = middle.command('leaf')
  for (const [cmd, value, source] of [
    [root, undefined, undefined],
    [middle, 'mid', 'config'],
    [leaf, 'leaf', 'cli'],
  ])
    cmd.setOptionValueWithSource('shared', value, source)
  middle.setOptionValueWithSource('middle', 0, 'default')
  leaf.setOptionValueWithSource('local', false, 'cli')
  const result = snapshot(leaf, true)
  assert.deepEqual(Object.keys(result), Object.keys(leaf.optsWithGlobals()))
  assert.deepEqual(result.shared, { value: undefined, source: undefined })
  assert.deepEqual(result.middle, { value: 0, source: 'default' })
  assert.deepEqual(result.local, { value: false, source: 'cli' })
  assert.deepEqual(snapshot(leaf).shared, { value: 'leaf', source: 'cli' })
})

test('property storage and parsed value sources remain supported', () => {
  const command = new Command()
    .storeOptionsAsProperties()
    .option('--count <n>', 'count', '3')
    .option('--flag')
  command.parse(['--flag'], { from: 'user' })
  const result = snapshot(command)
  assert.deepEqual(Object.keys(result), Object.keys(command.opts()))
  assert.deepEqual(result.count, { value: '3', source: 'default' })
  assert.deepEqual(result.flag, { value: true, source: 'cli' })
  command.setOptionValueWithSource('count', '8', 'config')
  assert.deepEqual(snapshot(command).count, { value: '8', source: 'config' })
})

test('enumerable prototype-like keys are ordinary own records', () => {
  const command = new Command()
  Object.defineProperty(command.opts(), '__proto__', { value: 'own-value', enumerable: true })
  const result = snapshot(command)
  assert(Object.hasOwn(result, '__proto__'))
  assert.deepEqual(result.__proto__, {
    value: 'own-value',
    source: command.getOptionValueSource('__proto__'),
  })
  const child = command.command('child')
  assert(Object.hasOwn(snapshot(child, true), '__proto__'))
})

test('ESM exports expose both methods', async () => {
  const esm = await import(pathToFileURL(join(root, 'esm.mjs')))
  assert.deepEqual(snapshot(new esm.Command()), {})
  assert.deepEqual(snapshot(new esm.Command(), true), {})
})

test('existing setters preserve writable non-configurable properties', () => {
  for (const store of [false, true])
    for (const key of ['value', '__proto__', 'constructor', 'toString']) {
      const command = new Command().storeOptionsAsProperties(store).option('--' + key + ' <text>')
      const target = store ? command : command.opts()
      Object.defineProperty(target, key, {
        value: 'before',
        writable: true,
        enumerable: true,
        configurable: false,
      })
      command.setOptionValueWithSource(key, 'after', 'config')
      assert.equal(command.getOptionValue(key), 'after')
      const result = snapshot(command)
      assert.deepEqual(Object.keys(result), Object.keys(command.opts()))
      if (Object.hasOwn(command.opts(), key))
        assert.deepEqual(result[key], { value: 'after', source: command.getOptionValueSource(key) })
      assert.equal(Object.getOwnPropertyDescriptor(target, key).configurable, false)
    }
})

test('existing setters continue invoking accessor setters without replacing them', () => {
  for (const store of [false, true])
    for (const key of ['value', '__proto__', 'constructor', 'toString']) {
      const command = new Command().storeOptionsAsProperties(store).option('--' + key + ' <text>')
      const target = store ? command : command.opts()
      let value = 'before'
      let calls = 0
      const get = () => value
      const set = (next) => {
        calls++
        value = String(next).toUpperCase()
      }
      Object.defineProperty(target, key, { get, set, enumerable: true, configurable: true })
      command.setOptionValueWithSource(key, 'after', 'env')
      assert.equal(calls, 1)
      assert.equal(command.getOptionValue(key), 'AFTER')
      const result = snapshot(command)
      assert.deepEqual(Object.keys(result), Object.keys(command.opts()))
      if (Object.hasOwn(command.opts(), key))
        assert.deepEqual(result[key], { value: 'AFTER', source: command.getOptionValueSource(key) })
      assert.equal(Object.getOwnPropertyDescriptor(target, key).set, set)
    }
})

test('existing setters keep read-only values intact and preserve their error', () => {
  for (const store of [false, true])
    for (const key of ['value', '__proto__', 'constructor', 'toString']) {
      const command = new Command().storeOptionsAsProperties(store).option('--' + key + ' <text>')
      const target = store ? command : command.opts()
      Object.defineProperty(target, key, {
        value: 'before',
        writable: false,
        enumerable: true,
        configurable: false,
      })
      assert.throws(() => command.setOptionValueWithSource(key, 'after', 'env'), TypeError)
      assert.equal(command.getOptionValue(key), 'before')
    }
})

test('generic declarations preserve each value type and expose optional sources', async (t) => {
  snapshot(new Command())
  const directory = await mkdtemp(join(tmpdir(), 'option-snapshot-types-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'consumer.ts')
  await writeFile(
    file,
    `import {Command} from ${JSON.stringify(root)};
const command = new Command();
const local=command.optsWithSources<{port:number; enabled:boolean}>();
const global=command.optsWithGlobalsAndSources<{port:number; enabled:boolean}>();
const n:number=local.port.value; const b:boolean=global.enabled.value;
const source:string|undefined=local.port.source;
// @ts-expect-error port is not boolean
const bad:boolean=local.port.value;
void [n,b,source,bad];
`
  )
  const result = spawnSync(
    process.execPath,
    [
      join(root, 'node_modules/typescript/lib/tsc.js'),
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2020',
      '--module',
      'commonjs',
      file,
    ],
    { encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
