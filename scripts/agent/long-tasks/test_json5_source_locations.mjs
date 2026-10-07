// 冻结的独立验收：值、语法位置、调用隔离与发布入口。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'

const root = process.cwd()
const require = createRequire(root + '/package.json')
const json5 = require(root + '/lib/index.js')
const parse = (...args) => {
  assert.equal(typeof json5.parseWithLocations, 'function', 'new public API must be exported')
  return json5.parseWithLocations(...args)
}
const node = (path, kind, start, end) => ({ path, kind, start, end })
test('new public API must be exported', () => parse('null'))
for (const [source, kind] of [
  ['null', 'null'],
  ['true', 'boolean'],
  ['false', 'boolean'],
  ['-0', 'number'],
  ['+.5', 'number'],
  ['0xA0', 'number'],
  ['-Infinity', 'number'],
  ['NaN', 'number'],
  ["'😀\\n'", 'string'],
  ['"a\\u0042"', 'string'],
  ['{}', 'object'],
  ['[]', 'array'],
])
  test(`literal and UTF-16 range: ${source}`, () => {
    const text = '\uFEFF /* lead */\r\n' + source + ' // tail\n'
    const start = text.indexOf(source)
    const result = parse(text)
    assert.deepEqual(result.value, json5.parse(text))
    assert.deepEqual(result.nodes, [node('', kind, start, start + source.length)])
  })
test('container order, escaped pointers, duplicates and exact value spans', () => {
  const text = '{"a/b~": [1, {x: "😀"}], x: 0, x: false,}'
  assert.deepEqual(parse(text).nodes, [
    node('', 'object', 0, text.length),
    node('/a~1b~0', 'array', text.indexOf('['), text.indexOf(']') + 1),
    node('/a~1b~0/0', 'number', text.indexOf('1'), text.indexOf('1') + 1),
    node('/a~1b~0/1', 'object', text.indexOf('{x'), text.indexOf('}') + 1),
    node('/a~1b~0/1/x', 'string', text.indexOf('"😀"'), text.indexOf('"😀"') + 4),
    node('/x', 'number', text.indexOf('0,'), text.indexOf('0,') + 1),
    node('/x', 'boolean', text.indexOf('false'), text.indexOf('false') + 5),
  ])
})
test('reviver semantics and nested parsing are independent of source metadata', () => {
  const text = '{keep: [1,2], drop: 3}'
  const calls = []
  const reviver = function (key, value) {
    calls.push([key, Array.isArray(this)])
    if (key === 'drop') return undefined
    if (key === '0') assert.equal(parse('{inner:4}').value.inner, 4)
    return typeof value === 'number' ? value * 10 : value
  }
  const result = parse(text, reviver)
  assert.deepEqual(result.value, { keep: [10, 20] })
  assert(result.nodes.some((n) => n.path === '/drop'))
  assert.deepEqual(
    calls.map((x) => x[0]),
    ['0', '1', 'keep', 'drop', '']
  )
  assert.deepEqual(parse('5').nodes, [node('', 'number', 0, 1)])
})
test('escaped and hostile keys retain syntax identity without polluting prototypes', () => {
  const result = parse('{"__proto__": {safe: 1}, "\\u002f": 2, "": 3, café: 4}')
  assert(Object.hasOwn(result.value, '__proto__'))
  assert.equal(Object.getPrototypeOf(result.value), Object.prototype)
  assert.equal({}.safe, undefined)
  assert.deepEqual(
    result.nodes.map((n) => n.path),
    ['', '/__proto__', '/__proto__/safe', '/~1', '/', '/café']
  )
})
test('errors and callback failures preserve ordinary parse diagnostics and reset state', () => {
  for (const input of ['{a:', '[1,,2]', '{x: "bad\n"}', '{a:1} trailing']) {
    let ordinary
    try {
      json5.parse(input)
    } catch (error) {
      ordinary = error
    }
    assert.throws(
      () => parse(input),
      (error) =>
        error.name === ordinary.name &&
        error.message === ordinary.message &&
        error.lineNumber === ordinary.lineNumber &&
        error.columnNumber === ordinary.columnNumber
    )
    assert.deepEqual(parse('[]').nodes, [node('', 'array', 0, 2)])
  }
  const failure = new Error('reviver sentinel')
  assert.throws(
    () =>
      parse('{a:1}', () => {
        throw failure
      }),
    (error) => error === failure
  )
  assert.equal(parse('true').value, true)
})
test('generated nested data ranges select parseable matching syntax', () => {
  for (let index = 0; index < 32; index++) {
    const value = { ['a/~' + index]: [index, { label: '😀' + index, yes: index % 2 === 0 }, null] }
    const text = '/*prefix*/' + json5.stringify(value, null, index % 3) + '\n'
    const result = parse(text)
    assert.deepEqual(result.value, value)
    assert.equal(result.nodes.length, 7)
    for (const item of result.nodes) {
      assert(Number.isInteger(item.start) && Number.isInteger(item.end) && item.end > item.start)
      json5.parse(text.slice(item.start, item.end))
    }
  }
})
test('rebuilt ESM and browser consumers expose matching results', async () => {
  const module = await import(pathToFileURL(root + '/dist/index.mjs'))
  const context = vm.createContext({})
  vm.runInContext(readFileSync(root + '/dist/index.js', 'utf8'), context)
  for (const api of [module.default, context.JSON5]) {
    assert.equal(typeof api.parseWithLocations, 'function')
    assert.equal(JSON.stringify(api.parseWithLocations('{x: 2}')), JSON.stringify(parse('{x: 2}')))
  }
})
test('CLI locations works on stdin and validation remains silent', () => {
  const input = '{x:[1,2]}'
  const run = (args) =>
    spawnSync(process.execPath, [root + '/lib/cli.js', ...args], { input, encoding: 'utf8' })
  const output = run(['--locations', '--space', '2'])
  assert.equal(output.status, 0, output.stderr)
  assert.deepEqual(JSON.parse(output.stdout), parse(input))
  const validation = run(['--locations', '--validate'])
  assert.equal(validation.status, 0, validation.stderr)
  assert.equal(validation.stdout, '')
})
