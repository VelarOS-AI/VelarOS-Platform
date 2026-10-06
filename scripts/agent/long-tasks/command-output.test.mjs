import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runGuardedCommand } from '../../release/safe-package-pack.mjs'
import { runCapturedCommand } from './command-output.mjs'

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'captured-check-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('immediate exit preserves large stdout and stderr with Unicode and trailing markers', async (t) => {
  const cwd = await workspace(t)
  const result = await runCapturedCommand(
    process.execPath,
    [
      '-e',
      `
    process.stdout.write(JSON.stringify({ value: '记录'.repeat(400000), end: 'stdout-end' }));
    process.stderr.write(JSON.stringify({ value: 'error'.repeat(300000), end: 'stderr-end' }));
    process.exit(0);
  `,
    ],
    { cwd }
  )
  assert.equal(result.exitCode, 0)
  assert.equal(result.signal, null)
  assert.equal(result.timedOut, false)
  assert.deepEqual(JSON.parse(result.stdout), { value: '记录'.repeat(400000), end: 'stdout-end' })
  assert.deepEqual(JSON.parse(result.stderr), { value: 'error'.repeat(300000), end: 'stderr-end' })
  assert.deepEqual(await readdir(cwd), [])
})

test('a failed command keeps its numeric exit status and both diagnostic streams', async (t) => {
  const result = await runCapturedCommand(
    process.execPath,
    [
      '-e',
      `
    console.log('before failure'); console.error('failure details'); process.exit(7);
  `,
    ],
    { cwd: await workspace(t) }
  )
  assert.equal(result.exitCode, 7)
  assert.equal(result.signal, null)
  assert.equal(result.stdout, 'before failure\n')
  assert.equal(result.stderr, 'failure details\n')
  assert.equal(result.timedOut, false)
  assert.match(result.error, /7/u)
})

test('missing executables are failures without a fabricated numeric status', async (t) => {
  const cwd = await workspace(t)
  const result = await runCapturedCommand(join(cwd, 'missing-command'), [], { cwd })
  assert.equal(result.exitCode, null)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
  assert.equal(result.timedOut, false)
  assert.match(result.error, /Failed to start/u)
})

test('output limits bound retained bytes and cannot turn a truncated report into success', async (t) => {
  const result = await runCapturedCommand(
    process.execPath,
    [
      '-e',
      `
    process.stdout.write('a'.repeat(5000)); process.stderr.write('complete'); process.exit(0);
  `,
    ],
    { cwd: await workspace(t), maxBuffer: 1000 }
  )
  assert.equal(result.exitCode, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
  assert([0, null].includes(result.processExitCode))
  assert.deepEqual(result.outputTruncated, { stdout: true, stderr: false })
  assert.equal(result.stdout, 'a'.repeat(1000))
  assert.equal(result.stderr, 'complete')
})

test('a stream exactly at the retention limit remains complete', async (t) => {
  const result = await runCapturedCommand(
    process.execPath,
    [
      '-e',
      `
    process.stdout.write('a'.repeat(1000)); process.stderr.write('b'.repeat(1000)); process.exit(0);
  `,
    ],
    { cwd: await workspace(t), maxBuffer: 1000 }
  )
  assert.equal(result.exitCode, 0)
  assert.equal(result.outputTruncated, undefined)
  assert.equal(result.stdout.length, 1000)
  assert.equal(result.stderr.length, 1000)
})

test('ongoing oversized output stops the command before its execution timeout', async (t) => {
  const cwd = await workspace(t)
  const started = Date.now()
  const result = await runCapturedCommand(
    process.execPath,
    [
      '-e',
      `
    require('node:fs').writeFileSync('pid', String(process.pid));
    setInterval(() => process.stderr.write('x'.repeat(1024)), 5);
  `,
    ],
    { cwd, maxBuffer: 4096, timeout: 10000 }
  )
  assert.equal(result.exitCode, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
  assert.equal(result.timedOut, false)
  assert.equal(result.stderr.length, 4096)
  assert.equal(result.outputTruncated.stderr, true)
  assert(Date.now() - started < 5000)
  const pid = Number(await readFile(join(cwd, 'pid'), 'utf8'))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

test('a pre-aborted guarded command never starts the child', async (t) => {
  const cwd = await workspace(t)
  await assert.rejects(
    runGuardedCommand({
      command: process.execPath,
      args: ['-e', "require('node:fs').writeFileSync('unexpected', 'started')"],
      cwd,
      signal: AbortSignal.abort(),
    }),
    { name: 'AbortError', cancelled: true }
  )
  assert.deepEqual(await readdir(cwd), [])
})

test('timeout retains partial output and terminates the owned process', async (t) => {
  const cwd = await workspace(t)
  const result = await runCapturedCommand(
    process.execPath,
    [
      '-e',
      `
    require('node:fs').writeFileSync('pid', String(process.pid));
    console.log('started'); setInterval(() => {}, 1000);
  `,
    ],
    { cwd, timeout: 1000 }
  )
  assert.equal(result.exitCode, null)
  assert.equal(result.timedOut, true)
  assert.equal(result.stdout, 'started\n')
  const pid = Number(await readFile(join(cwd, 'pid'), 'utf8'))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

test(
  'signal termination preserves the signal instead of reporting success',
  { skip: process.platform === 'win32' },
  async (t) => {
    const result = await runCapturedCommand(
      process.execPath,
      [
        '-e',
        `
    console.log('before signal'); process.kill(process.pid, 'SIGTERM');
  `,
      ],
      { cwd: await workspace(t) }
    )
    assert.equal(result.exitCode, null)
    assert.equal(result.signal, 'SIGTERM')
    assert.equal(result.timedOut, false)
    assert.equal(result.stdout, 'before signal\n')
  }
)

test('simultaneous checks keep literal arguments and output isolated', async (t) => {
  const cwd = await workspace(t)
  const values = ['first $(literal)', '第二 `text`']
  const results = await Promise.all(
    values.map((value) =>
      runCapturedCommand(
        process.execPath,
        ['-e', 'process.stdout.write(JSON.stringify(process.argv[1])); process.exit(0)', value],
        { cwd }
      )
    )
  )
  for (const [index, result] of results.entries()) {
    assert.equal(result.exitCode, 0)
    assert.equal(JSON.parse(result.stdout), values[index])
  }
  assert.deepEqual(await readdir(cwd), [])
})

test('invalid retention limits fail before starting a command', async () => {
  for (const maxBuffer of [0, -1, 0.5, Number.NaN]) {
    await assert.rejects(runCapturedCommand('missing', [], { maxBuffer }), /maxBuffer/u)
  }
})
