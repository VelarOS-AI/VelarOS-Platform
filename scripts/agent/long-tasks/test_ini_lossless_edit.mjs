// 独立 INI 编辑合同：以完整文本比较验证局部修改和无损保留。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'

import { runFileExample } from './file-example.mjs'

const require = createRequire(resolve('package.json'))
const ini = require(resolve('lib/ini.js'))
const feature = () => assert.equal(typeof ini.edit, 'function', 'exports lossless batch edit')
const edit = (source, operations) => {
  feature()
  return ini.edit(source, operations)
}
const set = (key, value, section) => ({
  op: 'set',
  key,
  value,
  ...(section === undefined ? {} : { section }),
})
const remove = (key, section) => ({
  op: 'remove',
  key,
  ...(section === undefined ? {} : { section }),
})

test('exports lossless batch edit', feature)

test('empty edits and absent removals preserve every byte', () => {
  for (const source of [
    '',
    '\uFEFF; title\r\na = 1\n\r\n[db]\r\nuser=x',
    '; comment\n\nflag',
    '[ignored\n#last',
  ]) {
    assert.equal(edit(source, []), source)
    assert.equal(edit(source, [remove('absent', 'missing')]), source)
  }
})

test('scalar replacement preserves trivia and the missing final newline', () => {
  const source = '; title\r\n  name \t=  old  ; keep this\r\nuntouched=x\n[db]\nport=80'
  assert.equal(
    edit(source, [set('name', 'new')]),
    '; title\r\n  name \t=  new  ; keep this\r\nuntouched=x\n[db]\nport=80'
  )
  assert.equal(
    edit(source, [set('port', 443, 'db')]),
    '; title\r\n  name \t=  old  ; keep this\r\nuntouched=x\n[db]\nport=443'
  )
})

test('BOM and Unicode survive changing the first assignment', () => {
  assert.equal(
    edit('\uFEFF名称 = 旧值\r\n;保留\n', [set('名称', '新值')]),
    '\uFEFF名称 = 新值\r\n;保留\n'
  )
})

test('quoted and escaped comment characters are part of the value', () => {
  assert.equal(
    edit('name = "old;#value"  ; comment\n', [set('name', 'new')]),
    'name = new  ; comment\n'
  )
  assert.equal(
    edit('name=old\\;semi\\#hash # note\nnext=x\n', [set('name', 'a;#b')]),
    'name=a\\;\\#b # note\nnext=x\n'
  )
  assert.equal(edit("name='old#value'\n", [set('name', ' value ')]), 'name=" value "\n')
})

test('quoted key spelling is preserved when setting a scalar', () => {
  assert.equal(
    edit('" display name " = old ; keep\n', [set(' display name ', 'new')]),
    '" display name " = new ; keep\n'
  )
})

test('bare flags gain a value without reformatting adjacent lines', () => {
  assert.equal(
    edit('  enabled\r\n# untouched\n', [set('enabled', false)]),
    '  enabled=false\r\n# untouched\n'
  )
})

test('duplicate scalar assignments collapse at the first position', () => {
  assert.equal(
    edit('x = old ; first\n; standalone\nx=older # second\ny=keep\n', [set('x', 'fresh')]),
    'x = fresh ; first\n; standalone\ny=keep\n'
  )
})

test('array shape changes preserve first-line style and unrelated comments', () => {
  const source = '  path = old ; first\r\n# standalone\r\npath[]=other\r\nx=1\r\n'
  const array = edit(source, [set('path', ['one', 'two'])])
  assert.equal(array, '  path[] = one ; first\r\n  path[] = two\r\n# standalone\r\nx=1\r\n')
  assert.equal(
    edit(array, [set('path', 'only')]),
    '  path = only ; first\r\n# standalone\r\nx=1\r\n'
  )
})

test('array replacement without final newline keeps the final-newline state', () => {
  assert.equal(edit('a=old', [set('a', ['x', 'y'])]), 'a[]=x\na[]=y')
  assert.equal(edit('a[]=x\na[]=y', [set('a', 'z')]), 'a=z\n')
})

test('removal deletes all matching assignments and retains section headings', () => {
  const source = '[db]\nx=1\n; keep\nx[]=2\ny=3\n[db]\nx=4\n[other]\nx=5\n'
  const expected = '[db]\n; keep\ny=3\n[db]\n[other]\nx=5\n'
  assert.equal(edit(source, [remove('x', 'db')]), expected)
  assert.equal(edit(source, [set('x', [], 'db')]), expected)
})

test('repeated sections are edited together while names and globals stay distinct', () => {
  const source = 'x=global\n[db]\nx=one\n[other]\nx=other\n[db]\nx=two\n'
  assert.equal(
    edit(source, [set('x', 'fresh', 'db')]),
    'x=global\n[db]\nx=fresh\n[other]\nx=other\n[db]\n'
  )
})

test('new root keys precede the first section and use the first newline style', () => {
  assert.equal(
    edit('; title\r\nx=1\n[db]\nuser=a', [set('root', 7)]),
    '; title\r\nx=1\nroot=7\r\n[db]\nuser=a'
  )
  assert.equal(edit('[db]\nx=1\n', [set('root', true, '')]), 'root=true\n[db]\nx=1\n')
})

test('new keys use the end of the first matching section block', () => {
  const source = '[db]\nx=1\n; retained\n[other]\nx=2\n[db]\nz=3\n'
  assert.equal(
    edit(source, [set('new', 'yes', 'db')]),
    '[db]\nx=1\n; retained\nnew=yes\n[other]\nx=2\n[db]\nz=3\n'
  )
})

test('missing sections append without an extra blank line', () => {
  assert.equal(edit('root=x', [set('port', 80, 'server')]), 'root=x\n[server]\nport=80\n')
  assert.equal(edit('; hello\r\n', [set('user', 'a', 'db')]), '; hello\r\n[db]\r\nuser=a\r\n')
  assert.equal(edit('', [set('x', null)]), 'x=null\n')
})

test('section names are matched before dotted expansion', () => {
  const source = '[a.b]\nx=1\n[a\\.b]\nx=2\n[" with spaces "]\nx=3\n'
  assert.equal(
    edit(source, [
      set('x', 'one', 'a.b'),
      set('x', 'two', 'a\\.b'),
      set('x', 'three', ' with spaces '),
    ]),
    '[a.b]\nx=one\n[a\\.b]\nx=two\n[" with spaces "]\nx=three\n'
  )
})

test('edits apply in order without mutating frozen operation values', () => {
  const values = Object.freeze(['a', 'b'])
  const operations = Object.freeze([
    Object.freeze(set('x', values)),
    Object.freeze(remove('x')),
    Object.freeze(set('x', 'final')),
  ])
  assert.equal(edit('x=old\ny=keep\n', operations), 'y=keep\nx=final\n')
  assert.deepEqual(values, ['a', 'b'])
})

test('encoded values agree with the package scalar and array conventions', () => {
  const values = ['a=b', ' leading ', 'semi;hash#', '\u96EA', true, false, null, 12, -1.5]
  for (const value of values) {
    const actual = edit('x=old\n', [set('x', value)])
    assert.deepEqual(ini.parse(actual), ini.parse(ini.stringify({ x: value })))
  }
  const actual = edit('x=old\n', [set('x', values)])
  assert.deepEqual(ini.parse(actual), ini.parse(ini.stringify({ x: values })))
})

test('invalid source, operations, names and values reject with TypeError', () => {
  feature()
  for (const source of [null, undefined, {}, 1])
    assert.throws(() => ini.edit(source, []), TypeError)
  for (const operations of [null, {}, 'set'])
    assert.throws(() => ini.edit('x=1', operations), TypeError)
  const invalid = [
    null,
    {},
    { op: 'move', key: 'x' },
    { op: 'set', key: 'x' },
    set('', 1),
    set('__proto__', 1),
    set('x[]', 1),
    set('x\nboom', 1),
    set('x\0', 1),
    set('x', 1, '__proto__'),
    set('x', 1, 'bad\rname'),
    set('x', 1, null),
    set('x', NaN),
    set('x', Infinity),
    set('x', {}),
    set('x', [['nested']]),
    set('x', [undefined]),
  ]
  for (const operation of invalid)
    assert.throws(() => ini.edit('x=1\n', [set('x', 2), operation]), TypeError)
  assert.equal(Object.prototype.polluted, undefined)
})

test('existing exports and the runnable example remain usable', async () => {
  feature()
  for (const name of ['parse', 'decode', 'stringify', 'encode', 'safe', 'unsafe'])
    assert.equal(typeof ini[name], 'function')
  assert.deepEqual(ini.decode('a=1\n'), ini.parse('a=1\n'))
  const readme = await readFile(resolve('README.md'), 'utf8')
  assert.match(readme, /\bedit\b/u)
  const result = await runFileExample({
    cwd: process.cwd(),
    entry: 'examples/edit.js',
    filename: 'settings.ini',
    fixture: '; retained comment\r\n[server]\r\nport = 80\r\nlegacy = true\r\nuntouched = yes\r\n',
  })
  assert.equal(result.passed, true, JSON.stringify(result.attempts))
})
