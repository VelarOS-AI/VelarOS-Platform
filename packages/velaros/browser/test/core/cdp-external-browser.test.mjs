/**
 * @test-meta
 * title: 外部浏览器一条连接
 * summary: 外部浏览器只走一条浏览器级 WebSocket：标签页会话按 sessionId 分流、子会话跟着页面走、标签页关了或浏览器退了驱动就作废；
 *   启动器先接用户开着的 Chrome、再接 userDataDir 上开着的、都没有才拉起，几次 launch 共用一条连接各开各的标签页，
 *   会话只关自己的标签页，收尾只杀自己拉起的浏览器；运行时据此回答会话还有没有外部页面。
 * area: packages
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

import { describe, test } from 'bun:test'

import {
  BrowserFetchLimits,
  ExternalBrowserUnavailableReason,
} from '../../../dist/browser/contract/constants.js'
import { createElectronBrowserRuntime } from '../../../dist/browser/electron.js'
import { CdpBrowserConnection } from '../../../dist/browser/impl/cdp/CdpBrowserConnection.js'
import { CdpBrowserPageDownloadItem } from '../../../dist/browser/impl/cdp/CdpBrowserPageDownloadItem.js'
import { CdpBrowserPageDriver } from '../../../dist/browser/impl/cdp/CdpBrowserPageDriver.js'
import { CdpExternalBrowserLauncher } from '../../../dist/browser/impl/cdp/CdpExternalBrowserLauncher.js'
import { CdpWebSocketTransport } from '../../../dist/browser/impl/cdp/CdpWebSocketTransport.js'
import { buildFetchResourceFunction } from '../../../dist/browser/utils/cdp/driver.js'
import { getDefaultUserDataDirCandidates } from '../../../dist/browser/utils/cdp/launcher.js'
import { openCdpWebSocket } from '../../../dist/browser/utils/cdp/transport.js'

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

// 逐条执行真实生成的远端函数，取消命令也经独立对象句柄投递；不用真实浏览器或网络。
function createResourceDriver(fetch) {
  const objects = new Map()
  const calls = []
  let nextId = 0
  const driver = new CdpBrowserPageDriver({
    transport: {
      send: async (method, params) => {
        calls.push({ method, params })
        if (method === 'Runtime.evaluate') {
          const objectId = `resource-${++nextId}`
          objects.set(objectId, { controller: new AbortController(), reader: null })
          return { result: { objectId } }
        }
        if (method === 'Runtime.releaseObject') {
          assert.equal(objects.delete(params.objectId), true)
          return {}
        }
        if (method === 'Runtime.callFunctionOn') {
          const holder = objects.get(params.objectId)
          assert.ok(holder, '命令必须仍持有本次资源对象')
          const operation = runInNewContext(`(${params.functionDeclaration})`, {
            fetch,
            Uint8Array,
            btoa,
          })
          try {
            return { result: { value: await operation.call(holder) } }
          } catch (error) {
            return { exceptionDetails: { text: String(error) } }
          }
        }
        return {}
      },
    },
  })
  return { driver, objects, calls }
}

function createDownloadDriver(downloadPath) {
  const listeners = new Map()
  const closure = []
  let notifyClosed
  const closed = new Promise((resolve) => {
    notifyClosed = resolve
  })
  const driver = new CdpBrowserPageDriver({
    downloadPath,
    onDispose: () => {
      closure.push('driver')
      notifyClosed()
    },
    transport: {
      send: async () => ({}),
      dispose: () => {
        closure.push('transport')
      },
      onEvent: (method, listener) => {
        const subscribers = listeners.get(method) ?? new Set()
        subscribers.add(listener)
        listeners.set(method, subscribers)
        return () => subscribers.delete(listener)
      },
    },
  })
  return {
    driver,
    closure,
    closed,
    emit: (method, value) => {
      for (const listener of [...(listeners.get(method) ?? [])]) listener(value)
    },
    finalDiagnostics: () =>
      driver
        .readDiagnostics({ limit: 100 })
        .filter((entry) => entry.kind === 'download' && entry.details?.pending === false),
  }
}

describe('CDP下载目标落盘终态', () => {
  test('受理先于浏览器完成和浏览器先完成两种顺序，都落盘后才done并只发布一次', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'browser-cdp-download-')))
    try {
      for (const order of ['accepted-first', 'browser-first']) {
        const downloadPath = join(root, order, 'downloads')
        const savePath = join(root, order, 'saved.bin')
        await mkdir(downloadPath, { recursive: true })
        await writeFile(join(downloadPath, 'guid'), 'download bytes')
        const fixture = createDownloadDriver(downloadPath)
        let item
        fixture.driver.onDownload((event) => {
          item = event.item
        })
        try {
          fixture.emit('Page.downloadWillBegin', { guid: 'guid', suggestedFilename: 'saved.bin' })
          assert.ok(item)
          const states = []
          const finished = new Promise((resolve) =>
            item.once('done', (_event, state) => {
              states.push(state)
              resolve(state)
            })
          )
          if (order === 'accepted-first') {
            item.setSavePath(savePath)
            item.resume()
          }
          fixture.emit('Page.downloadProgress', { guid: 'guid', state: 'completed' })
          assert.deepEqual(states, [])
          assert.deepEqual(fixture.finalDiagnostics(), [])
          if (order === 'browser-first') {
            await settle()
            assert.deepEqual(states, [])
            assert.deepEqual(fixture.finalDiagnostics(), [])
            item.setSavePath(savePath)
            item.resume()
            assert.deepEqual(states, [])
          }
          assert.equal(await finished, 'completed')
          assert.equal(await readFile(savePath, 'utf8'), 'download bytes')
          fixture.emit('Page.downloadProgress', { guid: 'guid', state: 'completed' })
          item.resume()
          item.cancel()
          await settle()
          assert.deepEqual(states, ['completed'])
          assert.equal(fixture.finalDiagnostics().length, 1)
          assert.equal(fixture.finalDiagnostics()[0].details.state, 'completed')
          assert.equal(await readFile(savePath, 'utf8'), 'download bytes')
        } finally {
          fixture.driver.dispose()
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('目标移动失败时仅done interrupted，保留诊断且不重试finalization', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'browser-cdp-download-failed-')))
    const downloadPath = join(root, 'downloads')
    const savePath = join(root, 'existing-directory')
    await mkdir(downloadPath)
    await mkdir(savePath)
    await writeFile(join(downloadPath, 'guid'), 'recoverable bytes')
    const fixture = createDownloadDriver(downloadPath)
    let item
    fixture.driver.onDownload((event) => {
      item = event.item
    })
    try {
      fixture.emit('Page.downloadWillBegin', { guid: 'guid', suggestedFilename: 'saved.bin' })
      assert.ok(item)
      const states = []
      const finished = new Promise((resolve) =>
        item.once('done', (_event, state) => {
          states.push(state)
          resolve(state)
        })
      )
      item.setSavePath(savePath)
      item.resume()
      fixture.emit('Page.downloadProgress', { guid: 'guid', state: 'completed' })
      assert.deepEqual(states, [])
      assert.deepEqual(fixture.finalDiagnostics(), [])
      assert.equal(await finished, 'interrupted')
      item.resume()
      fixture.emit('Page.downloadProgress', { guid: 'guid', state: 'completed' })
      await settle()
      assert.deepEqual(states, ['interrupted'])
      assert.equal(fixture.finalDiagnostics().length, 1)
      assert.equal(fixture.finalDiagnostics()[0].details.state, 'interrupted')
      const diagnostics = fixture.driver.readDiagnostics({ limit: 100 })
      assert.equal(
        diagnostics.some((entry) => entry.details?.state === 'completed'),
        false
      )
      assert.equal(diagnostics.filter((entry) => entry.details?.renameError).length, 1)
      assert.equal(diagnostics.filter((entry) => entry.details?.copyError).length, 0)
      assert.deepEqual(await readdir(savePath), [])
      assert.equal(await readFile(join(downloadPath, 'guid'), 'utf8'), 'recoverable bytes')
    } finally {
      fixture.driver.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('移动挂起期间取消与迟到canceled进度等待落盘结算，按实际结果仅通知一次', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'browser-cdp-download-drain-')))
    try {
      for (const outcome of ['completed', 'interrupted']) {
        const downloadPath = join(root, outcome, 'downloads')
        await mkdir(downloadPath, { recursive: true })
        await writeFile(join(downloadPath, 'guid'), 'download')
        const savePath = join(root, outcome, 'saved.bin')
        if (outcome === 'interrupted') await mkdir(savePath)
        let started
        let release
        const waiting = new Promise((resolve) => {
          started = resolve
        })
        const gate = new Promise((resolve) => {
          release = resolve
        })
        const diagnostics = []
        const item = new CdpBrowserPageDownloadItem(
          {
            transport: { send: async () => ({}) },
            guid: 'guid',
            url: null,
            filename: 'saved.bin',
            downloadPath,
            appendDiagnostic: (entry) => diagnostics.push(entry),
          },
          async (source, target) => {
            started()
            await gate
            if (outcome === 'interrupted')
              throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
            await rename(source, target)
          }
        )
        const states = []
        const done = new Promise((resolve) =>
          item.once('done', (_event, state) => {
            states.push(state)
            resolve(state)
          })
        )
        item.setSavePath(savePath)
        item.resume()
        item.updateProgress({ state: 'completed' })
        try {
          await waiting
          item.cancel()
          item.updateProgress({ state: 'canceled' })
          await settle()
          assert.deepEqual(states, [])
          release()
          assert.equal(await done, outcome)
          await item.drainFinalization()
          assert.deepEqual(states, [outcome])
          if (outcome === 'completed') assert.equal(await readFile(savePath, 'utf8'), 'download')
          else {
            assert.equal(await readFile(join(downloadPath, 'guid'), 'utf8'), 'download')
            assert.equal(diagnostics.filter((entry) => entry.details.copyError).length, 1)
          }
        } finally {
          release()
          await item.drainFinalization()
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('真实launcher与runtime连续关闭先排空下载，再关闭页面连接和自有profile', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'browser-cdp-download-close-')))
    const downloadPath = join(root, 'downloads')
    await mkdir(downloadPath)
    await writeFile(join(downloadPath, 'guid'), 'download')
    const machine = createMachine()
    const runtime = createElectronBrowserRuntime({ externalBrowserLauncher: machine.launcher })
    const session = await machine.launcher.launch({
      url: 'https://download.test/',
      platform: 'darwin',
      preferRunningBrowser: false,
      downloadPath,
    })
    const browser = machine.spawned[0].browser
    const targetId = [...browser.tabs].find(([, page]) => page.url === 'https://download.test/')[0]
    const pageSessionId = [...browser.sessions].find(([, page]) => page.targetId === targetId)[0]
    runtime.attachExternalPageDriver('s', session.driver, { disposeHost: session.dispose })
    let release
    let started
    const waiting = new Promise((resolve) => {
      started = resolve
    })
    const gate = new Promise((resolve) => {
      release = resolve
    })
    let item
    session.driver.onDownload((event) => {
      item = event.item
    })
    try {
      browser.event(pageSessionId, 'Page.downloadWillBegin', {
        guid: 'guid',
        suggestedFilename: 'saved.bin',
      })
      item.moveFile = async (source, target) => {
        started()
        await gate
        await rename(source, target)
      }
      const states = []
      item.once('done', (_event, state) => {
        assert.equal(browser.tabs.has(targetId), true)
        assert.equal(browser.sockets[0].closed, false)
        assert.deepEqual(machine.kills, [])
        assert.deepEqual(machine.removed, [])
        states.push(state)
      })
      assert.equal(
        (
          await runtime.handleDownload(
            's',
            { url: 'https://download.test/', workspaceRoot: root },
            { action: 'accept', savePath: 'saved.bin' }
          )
        ).state,
        'accepted'
      )
      browser.event(pageSessionId, 'Page.downloadProgress', { guid: 'guid', state: 'completed' })
      await waiting
      runtime.dispose()
      assert.deepEqual(states, [])
      assert.equal(browser.tabs.has(targetId), true)
      assert.equal(browser.sockets[0].closed, false)
      assert.deepEqual(machine.kills, [])
      assert.deepEqual(machine.removed, [])
      await assert.rejects(session.driver.insertText({ text: 'late input' }), {
        code: 'EXECUTION_ABORTED',
      })
      await assert.rejects(session.driver.executeJavaScript('document.title'), {
        code: 'EXECUTION_ABORTED',
      })
      release()
      await item.drainFinalization()
      await settle()
      assert.deepEqual(states, ['completed'])
      assert.deepEqual(
        browser.commands('Target.closeTarget').map((call) => call.params.targetId),
        [targetId]
      )
      assert.equal(browser.sockets[0].closed, true)
      assert.equal(machine.kills.length, 1)
      assert.deepEqual(machine.removed, [machine.spawned[0].userDataDir])
      assert.equal(await readFile(join(root, 'saved.bin'), 'utf8'), 'download')
    } finally {
      release()
      runtime.dispose()
      await item?.drainFinalization()
      await settle()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('目标祖先在受理后变成链接时不创建越界目录，权限错误不进入复制兜底', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'browser-cdp-download-path-')))
    try {
      for (const change of [
        'before-mkdir',
        'before-copy',
        'changed-decision',
        'permission',
        'cross-volume',
      ]) {
        const base = join(root, change)
        const downloadPath = join(base, 'downloads')
        const allowed = join(base, 'allowed')
        const outside = join(base, 'outside')
        await mkdir(downloadPath, { recursive: true })
        await mkdir(allowed)
        await mkdir(outside)
        await writeFile(join(downloadPath, 'guid'), 'download')
        const diagnostics = []
        let moves = 0
        const item = new CdpBrowserPageDownloadItem(
          {
            transport: { send: async () => ({}) },
            guid: 'guid',
            url: null,
            filename: 'saved.bin',
            downloadPath,
            appendDiagnostic: (entry) => diagnostics.push(entry),
          },
          async () => {
            moves += 1
            if (change === 'before-copy') {
              await rm(allowed, { recursive: true })
              await symlink(outside, allowed, process.platform === 'win32' ? 'junction' : 'dir')
            }
            if (change === 'changed-decision') item.setSavePath(join(outside, 'replaced.bin'))
            throw Object.assign(new Error(change), {
              code: change === 'permission' ? 'EACCES' : 'EXDEV',
            })
          }
        )
        const savePath = join(allowed, change === 'before-mkdir' ? 'nested/saved.bin' : 'saved.bin')
        item.setSavePath(savePath)
        if (change === 'before-mkdir') {
          await rm(allowed, { recursive: true })
          await symlink(outside, allowed, process.platform === 'win32' ? 'junction' : 'dir')
        }
        const done = new Promise((resolve) => item.once('done', (_event, state) => resolve(state)))
        item.resume()
        item.updateProgress({ state: 'completed' })
        assert.equal(await done, change === 'cross-volume' ? 'completed' : 'interrupted')
        await item.drainFinalization()
        assert.equal(moves, change === 'before-mkdir' ? 0 : 1)
        assert.deepEqual(await readdir(outside), [])
        if (change === 'cross-volume') {
          assert.equal(await readFile(savePath, 'utf8'), 'download')
          assert.deepEqual(await readdir(downloadPath), [])
        } else {
          assert.equal(await readFile(join(downloadPath, 'guid'), 'utf8'), 'download')
          assert.equal(diagnostics.length, 1)
          assert.equal(diagnostics[0].details.copyError, null)
          if (change === 'changed-decision') assert.equal(diagnostics[0].details.code, 'CONFLICT')
          else if (change !== 'permission') assert.equal(diagnostics[0].details.code, 'PERMISSION')
          else assert.deepEqual(await readdir(allowed), [])
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('外部页面资源读取', () => {
  test('空的成功资源合法返回零字节', async () => {
    const driver = new CdpBrowserPageDriver({
      transport: {
        send: async (method) =>
          method === 'Runtime.evaluate'
            ? { result: { objectId: 'empty-resource' } }
            : {
                result: {
                  value: { ok: true, status: 204, mimeType: null, contentLength: 0, data: '' },
                },
              },
      },
    })
    try {
      const resource = await driver.fetchResource({ url: 'https://example.test/empty' })
      assert.equal(resource.ok, true)
      assert.equal(resource.status, 204)
      assert.equal(resource.bytes.byteLength, 0)
    } finally {
      driver.dispose()
    }
  })

  test('没有Content-Length的资源按累计字节上限取消，原样保留VALIDATION原因', async () => {
    let reads = 0
    let cancelled = 0
    let released = 0
    const payload = await runInNewContext(
      `(${buildFetchResourceFunction({ url: 'https://example.test/large' })}).call({ controller: new AbortController(), reader: null })`,
      {
        AbortController,
        Uint8Array,
        btoa,
        fetch: async () => ({
          ok: true,
          status: 200,
          headers: { get: () => null },
          body: {
            getReader: () => ({
              read: async () => ({
                done: false,
                // 不在测试里分配50MiB；超限块在拷贝前就应被拒绝。
                value:
                  ++reads === 1
                    ? new Uint8Array(2)
                    : { byteLength: BrowserFetchLimits.fileBytes - 1 },
              }),
              cancel: async () => {
                cancelled += 1
              },
              releaseLock: () => {
                released += 1
              },
            }),
          },
        }),
      }
    )
    assert.equal(reads, 2)
    assert.equal(cancelled, 1)
    assert.equal(released, 1)
    assert.equal(payload.limitExceededBytes, BrowserFetchLimits.fileBytes + 1)
    const driver = new CdpBrowserPageDriver({
      transport: {
        send: async (method) =>
          method === 'Runtime.evaluate'
            ? { result: { objectId: 'large-resource' } }
            : { result: { value: payload } },
      },
    })
    try {
      await assert.rejects(driver.fetchResource({ url: 'https://example.test/large' }), (error) => {
        assert.equal(error.code, 'VALIDATION')
        assert.equal(error.context.bytes, BrowserFetchLimits.fileBytes + 1)
        return true
      })
    } finally {
      driver.dispose()
    }
  })

  test('响应头尚未返回时取消真正中止远端fetch，释放本次句柄且不影响另一请求', async () => {
    let started
    const waiting = new Promise((resolve) => {
      started = resolve
    })
    let remoteAborts = 0
    let remoteSignal
    const fixture = createResourceDriver(async (url, options) => {
      if (url.endsWith('/healthy'))
        return { ok: true, status: 204, body: null, headers: { get: () => null } }
      remoteSignal = options.signal
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => {
            remoteAborts += 1
            reject(options.signal.reason)
          },
          { once: true }
        )
        started()
      })
    })
    const abort = new AbortController()
    const pending = fixture.driver.fetchResource({
      url: 'https://example.test/headers',
      signal: abort.signal,
    })
    const rejected = assert.rejects(pending, { name: 'AbortError' })
    try {
      await waiting
      assert.notEqual(remoteSignal, abort.signal)
      const healthy = await fixture.driver.fetchResource({ url: 'https://example.test/healthy' })
      assert.equal(healthy.bytes.byteLength, 0)
      abort.abort()
      await rejected
      assert.equal(remoteAborts, 1)
      assert.equal(remoteSignal.aborted, true)
      assert.equal(fixture.objects.size, 0)
      assert.equal(
        fixture.calls.filter((call) => call.method === 'Runtime.releaseObject').length,
        2
      )
    } finally {
      abort.abort()
      fixture.driver.dispose()
    }
  })

  test('远端reader.read挂起时取消与driver关闭都停止读取，取消监听和句柄结算', async () => {
    for (const action of ['abort', 'dispose']) {
      let started
      const waiting = new Promise((resolve) => {
        started = resolve
      })
      let cancelled = 0
      let released = 0
      let remoteSignal
      const stream = new ReadableStream({
        cancel: () => {
          cancelled += 1
        },
      })
      const reader = stream.getReader()
      const fixture = createResourceDriver(async (_url, options) => {
        remoteSignal = options.signal
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          body: {
            getReader: () => ({
              read: () => {
                started()
                return reader.read()
              },
              cancel: () => reader.cancel(),
              releaseLock: () => {
                released += 1
                reader.releaseLock()
              },
            }),
          },
        }
      })
      const abort = new AbortController()
      const pending = fixture.driver.fetchResource({
        url: 'https://example.test/body',
        signal: abort.signal,
      })
      const rejected = assert.rejects(
        pending,
        action === 'abort' ? { name: 'AbortError' } : { code: 'EXECUTION_ABORTED' }
      )
      try {
        await waiting
        if (action === 'abort') abort.abort()
        else fixture.driver.dispose()
        await rejected
        assert.equal(remoteSignal.aborted, true)
        assert.equal(cancelled, 1)
        assert.equal(released, 1)
        assert.equal(fixture.objects.size, 0)
        const commands = fixture.calls.length
        abort.abort()
        await settle()
        assert.equal(fixture.calls.length, commands)
      } finally {
        abort.abort()
        fixture.driver.dispose()
      }
    }
  })

  test('已取消调用不创建远端fetch，创建句柄期间取消也不开始传输', async () => {
    const abort = new AbortController()
    abort.abort()
    const fixture = createResourceDriver(() => {
      throw new Error('不得开始fetch')
    })
    try {
      await assert.rejects(
        fixture.driver.fetchResource({ url: 'https://example.test/data', signal: abort.signal }),
        { name: 'AbortError' }
      )
      assert.deepEqual(fixture.calls, [])
    } finally {
      fixture.driver.dispose()
    }
    let release
    let started
    const waiting = new Promise((resolve) => {
      started = resolve
    })
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const during = new AbortController()
    const calls = []
    const driver = new CdpBrowserPageDriver({
      transport: {
        send: async (method, params) => {
          calls.push({ method, params })
          if (method === 'Runtime.evaluate') {
            started()
            await gate
            return { result: { objectId: 'late-controller' } }
          }
          return {}
        },
      },
    })
    const pending = driver.fetchResource({
      url: 'https://example.test/data',
      signal: during.signal,
    })
    const rejected = assert.rejects(pending, { name: 'AbortError' })
    try {
      await waiting
      during.abort()
      release()
      await rejected
      assert.equal(calls.filter((call) => call.method === 'Runtime.callFunctionOn').length, 1)
      assert.equal(
        calls.find((call) => call.method === 'Runtime.callFunctionOn').params.awaitPromise,
        undefined
      )
      assert.equal(calls.at(-1).method, 'Runtime.releaseObject')
    } finally {
      release()
      driver.dispose()
    }
  })
})

/** 一条假的 WebSocket：发出去的交给对面的假浏览器，对面回的按 message 事件送回来。 */
class FakeSocket {
  listeners = new Map()
  closed = false
  onSend = () => undefined

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(listener)
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }

  send(data) {
    if (!this.closed) this.onSend(JSON.parse(data))
  }

  close() {
    if (this.closed) return
    this.closed = true
    queueMicrotask(() => this.emit('close'))
  }

  /** 对面（浏览器）断开。 */
  drop() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }

  deliver(message) {
    if (!this.closed) this.emit('message', { data: JSON.stringify(message) })
  }
}

/** 一个假浏览器：只开浏览器级 WebSocket，Target 域建、挂、关标签页，flatten 会话按 sessionId 回话。 */
class FakeBrowser {
  constructor(port, id) {
    this.url = `ws://127.0.0.1:${port}/devtools/browser/${id}`
    this.running = true
    this.sockets = []
    this.tabs = new Map([['start', { url: 'about:blank', title: '', browserContextId: 'default' }]])
    this.sessions = new Map()
    this.calls = []
    this.downloadBehavior = null
    this.nextId = 1
  }

  accept(socket) {
    this.sockets.push(socket)
    socket.onSend = (message) => queueMicrotask(() => this.handle(socket, message))
    socket.emit('open')
  }

  handle(socket, { id, method, params = {}, sessionId }) {
    this.calls.push({ method, params, sessionId })
    const reply = (result) => socket.deliver(sessionId ? { id, result, sessionId } : { id, result })
    const fail = (message) => socket.deliver({ id, error: { code: -32_000, message } })
    if (method === 'Test.hang') return
    if (sessionId) {
      const session = this.sessions.get(sessionId)
      if (!session) return fail('Session with given id not found.')
      if (method === 'Runtime.evaluate') {
        const tab = this.tabs.get(session.targetId)
        return reply({ result: { type: 'object', value: { url: tab?.url ?? '', title: '' } } })
      }
      return reply({})
    }
    switch (method) {
      case 'Browser.getVersion':
        return reply({ product: 'Chrome/153.0.0.0' })
      case 'Browser.setDownloadBehavior':
        this.downloadBehavior = params
        return reply({})
      case 'Target.getTargets':
        return reply({
          targetInfos: [
            ...[...this.tabs].map(([targetId, tab]) => ({ targetId, type: 'page', ...tab })),
            {
              targetId: 'incognito-tab',
              type: 'page',
              url: 'https://secret.test/',
              title: '',
              browserContextId: 'incognito',
            },
            {
              targetId: 'sw',
              type: 'service_worker',
              url: 'chrome-extension://x/sw.js',
              title: '',
              browserContextId: 'default',
            },
          ],
        })
      case 'Target.createTarget': {
        const targetId = `tab-${this.nextId++}`
        this.tabs.set(targetId, { url: params.url, title: '', browserContextId: 'default' })
        return reply({ targetId })
      }
      case 'Target.attachToTarget': {
        if (!this.tabs.has(params.targetId)) return fail('No target with given id found')
        const attached = `session-${this.nextId++}`
        this.sessions.set(attached, { targetId: params.targetId, socket })
        socket.deliver({
          method: 'Target.attachedToTarget',
          params: { sessionId: attached, targetInfo: { targetId: params.targetId, type: 'page' } },
        })
        return reply({ sessionId: attached })
      }
      case 'Target.detachFromTarget':
        this.detach(params.sessionId)
        return reply({})
      case 'Target.closeTarget':
        this.closeTab(params.targetId)
        return reply({ success: true })
      default:
        return reply({})
    }
  }

  detach(sessionId) {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    session.socket.deliver({
      method: 'Target.detachedFromTarget',
      params: { sessionId, targetId: session.targetId },
    })
  }

  /** 标签页关了（用户关的，或者 Target.closeTarget）：挂在上面的会话都脱开。 */
  closeTab(targetId) {
    this.tabs.delete(targetId)
    for (const [sessionId, session] of [...this.sessions])
      if (session.targetId === targetId) this.detach(sessionId)
  }

  /** 页面会话上来一个事件。 */
  event(sessionId, method, params = {}) {
    this.sessions.get(sessionId).socket.deliver({ method, params, sessionId })
  }

  /** 页面会话上挂出一个子会话（跨进程 iframe）。 */
  attachChild(parentSessionId, childSessionId) {
    const parent = this.sessions.get(parentSessionId)
    this.sessions.set(childSessionId, {
      targetId: `frame-${childSessionId}`,
      socket: parent.socket,
    })
    this.event(parentSessionId, 'Target.attachedToTarget', {
      sessionId: childSessionId,
      targetInfo: { type: 'iframe' },
    })
  }

  /** 用户退出了浏览器：连接全断。 */
  quit() {
    this.running = false
    for (const socket of this.sockets) socket.drop()
  }

  commands(method) {
    return this.calls.filter((call) => call.method === method)
  }
}

/** 本机回环网：按地址找浏览器，没有（端口文件过期）就是连接被拒。 */
class FakeNetwork {
  browsers = new Map()
  opened = []

  add(browser) {
    this.browsers.set(browser.url, browser)
    return browser
  }

  createSocket = (url) => {
    this.opened.push(url)
    const socket = new FakeSocket()
    const browser = this.browsers.get(url)
    queueMicrotask(() => {
      if (browser?.running) browser.accept(socket)
      else socket.drop()
    })
    return socket
  }
}

const Home = '/home/tester'
const ChromeExecutable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const userChromeDir = (channel = 'Chrome') =>
  `${Home}/Library/Application Support/Google/${channel}`

/** 一台假机器：假文件、假网络、假进程；启动器的依赖全换成它们，不碰真的 Chrome 与用户目录。 */
function createMachine() {
  const files = new Map([[ChromeExecutable, '']])
  const reads = []
  const network = new FakeNetwork()
  const spawned = []
  const kills = []
  const removed = []
  const launcher = new CdpExternalBrowserLauncher({
    homedir: () => Home,
    env: {},
    existsSync: (path) => {
      reads.push(path)
      return files.has(path)
    },
    readFile: async (path) => {
      if (!files.has(path)) throw new Error(`ENOENT: ${path}`)
      return files.get(path)
    },
    unlink: async (path) => {
      files.delete(path)
    },
    mkdtemp: async (prefix) => `${prefix}${spawned.length + 1}`,
    rm: async (path) => {
      removed.push(path)
    },
    sleep: () => settle(),
    processKill: (pid, signal) => {
      kills.push([pid, signal])
      return true
    },
    createSocket: network.createSocket,
    spawn: (command, args) => {
      const index = spawned.length
      const userDataDir = args
        .find((arg) => arg.startsWith('--user-data-dir='))
        .slice('--user-data-dir='.length)
      const port = 40_000 + index
      const browser = network.add(new FakeBrowser(port, `spawned-${index}`))
      if (args.includes('--no-startup-window')) browser.tabs.clear()
      const child = {
        pid: 5_000 + index,
        exitCode: null,
        killed: false,
        kill(signal) {
          kills.push(['child', signal])
          this.killed = true
          return true
        },
      }
      spawned.push({ command, args, userDataDir, browser, child })
      // Chrome 起来一会儿之后才写出端口文件。
      setTimeout(
        () =>
          files.set(
            `${userDataDir}/DevToolsActivePort`,
            `${port}\n/devtools/browser/spawned-${index}\n`
          ),
        5
      )
      return child
    },
  })
  /** 用户在 chrome://inspect/#remote-debugging 打开了远程调试的 Chrome。 */
  const runUserChrome = (channel = 'Chrome', port = 9_222) => {
    const browser = network.add(new FakeBrowser(port, `user-${channel}`))
    files.set(
      `${userChromeDir(channel)}/DevToolsActivePort`,
      `${port}\n/devtools/browser/user-${channel}\n`
    )
    return browser
  }
  return { files, reads, network, spawned, kills, removed, launcher, runUserChrome }
}

describe('浏览器级连接上的标签页会话', () => {
  test('握手报错和超时都关闭尚未交给连接的socket，成功握手保持打开', async () => {
    for (const failure of ['error', 'timeout']) {
      const socket = new FakeSocket()
      const opening = openCdpWebSocket('ws://test/', {
        createSocket: () => socket,
        timeoutMs: 5,
      })
      if (failure === 'error') socket.emit('error')
      await assert.rejects(opening, { code: failure === 'error' ? 'NETWORK' : 'TIMEOUT' })
      assert.equal(socket.closed, true)
      assert.equal(
        [...socket.listeners.values()].every((listeners) => listeners.size === 0),
        true
      )
    }
    const socket = new FakeSocket()
    const opening = openCdpWebSocket('ws://test/', { createSocket: () => socket })
    socket.emit('open')
    assert.equal(await opening, socket)
    assert.equal(socket.closed, false)
    socket.close()
  })

  test('同步发送失败立即撤销在飞命令，后续响应仍按单调id归属', async () => {
    const socket = new FakeSocket()
    const transport = new CdpWebSocketTransport({ socket })
    const failure = new Error('socket send failed')
    socket.send = () => {
      throw failure
    }
    await assert.rejects(transport.send('Test.fail'), (error) => error === failure)
    assert.equal(transport.pending.size, 0)
    socket.send = (data) => {
      const message = JSON.parse(data)
      assert.equal(message.id, 2)
      queueMicrotask(() => socket.deliver({ id: message.id, result: 'ok' }))
    }
    assert.equal(await transport.send('Test.next'), 'ok')
    transport.dispose()
  })

  test('每页的事件只进自己的会话，子会话跟着页面转发，发给别人的会话发不过去', async () => {
    const network = new FakeNetwork()
    const browser = network.add(new FakeBrowser(9_222, 'b'))
    const connection = await new CdpBrowserConnection().connect(browser.url, {
      createSocket: network.createSocket,
    })
    const a = await connection.attach(await connection.createPage('https://a.test/'))
    const b = await connection.attach(await connection.createPage('https://b.test/'))
    const seen = { a: [], b: [], anyA: [], anyB: [] }
    a.onEvent('Runtime.consoleAPICalled', (params) => seen.a.push(params.n))
    b.onEvent('Runtime.consoleAPICalled', (params) => seen.b.push(params.n))
    a.onAnyEvent((method, _params, sessionId) => seen.anyA.push([method, sessionId]))
    b.onAnyEvent((method, _params, sessionId) => seen.anyB.push([method, sessionId]))

    browser.event(a.sessionId, 'Runtime.consoleAPICalled', { n: 1 })
    browser.event(b.sessionId, 'Runtime.consoleAPICalled', { n: 2 })
    browser.attachChild(a.sessionId, 'child-a')
    browser.event('child-a', 'Runtime.consoleAPICalled', { n: 3 })
    await settle()

    assert.deepEqual(seen.a, [1], '按方法订阅只收这一页自己的，子会话的同名事件不混进来')
    assert.deepEqual(seen.b, [2])
    assert.deepEqual(seen.anyA, [
      ['Runtime.consoleAPICalled', undefined],
      ['Target.attachedToTarget', undefined],
      ['Runtime.consoleAPICalled', 'child-a'],
    ])
    assert.deepEqual(seen.anyB, [['Runtime.consoleAPICalled', undefined]])

    await a.send('Page.getFrameTree', {}, 'child-a')
    assert.equal(browser.calls.at(-1).sessionId, 'child-a', '明写的子会话照发')
    await a.send('Runtime.enable')
    assert.equal(browser.calls.at(-1).sessionId, a.sessionId, '不写 sessionId 就发给这一页')
    const before = browser.calls.length
    await assert.rejects(a.send('Page.enable', {}, b.sessionId), { code: 'EXECUTION_FAILED' })
    assert.equal(browser.calls.length, before, '别的标签页的会话一条都不发过去')

    connection.dispose()
  })

  test('标签页关了，驱动作废、在飞的命令当场拒绝；别的页不受影响；释放只脱开自己，不关共用的 socket', async () => {
    const network = new FakeNetwork()
    const browser = network.add(new FakeBrowser(9_222, 'b'))
    const connection = await new CdpBrowserConnection().connect(browser.url, {
      createSocket: network.createSocket,
    })
    const tabA = await connection.createPage('https://a.test/')
    const tabB = await connection.createPage('https://b.test/')
    const a = await connection.attach(tabA)
    const driverA = new CdpBrowserPageDriver({ transport: a })
    const driverB = new CdpBrowserPageDriver({ transport: await connection.attach(tabB) })
    await settle()

    const hanging = a.send('Test.hang')
    browser.closeTab(tabA)
    await assert.rejects(hanging, { code: 'EXECUTION_ABORTED' })
    assert.equal(driverA.isDestroyed(), true)
    assert.equal(driverB.isDestroyed(), false)

    driverB.dispose()
    await settle()
    assert.deepEqual(
      browser.commands('Target.detachFromTarget').map((call) => call.sessionId),
      [undefined],
      '脱开发在浏览器级会话上'
    )
    assert.equal(browser.sockets[0].closed, false, '共用的 socket 还开着')
    assert.equal(connection.isClosed(), false)
    connection.dispose()
  })

  test('浏览器退了（连接断了），挂在上面的驱动全部作废，在飞的命令当场拒绝', async () => {
    const network = new FakeNetwork()
    const browser = network.add(new FakeBrowser(9_222, 'b'))
    const connection = await new CdpBrowserConnection().connect(browser.url, {
      createSocket: network.createSocket,
    })
    const session = await connection.attach(await connection.createPage('https://a.test/'))
    const driver = new CdpBrowserPageDriver({ transport: session })
    await settle()
    const hanging = session.send('Test.hang')
    let closed = 0
    connection.onClose(() => {
      closed += 1
    })

    browser.quit()
    await assert.rejects(hanging, { code: 'EXECUTION_ABORTED' })
    assert.equal(driver.isDestroyed(), true)
    assert.equal(connection.isClosed(), true)
    assert.equal(closed, 1)
    await assert.rejects(connection.createPage('about:blank'), { code: 'EXECUTION_ABORTED' })
  })

  test('驱动经标签页目录列页面、切页面、给模型另开会话，全走浏览器级连接', async () => {
    const machine = createMachine()
    const browser = machine.runUserChrome()
    const session = await machine.launcher.launch({ url: 'https://a.test/', platform: 'darwin' })
    const other = await machine.launcher.launch({ url: 'https://b.test/', platform: 'darwin' })

    const targets = await session.driver.listPageTargets()
    assert.deepEqual(
      targets.map((target) => [target.url, target.active]),
      [
        ['about:blank', false],
        ['https://a.test/', true],
        ['https://b.test/', false],
      ],
      '同一个浏览器上下文里的标签页；无痕窗口与非页面的 target 不列'
    )

    const bTab = targets.find((target) => target.url === 'https://b.test/')
    const switched = await session.driver.switchPageTarget({ targetId: bTab.id })
    assert.notEqual(switched, session.driver)
    assert.equal(switched.getURL(), 'https://b.test/')
    assert.deepEqual(
      (await switched.listPageTargets())
        .filter((target) => target.active)
        .map((target) => target.id),
      [bTab.id]
    )
    assert.equal(await session.driver.switchPageTarget({ targetId: targets[1].id }), session.driver)

    const known = new Set(browser.sessions.keys())
    const channel = await session.driver.openProtocolChannel()
    const channelSession = [...browser.sessions.keys()].find((sessionId) => !known.has(sessionId))
    assert.ok(channelSession, '模型的会话是同一页上另挂的一条 flatten 会话')
    const events = []
    channel.onEvent((method, _params, sessionId) => events.push([method, sessionId]))
    await channel.send('Runtime.enable', undefined)
    assert.equal(browser.calls.at(-1).sessionId, channelSession)
    browser.event(channelSession, 'Runtime.executionContextCreated')
    await settle()
    assert.deepEqual(events, [['Runtime.executionContextCreated', undefined]])
    await channel.close()
    await settle()
    assert.equal(browser.sessions.has(channelSession), false, '关掉模型的会话就脱开它')

    assert.equal(machine.network.opened.length, 1, '从头到尾一条 WebSocket')
    assert.equal(browser.commands('Target.getTargets').length > 0, true)
    switched.dispose()
    await settle()
    assert.equal(browser.tabs.has(bTab.id), true, '派生驱动只脱开协议，不关闭借用的标签页')
    other.dispose()
    session.dispose()
    machine.launcher.dispose()
  })
})

describe('外部浏览器启动器', () => {
  test('同步spawn失败和Node error事件都拒绝启动并回收未启动的临时profile', async () => {
    for (const mode of ['throw', 'error']) {
      const failure = new Error('ENOENT: browser executable missing')
      const profiles = []
      const removed = []
      let killCalls = 0
      const child = Object.assign(new EventEmitter(), {
        exitCode: null,
        signalCode: null,
        pid: undefined,
        killed: false,
        kill: () => {
          killCalls += 1
          return false
        },
      })
      const launcher = new CdpExternalBrowserLauncher({
        existsSync: () => false,
        mkdtemp: async (prefix) => {
          const profile = `${prefix}${profiles.length + 1}`
          profiles.push(profile)
          return profile
        },
        unlink: async () => undefined,
        rm: async (path) => {
          removed.push(path)
        },
        sleep: async () => undefined,
        spawn: () => {
          if (mode === 'throw') throw failure
          queueMicrotask(() => child.emit('error', failure))
          return child
        },
      })
      try {
        await assert.rejects(
          launcher.launch({
            executablePath: '/missing/browser',
            preferRunningBrowser: false,
            platform: 'linux',
          }),
          mode === 'error' ? { code: 'UNAVAILABLE' } : (error) => error === failure
        )
        await settle()
        assert.ok(profiles.length > 0)
        assert.deepEqual(removed, profiles)
        assert.equal(killCalls, 0)
        assert.equal(child.listenerCount('error'), 0)
      } finally {
        launcher.dispose()
      }
    }
  })

  test('用户自己的 Chrome：按默认配置目录的端口文件接上，过期的端口文件跳过；不改它的下载行为', async () => {
    const machine = createMachine()
    machine.files.set(
      `${userChromeDir('Chrome')}/DevToolsActivePort`,
      '9333\n/devtools/browser/gone\n'
    )
    const beta = machine.runUserChrome('Chrome Beta', 9_222)

    const session = await machine.launcher.launch({
      url: 'https://example.com',
      platform: 'darwin',
    })

    assert.deepEqual(machine.network.opened, [
      'ws://127.0.0.1:9333/devtools/browser/gone',
      'ws://127.0.0.1:9222/devtools/browser/user-Chrome Beta',
    ])
    assert.equal(machine.spawned.length, 0, '接上了就不拉起')
    assert.deepEqual(
      beta.commands('Target.createTarget').map((call) => call.params.url),
      ['https://example.com'],
      '另开一个新标签页，不占用户已有的标签页'
    )
    assert.equal(session.driver.kind, 'external')
    assert.equal(session.driver.getURL(), 'https://example.com/')
    assert.equal(beta.downloadBehavior, null, '用户自己的 Chrome 不改下载行为')
    session.dispose()
    machine.launcher.dispose()
  })

  test('两次 launch 共用一条 WebSocket，各开各的标签页；关一个会话只关它自己的标签页', async () => {
    const machine = createMachine()
    const browser = machine.runUserChrome()

    const [first, second] = await Promise.all([
      machine.launcher.launch({ url: 'https://a.test/', platform: 'darwin' }),
      machine.launcher.launch({ url: 'https://b.test/', platform: 'darwin' }),
    ])
    const third = await machine.launcher.launch({ url: 'https://c.test/', platform: 'darwin' })

    assert.equal(machine.network.opened.length, 1, '同时 launch 也只连一次，用户只点一次「允许」')
    const created = browser.commands('Target.createTarget').length
    assert.equal(created, 3)
    const tabs = [...browser.tabs.keys()].filter((targetId) => targetId !== 'start')
    assert.equal(new Set(tabs).size, 3)

    first.dispose()
    await settle()
    assert.equal(first.driver.isDestroyed(), true)
    assert.equal(second.driver.isDestroyed(), false)
    assert.equal(third.driver.isDestroyed(), false)
    assert.equal(browser.commands('Target.closeTarget').length, 1)
    assert.equal(browser.tabs.size, 3, '另外两页与起始页都还在')
    assert.equal(browser.sockets[0].closed, false, '连接留着给后来的会话')
    first.dispose()
    await settle()
    assert.equal(browser.commands('Target.closeTarget').length, 1, 'dispose 只做一次')
    machine.launcher.dispose()
  })

  test('没有开着的浏览器就拉起：按 DevToolsActivePort 里的路径连浏览器级 WebSocket；同一个 userDataDir 再 launch 复用它', async () => {
    const machine = createMachine()
    const userDataDir = '/data/velaros-profile'

    const [first, second] = await Promise.all([
      machine.launcher.launch({ url: 'https://a.test/', userDataDir, platform: 'darwin' }),
      machine.launcher.launch({ url: 'https://b.test/', userDataDir, platform: 'darwin' }),
    ])

    assert.equal(machine.spawned.length, 1, '同一个配置目录只拉起一个 Chrome')
    const [{ args, browser }] = machine.spawned
    assert.ok(args.includes('--remote-debugging-port=0'))
    assert.ok(args.includes(`--user-data-dir=${userDataDir}`))
    assert.ok(args.includes('--no-startup-window'))
    assert.equal(args.includes('about:blank'), false, '不额外生成启动空白页')
    assert.equal(browser.tabs.size, 2, '只保留两个调用方请求的页面')
    assert.deepEqual(machine.network.opened, ['ws://127.0.0.1:40000/devtools/browser/spawned-0'])
    assert.deepEqual(
      browser
        .commands('Target.createTarget')
        .map((call) => call.params.url)
        .sort(),
      ['https://a.test/', 'https://b.test/']
    )
    assert.deepEqual(browser.downloadBehavior, {
      behavior: 'allowAndName',
      downloadPath: join(userDataDir, 'Downloads'),
      eventsEnabled: false,
    })
    assert.equal(
      machine.reads.includes(`${userChromeDir('Chrome')}/DevToolsActivePort`),
      true,
      '缺省先找用户自己的 Chrome'
    )
    first.dispose()
    second.dispose()
    machine.launcher.dispose()
    assert.deepEqual(machine.removed, [], '用户给的配置目录不删')
  })

  test('收尾只杀自己拉起的浏览器、删自己建的临时目录，只是连上的浏览器不关', async () => {
    const machine = createMachine()
    const userBrowser = machine.runUserChrome()
    const connected = await machine.launcher.launch({ url: 'https://a.test/', platform: 'darwin' })
    const spawnedSession = await machine.launcher.launch({
      url: 'https://b.test/',
      platform: 'darwin',
      preferRunningBrowser: false,
    })
    const again = await machine.launcher.launch({
      url: 'https://c.test/',
      platform: 'darwin',
      preferRunningBrowser: false,
    })
    assert.equal(machine.spawned.length, 1, '没给 userDataDir 时复用本实例拉起的那个临时浏览器')
    const [{ child, userDataDir, browser }] = machine.spawned

    machine.launcher.dispose()
    await settle()

    assert.deepEqual(machine.kills, [[-child.pid, 'SIGTERM']], '只杀自己拉起的进程组')
    assert.deepEqual(machine.removed, [userDataDir], '删自己建的临时目录')
    assert.equal(userBrowser.running, true)
    assert.equal(userBrowser.sockets[0].closed, true, '连接断开')
    assert.equal(browser.sockets[0].closed, true)
    for (const session of [connected, spawnedSession, again])
      assert.equal(session.driver.isDestroyed(), true)
    await assert.rejects(machine.launcher.launch({ platform: 'darwin' }), {
      code: 'EXECUTION_ABORTED',
    })
  })

  test('preferRunningBrowser: false 不碰用户的 Chrome：一个用户目录都不读', async () => {
    const machine = createMachine()
    const userBrowser = machine.runUserChrome()

    const session = await machine.launcher.launch({
      url: 'https://a.test/',
      userDataDir: '/data/velaros-profile',
      platform: 'darwin',
      preferRunningBrowser: false,
    })

    assert.equal(machine.reads.filter((path) => path.startsWith(Home)).length, 0)
    assert.equal(machine.network.opened.includes(userBrowser.url), false)
    assert.equal(machine.spawned.length, 1)
    session.dispose()
    machine.launcher.dispose()
  })

  test('spawnIfNoneRunning: false 只接开着的：没有就报 external-browser-unavailable，不拉起；用户开着就照常接上', async () => {
    const machine = createMachine()

    await assert.rejects(
      machine.launcher.launch({
        url: 'https://a.test/',
        platform: 'darwin',
        spawnIfNoneRunning: false,
      }),
      (error) => {
        assert.equal(error.context?.reason, ExternalBrowserUnavailableReason)
        return true
      }
    )
    assert.equal(machine.spawned.length, 0)

    const userBrowser = machine.runUserChrome()
    const session = await machine.launcher.launch({
      url: 'https://a.test/',
      platform: 'darwin',
      spawnIfNoneRunning: false,
    })
    assert.equal(machine.spawned.length, 0)
    assert.equal(machine.network.opened.includes(userBrowser.url), true)
    session.dispose()
    machine.launcher.dispose()
  })

  test('用户退出了 Chrome：那条连接划掉，下次 launch 重新连', async () => {
    const machine = createMachine()
    const browser = machine.runUserChrome()
    const session = await machine.launcher.launch({ url: 'https://a.test/', platform: 'darwin' })

    browser.quit()
    await settle()
    assert.equal(session.driver.isDestroyed(), true)

    browser.running = true
    browser.sockets = []
    const next = await machine.launcher.launch({ url: 'https://b.test/', platform: 'darwin' })
    assert.equal(machine.network.opened.length, 2, '重新连了一条')
    assert.equal(next.driver.isDestroyed(), false)
    next.dispose()
    machine.launcher.dispose()
  })

  test('三个平台的用户 Chrome 默认配置目录，正式版、Beta、Dev、Canary 的先后', () => {
    assert.deepEqual(
      getDefaultUserDataDirCandidates('darwin', { home: '/Users/example', env: {} }),
      [
        '/Users/example/Library/Application Support/Google/Chrome',
        '/Users/example/Library/Application Support/Google/Chrome Beta',
        '/Users/example/Library/Application Support/Google/Chrome Dev',
        '/Users/example/Library/Application Support/Google/Chrome Canary',
      ]
    )
    assert.deepEqual(
      getDefaultUserDataDirCandidates('win32', {
        home: 'C:\\Users\\u',
        env: { LOCALAPPDATA: 'D:\\Local' },
      }),
      [
        'D:\\Local\\Google\\Chrome\\User Data',
        'D:\\Local\\Google\\Chrome Beta\\User Data',
        'D:\\Local\\Google\\Chrome Dev\\User Data',
        'D:\\Local\\Google\\Chrome SxS\\User Data',
      ]
    )
    assert.deepEqual(getDefaultUserDataDirCandidates('linux', { home: '/home/u', env: {} }), [
      '/home/u/.config/google-chrome',
      '/home/u/.config/google-chrome-beta',
      '/home/u/.config/google-chrome-unstable',
      '/home/u/.config/google-chrome-canary',
    ])
    assert.equal(
      getDefaultUserDataDirCandidates('linux', {
        home: '/home/u',
        env: { XDG_CONFIG_HOME: '/x' },
      })[0],
      '/x/google-chrome'
    )
  })
})

describe('运行时的外部页面', () => {
  test('hasExternalPage：开了就有，用户退出浏览器就没有；不进动作队列、不抛', async () => {
    const machine = createMachine()
    const browser = machine.runUserChrome()
    const runtime = createElectronBrowserRuntime({ externalBrowserLauncher: machine.launcher })
    const context = { url: 'https://example.com/', workspaceRoot: '/tmp/velaros-test-site' }

    assert.equal(runtime.hasExternalPage('chat-1'), false)
    await runtime.launchExternalBrowserPage('chat-1', context, { platform: 'darwin' })
    assert.equal(runtime.hasExternalPage('chat-1'), true)
    assert.equal(runtime.hasExternalPage('chat-2'), false)

    browser.quit()
    await settle()
    assert.equal(runtime.hasExternalPage('chat-1'), false)
    runtime.dispose()
  })

  test('运行时 dispose 收掉启动器；setOptions 换了启动器就收掉换下来的，同一个再给一遍不收', () => {
    const disposed = []
    const launcherNamed = (name) => ({
      launch: () => Promise.reject(new Error('测试里不开页面')),
      dispose: () => disposed.push(name),
    })
    const first = launcherNamed('first')
    const second = launcherNamed('second')
    const runtime = createElectronBrowserRuntime({ externalBrowserLauncher: first })

    runtime.setOptions({ externalBrowserLauncher: second })
    runtime.setOptions({ externalBrowserLauncher: second })
    assert.deepEqual(disposed, ['first'])
    runtime.dispose()
    assert.deepEqual(disposed, ['first', 'second'])
  })
})
