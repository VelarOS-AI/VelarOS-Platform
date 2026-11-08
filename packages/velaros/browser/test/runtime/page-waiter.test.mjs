/**
 * @test-meta
 * title: 浏览器导航等待共享原生事件监听
 * summary: 同一页面上的并发等待只占一个 Electron 监听器，并在结算后完全清理。
 * area: packages
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'

import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

const packagePath = new URL(
  '../../../dist/browser/impl/electron/BrowserPageWaiter.js',
  import.meta.url
)

class FakeWebContents extends EventEmitter {
  isDestroyed() {
    return false
  }

  isLoading() {
    return true
  }
}

class LoadableFakeWebContents extends FakeWebContents {
  async loadURL(url, options) {
    this.loaded = { url, options }
    queueMicrotask(() => this.emit('did-finish-load'))
  }
}

test('parallel navigation waits share and release native WebContents listeners', async () => {
  const { BrowserPageWaiter } = await import(packagePath.href)
  const waiter = new BrowserPageWaiter()
  const webContents = new FakeWebContents()
  const waits = Array.from({ length: 24 }, () => waiter.waitForNavigationToSettle(webContents))

  assert.equal(webContents.listenerCount('did-finish-load'), 1)
  assert.equal(webContents.listenerCount('did-fail-load'), 1)
  assert.equal(webContents.listenerCount('did-navigate-in-page'), 1)
  assert.equal(webContents.listenerCount('did-stop-loading'), 1)
  assert.equal(webContents.listenerCount('destroyed'), 1)

  webContents.emit('did-stop-loading')
  await Promise.all(waits)

  assert.equal(webContents.eventNames().length, 0)
})

test('subframe failures do not consume the shared main-frame failure listener', async () => {
  const { BrowserPageWaiter } = await import(packagePath.href)
  const waiter = new BrowserPageWaiter()
  const webContents = new FakeWebContents()
  const wait = waiter.waitForNavigationToSettle(webContents)

  webContents.emit('did-fail-load', {}, -2, 'subframe failed', 'https://example.com/frame', false)
  assert.equal(webContents.listenerCount('did-fail-load'), 1)

  webContents.emit('did-stop-loading')
  await wait
  assert.equal(webContents.eventNames().length, 0)
})

test('loadUrl forwards POST and referrer options to Electron', async () => {
  const { BrowserPageWaiter } = await import(packagePath.href)
  const waiter = new BrowserPageWaiter()
  const webContents = new LoadableFakeWebContents()
  const options = {
    httpReferrer: 'https://origin.test/start',
    extraHeaders: 'Content-Type: application/x-www-form-urlencoded\n',
    postData: [{ bytes: Buffer.from('query=velaros') }],
  }

  await waiter.loadUrl(webContents, 'https://destination.test/submit', undefined, options)

  assert.deepEqual(webContents.loaded, {
    url: 'https://destination.test/submit',
    options,
  })
})

test('all navigation wait entries reject a pre-cancelled signal before allocating resources', async () => {
  const { BrowserPageWaiter } = await import(packagePath.href)
  const waiter = new BrowserPageWaiter()
  const page = new LoadableFakeWebContents()
  const controller = new AbortController()
  controller.abort()
  const after = TimerScope.prototype.after
  let allocated = 0
  TimerScope.prototype.after = function (...args) {
    allocated += 1
    return after.apply(this, args)
  }
  try {
    for (const waiting of [
      () => waiter.loadUrl(page, 'https://must-not-load.test/', controller.signal),
      () => waiter.waitForTargetActionToSettle(page, controller.signal),
      () => waiter.waitForNavigationToSettle(page, controller.signal),
    ])
      await assert.rejects(waiting(), { name: 'AbortError' })
    assert.equal(page.loaded, undefined)
    assert.equal(page.eventNames().length, 0)
    assert.equal(allocated, 0)
  } finally {
    TimerScope.prototype.after = after
  }
})
