/**
 * @test-meta
 * title: 后台页面接管
 * summary: 界面没挂 webview 时向宿主要后台页面并直接接管；界面先挂上、或宿主不给时不接。
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

/** 一个会话管理器；给了 page 就当宿主实现了后台页面，记下每次被要的会话。 */
function createManager(page) {
  const requested = []
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
    pageWaiter: { loadUrl: async () => undefined },
    normalizeUrl: (url) => new URL(url).toString(),
    callbacks,
  })
  return { manager, requested }
}

void test('界面没挂 webview 时接管宿主给的后台页面：同时在等的操作都拿到它，只要一次，标成不可见', async () => {
  const page = new FakeWebContents()
  const { manager, requested } = createManager(page)

  const [first, second] = await Promise.all([
    manager.waitForSession('rt-1', 3000),
    manager.waitForSession('rt-1', 3000),
  ])

  assert.equal(first.webContents, page)
  assert.equal(second, first)
  assert.equal(first.visible, false)
  assert.deepEqual(requested, ['rt-1'])
  manager.dispose()
})

void test('界面先挂上了就不要后台页面', async () => {
  const { manager, requested } = createManager(new FakeWebContents())
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
