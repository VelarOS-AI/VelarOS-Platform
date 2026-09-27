/**
 * @test-meta
 * title: 后台页面接管
 * summary: 界面没挂 webview 时向宿主要后台页面，接管后先加载会话的地址再交给在等的操作；界面先挂上、或宿主不给时不接。
 * area: packages
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { test } from 'bun:test'

import { BrowserViewNotAttachedReason } from '../../../dist/browser/contract/constants.js'
import { BrowserSessionManager } from '../../../dist/browser/impl/electron/BrowserSessionManager.js'

class FakeElectronSession extends EventEmitter {}

class FakeWebContents extends EventEmitter {
  constructor(url = 'about:blank') {
    super()
    this.currentUrl = url
    this.destroyed = false
    this.session = new FakeElectronSession()
  }

  setWindowOpenHandler() {}

  getURL() {
    return this.currentUrl
  }

  isDestroyed() {
    return this.destroyed
  }

  executeJavaScript() {
    return Promise.resolve(true)
  }
}

/**
 * 一个会话管理器；给了 page 就当宿主实现了后台页面，记下每次被要的会话。
 * 加载由 load 决定（缺省立刻加载完），记下每次加载的页面与地址。
 */
function createManager(page, load = async () => undefined) {
  const requested = []
  const loads = []
  const callbacks = {}
  if (page !== undefined)
    callbacks.provideBackgroundPage = async (sessionId) => {
      requested.push(sessionId)
      return page
    }
  const manager = new BrowserSessionManager({
    diagnostics: {
      record: () => undefined,
      shouldRecordConsoleMessage: () => false,
      normalizeConsoleLevel: () => 'info',
    },
    pageWaiter: {
      loadUrl: async (webContents, url) => {
        loads.push({ webContents, url })
        await load(webContents, url)
        webContents.currentUrl = url
      },
    },
    normalizeUrl: (url) => new URL(url).toString(),
    callbacks,
  })
  return { manager, requested, loads }
}

void test('界面没挂 webview 时接管宿主给的后台页面：加载会话的地址，同时在等的操作都拿到它，只要一次，标成不可见', async () => {
  const webContents = new FakeWebContents()
  const { manager, requested, loads } = createManager({
    webContents,
    url: 'https://shop.test/books',
  })

  const [first, second] = await Promise.all([
    manager.waitForSession('rt-1', 3000),
    manager.waitForSession('rt-1', 3000),
  ])

  assert.equal(first.webContents, webContents)
  assert.equal(second, first)
  assert.equal(first.visible, false)
  assert.deepEqual(requested, ['rt-1'])
  assert.deepEqual(loads, [{ webContents, url: 'https://shop.test/books' }])
  assert.equal(webContents.getURL(), 'https://shop.test/books')
  manager.dispose()
})

void test('加载比等挂载的时限还久也照样等到：页面有了，只等它加载完', async () => {
  const webContents = new FakeWebContents()
  const { manager } = createManager(
    { webContents, url: 'https://slow.test/' },
    () => new Promise((resolve) => setTimeout(resolve, 900))
  )

  const session = await manager.waitForSession('rt-slow', 600)

  assert.equal(session.webContents, webContents)
  assert.equal(webContents.getURL(), 'https://slow.test/')
  manager.dispose()
})

void test('加载失败也把页面交出去，页面上是什么操作自己看', async () => {
  const webContents = new FakeWebContents()
  const { manager } = createManager({ webContents, url: 'https://down.test/' }, async () => {
    throw new Error('ERR_CONNECTION_REFUSED')
  })

  const session = await manager.waitForSession('rt-down', 3000)

  assert.equal(session.webContents, webContents)
  manager.dispose()
})

void test('加载途中页面被关掉，在等的操作收到会话已关闭', async () => {
  const webContents = new FakeWebContents()
  const { manager } = createManager({ webContents, url: 'https://gone.test/' }, async (page) => {
    page.destroyed = true
    throw new Error('window closed')
  })

  await assert.rejects(manager.waitForSession('rt-gone', 3000), /浏览器页面会话已关闭/)
  manager.dispose()
})

void test('界面先挂上了就不要后台页面', async () => {
  const { manager, requested } = createManager({
    webContents: new FakeWebContents(),
    url: 'https://shop.test/',
  })
  const view = new FakeWebContents()

  const waiting = manager.waitForSession('rt-2', 3000)
  manager.attachWebContents('rt-2', view)
  assert.equal((await waiting).webContents, view)
  await new Promise((resolve) => setTimeout(resolve, 500))

  assert.deepEqual(requested, [])
  assert.equal(manager.getSession('rt-2').webContents, view)
  manager.dispose()
})

void test('宿主不给后台页面就照旧等界面挂载，超时报视图没接入', async () => {
  const { manager, requested } = createManager(null)

  await assert.rejects(manager.waitForSession('rt-3', 800), (error) => {
    assert.equal(error.context?.reason, BrowserViewNotAttachedReason)
    return true
  })
  assert.deepEqual(requested, ['rt-3'])
  manager.dispose()
})
