// 用途：钉住站点工作区换粒度（按会话 → 按站点）时的「写新读旧」契约。
// 没有这层回退，用户攒了半年的 recipe / 快照会在一次发版后从制品面板里整批消失——
// 文件还在盘上，界面上却等价于「资产没了」，而任何门都不会红。
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, test } from 'bun:test'

import { createBrowserSiteWorkspaceFileAccess } from '../../src/core/BrowserWorkspaceFileAccess.js'

async function createSiteRoots(): Promise<{
  siteRoot: string
  legacyRoot: string
}> {
  const base = await mkdtemp(join(tmpdir(), 'velaros-browser-site-'))
  const siteRoot = join(base, 'browser-sites', 'example-com-abc')
  const legacyRoot = join(base, 'session', 'browser', 'example-com-abc')
  mkdirSync(join(siteRoot, 'recipes'), { recursive: true })
  mkdirSync(join(legacyRoot, 'recipes'), { recursive: true })
  return { siteRoot, legacyRoot }
}

void describe('浏览器站点工作区的历史根回退', () => {
  void test('主根没有的文件从历史根读出来', async () => {
    const { siteRoot, legacyRoot } = await createSiteRoots()
    await writeFile(
      join(legacyRoot, 'recipes', 'old.json'),
      '{"title":"old"}',
      'utf8',
    )

    const access = createBrowserSiteWorkspaceFileAccess({
      workspaceRoot: siteRoot,
      legacyWorkspaceRoots: [legacyRoot],
    })
    const file = await access.readFile('recipes/old.json')

    assert.equal(file.content, '{"title":"old"}')
  })

  void test('同名文件以主根为准，历史根不覆盖新内容', async () => {
    const { siteRoot, legacyRoot } = await createSiteRoots()
    await writeFile(join(siteRoot, 'recipes', 'same.json'), 'new', 'utf8')
    await writeFile(join(legacyRoot, 'recipes', 'same.json'), 'old', 'utf8')

    const access = createBrowserSiteWorkspaceFileAccess({
      workspaceRoot: siteRoot,
      legacyWorkspaceRoots: [legacyRoot],
    })

    assert.equal((await access.readFile('recipes/same.json')).content, 'new')
  })

  void test('列目录取并集，同名相对路径只出现一次', async () => {
    const { siteRoot, legacyRoot } = await createSiteRoots()
    await writeFile(join(siteRoot, 'recipes', 'a.json'), 'a', 'utf8')
    await writeFile(join(siteRoot, 'recipes', 'shared.json'), 'new', 'utf8')
    await writeFile(join(legacyRoot, 'recipes', 'b.json'), 'b', 'utf8')
    await writeFile(join(legacyRoot, 'recipes', 'shared.json'), 'old', 'utf8')

    const access = createBrowserSiteWorkspaceFileAccess({
      workspaceRoot: siteRoot,
      legacyWorkspaceRoots: [legacyRoot],
    })
    const entries = await access.listFiles({
      path: 'recipes',
      recursive: true,
      limit: 50,
    })
    const names = entries.map((entry) => entry.path.split('/').at(-1)).sort()

    assert.deepEqual(names, ['a.json', 'b.json', 'shared.json'])
    // 同名条目必须指向主根那一份：历史根只补缺，不覆盖。
    const realSiteRoot = await realpath(siteRoot)
    const sharedEntry = entries.find((entry) =>
      entry.path.endsWith('shared.json'),
    )
    assert.ok(sharedEntry?.path.startsWith(realSiteRoot))
  })

  void test('写入永远只落主根，历史根保持只读', async () => {
    const { siteRoot, legacyRoot } = await createSiteRoots()
    await writeFile(join(legacyRoot, 'recipes', 'old.json'), 'old', 'utf8')

    const access = createBrowserSiteWorkspaceFileAccess({
      workspaceRoot: siteRoot,
      legacyWorkspaceRoots: [legacyRoot],
    })
    await access.writeFile('recipes/old.json', 'rewritten', {
      overwrite: true,
    })

    assert.equal(
      await readFile(join(siteRoot, 'recipes', 'old.json'), 'utf8'),
      'rewritten',
    )
    assert.equal(
      await readFile(join(legacyRoot, 'recipes', 'old.json'), 'utf8'),
      'old',
    )
  })

  void test('历史根里的绝对路径仍可预览，不被判越权', async () => {
    const { siteRoot, legacyRoot } = await createSiteRoots()
    const legacyFile = join(legacyRoot, 'recipes', 'old.json')
    await writeFile(legacyFile, 'old', 'utf8')

    const access = createBrowserSiteWorkspaceFileAccess({
      workspaceRoot: siteRoot,
      legacyWorkspaceRoots: [legacyRoot],
    })

    assert.equal((await access.readWorkspacePath(legacyFile)).content, 'old')
  })

  void test('历史绝对路径与主根同名时仍读取指定的历史文件', async () => {
    const { siteRoot, legacyRoot } = await createSiteRoots()
    const legacyFile = join(legacyRoot, 'recipes', 'same.json')
    await writeFile(join(siteRoot, 'recipes', 'same.json'), 'new', 'utf8')
    await writeFile(legacyFile, 'old', 'utf8')

    const access = createBrowserSiteWorkspaceFileAccess({
      workspaceRoot: siteRoot,
      legacyWorkspaceRoots: [legacyRoot],
    })

    assert.equal((await access.readWorkspacePath(legacyFile)).content, 'old')
  })

  void test('删除只作用于主根，历史根永远保持只读', async () => {
    const { siteRoot, legacyRoot } = await createSiteRoots()
    const legacyFile = join(legacyRoot, 'recipes', 'old.json')
    await writeFile(legacyFile, 'old', 'utf8')

    const access = createBrowserSiteWorkspaceFileAccess({
      workspaceRoot: siteRoot,
      legacyWorkspaceRoots: [legacyRoot],
    })
    const result = await access.deleteFile('recipes/old.json')

    assert.equal(result.deleted, false)
    assert.equal(await readFile(legacyFile, 'utf8'), 'old')
  })

  void test('没有历史根时行为与从前逐字一致', async () => {
    const { siteRoot } = await createSiteRoots()
    await writeFile(join(siteRoot, 'recipes', 'a.json'), 'a', 'utf8')

    const access = createBrowserSiteWorkspaceFileAccess({
      workspaceRoot: siteRoot,
    })
    const entries = await access.listFiles({ path: 'recipes', limit: 50 })

    assert.equal(entries.length, 1)
    assert.equal((await access.readFile('recipes/a.json')).content, 'a')
  })
})
