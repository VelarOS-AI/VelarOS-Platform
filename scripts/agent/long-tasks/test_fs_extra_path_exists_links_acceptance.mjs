import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const api = createRequire(join(root, 'package.json'))('./lib/index.js')

async function fixture(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'path-exists-links-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  await fs.writeFile(join(dir, 'file'), 'unchanged')
  await fs.mkdir(join(dir, 'folder'))
  await fs.symlink('absent', join(dir, 'dangling'))
  await fs.symlink('file', join(dir, 'live'))
  await fs.symlink('folder', join(dir, 'directory-link'))
  return dir
}

async function callback(call, expected) {
  let synchronous = true
  let calls = 0
  let failure
  let timer
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('callback did not settle')), 3000)
      call((error, value) => {
        calls++
        try {
          assert.equal(synchronous, false)
          assert.equal(error, null)
          assert.equal(value, expected)
        } catch (error) {
          failure = error
        }
        resolve()
      })
      synchronous = false
    })
    await nextTurn()
    if (failure) throw failure
    assert.equal(calls, 1)
  } finally {
    clearTimeout(timer)
  }
}

test('non-following checks recognize dangling links in Promise and sync forms', async (t) => {
  const dir = await fixture(t)
  const path = join(dir, 'dangling')
  assert.equal(
    await api.pathExists(path, { followSymlinks: false }),
    true,
    'non-following checks must recognize dangling symlinks'
  )
  assert.equal(api.pathExistsSync(path, { followSymlinks: false }), true)
})

test('default and explicit following policies keep target-existence behavior', async (t) => {
  const dir = await fixture(t)
  for (const options of [undefined, {}, { followSymlinks: undefined }, { followSymlinks: true }]) {
    assert.equal(await api.pathExists(join(dir, 'dangling'), options), false)
    assert.equal(api.pathExistsSync(join(dir, 'dangling'), options), false)
    assert.equal(await api.pathExists(join(dir, 'live'), options), true)
  }
})

test('files, directories, missing entries and ENOTDIR preserve boolean semantics', async (t) => {
  const dir = await fixture(t)
  for (const followSymlinks of [true, false]) {
    for (const [name, exists] of [
      ['file', true],
      ['folder', true],
      ['live', true],
      ['directory-link', true],
      ['absent', false],
      ['file/child', false],
    ]) {
      assert.equal(await api.pathExists(join(dir, name), { followSymlinks }), exists)
      assert.equal(api.pathExistsSync(join(dir, name), { followSymlinks }), exists)
    }
  }
})

test('Buffer and file URL paths work with both policies', async (t) => {
  const dir = await fixture(t)
  for (const convert of [(value) => Buffer.from(value), pathToFileURL]) {
    const path = convert(join(dir, 'dangling'))
    assert.equal(await api.pathExists(path, { followSymlinks: false }), true)
    assert.equal(api.pathExistsSync(path, { followSymlinks: false }), true)
    assert.equal(await api.pathExists(path), false)
    assert.equal(api.pathExistsSync(path), false)
  }
})

test('callbacks preserve old signatures and settle once asynchronously', async (t) => {
  const dir = await fixture(t)
  await callback((cb) => api.pathExists(join(dir, 'file'), cb), true)
  await callback((cb) => api.pathExists(join(dir, 'dangling'), cb), false)
  await callback((cb) => api.pathExists(join(dir, 'dangling'), { followSymlinks: false }, cb), true)
  await callback((cb) => api.pathExists(join(dir, 'absent'), { followSymlinks: false }, cb), false)
})

test('frozen options and filesystem inputs remain intact', async (t) => {
  const dir = await fixture(t)
  const options = Object.freeze({ followSymlinks: false })
  assert.equal(await api.pathExists(join(dir, 'dangling'), options), true)
  assert.equal(api.pathExistsSync(join(dir, 'dangling'), options), true)
  assert.deepEqual(options, { followSymlinks: false })
  assert.equal(await fs.readlink(join(dir, 'dangling')), 'absent')
  assert.equal(await fs.readFile(join(dir, 'file'), 'utf8'), 'unchanged')
})

test('ESM exports support the same Promise, callback and sync forms', async (t) => {
  const dir = await fixture(t)
  const esm = await import(pathToFileURL(join(root, 'lib/esm.mjs')))
  const path = join(dir, 'dangling')
  assert.equal(await esm.pathExists(path, { followSymlinks: false }), true)
  assert.equal(esm.pathExistsSync(path, { followSymlinks: false }), true)
  await callback((cb) => esm.pathExists(path, { followSymlinks: false }, cb), true)
})
