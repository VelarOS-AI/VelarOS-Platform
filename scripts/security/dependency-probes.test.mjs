import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

import {
  assertBracesPatch,
  assertInstalledDependencyRepairs,
  installedDependencyGraph,
} from './dependency-probes.mjs'

const root = resolve(import.meta.dirname, '../..')
const manifests = ['script', 'velaros'].map((name) => join(root, 'packages', name, 'package.json'))
const scriptRequire = createRequire(manifests[0])

test('all reachable copies are patched and standard brace semantics remain compatible', () => {
  assert(assertInstalledDependencyRepairs(manifests) > 0)
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
  const { globby, globbySync, globbyStream } = await import(scriptRequire.resolve('globby'))
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
