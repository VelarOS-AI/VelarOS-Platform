import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { workspaceChanges } from './workspace-changes.mjs'

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
  await git('checkout', '--orphan', 'unrelated')
  await git('commit', '-qm', 'Other repository')
  await assert.rejects(workspaceChanges(cwd), /Historical task root/u)
})
