import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'bun:test'

import { ElectronBrowserRuntime } from '../../../dist/browser/impl/electron/ElectronBrowserRuntime.js'

// Keep the real runtime queue, kernel, interaction and screenshot preparation. Only the page
// transport and native image encoding are replaced; no browser window or global Electron mock.
const createHarness = async (kind, mobile = false) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'velaros-screenshot-viewport-'))
  const context = { url: 'https://example.com', workspaceRoot }
  const events = []
  let dimensions = { width: 929, height: 900 }
  const session = {
    viewport: { width: 1440, height: 1000, mobile },
    webContents: {
      isDestroyed: () => false,
      isLoading: () => false,
      getType: () => 'window',
      getURL: () => context.url,
    },
  }
  const driver = {
    executeJavaScript: async () => {
      events.push('read-viewport')
      return { ...dimensions }
    },
    setViewport: async (viewport) => {
      events.push({ setViewport: viewport })
      dimensions = { width: viewport.width, height: viewport.height }
    },
    refreshPageState: async () => ({ url: context.url, title: '' }),
  }
  const page = {
    driver,
    ...(kind === 'external' ? { externalSession: session } : { browserSession: session }),
  }
  const runtime = new ElectronBrowserRuntime({ externalBrowserLauncher: {} })
  runtime.getLivePageDriverSessionUnlocked = async () => page
  runtime.getLivePageSessionUnlocked = async () => session
  runtime.getExternalPageSession = () => (kind === 'external' ? session : undefined)
  runtime.refreshPageDriverSessionState = async () => ({ url: context.url, title: '' })
  runtime.sessionManager.getSession = () => session
  runtime.sessionManager.notifyViewportChanged = (sessionId, viewport) => {
    events.push({ notify: { sessionId, viewport } })
  }
  const capture = () => {
    events.push('capture')
    return { ...dimensions }
  }
  runtime.screenshot.captureExternalScreenshot = async () => ({
    ...capture(),
    metadata: { viewport: { ...dimensions } },
  })
  runtime.screenshot.readScreenshotMetadata = async () => {
    events.push('metadata')
    return { viewport: { ...dimensions } }
  }
  runtime.screenshot.captureBrowserScreenshotImage = async () => {
    const captured = capture()
    return {
      image: { getSize: () => captured, toPNG: () => Buffer.from('transport fixture') },
      capture: { mode: 'fullPage' },
    }
  }
  return {
    events,
    session,
    driver,
    runtime,
    readViewport: () => ({ ...dimensions }),
    capture: (options = {}, signal) =>
      runtime.captureScreenshot(
        'viewport-test',
        context,
        { path: 'viewport.png', fullPage: true, includeModelImage: false, ...options },
        signal
      ),
    dispose: () => rm(workspaceRoot, { recursive: true, force: true }),
  }
}

for (const kind of ['embedded', 'external']) {
  test(`${kind} screenshots apply 390 then 320 CSS viewports before capture and persist state`, async () => {
    const harness = await createHarness(kind)
    try {
      for (const dimensions of [
        { width: 390, height: 844 },
        { width: 320, height: 568 },
      ]) {
        harness.events.length = 0
        const artifact = await harness.capture(dimensions)
        assert.deepEqual(harness.readViewport(), dimensions)
        assert.deepEqual(artifact.metadata.viewport, dimensions)
        assert.deepEqual(harness.session.viewport, { ...dimensions, mobile: false })
        assert.deepEqual(harness.events, [
          'read-viewport',
          { setViewport: { ...dimensions, mobile: false } },
          { notify: { sessionId: 'viewport-test', viewport: { ...dimensions, mobile: false } } },
          ...(kind === 'embedded' ? ['metadata'] : []),
          'capture',
        ])
      }
      // A subsequent screenshot/evaluation keeps the selected viewport without resetting it.
      harness.events.length = 0
      const subsequent = await harness.capture()
      assert.deepEqual(subsequent.metadata.viewport, { width: 320, height: 568 })
      assert.deepEqual(harness.events, [...(kind === 'embedded' ? ['metadata'] : []), 'capture'])
    } finally {
      await harness.dispose()
    }
  })

  test(`${kind} partial dimensions preserve the live other dimension and current mobile mode`, async () => {
    const harness = await createHarness(kind, true)
    try {
      await harness.capture({ width: 390 })
      assert.deepEqual(harness.session.viewport, { width: 390, height: 900, mobile: true })
      await harness.capture({ height: 568 })
      assert.deepEqual(harness.session.viewport, { width: 390, height: 568, mobile: true })
    } finally {
      await harness.dispose()
    }
  })

  test(`${kind} failed viewport changes do not capture or publish a successful viewport`, async () => {
    const harness = await createHarness(kind)
    try {
      const failure = new Error('test transport rejected viewport')
      harness.driver.setViewport = async () => {
        throw failure
      }
      await assert.rejects(harness.capture({ width: 390, height: 844 }), failure)
      assert.deepEqual(harness.events, ['read-viewport'])
      assert.deepEqual(harness.session.viewport, { width: 1440, height: 1000, mobile: false })
    } finally {
      await harness.dispose()
    }
  })

  test(`${kind} cancellation before or during resize does not capture`, async () => {
    const harness = await createHarness(kind)
    try {
      const cancelled = new AbortController()
      cancelled.abort(new Error('test cancellation before capture'))
      await assert.rejects(
        harness.capture({ width: 390, height: 844 }, cancelled.signal),
        /test cancellation before capture/
      )
      assert.deepEqual(harness.events, [])
      const resizing = new AbortController()
      harness.driver.setViewport = async () => {
        resizing.abort(new Error('test cancellation during resize'))
      }
      await assert.rejects(
        harness.capture({ width: 390, height: 844 }, resizing.signal),
        /test cancellation during resize/
      )
      assert.equal(harness.events.includes('capture'), false)
    } finally {
      await harness.dispose()
    }
  })
}
