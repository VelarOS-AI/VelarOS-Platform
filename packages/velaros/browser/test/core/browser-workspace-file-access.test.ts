import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { test } from 'bun:test'

import { BrowserFileLimits } from '../../contract/constants.js'
import { createBrowserSiteWorkspaceFileAccess } from '../../impl/workspace/BrowserWorkspaceFileAccess.js'

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'velaros-browser-site-'))
  const root = join(base, 'site')
  const outside = join(base, 'outside')
  await mkdir(join(root, 'recipes'), { recursive: true })
  await mkdir(outside)
  return {
    root,
    outside,
    access: createBrowserSiteWorkspaceFileAccess({ workspaceRoot: root }),
    dispose: () => rm(base, { recursive: true, force: true }),
  }
}

test('current workspace files round trip through relative and absolute preview paths', async () => {
  const f = await fixture()
  try {
    const saved = await f.access.writeFile('recipes/current.json', 'current')
    assert.equal((await f.access.readFile('recipes/current.json')).content, 'current')
    assert.equal((await f.access.readWorkspacePath(saved.path)).content, 'current')
    await assert.rejects(f.access.writeFile('recipes/current.json', 'replacement'))
    await f.access.writeFile('recipes/current.json', 'replacement', { overwrite: true })
    assert.equal(await readFile(saved.path, 'utf8'), 'replacement')
  } finally {
    await f.dispose()
  }
})

test('listing includes only the current root and respects nonexistent directories', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, 'recipes', 'a.json'), 'a')
    await writeFile(join(f.root, 'recipes', 'shared.json'), 'current')
    await writeFile(join(f.outside, 'other.json'), 'outside')
    const entries = await f.access.listFiles({ path: 'recipes', recursive: true, limit: 50 })
    assert.deepEqual(entries.map((entry) => basename(entry.path)).sort(), ['a.json', 'shared.json'])
    assert.deepEqual(await f.access.listFiles({ path: 'missing' }), [])
  } finally {
    await f.dispose()
  }
})

test('default text reads respect the declared character limit while explicit larger reads remain available', async () => {
  const f = await fixture()
  try {
    const content = '甲'.repeat(BrowserFileLimits.readChars + 7)
    await writeFile(join(f.root, 'large.txt'), content, 'utf8')
    const bounded = await f.access.readFile('large.txt')
    assert.equal(bounded.content.length, BrowserFileLimits.readChars)
    assert.equal(bounded.returnedChars, BrowserFileLimits.readChars)
    assert.equal(bounded.truncated, true)
    const complete = await f.access.readFile('large.txt', 1, undefined, content.length)
    assert.equal(complete.content, content)
    assert.equal(complete.truncated, false)
  } finally {
    await f.dispose()
  }
})

test('absolute and relative paths outside the workspace are rejected, including list requests', async () => {
  const f = await fixture()
  try {
    const outside = join(f.outside, 'other.json')
    await writeFile(outside, 'outside')
    await assert.rejects(f.access.readWorkspacePath(outside), { code: 'PERMISSION' })
    await assert.rejects(f.access.readFile('../outside/other.json'), { code: 'PERMISSION' })
    await assert.rejects(f.access.listFiles({ path: '../outside' }), { code: 'PERMISSION' })
    assert.equal(await readFile(outside, 'utf8'), 'outside')
  } finally {
    await f.dispose()
  }
})

test('deletion affects only the current workspace and a missing target is explicit', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.outside, 'same.json'), 'outside')
    await f.access.writeFile('recipes/same.json', 'current')
    assert.equal((await f.access.deleteFile('recipes/same.json')).deleted, true)
    assert.equal((await f.access.deleteFile('recipes/same.json')).deleted, false)
    assert.equal(await readFile(join(f.outside, 'same.json'), 'utf8'), 'outside')
  } finally {
    await f.dispose()
  }
})

test('INV-33 rejected writes do not create directories outside the workspace', async () => {
  const f = await fixture()
  try {
    await assert.rejects(f.access.writeFile('../outside/traversed/file.txt', 'x'), {
      code: 'PERMISSION',
    })
    await assert.rejects(access(join(f.outside, 'traversed')), { code: 'ENOENT' })
    await symlink(
      f.outside,
      join(f.root, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await assert.rejects(f.access.writeBinaryFile('linked/created/file.bin', Buffer.from('x')), {
      code: 'PERMISSION',
    })
    await assert.rejects(access(join(f.outside, 'created')), { code: 'ENOENT' })
  } finally {
    await f.dispose()
  }
})
