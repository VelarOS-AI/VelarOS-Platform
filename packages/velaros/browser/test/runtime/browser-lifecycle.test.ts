import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'bun:test'

import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { BrowserPageDriver } from '../../contract/requires.js'
import { BrowserPageWaiter } from '../../impl/electron/BrowserPageWaiter.js'
import { BrowserScreenshotEngine } from '../../impl/electron/BrowserScreenshotEngine.js'
import { ElectronWebContentsBrowserPageDriver } from '../../impl/electron/ElectronWebContentsBrowserPageDriver.js'
import { BrowserPerformanceOrchestrator } from '../../impl/engines/BrowserPerformanceOrchestrator.js'
import { BrowserPendingEventsBroker } from '../../impl/session/BrowserPendingEventsBroker.js'
import { writeScreenshotModelImage } from '../../utils/electron/screenshot-image.js'

function contents() {
  const debuggerEvents = new EventEmitter()
  let attached = false
  let enableFailures = 0
  let detaches = 0
  const sent: string[] = []
  const page = {
    debugger: Object.assign(debuggerEvents, {
      isAttached: () => attached,
      attach: () => {
        attached = true
      },
      detach: () => {
        attached = false
        detaches += 1
        debuggerEvents.emit('detach')
      },
      sendCommand: async (method: string) => {
        sent.push(method)
        if (method === 'Network.enable' && enableFailures-- > 0) throw new Error('enable failed')
        if (method === 'Tracing.end')
          debuggerEvents.emit('message', {}, 'Tracing.tracingComplete', { stream: 'trace-stream' })
        if (method === 'IO.read') return { data: '[]', eof: true }
        return {}
      },
    }),
    session: {
      webRequest: new Proxy(
        {},
        {
          get: () => {
            throw new Error('host webRequest must remain untouched')
          },
        }
      ),
    },
    getURL: () => 'https://example.test/',
    isDestroyed: () => false,
  }
  return {
    page,
    sent,
    failEnable: () => {
      enableFailures = 1
    },
    detaches: () => detaches,
    event: (method: string, params: unknown) => debuggerEvents.emit('message', {}, method, params),
  }
}

test('INV-32 network idle uses page CDP events, keeps host hooks, and drains on detach', async () => {
  const first = contents()
  const second = contents()
  const waiter = new BrowserPageWaiter()
  const idle = waiter.waitForNetworkIdle(first.page as never, 5, 100)
  await Promise.resolve()
  second.event('Network.requestWillBeSent', { requestId: 'other' })
  assert.equal(await idle, true)
  const pending = waiter.waitForNetworkIdle(first.page as never, 50, 1000)
  await new Promise((resolve) => setTimeout(resolve, 0))
  first.event('Network.requestWillBeSent', { requestId: 'active' })
  first.page.debugger.detach()
  assert.equal(await pending, false)
  assert.equal(first.page.debugger.listenerCount('message'), 0)
})

test('INV-32 failed network initialization can retry and reconnect reenables the domain', async () => {
  const fake = contents()
  const driver = new ElectronWebContentsBrowserPageDriver(fake.page as never)
  fake.failEnable()
  assert.match(String((await driver.ensureNetworkCapture()).unavailableReason), /enable failed/)
  assert.equal((await driver.ensureNetworkCapture()).startedNow, true)
  fake.page.debugger.detach()
  assert.equal((await driver.ensureNetworkCapture()).startedNow, true)
  assert.equal(fake.sent.filter((method) => method === 'Network.enable').length, 3)
  fake.page.debugger.detach()
})

test('INV-32 stopping trace preserves a concurrent screencast debugger hold', async () => {
  const fake = contents()
  const driver = new ElectronWebContentsBrowserPageDriver(fake.page as never)
  await driver.startTracing()
  await driver.startScreencast({ maxWidth: 640, maxHeight: 360, everyNthFrame: 1, maxFrames: 10 })
  await driver.stopTracing()
  assert.equal(fake.detaches(), 0)
  assert.equal(driver.isScreencasting(), true)
  await driver.stopScreencast()
})

test('INV-32 closing during preview startup discards late publication and allows reuse', async () => {
  let release!: () => void
  let running = false
  let stops = 0
  let defer = true
  const driver = {
    isDestroyed: () => false,
    getURL: () => 'https://example.test/',
    getTitle: () => '',
    isScreencasting: () => running,
    startScreencast: async () => {
      running = true
      if (defer)
        await new Promise<void>((resolve) => {
          release = resolve
        })
    },
    stopScreencast: async () => {
      running = false
      stops += 1
      return { frames: [], frameLimitReached: false }
    },
  } as unknown as BrowserPageDriver
  const engine = new BrowserScreenshotEngine(
    {
      getLivePageDriverSession: async () => ({ driver }),
      refreshPageDriverSessionState: async () => ({ url: driver.getURL(), title: '' }),
    } as never,
    {} as never,
    {} as never
  )
  const context = { url: driver.getURL(), workspaceRoot: '/unused' }
  const opening = engine.startPreviewFrameStream('s', context, {}, () => undefined)
  const failed = assert.rejects(opening, { code: 'CLOSED' })
  while (!release) await Promise.resolve()
  await engine.closeSession('s')
  release()
  await failed
  assert.equal(running, false)
  defer = false
  await engine.startPreviewFrameStream('s', context, {}, () => undefined)
  await engine.closeSession('s')
  assert.equal(stops, 2)
})

test('INV-33 trace parsing failure permits a new recording and generated artifacts respect workspace links', async () => {
  const base = await mkdtemp(join(tmpdir(), 'browser-lifecycle-'))
  const root = join(base, 'site')
  const outside = join(base, 'outside')
  await mkdir(root)
  await mkdir(outside)
  await symlink(outside, join(root, 'artifacts'), process.platform === 'win32' ? 'junction' : 'dir')
  let starts = 0
  const driver = {
    startTracing: async () => {
      starts += 1
    },
    stopTracing: async () => [{}],
  }
  const kernel = {
    getLivePageDriverSession: async () => ({ driver }),
    refreshPageDriverSessionState: async () => ({ url: 'https://example.test/', title: '' }),
  }
  let fail = true
  const trace = new BrowserPerformanceOrchestrator(
    kernel as never,
    {
      parse: async () => {
        if (fail) throw new Error('parse failed')
        return { parsedTrace: {}, insightSetIds: [], rawEvents: [{}] }
      },
      formatSummary: async () => '',
    } as never
  )
  const context = { url: 'https://example.test/', workspaceRoot: root }
  try {
    await trace.startTrace('s', context, { reload: false, autoStopMs: null })
    await assert.rejects(trace.stopTrace('s', context), /parse failed/)
    await trace.startTrace('s', context, { reload: false, autoStopMs: null })
    assert.equal(starts, 2)
    fail = false
    await assert.rejects(trace.stopTrace('s', context), { code: 'PERMISSION' })
    await assert.rejects(
      writeScreenshotModelImage(root, 'original.png', {
        data: 'AA==',
        mediaType: 'image/png',
        width: 1,
        height: 1,
        bytes: 1,
        sourceWidth: 1,
        sourceHeight: 1,
        scale: 1,
        quality: 100,
      }),
      { code: 'PERMISSION' }
    )
    assert.deepEqual(await readdir(outside), [])
  } finally {
    trace.dispose()
    await rm(base, { recursive: true, force: true })
  }
})

test('pending downloads retain invalid decisions and release timeout leases when settled', () => {
  const broker = new BrowserPendingEventsBroker()
  const item = {
    getFilename: () => 'file.bin',
    getMimeType: () => '',
    getTotalBytes: () => 1,
    getReceivedBytes: () => 0,
    getSavePath: () => '',
    pause: () => undefined,
    resume: () => undefined,
    cancel: () => undefined,
    setSavePath: () => undefined,
  }
  const timers = (broker as unknown as { timers: TimerScope }).timers
  try {
    broker.handleIncomingDownload({ sessionId: 's', item: item as never, url: null })
    assert.throws(
      () => broker.resolveDownload({ sessionId: 's', action: 'accept', savePath: '' }),
      { code: 'VALIDATION' }
    )
    assert.equal(broker.listPendingEvents('s').length, 1)
    broker.resolveDownload({ sessionId: 's', action: 'accept', savePath: '/accepted.bin' })
    assert.equal(timers.size, 0)
    broker.handleIncomingDownload({ sessionId: 's', item: item as never, url: null })
    broker.clearSession('s')
    assert.equal(timers.size, 0)
  } finally {
    broker.dispose()
  }
})

test('INV-32 cancelling trace auto-stop drains the collector and permits another recording', async () => {
  let stopped = 0
  let waiting!: () => void
  const entered = new Promise<void>((resolve) => {
    waiting = resolve
  })
  const driver = {
    startTracing: async () => undefined,
    stopTracing: async () => {
      stopped += 1
      return []
    },
  }
  const trace = new BrowserPerformanceOrchestrator({
    getLivePageDriverSession: async () => ({ driver }),
    refreshPageDriverSessionState: async () => ({ url: 'https://example.test/', title: '' }),
    delay: (ms: number, signal: AbortSignal) => {
      waiting()
      return TimerScope.sleep(ms, { signal })
    },
  } as never)
  const context = { url: 'https://example.test/', workspaceRoot: '/unused' }
  const controller = new AbortController()
  const pending = trace.startTrace(
    's',
    context,
    { reload: false, autoStopMs: 5000 },
    controller.signal
  )
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  await entered
  controller.abort()
  await rejected
  assert.equal(stopped, 1)
  await trace.startTrace('s', context, { reload: false, autoStopMs: null })
  await trace.closeSession('s')
  assert.equal(stopped, 2)
})
