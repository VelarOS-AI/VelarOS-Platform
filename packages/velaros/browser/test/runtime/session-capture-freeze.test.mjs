/**
 * @test-meta
 * title: 截图定格
 * summary: 截图要临时改动页面画面时，会话管理器把此刻这一屏交给宿主盖住页面、等它盖好，截完再请它拿掉；宿主没接不取图，宿主迟迟不结算或出错都照截。
 * area: packages
 */
import assert from 'node:assert/strict'

import { test } from 'bun:test'

import { BrowserSessionManager } from '../../../dist/browser/impl/electron/BrowserSessionManager.js'
import { BrowserTuning } from '../../../dist/browser/utils/tuning.js'

const Frame = {
  dataUrl: 'data:image/jpeg;base64,AAAA',
  width: 2880,
  height: 1800,
  url: 'https://shop.test/',
  title: '书店',
  capturedAt: 1,
}

/** 一个会话管理器；给了 freeze 就当宿主实现了截图定格。 */
function createManager(freeze) {
  const callbacks = {}
  if (freeze) callbacks.onPageCaptureFreeze = freeze
  return new BrowserSessionManager({
    diagnostics: {
      record: () => undefined,
      shouldRecordConsoleMessage: () => false,
      normalizeConsoleLevel: () => 'info',
    },
    pageWaiter: {},
    normalizeUrl: (url) => new URL(url).toString(),
    callbacks,
  })
}

/** 取定格图的替身：记下被取了几次。 */
function frameSource(frame = Frame) {
  const source = async () => {
    source.calls += 1
    return frame
  }
  source.calls = 0
  return source
}

void test('宿主没接截图定格：不取图，交回 null', async () => {
  const manager = createManager(null)
  const captureFrame = frameSource()

  assert.equal(await manager.freezePageForCapture('rt-1', captureFrame), null)
  assert.equal(captureFrame.calls, 0)
  manager.dispose()
})

void test('宿主盖好了才往下截；拿掉时再通知一次、frame 为 null', async () => {
  const calls = []
  let covered = false
  const manager = createManager(async (sessionId, frame) => {
    calls.push({ sessionId, frame })
    if (frame) {
      await new Promise((resolve) => setTimeout(resolve, 60))
      covered = true
    }
  })

  const release = await manager.freezePageForCapture('rt-1', frameSource())
  assert.equal(covered, true, '交回之前宿主已经盖好')
  assert.deepEqual(calls, [{ sessionId: 'rt-1', frame: Frame }])

  release()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(calls.at(-1), { sessionId: 'rt-1', frame: null })
  manager.dispose()
})

void test('取不到图就不盖，也不通知宿主', async () => {
  const calls = []
  const manager = createManager((sessionId, frame) => {
    calls.push(frame)
  })

  assert.equal(await manager.freezePageForCapture('rt-1', frameSource(null)), null)
  assert.equal(
    await manager.freezePageForCapture('rt-1', async () => {
      throw new Error('capturePage failed')
    }),
    null
  )
  assert.deepEqual(calls, [])
  manager.dispose()
})

void test('宿主迟迟不结算：到时限就照截，截完照样请它拿掉', async () => {
  const calls = []
  const manager = createManager((sessionId, frame) => {
    calls.push(frame)
    return frame ? new Promise(() => undefined) : undefined
  })

  const started = Date.now()
  const release = await manager.freezePageForCapture('rt-1', frameSource())
  const waited = Date.now() - started
  assert.ok(waited >= BrowserTuning.screenshot.captureFreezeTimeoutMs - 50, `等了 ${waited}ms`)
  assert.ok(waited < BrowserTuning.screenshot.captureFreezeTimeoutMs + 1_000)

  release()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(calls, [Frame, null])
  manager.dispose()
})

void test('宿主出错也照截，拿掉时的出错不往外抛', async () => {
  const calls = []
  const manager = createManager(async (sessionId, frame) => {
    calls.push(frame)
    throw new Error('renderer gone')
  })

  const release = await manager.freezePageForCapture('rt-1', frameSource())
  assert.equal(typeof release, 'function')
  release()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(calls, [Frame, null])
  manager.dispose()
})
