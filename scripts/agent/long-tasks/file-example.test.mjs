import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { runFileExample } from './file-example.mjs'

async function example(t, source) {
  const cwd = await mkdtemp(join(tmpdir(), 'file-example-control-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const entry = join(cwd, 'example.cjs')
  if (source !== null) await writeFile(entry, source)
  return { cwd, entry, filename: 'sample.ini', fixture: '\uFEFF; 保留\r\n[app]\r\nport=80\n' }
}

test('self-contained examples run without imposing extra arguments', async (t) => {
  const options = await example(
    t,
    "if (process.argv.length !== 2) process.exit(2); console.log('example ran')"
  )
  const result = await runFileExample(options)
  assert.equal(result.passed, true)
  assert.equal(result.attempts.length, 1)
  assert.match(result.attempts[0].stdout, /example ran/)
})

test('file-input examples receive an actual isolated fixture and both outcomes are retained', async (t) => {
  const source =
    "if (!process.argv[2]) { console.error('usage: example FILE'); process.exit(2) }; process.stdout.write(require('node:fs').readFileSync(process.argv[2]));"
  const options = await example(t, source)
  const result = await runFileExample(options)
  assert.equal(result.passed, true)
  assert.deepEqual(
    result.attempts.map((item) => item.exitCode),
    [2, 0]
  )
  assert.equal(result.attempts[1].stdout, options.fixture)
  assert.equal(existsSync(result.attempts[1].arguments[0]), false)
  assert.equal(await readFile(options.entry, 'utf8'), source)
})

for (const [name, source] of [
  ['missing entry', null],
  ['syntax error', 'this is not valid JavaScript !'],
  ['runtime failure', "throw new Error('broken example')"],
])
  test(`${name} cannot pass through an input-file retry`, async (t) => {
    const result = await runFileExample(await example(t, source))
    assert.equal(result.passed, false)
    assert.equal(result.attempts.length, 2)
    assert(result.attempts.every((item) => item.exitCode !== 0))
  })

test('a timed-out example is stopped without launching another invocation', async (t) => {
  const result = await runFileExample({
    ...(await example(t, 'setInterval(() => {}, 1000)')),
    timeoutMs: 50,
  })
  assert.equal(result.passed, false)
  assert.equal(result.attempts.length, 1)
  assert.equal(result.attempts[0].timedOut, true)
})
