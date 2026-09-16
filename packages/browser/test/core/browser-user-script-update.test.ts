// 用途：钉住用户脚本「改代码或执行范围要重新确认」这条承诺不被半截状态绕开。
// 老写法先写代码后校验：update 同时带上新代码和一条非法 match 时，报错返回，索引里的
// revision / enabled 一个没动，磁盘上的代码却已经换成没人确认的新版本——下次注入就跑它。
import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import { BrowserUserScriptManager } from '../../src/core/BrowserUserScriptManager.js'
import type { BrowserSiteContext } from '../../src/core/types.js'

const context = {
  url: 'https://example.test/',
  workspaceRoot: '/tmp/velaros-browser-user-scripts',
} as unknown as BrowserSiteContext

/** 内存假存储：每次读写都让出一次事件循环，好把「读改写回」交错暴露出来。 */
function createMemoryAccess() {
  const files = new Map<string, string>()
  const access = {
    readFile: async (path: string) => {
      await Promise.resolve()
      const content = files.get(path)
      if (content === undefined) throw new AppError('NOT_FOUND', '找不到文件。')
      return {
        path,
        content,
        totalLines: content.split('\n').length,
        startLine: 1,
        endLine: content.split('\n').length,
        totalChars: content.length,
        returnedChars: content.length,
        truncated: false,
      }
    },
    writeFile: async (path: string, content: string) => {
      await Promise.resolve()
      const created = !files.has(path)
      files.set(path, content)
      return { path, bytes: content.length, created, changed: true }
    },
    deleteFile: async (path: string) => {
      await Promise.resolve()
      const deleted = files.delete(path)
      return { path, deleted }
    },
  }

  return { files, access }
}

function createManager() {
  const { files, access } = createMemoryAccess()
  return { files, manager: new BrowserUserScriptManager(access as never) }
}

void describe('用户脚本的修改事务', () => {
  void test('校验失败时代码与索引都不动', async () => {
    const { files, manager } = createManager()
    const created = await manager.createScript(
      context,
      { name: 'demo', code: 'console.log("v1")', match: ['https://example.test/*'] },
      { source: 'agent', enabled: false }
    )
    await manager.setScriptEnabled(context, created.script.id, true)

    await assert.rejects(
      manager.updateScript(
        context,
        created.script.id,
        { code: 'alert("unconfirmed v2")', match: ['file:///*'] },
        { disableAfterExecutionChange: true }
      ),
      /match 只支持 http\/https 浏览器 match pattern/u
    )

    const overview = await manager.getOverview(context)
    const record = overview.scripts.find((script) => script.id === created.script.id)!
    assert.equal(record.enabled, true)
    assert.equal(record.revision, 1)
    assert.equal(files.get(record.relativePath), 'console.log("v1")\n')
  })

  void test('校验通过时代码与索引一起更新，并按宿主策略停用', async () => {
    const { files, manager } = createManager()
    const created = await manager.createScript(
      context,
      { name: 'demo', code: 'console.log("v1")', match: ['https://example.test/*'] },
      { source: 'agent', enabled: false }
    )
    await manager.setScriptEnabled(context, created.script.id, true)

    const updated = await manager.updateScript(
      context,
      created.script.id,
      { code: 'console.log("v2")', match: ['https://example.test/list/*'] },
      { disableAfterExecutionChange: true }
    )

    assert.equal(updated.script.enabled, false)
    assert.equal(updated.script.revision, 2)
    assert.equal(updated.refreshRequired, true)
    assert.equal(files.get(updated.script.relativePath), 'console.log("v2")\n')
  })

  void test('索引写入失败时代码回滚到修改之前', async () => {
    const { files, access } = createMemoryAccess()
    const manager = new BrowserUserScriptManager(access as never)
    const created = await manager.createScript(
      context,
      { name: 'demo', code: 'console.log("v1")', match: ['https://example.test/*'] },
      { source: 'agent', enabled: false }
    )

    const writeFile = access.writeFile
    access.writeFile = async (path: string, content: string) => {
      if (path === 'scripts/index.json') throw new AppError('PERMISSION', '磁盘只读。')
      return writeFile(path, content)
    }

    await assert.rejects(
      manager.updateScript(context, created.script.id, { code: 'console.log("v2")' }, {}),
      /磁盘只读/u
    )
    assert.equal(files.get(created.script.relativePath), 'console.log("v1")\n')
  })

  void test('并发修改不丢更新', async () => {
    const { manager } = createManager()

    const [first, second] = await Promise.all([
      manager.createScript(
        context,
        { name: 'first', code: 'console.log(1)', match: ['https://example.test/*'] },
        { source: 'user', enabled: false }
      ),
      manager.createScript(
        context,
        { name: 'second', code: 'console.log(2)', match: ['https://example.test/*'] },
        { source: 'user', enabled: false }
      ),
    ])

    await Promise.all([
      manager.setScriptEnabled(context, first.script.id, true),
      manager.updateScript(context, second.script.id, { version: '2.0.0' }, {}),
    ])

    const overview = await manager.getOverview(context)
    assert.equal(overview.scripts.length, 2)
    assert.equal(overview.scripts.find((script) => script.id === first.script.id)?.enabled, true)
    assert.equal(
      overview.scripts.find((script) => script.id === second.script.id)?.version,
      '2.0.0'
    )
  })
})
