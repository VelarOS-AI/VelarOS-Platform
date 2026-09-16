// 用途：钉住「读清单不写盘」。
// 历史事故：ensureManifest 每次整份重写 manifest.json（只为刷新 lastActivatedAt），
// 而 listArtifacts、writeArtifact、space_manifest 都先调它——声明 effectKind:'read'、
// filesystem.write:'none'、可并发的 browser:space_manifest 每调一次就改一次盘，
// 两个并发的 files action=list_artifacts 还会同时整份写同一个文件。
import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import { BrowserWorkspaceArtifactManager } from '../../src/core/BrowserWorkspaceArtifactManager.js'
import type { BrowserSiteContext } from '../../src/core/types.js'

const context = {
  url: 'https://example.test/list',
  workspaceRoot: '/tmp/velaros-browser-site',
} as unknown as BrowserSiteContext

function createManager() {
  const files = new Map<string, string>()
  const writes: string[] = []
  const access = {
    readFile: async (path: string) => {
      const content = files.get(path)
      if (content === undefined) {
        throw Object.assign(new Error('找不到文件。'), { code: 'NOT_FOUND' })
      }
      return {
        path,
        content,
        totalLines: 1,
        startLine: 1,
        endLine: 1,
        totalChars: content.length,
        returnedChars: content.length,
        truncated: false,
      }
    },
    writeFile: async (path: string, content: string) => {
      writes.push(path)
      files.set(path, content)
      return { path, bytes: content.length, created: true, changed: true }
    },
    listFiles: async () => [],
  }

  return { files, writes, manager: new BrowserWorkspaceArtifactManager(access as never) }
}

void describe('站点工作区清单', () => {
  void test('已经是当前站点的清单，读多少次都不写盘', async () => {
    const { manager, writes } = createManager()

    await manager.activateManifest(context)
    assert.deepEqual(writes, ['manifest.json'])

    await manager.getManifest(context)
    await manager.ensureManifest(context)
    await manager.listArtifacts({ context, limit: 20 })

    assert.deepEqual(writes, ['manifest.json'])
  })

  void test('清单缺失时补写一份', async () => {
    const { manager, writes } = createManager()

    const manifest = await manager.getManifest(context)

    assert.equal(manifest.siteOrigin, 'https://example.test')
    assert.deepEqual(writes, ['manifest.json'])
  })

  void test('清单不是当前站点的就重建', async () => {
    const { manager, writes } = createManager()
    await manager.activateManifest(context)

    await manager.ensureManifest({
      url: 'https://other.test/',
      workspaceRoot: '/tmp/velaros-browser-site',
    } as unknown as BrowserSiteContext)

    assert.deepEqual(writes, ['manifest.json', 'manifest.json'])
  })

  void test('进入站点刷新 lastActivatedAt，createdAt 保持首次创建时间', async () => {
    const { manager } = createManager()

    const created = await manager.activateManifest(context)
    await new Promise((resolve) => setTimeout(resolve, 2))
    const reactivated = await manager.activateManifest(context)

    assert.equal(reactivated.createdAt, created.createdAt)
    assert.ok(reactivated.lastActivatedAt >= created.lastActivatedAt)
  })

  void test('产物记录的 savedAt 是落盘时刻，不是上次进入站点的时刻', async () => {
    const { manager } = createManager()
    const activated = await manager.activateManifest(context)
    await new Promise((resolve) => setTimeout(resolve, 2))

    const record = await manager.writeArtifact({
      context,
      kind: 'extract',
      format: 'json',
      content: '{}\n',
      name: 'demo',
    })

    assert.ok(record.savedAt > activated.lastActivatedAt)
  })
})
