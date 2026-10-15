import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { freezeHarness } from './freeze-harness.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'velaros-harness-freeze-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const destination = join(root, 'frozen')
  await mkdir(source)
  return { root, source, destination }
}

test('frozen ESM commands load CommonJS preloads and data after the source tree is removed', async (t) => {
  const { source, destination } = await fixture(t)
  const contents = {
    'runner.mjs':
      "import fs from 'node:fs/promises'; console.log(JSON.stringify({preload:globalThis.preloadValue, data:await fs.readFile(new URL('./fixtures/payload.txt',import.meta.url),'utf8')}))",
    'preload.cjs': "globalThis.preloadValue = require('./helper.js')",
    'helper.js': "module.exports = 'loaded-through-commonjs'",
    'fixtures/payload.txt': '真实冻结数据\n',
    'fixtures/bytes.bin': Buffer.from([0, 127, 255]),
    'fixtures/consumer.ts': 'export const value: string = "consumer"',
    'fixtures/manifest.json': '{"stable":true}',
    'fixtures/check.py': 'print("python")',
    'fixtures/extensionless': 'also required',
  }
  await mkdir(join(source, 'fixtures'))
  for (const [name, content] of Object.entries(contents))
    await writeFile(join(source, name), content)
  for (const name of ['node_modules', '__pycache__', '.git']) {
    await mkdir(join(source, name))
    await writeFile(join(source, name, 'cache'), 'must not be copied')
  }
  const files = await freezeHarness(source, destination)
  assert.equal(Object.keys(files).length, Object.keys(contents).length)
  for (const [name, content] of Object.entries(contents)) {
    assert.equal(files[join(destination, name)], createHash('sha256').update(content).digest('hex'))
    assert.deepEqual(await readFile(join(destination, name)), Buffer.from(content))
  }
  await rm(source, { recursive: true })
  const result = await promisify(execFile)(
    process.execPath,
    ['--require', join(destination, 'preload.cjs'), join(destination, 'runner.mjs')],
    { cwd: destination, timeout: 10000 }
  )
  assert.deepEqual(JSON.parse(result.stdout), {
    preload: 'loaded-through-commonjs',
    data: '真实冻结数据\n',
  })
  assert.equal(result.stderr, '')
})

test('a second freeze cannot replace retained evidence', async (t) => {
  const { source, destination } = await fixture(t)
  await writeFile(join(source, 'preload.cjs'), 'original')
  await freezeHarness(source, destination)
  await writeFile(join(source, 'preload.cjs'), 'changed')
  await assert.rejects(freezeHarness(source, destination), { code: 'EEXIST' })
  assert.equal(await readFile(join(destination, 'preload.cjs'), 'utf8'), 'original')
})

test('external linked dependencies fail during preparation instead of being silently omitted', async (t) => {
  const { root, source, destination } = await fixture(t)
  const outside = join(root, 'outside.cjs')
  await writeFile(outside, 'external')
  await symlink(outside, join(source, 'preload.cjs'))
  await assert.rejects(freezeHarness(source, destination), /must be a regular file/u)
})

test('freezing into the source tree is rejected before recursive copying', async (t) => {
  const { source } = await fixture(t)
  await writeFile(join(source, 'command.mjs'), 'process.exit(0)')
  await assert.rejects(freezeHarness(source, join(source, 'frozen')), /outside its source tree/u)
  await assert.rejects(freezeHarness(source, source), /outside its source tree/u)
})
