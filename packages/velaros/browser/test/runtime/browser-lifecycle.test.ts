import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'bun:test'

import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import { BrowserFetchLimits } from '../../contract/constants.js'
import type { BrowserPageDriver } from '../../contract/requires.js'
import { BrowserPageDataEngine } from '../../impl/electron/BrowserPageDataEngine.js'
import { BrowserPageWaiter } from '../../impl/electron/BrowserPageWaiter.js'
import { BrowserScreenshotEngine } from '../../impl/electron/BrowserScreenshotEngine.js'
import { ElectronBrowserRuntime } from '../../impl/electron/ElectronBrowserRuntime.js'
import { electronDebuggerHolds } from '../../impl/electron/ElectronDebuggerHolds.js'
import { ElectronWebContentsBrowserPageDriver } from '../../impl/electron/ElectronWebContentsBrowserPageDriver.js'
import { BrowserPerformanceOrchestrator } from '../../impl/engines/BrowserPerformanceOrchestrator.js'
import { CdpPageDataEngine } from '../../impl/engines/CdpPageDataEngine.js'
import { BrowserPendingEventsBroker } from '../../impl/session/BrowserPendingEventsBroker.js'
import { writeScreenshotModelImage } from '../../utils/electron/screenshot-image.js'

test('browser runtime disposal rejects new work while closeAllSessions permits reopening', async () => {
  let pageHooks = 0
  let subscriptions = 0
  let releases = 0
  let launches = 0
  const context = { url: 'https://example.test/', workspaceRoot: '/unused' }
  const driver = (): BrowserPageDriver =>
    ({
      isDestroyed: () => false,
      getURL: () => context.url,
      getTitle: () => '',
      refreshPageState: async () => {
        pageHooks += 1
        return { url: context.url, title: '' }
      },
      bringToFront: async () => {
        pageHooks += 1
      },
      onDownload: () => {
        subscriptions += 1
        return () => {
          releases += 1
        }
      },
      dispose: () => undefined,
    }) as unknown as BrowserPageDriver
  const runtime = new ElectronBrowserRuntime({
    externalBrowserLauncher: {
      launch: async () => {
        launches += 1
        return { driver: driver(), dispose: () => undefined }
      },
    },
  })
  try {
    runtime.attachExternalPageDriver('first', driver())
    await runtime.showPage('first', context)
    runtime.closeAllSessions()
    assert.equal(releases, 1)
    runtime.attachExternalPageDriver('second', driver())
    await runtime.showPage('second', context)
    runtime.dispose()
    assert.equal(releases, 2)
    const hooksBefore = pageHooks
    assert.throws(() => runtime.attachExternalPageDriver('fresh', driver()), { code: 'CLOSED' })
    assert.throws(() => runtime.setOptions({}), { code: 'CLOSED' })
    assert.throws(
      () =>
        runtime.withModelAction('fresh', async () => {
          pageHooks += 1
        }),
      { code: 'CLOSED' }
    )
    const requests: Array<() => Promise<unknown>> = [
      () => runtime.openPage('fresh', context),
      () => runtime.showPage('fresh', context),
      () => runtime.presentPage('fresh', context, 1),
      () => runtime.launchExternalBrowserPage('fresh', context),
      () => runtime.getPageState('fresh', context),
      () => runtime.listPageTargets('fresh', context),
      () => runtime.capturePreviewFrame('fresh', context, {}),
      () => runtime.startPreviewFrameStream('fresh', context, {}, () => undefined),
      () => runtime.readProtocolEvents('fresh', context, {}),
      () => runtime.inspectPage('fresh', context),
    ]
    for (const request of requests)
      await assert.rejects(Promise.resolve().then(request), { code: 'CLOSED' })
    assert.equal(runtime.hasExternalPage('fresh'), false)
    assert.equal(runtime.getTurnContextSnapshot('fresh'), null)
    await runtime.stopPreviewFrameStream('fresh')
    await runtime.closeSession('fresh')
    assert.equal(pageHooks, hooksBefore)
    assert.equal(subscriptions, 2)
    assert.equal(launches, 0)
  } finally {
    runtime.dispose()
  }
})

test('browser runtime disposal publishes terminal admission before cleanup callbacks reenter', () => {
  let disposals = 0
  let launchDisposals = 0
  let subscriptionCalls = 0
  const runtime = new ElectronBrowserRuntime({
    externalBrowserLauncher: {
      launch: async () => {
        throw new Error('closed owner must never launch')
      },
      dispose: () => {
        launchDisposals += 1
        runtime.dispose()
        assert.throws(() => runtime.setOptions({}), { code: 'CLOSED' })
      },
    },
  })
  const driver = {
    getURL: () => 'https://example.test/',
    getTitle: () => '',
    isDestroyed: () => false,
    onDownload: () => {
      subscriptionCalls += 1
      return () => undefined
    },
    dispose: () => {
      disposals += 1
      runtime.dispose()
      assert.throws(() => runtime.attachExternalPageDriver('reentrant', driver), { code: 'CLOSED' })
    },
  } as unknown as BrowserPageDriver
  runtime.attachExternalPageDriver('s', driver)
  runtime.dispose()
  runtime.dispose()
  assert.equal(disposals, 1)
  assert.equal(launchDisposals, 1)
  assert.equal(subscriptionCalls, 1)
  assert.equal(runtime.hasExternalPage('reentrant'), false)
  assert.equal(runtime.getTurnContextSnapshot('s'), null)
})

test('browser runtime disposal retries failed host cleanup without reopening admission', () => {
  for (const failingOwner of ['page', 'launcher']) {
    const failure = new Error(`${failingOwner} cleanup failed`)
    let failing = true
    let pageDisposals = 0
    let launcherDisposals = 0
    const runtime = new ElectronBrowserRuntime({
      externalBrowserLauncher: {
        launch: async () => {
          throw new Error('closed owner must never launch')
        },
        dispose: () => {
          launcherDisposals += 1
          if (failing && failingOwner === 'launcher') throw failure
        },
      },
    })
    const driver = {
      getURL: () => 'https://example.test/',
      getTitle: () => '',
      isDestroyed: () => false,
      dispose: () => {
        pageDisposals += 1
        if (failing && failingOwner === 'page') throw failure
      },
    } as unknown as BrowserPageDriver
    try {
      runtime.attachExternalPageDriver('s', driver)
      assert.throws(
        () => runtime.dispose(),
        (error) => error === failure
      )
      assert.throws(() => runtime.attachExternalPageDriver('new', driver), { code: 'CLOSED' })
      assert.throws(() => runtime.setOptions({}), { code: 'CLOSED' })
      failing = false
      runtime.dispose()
      assert.equal(pageDisposals, failingOwner === 'page' ? 2 : 1)
      assert.equal(launcherDisposals, failingOwner === 'launcher' ? 2 : 1)
      runtime.dispose()
      assert.equal(launcherDisposals, failingOwner === 'launcher' ? 2 : 1)
      assert.equal(runtime.getTurnContextSnapshot('s'), null)
    } finally {
      failing = false
      runtime.dispose()
    }
  }
})

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

test('下载原生决策失败保留pending和timeout，显式成功取消才清理', () => {
  for (const broken of ['setSavePath', 'resume', 'cancel']) {
    const broker = new BrowserPendingEventsBroker()
    const timers = (broker as unknown as { timers: TimerScope }).timers
    const failure = new Error(`${broken} failed`)
    let failing = true
    const attempt = (method: string): void => {
      if (failing && broken === method) throw failure
    }
    const item = {
      getFilename: () => 'file.bin',
      getMimeType: () => '',
      getTotalBytes: () => 1,
      getReceivedBytes: () => 0,
      getSavePath: () => '',
      pause: () => undefined,
      resume: () => attempt('resume'),
      cancel: () => attempt('cancel'),
      setSavePath: () => attempt('setSavePath'),
    }
    try {
      broker.handleIncomingDownload({ sessionId: 's', item: item as never, url: null })
      const activeTimers = timers.size
      assert.ok(activeTimers > 0)
      assert.throws(
        () =>
          broker.resolveDownload({
            sessionId: 's',
            action: broken === 'cancel' ? 'cancel' : 'accept',
            savePath: '/accepted.bin',
          }),
        (error) => error === failure
      )
      assert.equal(broker.listPendingEvents('s').length, 1)
      assert.equal(timers.size, activeTimers)
      failing = false
      assert.equal(broker.resolveDownload({ sessionId: 's', action: 'cancel' }).state, 'cancelled')
      assert.equal(broker.listPendingEvents('s').length, 0)
      assert.equal(timers.size, 0)
    } finally {
      failing = false
      broker.dispose()
    }
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

test('CDP资源返回后重查取消和工作区边界，不创建迟到的下载产物', async () => {
  const base = await mkdtemp(join(tmpdir(), 'browser-download-'))
  const root = join(base, 'site')
  const outside = join(base, 'outside')
  await mkdir(root)
  await mkdir(outside)
  const response = {
    ok: true,
    status: 200,
    mimeType: 'text/plain',
    contentLength: 1,
    bytes: Buffer.from('x'),
  }
  let fetchResource = async (_options: { signal?: AbortSignal }) => response
  const engine = new CdpPageDataEngine(
    {
      getExternalPageSession: () => ({
        driver: {
          getURL: () => 'https://example.test/',
          fetchResource: (options: { signal?: AbortSignal }) => fetchResource(options),
        },
      }),
    } as never,
    {} as never,
    {} as never
  )
  const context = { url: 'https://example.test/', workspaceRoot: root }
  try {
    const abort = new AbortController()
    fetchResource = async (options) => {
      assert.equal(options.signal, abort.signal)
      abort.abort()
      return response
    }
    await assert.rejects(
      engine.fetchResource(
        's',
        context,
        { url: 'https://example.test/data', savePath: 'cancelled/result.bin' },
        abort.signal
      ),
      { name: 'AbortError' }
    )
    assert.deepEqual(await readdir(root), [])

    fetchResource = async () => {
      await symlink(outside, join(root, 'late'), process.platform === 'win32' ? 'junction' : 'dir')
      return response
    }
    await assert.rejects(
      engine.fetchResource('s', context, {
        url: 'https://example.test/data',
        savePath: 'late/result.bin',
      }),
      { code: 'PERMISSION' }
    )
    assert.deepEqual(await readdir(outside), [])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

function embeddedResourceEngine(
  fetchResponse: ConstructorParameters<typeof BrowserPageDataEngine>[5]
) {
  return new BrowserPageDataEngine(
    {
      getExternalPageSession: () => null,
      getLivePageSession: async () => ({ webContents: { session: {} } }),
      resolveCurrentPageUrl: () => 'https://example.test/page',
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    fetchResponse
  )
}

test('embedded资源按声明长度或无长度流累计执行50MiB上限，取消body且不落盘', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-embedded-fetch-limit-'))
  try {
    for (const lengthHeader of [String(BrowserFetchLimits.fileBytes + 1), null]) {
      let reads = 0
      let releases = 0
      let cancels = 0
      const engine = embeddedResourceEngine(
        async () =>
          ({
            ok: true,
            status: 200,
            headers: { get: () => lengthHeader },
            body: {
              cancel: async () => {
                cancels += 1
              },
              getReader: () => ({
                read: async () => {
                  reads += 1
                  // 第二块在拷贝前已超限，无需分配50MiB。
                  return {
                    done: false,
                    value:
                      reads === 1
                        ? new Uint8Array(1)
                        : { byteLength: BrowserFetchLimits.fileBytes },
                  }
                },
                cancel: async () => {
                  cancels += 1
                },
                releaseLock: () => {
                  releases += 1
                },
              }),
            },
          }) as never
      )
      await assert.rejects(
        engine.fetchResource(
          's',
          { url: 'https://example.test/', workspaceRoot: root },
          {
            url: 'https://example.test/large',
            savePath: 'downloads/large.bin',
          }
        ),
        (error: unknown) => {
          const failure = error as { code: string; context: { bytes: number } }
          assert.equal(failure.code, 'VALIDATION')
          assert.equal(failure.context.bytes, BrowserFetchLimits.fileBytes + 1)
          return true
        }
      )
      assert.equal(reads, lengthHeader ? 0 : 2)
      assert.equal(releases, lengthHeader ? 0 : 1)
      assert.equal(cancels, 1)
      assert.deepEqual(await readdir(root), [])
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('embedded资源在响应头和body读取挂起时均可取消，不产生迟到文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-embedded-fetch-abort-'))
  try {
    for (const stage of ['headers', 'reader']) {
      const abort = new AbortController()
      let started!: () => void
      const waiting = new Promise<void>((resolve) => {
        started = resolve
      })
      let cancels = 0
      let releases = 0
      const stream = new ReadableStream<Uint8Array>({
        cancel: () => {
          cancels += 1
        },
      })
      const engine = embeddedResourceEngine(async (_url, options) => {
        assert.equal(options?.signal, abort.signal)
        if (stage === 'headers')
          return new Promise<never>((_resolve, reject) => {
            abort.signal.addEventListener(
              'abort',
              () => {
                cancels += 1
                reject(abort.signal.reason)
              },
              { once: true }
            )
            started()
          })
        const reader = stream.getReader()
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          body: {
            cancel: () => stream.cancel(),
            getReader: () => ({
              read: () => {
                started()
                return reader.read()
              },
              cancel: () => reader.cancel(),
              releaseLock: () => {
                releases += 1
                reader.releaseLock()
              },
            }),
          },
        } as never
      })
      const pending = engine.fetchResource(
        's',
        { url: 'https://example.test/', workspaceRoot: root },
        {
          url: 'https://example.test/pending',
          savePath: 'cancelled/result.bin',
        },
        abort.signal
      )
      const rejected = assert.rejects(pending, { name: 'AbortError' })
      await waiting
      abort.abort()
      await rejected
      assert.equal(cancels, 1)
      assert.equal(releases, stage === 'reader' ? 1 : 0)
      assert.deepEqual(await readdir(root), [])
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('embedded资源重查读取期间替换的工作区路径，零字节成功响应仍能保存', async () => {
  const base = await mkdtemp(join(tmpdir(), 'browser-embedded-fetch-path-'))
  const root = join(base, 'root')
  const outside = join(base, 'outside')
  await mkdir(root)
  await mkdir(outside)
  try {
    await mkdir(join(root, 'late'))
    const late = embeddedResourceEngine(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: { get: () => null },
          body: {
            getReader: () => ({
              read: async () => {
                await rm(join(root, 'late'), { recursive: true })
                await symlink(
                  outside,
                  join(root, 'late'),
                  process.platform === 'win32' ? 'junction' : 'dir'
                )
                return { done: true }
              },
              releaseLock: () => undefined,
            }),
          },
        }) as never
    )
    await assert.rejects(
      late.fetchResource(
        's',
        { url: 'https://example.test/', workspaceRoot: root },
        {
          url: 'https://example.test/data',
          savePath: 'late/result.bin',
        }
      ),
      { code: 'PERMISSION' }
    )
    assert.deepEqual(await readdir(outside), [])
    const empty = embeddedResourceEngine(
      async () => ({ ok: true, status: 204, body: null, headers: { get: () => null } }) as never
    )
    const saved = await empty.fetchResource(
      's',
      { url: 'https://example.test/', workspaceRoot: root },
      {
        url: 'https://example.test/empty',
        savePath: 'downloads/empty.bin',
      }
    )
    assert.equal(saved.bytes, 0)
    assert.equal((await readFile(saved.path)).byteLength, 0)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('上传仅释放自己的临时debugger连接，并保留期间新增的持久占用', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-upload-hold-'))
  await writeFile(join(root, 'upload.txt'), 'upload')
  try {
    for (const addPersistentHold of [false, true]) {
      let release!: () => void
      let started!: () => void
      const waiting = new Promise<void>((resolve) => {
        started = resolve
      })
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let attached = false
      let detaches = 0
      const page = {
        isDestroyed: () => false,
        executeJavaScript: async () => ({ matched: true, selector: '#file' }),
        debugger: {
          isAttached: () => attached,
          attach: () => {
            attached = true
          },
          detach: () => {
            attached = false
            detaches += 1
          },
          sendCommand: async (method: string) => {
            if (method === 'DOM.getDocument') {
              started()
              await gate
              return { root: { nodeId: 1 } }
            }
            if (method === 'DOM.querySelector') return { nodeId: 2 }
            return {}
          },
        },
      }
      const engine = new BrowserPageDataEngine(
        {
          getExternalPageSession: () => null,
          getLivePageSession: async () => ({ webContents: page }),
        } as never,
        {} as never,
        {} as never,
        { hydrateTarget: () => ({ css: '#file' }) } as never,
        { highlightTarget: async () => undefined } as never
      )
      try {
        const uploading = engine.uploadFile(
          's',
          { url: 'https://example.test/', workspaceRoot: root },
          {
            filePath: 'upload.txt',
            target: { css: '#file', role: null, text: null, name: null, attributes: {} },
          }
        )
        await Promise.race([waiting, uploading])
        if (addPersistentHold)
          electronDebuggerHolds.setProtocol(page as never, { sessionId: 'concurrent-model' })
        release()
        assert.equal((await uploading).matched, true)
        assert.equal(detaches, addPersistentHold ? 0 : 1)
        assert.equal(attached, addPersistentHold)
      } finally {
        release()
        electronDebuggerHolds.deleteProtocol(page as never, 'concurrent-model')
        if (attached) page.debugger.detach()
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
