/**
 * @test-meta
 * title: 浏览器新窗口导航策略
 * summary: 站点新窗口请求保留原始提交语义，并支持空白窗口稍后赋 URL。
 * area: packages
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { test } from 'bun:test'

import { BrowserSessionManager } from '../../../dist/browser/impl/electron/BrowserSessionManager.js'

class FakeElectronSession extends EventEmitter {}

class FakeWebContents extends EventEmitter {
  constructor(url = 'https://origin.test/start') {
    super()
    this.currentUrl = url
    this.destroyed = false
    this.closeCount = 0
    this.executedScripts = []
    this.session = new FakeElectronSession()
  }

  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler
  }

  getURL() {
    return this.currentUrl
  }

  isDestroyed() {
    return this.destroyed
  }

  close() {
    if (this.destroyed) return
    this.destroyed = true
    this.closeCount += 1
    this.emit('destroyed')
  }

  executeJavaScript(script) {
    this.executedScripts.push(script)
    return Promise.resolve(true)
  }
}

class FakeBrowserWindow {
  constructor(webContents, options = {}) {
    this.webContents = webContents
    this.destroyed = false
    this.destroyCount = 0
    this.destroyAttempts = 0
    this.destroyFailures = options.destroyFailures ?? 0
    this.showCount = 0
    this.centerCount = 0
    this.minimumSize = null
    this.maximumSize = null
    this.size = null
  }

  isDestroyed() {
    return this.destroyed
  }

  show() {
    this.showCount += 1
  }

  center() {
    this.centerCount += 1
  }

  setMinimumSize(width, height) {
    this.minimumSize = [width, height]
  }

  setMaximumSize(width, height) {
    this.maximumSize = [width, height]
  }

  setSize(width, height) {
    this.size = [width, height]
  }

  destroy() {
    if (this.destroyed) return
    this.destroyAttempts += 1
    if (this.destroyFailures > 0) {
      this.destroyFailures -= 1
      throw new Error('destroy failed')
    }
    this.destroyed = true
    this.destroyCount += 1
    this.webContents.close()
  }
}

class FakeDownloadItem extends EventEmitter {
  constructor() {
    super()
    this.pauseCount = 0
    this.cancelCount = 0
  }

  getFilename() {
    return 'report.pdf'
  }

  getTotalBytes() {
    return 128
  }

  getURL() {
    return 'https://destination.test/report.pdf'
  }

  getMimeType() {
    return 'application/pdf'
  }

  getReceivedBytes() {
    return 0
  }

  getSavePath() {
    return ''
  }

  pause() {
    this.pauseCount += 1
  }

  cancel() {
    this.cancelCount += 1
  }
}

function createHarness(options = {}) {
  const diagnostics = []
  const routes = []
  const manager = new BrowserSessionManager({
    diagnostics: {
      record: (_session, entry) => diagnostics.push(entry),
      shouldRecordConsoleMessage: () => false,
      normalizeConsoleLevel: () => 'info',
    },
    pageWaiter: {
      loadUrl:
        options.loadUrl ??
        (async (webContents, url, _signal, loadOptions) => {
          routes.push({ webContents, url, loadOptions })
        }),
    },
    normalizeUrl: (url) => new URL(url).toString(),
  })
  const webContents = new FakeWebContents()
  manager.attachWebContents('session-1', webContents)
  return { diagnostics, manager, routes, webContents }
}

function createWindowOpenDetails(overrides = {}) {
  return {
    url: 'https://destination.test/next',
    frameName: '_blank',
    features: '',
    disposition: 'new-window',
    referrer: {
      url: 'https://origin.test/start',
      policy: 'strict-origin-when-cross-origin',
    },
    ...overrides,
  }
}

void test('routes target-blank POST with body, content type, and referrer intact', async () => {
  const harness = createHarness()
  const postData = [{ bytes: Buffer.from('query=velaros') }]
  const response = harness.webContents.windowOpenHandler(
    createWindowOpenDetails({
      url: 'https://destination.test/submit',
      postBody: {
        contentType: 'application/x-www-form-urlencoded',
        data: postData,
      },
    })
  )

  assert.deepEqual(response, { action: 'deny' })
  assert.equal(harness.routes.length, 1)
  assert.equal(harness.routes[0].url, 'https://destination.test/submit')
  assert.deepEqual(harness.routes[0].loadOptions.postData, postData)
  assert.equal(
    harness.routes[0].loadOptions.extraHeaders,
    'Content-Type: application/x-www-form-urlencoded\n'
  )
  assert.deepEqual(harness.routes[0].loadOptions.httpReferrer, {
    url: 'https://origin.test/start',
    policy: 'strict-origin-when-cross-origin',
  })
  assert.equal(harness.diagnostics.at(-1).details.routingStatus, 'queued')
  assert.equal(harness.diagnostics.at(-1).details.routedToCurrentView, false)

  await Promise.resolve()
  assert.equal(harness.diagnostics.at(-1).details.routingStatus, 'completed')
  assert.equal(harness.diagnostics.at(-1).details.routedToCurrentView, true)
  harness.manager.dispose()
})

void test('keeps a real blank popup bootstrap until the page assigns its destination', async () => {
  const harness = createHarness()
  const response = harness.webContents.windowOpenHandler(
    createWindowOpenDetails({ url: 'about:blank', postBody: undefined })
  )

  assert.equal(response.action, 'allow')
  assert.equal(response.createWindow, undefined)
  assert.equal(response.outlivesOpener, false)
  assert.equal(response.overrideBrowserWindowOptions.show, false)
  assert.equal(response.overrideBrowserWindowOptions.focusable, false)
  assert.equal(response.overrideBrowserWindowOptions.skipTaskbar, true)
  assert.equal(response.overrideBrowserWindowOptions.webPreferences.nodeIntegration, false)
  assert.equal(response.overrideBrowserWindowOptions.webPreferences.contextIsolation, true)
  assert.equal(response.overrideBrowserWindowOptions.webPreferences.sandbox, true)
  assert.equal(response.overrideBrowserWindowOptions.webPreferences.webviewTag, false)
  assert.equal(response.overrideBrowserWindowOptions.webPreferences.disableDialogs, true)
  assert.equal(
    response.overrideBrowserWindowOptions.webPreferences.session,
    harness.webContents.session
  )

  const popup = new FakeWebContents('about:blank')
  const popupWindow = new FakeBrowserWindow(popup)
  harness.webContents.emit(
    'did-create-window',
    popupWindow,
    createWindowOpenDetails({ url: 'about:blank', postBody: undefined })
  )
  assert.equal(harness.routes.length, 0)

  let prevented = false
  popup.emit(
    'will-navigate',
    {
      preventDefault: () => {
        prevented = true
      },
    },
    'https://destination.test/oauth'
  )

  assert.equal(prevented, true)
  assert.equal(harness.routes.length, 1)
  assert.equal(harness.routes[0].url, 'https://destination.test/oauth')
  assert.deepEqual(harness.routes[0].loadOptions.httpReferrer, {
    url: 'https://origin.test/start',
    policy: 'strict-origin-when-cross-origin',
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(popupWindow.destroyCount, 1)
  assert.equal(popup.closeCount, 1)
  harness.manager.dispose()
})

void test('keeps named popup form navigation native instead of guessing its method or body', () => {
  const harness = createHarness()
  const details = createWindowOpenDetails({
    url: 'about:blank',
    frameName: 'payment-window',
  })
  const response = harness.webContents.windowOpenHandler(details)
  assert.equal(response.action, 'allow')
  assert.equal(response.overrideBrowserWindowOptions.focusable, true)
  assert.equal(response.overrideBrowserWindowOptions.skipTaskbar, false)
  assert.equal(response.overrideBrowserWindowOptions.frame, true)
  assert.equal(response.overrideBrowserWindowOptions.width, 900)
  assert.equal(response.overrideBrowserWindowOptions.height, 700)
  assert.equal(response.overrideBrowserWindowOptions.maxWidth, 1600)
  assert.equal(response.overrideBrowserWindowOptions.maxHeight, 1200)
  assert.equal(response.overrideBrowserWindowOptions.opacity, 1)
  assert.equal(response.overrideBrowserWindowOptions.webPreferences.zoomFactor, 1)
  assert.equal(response.overrideBrowserWindowOptions.webPreferences.javascript, true)

  const popup = new FakeWebContents('about:blank')
  const popupWindow = new FakeBrowserWindow(popup)
  harness.webContents.emit('did-create-window', popupWindow, details)
  let prevented = false
  popup.emit(
    'will-navigate',
    {
      preventDefault: () => {
        prevented = true
      },
    },
    'https://destination.test/pay'
  )

  assert.equal(prevented, false)
  assert.equal(harness.routes.length, 0)
  assert.equal(popupWindow.showCount, 1)
  assert.equal(popupWindow.centerCount, 1)
  assert.deepEqual(popupWindow.minimumSize, [480, 320])
  assert.deepEqual(popupWindow.maximumSize, [1600, 1200])
  assert.deepEqual(popupWindow.size, [900, 700])
  assert.equal(harness.diagnostics.at(-1).details.method, 'preserved-by-browser')
  assert.equal(harness.diagnostics.at(-1).details.routingStatus, 'opened-controlled-popup')
  assert.equal(popupWindow.destroyCount, 0)
  harness.manager.dispose()
  assert.equal(popupWindow.destroyCount, 1)
})

void test('does not misreport blocked or failed popup requests as routed', async () => {
  const blocked = createHarness()
  const response = blocked.webContents.windowOpenHandler(
    createWindowOpenDetails({ url: 'mailto:hello@example.test' })
  )
  assert.deepEqual(response, { action: 'deny' })
  assert.equal(blocked.routes.length, 0)
  assert.equal(blocked.diagnostics.at(-1).details.routingStatus, 'blocked')
  assert.equal(blocked.diagnostics.at(-1).details.routedToCurrentView, false)
  blocked.manager.dispose()

  const failed = createHarness({
    loadUrl: async () => {
      throw new Error('route failed')
    },
  })
  failed.webContents.windowOpenHandler(createWindowOpenDetails())
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(failed.diagnostics.at(-1).details.routingStatus, 'failed')
  assert.equal(failed.diagnostics.at(-1).details.routedToCurrentView, false)
  failed.manager.dispose()
})

void test('only lets a trusted local page initiate file popup navigation', async () => {
  const remote = createHarness()
  const blocked = remote.webContents.windowOpenHandler(
    createWindowOpenDetails({ url: 'file:///tmp/velaros-browser-test.html' })
  )
  assert.deepEqual(blocked, { action: 'deny' })
  assert.equal(remote.routes.length, 0)
  assert.equal(remote.diagnostics.at(-1).details.reason, 'untrusted-file-navigation')
  remote.manager.dispose()

  const local = createHarness()
  local.webContents.currentUrl = 'file:///tmp/velaros-browser-start.html'
  const routed = local.webContents.windowOpenHandler(
    createWindowOpenDetails({
      url: 'file:///tmp/velaros-browser-test.html',
      referrer: {
        url: 'file:///tmp/velaros-browser-start.html',
        policy: 'strict-origin-when-cross-origin',
      },
    })
  )
  assert.deepEqual(routed, { action: 'deny' })
  assert.equal(local.routes[0]?.url, 'file:///tmp/velaros-browser-test.html')
  await Promise.resolve()
  assert.equal(local.diagnostics.at(-1).details.routingStatus, 'completed')
  local.manager.dispose()
})

void test('routes same-origin blob popups but rejects foreign blob origins', async () => {
  const harness = createHarness()
  const sameOrigin = harness.webContents.windowOpenHandler(
    createWindowOpenDetails({ url: 'blob:https://origin.test/blob-id' })
  )
  assert.deepEqual(sameOrigin, { action: 'deny' })
  assert.equal(harness.routes[0]?.url, 'blob:https://origin.test/blob-id')
  await Promise.resolve()

  const foreign = harness.webContents.windowOpenHandler(
    createWindowOpenDetails({ url: 'blob:https://foreign.test/blob-id' })
  )
  assert.deepEqual(foreign, { action: 'deny' })
  assert.equal(harness.routes.length, 1)
  assert.equal(harness.diagnostics.at(-1).details.reason, 'unsupported-blob-origin')

  const frameBlob = harness.webContents.windowOpenHandler(
    createWindowOpenDetails({
      url: 'blob:https://frame.test/frame-blob-id',
      referrer: {
        url: 'https://frame.test/embed',
        policy: 'strict-origin-when-cross-origin',
      },
    })
  )
  assert.deepEqual(frameBlob, { action: 'deny' })
  assert.equal(harness.routes[1]?.url, 'blob:https://frame.test/frame-blob-id')
  harness.manager.dispose()
})

void test('keeps hidden popup downloads inside the opener session broker', () => {
  const harness = createHarness()
  const response = harness.webContents.windowOpenHandler(
    createWindowOpenDetails({ url: 'about:blank' })
  )
  assert.equal(response.action, 'allow')

  const popup = new FakeWebContents('about:blank')
  const popupWindow = new FakeBrowserWindow(popup)
  harness.webContents.emit(
    'did-create-window',
    popupWindow,
    createWindowOpenDetails({ url: 'about:blank' })
  )

  const item = new FakeDownloadItem()
  harness.webContents.session.emit('will-download', {}, item, popup)
  assert.equal(item.pauseCount, 1)
  assert.equal(
    harness.manager.getPendingEventsBroker().listPendingEvents('session-1')[0]?.kind,
    'download'
  )

  harness.manager.dispose()
  assert.equal(item.cancelCount, 1)
  assert.equal(popupWindow.destroyCount, 1)
})

void test('caps blank popups and retries a failed destroy while still tracked', async () => {
  const harness = createHarness()
  const windows = []
  for (let index = 0; index < 4; index += 1) {
    const blankUrl = index === 0 ? 'about:blank#oauth-state' : 'about:blank'
    const response = harness.webContents.windowOpenHandler(
      createWindowOpenDetails({ url: blankUrl, frameName: `popup-${index}` })
    )
    assert.equal(response.action, 'allow')
    const popup = new FakeWebContents('about:blank')
    const popupWindow = new FakeBrowserWindow(popup, {
      destroyFailures: index === 0 ? 1 : 0,
    })
    windows.push(popupWindow)
    harness.webContents.emit(
      'did-create-window',
      popupWindow,
      createWindowOpenDetails({ url: blankUrl, frameName: `popup-${index}` })
    )
  }

  const denied = harness.webContents.windowOpenHandler(
    createWindowOpenDetails({ url: 'about:blank', frameName: 'popup-over-limit' })
  )
  assert.deepEqual(denied, { action: 'deny' })
  assert.equal(harness.diagnostics.at(-1).details.reason, 'bootstrap-limit')

  harness.manager.closeSession('session-1')
  await Promise.resolve()
  assert.equal(windows[0].destroyAttempts, 1)
  assert.equal(windows[0].destroyCount, 0)
  const orphanedDownload = new FakeDownloadItem()
  harness.webContents.session.emit('will-download', {}, orphanedDownload, windows[0].webContents)
  assert.equal(orphanedDownload.cancelCount, 1)

  harness.manager.closeAllSessions()
  assert.equal(windows[0].destroyAttempts, 2)
  assert.equal(windows[0].destroyCount, 1)
  assert.ok(windows.slice(1).every((window) => window.destroyCount === 1))
  harness.manager.dispose()
})

void test('dispose removes the shared Session download listener and subframe failures leave main navigation healthy', () => {
  const harness = createHarness()
  const session = harness.webContents.session
  assert.equal(session.listenerCount('will-download'), 1)
  harness.webContents.emit('did-fail-load', {}, -2, 'frame failed', 'https://frame.test/', false)
  assert.equal(harness.manager.getSession('session-1').lastNavigationError, null)
  harness.manager.dispose()
  assert.equal(session.listenerCount('will-download'), 0)
  assert.equal(session.listenerCount('select-webauthn-account'), 0)
})

void test('page replacement revokes owned listeners and remounting the same WebContents does not duplicate dialogs', () => {
  const harness = createHarness()
  const first = harness.webContents
  const second = new FakeWebContents('https://second.test/')
  let hostEvents = 0
  const hostListener = () => {
    hostEvents += 1
  }
  first.on('dom-ready', hostListener)
  try {
    harness.manager.attachWebContents('session-1', second)
    assert.equal(first.listenerCount('dialog'), 0)
    assert.equal(first.listenerCount('dom-ready'), 1)
    harness.manager.attachWebContents('session-1', first)
    assert.equal(first.listenerCount('dialog'), 1)
    let decisions = 0
    first.emit('dialog', {}, { type: 'confirm', message: 'Continue?' }, () => {
      decisions += 1
    })
    const broker = harness.manager.getPendingEventsBroker()
    assert.equal(broker.listPendingEvents('session-1').length, 1)
    broker.resolveDialog({ sessionId: 'session-1', accept: false })
    assert.equal(decisions, 1)
    harness.manager.closeSession('session-1')
    assert.equal(first.listenerCount('dialog'), 0)
    first.emit('dom-ready')
    assert.equal(hostEvents, 1)
  } finally {
    harness.manager.dispose()
    first.off('dom-ready', hostListener)
  }
})

void test('an in-flight window event cannot attach a popup to a retired binding after the host remounts the same page', () => {
  const harness = createHarness()
  const page = harness.webContents
  const retired = harness.manager.getSession('session-1')
  const popup = new FakeBrowserWindow(new FakeWebContents('about:blank'))
  page.prependOnceListener('did-create-window', () => {
    harness.manager.closeSession('session-1')
    harness.manager.attachWebContents('session-1', page)
  })
  try {
    // EventEmitter 已复制旧 listener；off 不会把本轮发射快照里的旧回调撤回。
    page.emit('did-create-window', popup, createWindowOpenDetails({ url: 'about:blank' }))
    assert.notEqual(harness.manager.getSession('session-1'), retired)
    assert.equal(popup.destroyCount, 1)
    assert.equal(page.listenerCount('did-create-window'), 1)
  } finally {
    harness.manager.dispose()
  }
})
