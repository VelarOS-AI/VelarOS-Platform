// 冻结的独立验收：完整事务、路径边界与实际发布模块。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { pathToFileURL } from 'node:url'
const root = process.cwd()
const require = createRequire(root + '/package.json')
const diff = require(root + '/lib/index.js')
const apply = (...args) => {
  assert.equal(typeof diff.applyPatchSet, 'function', 'new public API must be exported')
  assert.equal(typeof diff.PatchSetError, 'function')
  return diff.applyPatchSet(...args)
}
const patch = (oldName, newName, before, after) =>
  diff.createTwoFilesPatch(oldName, newName, before, after)
function failure(files, patches, options, code, index) {
  const original = [...files]
  assert.throws(
    () => apply(files, patches, options),
    (error) =>
      error instanceof diff.PatchSetError && error.code === code && error.patchIndex === index
  )
  assert.deepEqual([...files], original)
}
test('new public API must be exported', () => assert(apply(new Map(), '') instanceof Map))
test('create, update, rename and delete in one immutable transaction', () => {
  const files = new Map([
    ['a', 'one\n'],
    ['remove', 'bye\n'],
    ['untouched', 'yes'],
  ])
  const text =
    patch('/dev/null', 'new', '', 'new\n') +
    patch('new', 'new', 'new\n', 'next\n') +
    patch('a', 'renamed', 'one\n', 'two\n') +
    '--- remove\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-bye\n'
  const parsed = diff.parsePatch(text)
  const before = JSON.stringify(parsed)
  const result = apply(files, parsed)
  assert.deepEqual([...result].sort(), [
    ['new', 'next\n'],
    ['renamed', 'two\n'],
    ['untouched', 'yes'],
  ])
  assert.deepEqual(
    [...files],
    [
      ['a', 'one\n'],
      ['remove', 'bye\n'],
      ['untouched', 'yes'],
    ]
  )
  assert.equal(JSON.stringify(parsed), before)
  assert.deepEqual(apply(files, parsed), result)
})
test('a later failed hunk cannot commit an earlier successful edit', () => {
  const files = new Map([
    ['a', 'one\n'],
    ['b', 'two\n'],
  ])
  failure(
    files,
    patch('a', 'a', 'one\n', 'changed\n') + patch('b', 'b', 'wrong\n', 'changed\n'),
    {},
    'PATCH_FAILED',
    1
  )
})
for (const path of [
  '../escape',
  'a/../escape',
  '/absolute',
  './same',
  'a/./b',
  'a\\b',
  'C:/drive',
  'a\u0000b',
])
  test(`reject path ${JSON.stringify(path)}`, () =>
    failure(
      new Map(),
      [{ oldFileName: '/dev/null', newFileName: path, hunks: [] }],
      {},
      'INVALID_PATH',
      0
    ))
test('strip normalization and validation happen before map lookup', () => {
  const files = new Map([['src/a', 'old\n']])
  assert.equal(
    apply(files, patch('a/src/a', 'b/src/a', 'old\n', 'new\n'), { strip: 1 }).get('src/a'),
    'new\n'
  )
  for (const strip of [-1, 1.5, NaN]) failure(files, [], { strip }, 'INVALID_PATH', -1)
  failure(files, patch('x', 'x', '', ''), { strip: 1 }, 'INVALID_PATH', 0)
})
test('missing source, creation and rename collisions preserve input', () => {
  const files = new Map([
    ['a', 'A\n'],
    ['b', 'B\n'],
  ])
  failure(files, patch('missing', 'new', 'x\n', 'y\n'), {}, 'MISSING_FILE', 0)
  failure(files, patch('/dev/null', 'a', '', 'X\n'), {}, 'TARGET_EXISTS', 0)
  failure(files, patch('a', 'b', 'A\n', 'B\n'), {}, 'TARGET_EXISTS', 0)
})
test('empty files, empty set, and deletion semantics are preserved', () => {
  const files = new Map([
    ['empty', ''],
    ['full', 'line\n'],
  ])
  for (const set of ['', []]) {
    const result = apply(files, set)
    assert.deepEqual(result, files)
    assert.notEqual(result, files)
  }
  const renamed = apply(files, [{ oldFileName: 'empty', newFileName: 'renamed', hunks: [] }])
  assert.equal(renamed.get('renamed'), '')
  assert(!renamed.has('empty'))
  failure(files, patch('full', '/dev/null', 'line\n', 'remaining\n'), {}, 'INVALID_PATCH', 0)
  failure(
    files,
    [{ oldFileName: '/dev/null', newFileName: '/dev/null', hunks: [] }],
    {},
    'INVALID_PATCH',
    0
  )
})
test('newline and matching options use the existing patch engine results', () => {
  for (const [before, after] of [
    ['a', 'b'],
    ['a\r\nb\r\n', 'a\r\nc\r\n'],
    ['', 'new'],
    ['a\n', ''],
  ]) {
    const text = patch('x', 'x', before, after)
    assert.equal(apply(new Map([['x', before]]), text).get('x'), diff.applyPatch(before, text))
  }
  const text = patch('x', 'x', 'HELLO\n', 'after\n')
  const options = {
    compareLine: (_n, line, _op, expected) => line.toLowerCase() === expected.toLowerCase(),
  }
  assert.equal(apply(new Map([['x', 'hello\n']]), text, options).get('x'), 'after\n')
})
test('rebuilt ESM and browser bundles expose the same transaction', async () => {
  const module = await import(pathToFileURL(root + '/lib/index.mjs'))
  const context = vm.createContext({ Map })
  vm.runInContext(readFileSync(root + '/dist/diff.js', 'utf8'), context)
  for (const api of [module, context.Diff]) {
    assert.equal(typeof api.applyPatchSet, 'function')
    assert.equal(typeof api.PatchSetError, 'function')
    assert.equal(
      api.applyPatchSet(new Map([['a', 'a\n']]), patch('a', 'b', 'a\n', 'b\n')).get('b'),
      'b\n'
    )
  }
})
