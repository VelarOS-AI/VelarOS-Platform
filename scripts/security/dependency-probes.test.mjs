import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import {
  assertBracesPatch,
  assertInstalledDependencyRepairs,
  assertMinimatchProtection,
  installedDependencyGraph,
} from './dependency-probes.mjs'

const root = resolve(import.meta.dirname, '../..')
const manifests = ['script', 'velaros'].map((name) => join(root, 'packages', name, 'package.json'))
const scriptRequire = createRequire(manifests[0])

test('all reachable copies are patched and standard brace semantics remain compatible', () => {
  assert(assertInstalledDependencyRepairs(manifests) > 0)
})

test('minimatch guards reject a modified or unreviewed installation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'velaros-minimatch-integrity-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const copy = installedDependencyGraph(manifests).find(
    ({ manifest }) => manifest.name === 'minimatch' && manifest.version === '10.2.6'
  )
  assert(copy)
  await cp(copy.root, directory, { recursive: true, dereference: true })
  await writeFile(join(directory, 'dist/esm/index.js'), '// missing protection')
  assert.throws(() => assertMinimatchProtection(directory), /保护内容变化/)
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'minimatch', version: '10.0.0' })
  )
  assert.throws(() => assertMinimatchProtection(directory), /尚未核验/)
})

test('reachable qs copies safely serialize hostile comma-array elements and preserve normal values', () => {
  const copies = installedDependencyGraph(manifests).filter(
    ({ manifest }) => manifest.name === 'qs'
  )
  assert(copies.length > 0)
  for (const { root: directory } of copies) {
    const qs = createRequire(join(directory, 'package.json'))(directory)
    const inputs = [
      { a: [{ toString: 'x' }] },
      { a: [[{ toString: 'x' }]] },
      qs.parse('a[0][toString]=x', { allowPrototypes: true }),
      qs.parse('a[][b]=c', { plainObjects: true }),
    ]
    for (const input of inputs)
      for (const encodeValuesOnly of [false, true])
        assert.doesNotThrow(() => qs.stringify(input, { arrayFormat: 'comma', encodeValuesOnly }))
    assert.equal(qs.stringify({ a: ['x', 'y'] }, { arrayFormat: 'comma' }), 'a=x%2Cy')
    assert.deepEqual(qs.parse('a[0]=x&a[1]=y'), { a: ['x', 'y'] })
  }
})

test('reachable Hono Node static servers reject a second path decode without bypassing protected middleware', async (t) => {
  const copies = installedDependencyGraph(manifests).filter(
    ({ manifest }) => manifest.name === '@hono/node-server'
  )
  assert(copies.length > 0)
  const directory = await mkdtemp(join(tmpdir(), 'velaros-static-path-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, 'static', 'admin'), { recursive: true })
  await writeFile(join(directory, 'static', 'admin', 'secret.txt'), 'private-fixture')
  await writeFile(join(directory, 'static', 'hello world.txt'), 'public-fixture')
  await writeFile(join(directory, 'static', '中文.txt'), 'unicode-fixture')
  for (const { root: dependencyRoot, manifest } of copies) {
    const require = createRequire(join(dependencyRoot, 'package.json'))
    const { Hono } = require('hono')
    const { serveStatic } = require('@hono/node-server/serve-static')
    const app = new Hono()
    app.use('/static/admin/*', (context) => context.text('denied', 401))
    app.use('/static/*', serveStatic({ root: directory }))
    for (const path of ['/static/admin/secret.txt', '/static/%61dmin/secret.txt']) {
      const response = await app.request(path)
      assert.equal(response.status, 401)
      assert.equal(await response.text(), 'denied')
    }
    const malformed = await app.request('/static/%%36%31dmin/secret.txt')
    assert.equal(
      malformed.status,
      404,
      `${manifest.name}@${manifest.version} must not serve a second-decoded path`
    )
    assert.notEqual(await malformed.text(), 'private-fixture')
    for (const [path, text] of [
      ['/static/hello%20world.txt', 'public-fixture'],
      ['/static/%E4%B8%AD%E6%96%87.txt', 'unicode-fixture'],
    ]) {
      const response = await app.request(path)
      assert.equal(response.status, 200)
      assert.equal(await response.text(), text)
    }
  }
})

test('security gate rejects an altered or missing patch', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'velaros-braces-integrity-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const [{ root: source }] = installedDependencyGraph(manifests).filter(
    ({ manifest }) => manifest.name === 'braces'
  )
  await cp(source, directory, { recursive: true })
  await writeFile(join(directory, 'lib/parse.js'), 'module.exports = value => value\n')
  assert.throws(() => assertBracesPatch(directory), /安全补丁缺失/u)
})

test('Mammoth command line remains compatible with the sprintf-free argument parser', async (t) => {
  const require = createRequire(manifests[1])
  const executable = join(dirname(require.resolve('mammoth/package.json')), 'bin/mammoth')
  const output = execFileSync(process.execPath, [executable, '--help'], {
    encoding: 'utf8',
    timeout: 5000,
  })
  assert.match(output, /--output-format/u)
  const invalid = spawnSync(
    process.execPath,
    [executable, 'example.docx', '--output-format', 'invalid'],
    {
      encoding: 'utf8',
      timeout: 5000,
    }
  )
  assert.equal(invalid.status, 2)
  assert.match(invalid.stderr, /invalid choice/u)
  const directory = await mkdtemp(join(tmpdir(), 'velaros-mammoth-cli-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { Document, Packer, Paragraph } = require('docx')
  const document = new Document({ sections: [{ children: [new Paragraph('CLI 转换验证')] }] })
  const input = join(directory, 'example.docx')
  await writeFile(input, await Packer.toBuffer(document))
  const html = execFileSync(process.execPath, [executable, input, '--output-format', 'html'], {
    encoding: 'utf8',
    timeout: 5000,
  })
  assert.match(html, /<p>CLI 转换验证<\/p>/u)
})

test('globby async, sync and stream APIs preserve matching and reject deeply nested patterns', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'velaros-globby-security-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, 'src'))
  for (const file of ['a.js', 'b.ts', 'ignored.js', '文字.ts'])
    await writeFile(join(directory, 'src', file), 'fixture')
  const { globby, globbySync, globbyStream } = await import(
    pathToFileURL(scriptRequire.resolve('globby')).href
  )
  const patterns = ['src/*.{js,ts}', '!**/ignored.js']
  const options = { cwd: directory }
  const expected = ['src/a.js', 'src/b.ts', 'src/文字.ts']
  assert.deepEqual((await globby(patterns, options)).sort(), expected)
  assert.deepEqual(globbySync(patterns, options).sort(), expected)
  const paths = []
  for await (const path of globbyStream(patterns, options)) paths.push(path)
  assert.deepEqual(paths.sort(), expected)
  const excessive = '{'.repeat(4000) + 'a,b' + '}'.repeat(4000)
  await assert.rejects(globby(excessive, options), /maximum depth/u)
  assert.throws(() => globbySync(excessive, options), /maximum depth/u)
  await assert.rejects(async () => {
    for await (const path of globbyStream(excessive, options)) assert.fail(path)
  }, /maximum depth/u)
})
