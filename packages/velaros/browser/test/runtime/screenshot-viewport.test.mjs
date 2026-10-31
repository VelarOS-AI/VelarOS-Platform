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
    temporaryViewport: async (viewport) => {
      events.push({ temporaryViewport: viewport })
      const previous = dimensions
      dimensions = { width: viewport.width, height: viewport.height }
      return async () => {
        events.push('restore-viewport')
        dimensions = previous
      }
    },
    setViewport: async () => {
      throw new Error('Screenshot must not publish persistent viewport')
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
    context,
    events,
    session,
    driver,
    runtime,
    readViewport: () => ({ ...dimensions }),
    writeViewport: (viewport) => {
      dimensions = { ...viewport }
    },
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
  test(`${kind} queues newer host and model viewport commands until screenshot restoration completes`, async () => {
    const harness = await createHarness(kind)
    let enterCapture
    let finishCapture
    const entered = new Promise((resolve) => {
      enterCapture = resolve
    })
    const finished = new Promise((resolve) => {
      finishCapture = resolve
    })
    const method =
      kind === 'external' ? 'captureExternalScreenshot' : 'captureBrowserScreenshotImage'
    const capture = harness.runtime.screenshot[method].bind(harness.runtime.screenshot)
    harness.runtime.screenshot[method] = async (...args) => {
      enterCapture()
      await finished
      return capture(...args)
    }
    harness.driver.setViewport = async (viewport) => {
      harness.events.push('host-viewport')
      harness.writeViewport({ width: viewport.width, height: viewport.height })
    }
    harness.runtime.protocolSessions.send = async (_sessionId, _open, command) => {
      harness.events.push('model-viewport')
      harness.writeViewport({ width: command.params.width, height: command.params.height })
      return {}
    }
    try {
      const screenshot = harness.capture({ width: 820, height: 820 })
      await entered
      const host = harness.runtime.setViewport('viewport-test', harness.context, {
        width: 1000,
        height: 700,
      })
      const model = harness.runtime.sendProtocolCommand('viewport-test', harness.context, {
        method: 'Emulation.setDeviceMetricsOverride',
        params: { width: 1024, height: 768, mobile: false, deviceScaleFactor: 1 },
      })
      await Promise.resolve()
      expectNoNewOwner()
      finishCapture()
      await Promise.all([screenshot, host, model])
      assert.ok(
        harness.events.indexOf('restore-viewport') < harness.events.indexOf('host-viewport')
      )
      assert.ok(harness.events.indexOf('host-viewport') < harness.events.indexOf('model-viewport'))
      assert.deepEqual(harness.readViewport(), { width: 1024, height: 768 })
    } finally {
      finishCapture()
      await harness.dispose()
    }
    function expectNoNewOwner() {
      assert.equal(harness.events.includes('host-viewport'), false)
      assert.equal(harness.events.includes('model-viewport'), false)
    }
  })

  test(`${kind} screenshots apply 390 then 320 CSS viewports before capture and restore the live viewport`, async () => {
    const harness = await createHarness(kind)
    try {
      for (const dimensions of [
        { width: 390, height: 844 },
        { width: 320, height: 568 },
      ]) {
        harness.events.length = 0
        const artifact = await harness.capture(dimensions)
        assert.deepEqual(harness.readViewport(), { width: 929, height: 900 })
        assert.deepEqual(artifact.metadata.viewport, dimensions)
        assert.deepEqual(harness.session.viewport, { width: 1440, height: 1000, mobile: false })
        assert.deepEqual(harness.events, [
          'read-viewport',
          { temporaryViewport: { ...dimensions, mobile: false } },
          ...(kind === 'embedded' ? ['metadata'] : []),
          'capture',
          'restore-viewport',
        ])
      }
      // A subsequent screenshot sees the live host dimensions, not the prior screenshot size.
      harness.events.length = 0
      const subsequent = await harness.capture()
      assert.deepEqual(subsequent.metadata.viewport, { width: 929, height: 900 })
      assert.deepEqual(harness.events, [...(kind === 'embedded' ? ['metadata'] : []), 'capture'])
    } finally {
      await harness.dispose()
    }
  })

  test(`${kind} partial dimensions preserve the live other dimension and current mobile mode`, async () => {
    const harness = await createHarness(kind, true)
    try {
      const narrow = await harness.capture({ width: 390 })
      assert.deepEqual(narrow.metadata.viewport, { width: 390, height: 900 })
      const short = await harness.capture({ height: 568 })
      assert.deepEqual(short.metadata.viewport, { width: 929, height: 568 })
      assert.deepEqual(harness.session.viewport, { width: 1440, height: 1000, mobile: true })
    } finally {
      await harness.dispose()
    }
  })

  test(`${kind} failed viewport changes do not capture or publish a successful viewport`, async () => {
    const harness = await createHarness(kind)
    try {
      const failure = new Error('test transport rejected viewport')
      harness.driver.temporaryViewport = async () => {
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
      const original = harness.driver.temporaryViewport
      harness.driver.temporaryViewport = async (viewport) => {
        const restore = await original(viewport)
        resizing.abort(new Error('test cancellation during resize'))
        return restore
      }
      await assert.rejects(
        harness.capture({ width: 390, height: 844 }, resizing.signal),
        /test cancellation during resize/
      )
      assert.equal(harness.events.includes('capture'), false)
      assert.equal(harness.events.at(-1), 'restore-viewport')
      assert.deepEqual(harness.readViewport(), { width: 929, height: 900 })
    } finally {
      await harness.dispose()
    }
  })

  test(`${kind} capture failure restores viewport and keeps the original error`, async () => {
    const harness = await createHarness(kind)
    try {
      const failure = new Error('native capture failed')
      harness.runtime.screenshot[
        kind === 'external' ? 'captureExternalScreenshot' : 'captureBrowserScreenshotImage'
      ] = async () => {
        throw failure
      }
      await assert.rejects(harness.capture({ width: 820, height: 820 }), failure)
      assert.deepEqual(harness.readViewport(), { width: 929, height: 900 })
      assert.equal(harness.events.at(-1), 'restore-viewport')
    } finally {
      await harness.dispose()
    }
  })
}
