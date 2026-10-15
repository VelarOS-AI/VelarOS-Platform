import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { workspaceChanges } from './workspace-changes.mjs'
import { preserveWorkspaceEvidence } from './workspace-evidence.mjs'

test('evidence admission counts only the actual patch, new artifacts and manifest before writing', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'long-task-evidence-budget-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const execute = promisify(execFile)
  const git = async (...args) =>
    (
      await execute(
        'git',
        ['-c', 'user.name=Evaluation', '-c', 'user.email=evaluation@localhost', ...args],
        { cwd }
      )
    ).stdout.trim()
  await git('init', '-q')
  await writeFile(join(cwd, '.gitignore'), '*.ignored\n')
  await writeFile(join(cwd, 'source.txt'), 'before\n')
  await git('add', '.')
  await git('commit', '-qm', 'baseline')
  const baseline = await git('rev-parse', 'HEAD')
  await writeFile(join(cwd, 'source.txt'), 'after\n')
  await writeFile(join(cwd, 'result.txt'), 'new artifact\n')
  await writeFile(join(cwd, 'large.ignored'), Buffer.alloc(1024 * 1024))
  const output = await mkdtemp(join(tmpdir(), 'long-task-evidence-output-'))
  t.after(() => rm(output, { recursive: true, force: true }))
  const reason = new Error('admission denied')
  let reserved
  await assert.rejects(
    preserveWorkspaceEvidence(cwd, output, baseline, {
      beforeWrite: (bytes) => {
        reserved = bytes
        throw reason
      },
    }),
    (error) => error === reason
  )
  assert(reserved > 0 && reserved < 64 * 1024)
  await assert.rejects(lstat(join(output, 'source-evidence')), { code: 'ENOENT' })
  const controller = new AbortController()
  await assert.rejects(
    preserveWorkspaceEvidence(cwd, output, baseline, {
      signal: controller.signal,
      beforeWrite: () => controller.abort(reason),
    }),
    (error) => error === reason
  )
  await assert.rejects(lstat(join(output, 'source-evidence')), { code: 'ENOENT' })
  const manifest = await preserveWorkspaceEvidence(cwd, output, baseline)
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    ['result.txt']
  )
  assert.equal(
    await readFile(join(output, 'source-evidence', 'files', 'result.txt'), 'utf8'),
    'new artifact\n'
  )
})

test('task change accounting includes committed, staged, deleted and untracked artifacts', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'long-task-changes-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const execute = promisify(execFile)
  const git = async (...args) =>
    (
      await execute(
        'git',
        ['-c', 'user.name=Evaluation', '-c', 'user.email=evaluation@localhost', ...args],
        { cwd }
      )
    ).stdout.trim()
  const write = (name, body) => writeFile(join(cwd, name), body)
  await git('init', '-q')
  for (const file of ['committed.txt', 'staged.txt', 'working.txt', 'deleted.txt'])
    await write(file, 'before\n')
  await write('.gitignore', '*.ignored\n')
  await git('add', '.')
  await git('commit', '-qm', 'Frozen task baseline')
  const baseline = await git('rev-parse', 'HEAD')
  await write('committed.txt', 'after\n')
  await write('new committed.txt', 'new\n')
  await git('add', '.')
  await git('commit', '-qm', 'Agent progress')
  await write('staged.txt', 'after\n')
  await write('new staged.txt', 'new\n')
  await git('add', '.')
  await write('working.txt', 'after\n')
  await rm(join(cwd, 'deleted.txt'))
  await write('new untracked.txt', 'new\n')
  await write('cache.ignored', 'ignored\n')
  const currentDiff = await git('diff', '--numstat')
  assert(!currentDiff.includes('committed.txt'))
  assert(!currentDiff.includes('staged.txt'))
  const result = await workspaceChanges(cwd, baseline)
  assert.equal(result.changeAccounting.changedFiles, 4)
  assert.equal(result.changeAccounting.createdFiles, 3)
  for (const file of ['committed.txt', 'staged.txt', 'working.txt', 'deleted.txt'])
    assert(result.changed.includes(file))
  assert.equal(result.created, 'new committed.txt\nnew staged.txt\nnew untracked.txt\n')
  assert.equal(result.changeAccounting.source, 'recorded-baseline')
  const historical = await workspaceChanges(cwd)
  assert.equal(historical.changed, result.changed)
  assert.equal(historical.created, result.created)
  assert.equal(historical.changeAccounting.source, 'verified-historical-root')
  const output = await mkdtemp(join(tmpdir(), 'long-task-evidence-'))
  t.after(() => rm(output, { recursive: true, force: true }))
  await write('new-source.ts', 'export const value = 1\n')
  await write('new-binary.bin', Buffer.from([0, 1, 255]))
  const evidence = await preserveWorkspaceEvidence(cwd, output, baseline)
  assert(evidence.files.some((file) => file.path === 'new-source.ts'))
  assert.deepEqual(
    await readFile(join(output, 'source-evidence/files/new-binary.bin')),
    Buffer.from([0, 1, 255])
  )
  const patch = await readFile(join(output, 'source-evidence/tracked.patch'), 'utf8')
  for (const path of [
    'committed.txt',
    'staged.txt',
    'working.txt',
    'deleted.txt',
    'new committed.txt',
    'new staged.txt',
  ])
    assert(patch.includes(path))
  await git('checkout', '--orphan', 'unrelated')
  await git('commit', '-qm', 'Other repository')
  await assert.rejects(workspaceChanges(cwd), /Historical task root/u)
})
