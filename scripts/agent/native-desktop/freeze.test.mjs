// 用途：保证候选覆盖当前构建目录的新产物，并将同一上下文容量写入配对清单。
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  freezeCandidate,
  nativeInputIdentity,
  nativeTestArgs,
  pairedContextTokens,
  verifyAcceptance,
} from './freeze.mjs'
import { snapshotFiles, verifyFrozen } from './controller.mjs'

test('a new build is enumerated from artifact roots rather than stale hashed chunk names', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'native-freeze-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const runtime = join(directory, 'runtime'),
    harness = join(directory, 'harness')
  await mkdir(runtime)
  await mkdir(harness)
  const oldChunk = join(runtime, 'worker-old.js')
  await writeFile(oldChunk, 'old')
  await writeFile(join(harness, 'controller.mjs'), 'controller')
  const previous = { candidate: await snapshotFiles([runtime]) }
  await rm(oldChunk)
  await writeFile(join(runtime, 'worker-new.js'), 'new')
  await writeFile(join(runtime, 'short-reference.js'), 'new tool')
  await assert.rejects(freezeCandidate(previous, [], harness), /artifact roots are required/)
  const current = await freezeCandidate(previous, [runtime], harness)
  assert.deepEqual(
    current.candidate.files.map((file) => file.path).sort(),
    [
      join(harness, 'controller.mjs'),
      join(runtime, 'short-reference.js'),
      join(runtime, 'worker-new.js'),
    ].sort()
  )
  await verifyFrozen(current.candidate)
  assert.deepEqual(await freezeCandidate(current, [], harness), current)
})

test('paired context capacity rejects missing, unsafe, fractional and exhausted input windows', () => {
  assert.equal(pairedContextTokens('1050000'), 1050000)
  assert.equal(pairedContextTokens(128000), 128000)
  for (const value of [
    undefined,
    null,
    '',
    0,
    -1,
    16096,
    17000.5,
    '1e6',
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(() => pairedContextTokens(value), /Invalid paired context/)
})

test('the source command uses the configured native runner without changing its args', () => {
  const base = { python: '/native/python', args: ['app.tests', '--parallel=1'] }
  assert.deepEqual(nativeTestArgs({ ...base, runner: 'django' }), [
    base.python,
    'tests/runtests.py',
    ...base.args,
  ])
  assert.deepEqual(nativeTestArgs({ ...base, runner: 'pytest', pytest_plugins: ['pytester'] }), [
    base.python,
    '-m',
    'pytest',
    '-p',
    'pytester',
    ...base.args,
  ])
  assert.deepEqual(nativeTestArgs({ ...base, runner: 'sympy' }), [
    base.python,
    'bin/test',
    ...base.args,
  ])
  assert.throws(() => nativeTestArgs({ ...base, runner: 'unknown' }), /Unsupported native/)
})

test('zero-model receipts bind task, runner, parser, environment and grading code', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'native-acceptance-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const name of [
    'task.json',
    'test.patch',
    'grade.py',
    'prepare.py',
    'parser.py',
    'constants.py',
  ])
    await writeFile(join(directory, name), name)
  await writeFile(
    join(directory, 'native-test-profile.json'),
    JSON.stringify({
      official_parser: {
        source: join(directory, 'parser.py'),
        constants: join(directory, 'constants.py'),
      },
    })
  )
  const identity = await nativeInputIdentity(directory, directory)
  assert.equal(identity.environmentLockSha256, null)
  const receipt = {
    kind: 'baseline',
    status: 'baseline_verified',
    taskId: 'task',
    modelCalls: 0,
    nativeInputIdentity: identity,
  }
  verifyAcceptance(receipt, 'baseline', 'task', identity)
  for (const key of Object.keys(identity))
    assert.throws(
      () => verifyAcceptance(receipt, 'baseline', 'task', { ...identity, [key]: 'changed' }),
      /does not match current/
    )
  for (const change of [
    { nativeInputIdentity: undefined },
    { nativeInputIdentity: { ...identity, unknown: 'extra' } },
    { kind: 'oracle' },
    { taskId: 'other' },
    { modelCalls: 1 },
  ])
    assert.throws(() => verifyAcceptance({ ...receipt, ...change }, 'baseline', 'task', identity))
  await writeFile(join(directory, 'native-environment-lock.json'), '{}')
  const updated = await nativeInputIdentity(directory, directory)
  assert.throws(
    () => verifyAcceptance(receipt, 'baseline', 'task', updated),
    /does not match current/
  )
})
