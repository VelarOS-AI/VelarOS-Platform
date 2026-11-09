// 用途：钉住用户脚本「改代码或执行范围要重新确认」这条承诺不被半截状态绕开。
// 老写法先写代码后校验：update 同时带上新代码和一条非法 match 时，报错返回，索引里的
// revision / enabled 一个没动，磁盘上的代码却已经换成没人确认的新版本——下次注入就跑它。
import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import { BrowserUserScriptLimits } from '../../contract/constants.js'
import { BrowserUserScriptManager } from '../../impl/workspace/BrowserUserScriptManager.js'
import type { BrowserSiteContext } from '../../types/browser.js'

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

  void test('旧代码不可读时在覆盖前拒绝，不留下新代码与旧启用索引', async () => {
    const { files, access } = createMemoryAccess()
    const manager = new BrowserUserScriptManager(access as never)
    const created = await manager.createScript(
      context,
      { name: 'demo', code: 'console.log("v1")', match: ['https://example.test/*'] },
      { source: 'user', enabled: true }
    )
    const index = files.get('scripts/index.json')
    const readFile = access.readFile
    access.readFile = async (path) => {
      if (path === created.script.relativePath) throw new AppError('PERMISSION', '旧代码不可读。')
      return readFile(path)
    }
    await assert.rejects(
      manager.updateScript(
        context,
        created.script.id,
        { code: 'alert("unconfirmed")' },
        { disableAfterExecutionChange: true }
      ),
      /旧代码不可读/u
    )
    assert.equal(files.get(created.script.relativePath), 'console.log("v1")\n')
    assert.equal(files.get('scripts/index.json'), index)
  })

  void test('INV-34 预停用失败时不改代码，也不掩盖原错误', async () => {
    const { files, access } = createMemoryAccess()
    const manager = new BrowserUserScriptManager(access as never)
    const created = await manager.createScript(
      context,
      { name: 'demo', code: 'console.log("v1")', match: ['https://example.test/*'] },
      { source: 'user', enabled: true }
    )
    const index = files.get('scripts/index.json')
    const writeFile = access.writeFile
    let codeWrites = 0
    access.writeFile = async (path, content) => {
      if (path === 'scripts/index.json') throw new AppError('PERMISSION', '预停用索引不可写。')
      codeWrites++
      return writeFile(path, content)
    }
    await assert.rejects(
      manager.updateScript(context, created.script.id, { code: 'console.log("v2")' }, {}),
      /预停用索引不可写/u
    )
    assert.equal(codeWrites, 0)
    assert.equal(files.get(created.script.relativePath), 'console.log("v1")\n')
    assert.equal(files.get('scripts/index.json'), index)
  })

  void test('INV-34 索引提交与代码回滚同时失败也不留下可自动执行的新代码', async () => {
    const { files, access } = createMemoryAccess()
    const manager = new BrowserUserScriptManager(access as never)
    const created = await manager.createScript(
      context,
      { name: 'demo', code: 'console.log("v1")', match: ['https://example.test/*'] },
      { source: 'user', enabled: true }
    )
    const writeFile = access.writeFile
    let indexWrites = 0
    access.writeFile = async (path, content) => {
      if (path === 'scripts/index.json' && ++indexWrites === 2)
        throw new AppError('PERMISSION', '新版索引提交失败。')
      if (path === created.script.relativePath && content === 'console.log("v1")\n')
        throw new AppError('PERMISSION', '旧代码回滚失败。')
      return writeFile(path, content)
    }
    await assert.rejects(
      manager.updateScript(
        context,
        created.script.id,
        { code: 'console.log("v2")' },
        { disableAfterExecutionChange: true }
      ),
      /新版索引提交失败/u
    )
    assert.equal(files.get(created.script.relativePath), 'console.log("v2")\n')
    assert.equal((await manager.getOverview(context)).scripts[0]?.enabled, false)
    assert.deepEqual(await manager.listRunnable(context.url), [])
  })

  void test('INV-34 执行面未变时不预停用，成功更新仍服从宿主启用策略', async () => {
    const { access } = createMemoryAccess()
    const manager = new BrowserUserScriptManager(access as never)
    const created = await manager.createScript(
      context,
      { name: 'demo', code: 'console.log("v1")', match: ['https://example.test/*'] },
      { source: 'user', enabled: true }
    )
    const enabledWrites: boolean[] = []
    let codeWrites = 0
    const writeFile = access.writeFile
    access.writeFile = async (path, content) => {
      if (path === 'scripts/index.json') {
        const stored = JSON.parse(content) as { scripts: Array<{ enabled: boolean }> }
        enabledWrites.push(stored.scripts[0]!.enabled)
      } else codeWrites++
      return writeFile(path, content)
    }
    const unchanged = await manager.updateScript(
      context,
      created.script.id,
      {
        code: 'console.log("v1")',
        match: ['https://example.test/*'],
        runAt: 'document-end',
        world: 'isolated',
      },
      { disableAfterExecutionChange: true }
    )
    assert.equal(unchanged.refreshRequired, false)
    assert.equal(unchanged.script.enabled, true)
    assert.equal(unchanged.script.revision, 1)
    assert.equal(codeWrites, 0)
    assert.deepEqual(enabledWrites, [true])
    enabledWrites.length = 0
    const updated = await manager.updateScript(
      context,
      created.script.id,
      { code: 'console.log("v2")' },
      {}
    )
    assert.equal(updated.script.enabled, true)
    assert.deepEqual(enabledWrites, [false, true])
  })

  void test('脚本字节预算包含规范化补上的换行', async () => {
    const { files, manager } = createManager()
    await assert.rejects(
      manager.createScript(
        context,
        {
          name: 'too-large-after-normalization',
          code: 'x'.repeat(BrowserUserScriptLimits.codeBytes),
          match: ['https://example.test/*'],
        },
        { source: 'agent', enabled: false }
      ),
      /不能超过 1 MB/u
    )
    assert.equal(files.size, 0)
    const code = `${'x'.repeat(BrowserUserScriptLimits.codeBytes - 1)}\n`
    const created = await manager.createScript(
      context,
      { name: 'exact-budget', code, match: ['https://example.test/*'] },
      { source: 'agent', enabled: false }
    )
    assert.equal((await manager.readScript(context, created.script.id)).code, code)
  })

  void test('自动注入与读取等待修改结算，不能看到新代码与旧启用索引', async () => {
    const { files, access } = createMemoryAccess()
    const manager = new BrowserUserScriptManager(access as never)
    const created = await manager.createScript(
      context,
      { name: 'demo', code: 'console.log("v1")', match: ['https://example.test/*'] },
      { source: 'user', enabled: true }
    )
    let release!: () => void
    let written!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const codeWritten = new Promise<void>((resolve) => {
      written = resolve
    })
    const writeFile = access.writeFile
    access.writeFile = async (path, content) => {
      const result = await writeFile(path, content)
      if (path === created.script.relativePath) {
        written()
        await held
      }
      return result
    }
    const update = manager.updateScript(
      context,
      created.script.id,
      { code: 'console.log("v2")' },
      { disableAfterExecutionChange: true }
    )
    await codeWritten
    let settled = false
    const runnable = manager.listRunnable(context.url).then((result) => {
      settled = true
      return result
    })
    const read = manager.readScript(context, created.script.id)
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(settled, false)
    } finally {
      release()
      await update
    }
    assert.deepEqual(await runnable, [])
    const current = await read
    assert.equal(current.script.enabled, false)
    assert.equal(current.code, 'console.log("v2")\n')
    assert.equal(files.get(created.script.relativePath), current.code)
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

  void test('界面与工具各拿一个 manager 并发修改，也不丢更新', async () => {
    // 宿主按请求建 manager（Desktop 的用户脚本服务每次操作都 new 一个），队列挂在实例上就等于没有队列。
    const { access } = createMemoryAccess()
    const ui = new BrowserUserScriptManager(access as never)
    const tool = new BrowserUserScriptManager(access as never)

    const [first, second] = await Promise.all([
      ui.createScript(
        context,
        { name: 'first', code: 'console.log(1)', match: ['https://example.test/*'] },
        { source: 'user', enabled: false }
      ),
      tool.createScript(
        context,
        { name: 'second', code: 'console.log(2)', match: ['https://example.test/*'] },
        { source: 'user', enabled: false }
      ),
    ])

    await Promise.all([
      ui.setScriptEnabled(context, first.script.id, true),
      tool.updateScript(context, second.script.id, { version: '2.0.0' }, {}),
    ])

    const overview = await new BrowserUserScriptManager(access as never).getOverview(context)
    assert.equal(overview.scripts.length, 2)
    assert.equal(overview.scripts.find((script) => script.id === first.script.id)?.enabled, true)
    assert.equal(
      overview.scripts.find((script) => script.id === second.script.id)?.version,
      '2.0.0'
    )
  })
})
