// 用途：钉住内嵌页面的网络采集「读诊断时按需建立 + 回执如实说明」。
// 历史事故：采集只有在调网络控制 / 响应体 / 请求详情 / 等网络空闲时才建立，读诊断在那之前
// 恒回空数组；模型照提示词「先 list_network_events 找 requestId」在内嵌页面上什么都拿不到，
// 而提示词又说内嵌页面「会明确报错」——实际是能用的，只是要先有人开采集。
import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import { buildBrowserNetworkCaptureNotice } from '../../src/core/BrowserRuntimeInternals.js'
import { ElectronWebContentsBrowserPageDriver } from '../../src/runtime/ElectronWebContentsBrowserPageDriver.js'

/** 最小 webContents 替身：只提供 debugger 与 URL。 */
function createWebContents(options: { attachThrows?: boolean } = {}) {
  let attached = false
  const sent: string[] = []
  const webContents = {
    sent,
    debugger: {
      isAttached: () => attached,
      attach: () => {
        if (options.attachThrows) throw new Error('开发者工具已经接管调试器')
        attached = true
      },
      detach: () => {
        attached = false
      },
      on: () => undefined,
      sendCommand: async (method: string) => {
        sent.push(method)
        return {}
      },
    },
    getURL: () => 'https://example.test/',
    isDestroyed: () => false,
  }

  return webContents
}

function createDriver(webContents: unknown) {
  return new ElectronWebContentsBrowserPageDriver(webContents as never)
}

void describe('内嵌页面的网络采集', () => {
  void test('读诊断时按需建立采集，并回报「这次才开始」', async () => {
    const webContents = createWebContents()
    const driver = createDriver(webContents)

    const first = await driver.ensureNetworkCapture()
    assert.deepEqual(first, { startedNow: true, unavailableReason: null })
    assert.ok(webContents.sent.includes('Network.enable'))
    // 采集建立之后就能读了（还没有请求，所以是空的，但不再是「永远空」）。
    assert.deepEqual(driver.readDiagnostics({ limit: 50, kinds: ['network'] }), [])
  })

  void test('采集已经在跑时不重复建立，也不再提示', async () => {
    const webContents = createWebContents()
    const driver = createDriver(webContents)

    await driver.ensureNetworkCapture()
    const second = await driver.ensureNetworkCapture()

    assert.deepEqual(second, { startedNow: false, unavailableReason: null })
    assert.equal(buildBrowserNetworkCaptureNotice(second), null)
  })

  void test('采集建立失败不让读诊断整个失败，如实带回原因', async () => {
    const driver = createDriver(createWebContents({ attachThrows: true }))

    const state = await driver.ensureNetworkCapture()

    assert.equal(state.startedNow, false)
    assert.match(String(state.unavailableReason), /开发者工具已经接管调试器/u)
    assert.match(String(buildBrowserNetworkCaptureNotice(state)), /没能开始/u)
  })

  void test('「这次才开始」的说明写明之前的请求看不到', () => {
    const notice = buildBrowserNetworkCaptureNotice({ startedNow: true, unavailableReason: null })

    assert.match(String(notice), /之前发出的请求没有记录/u)
    assert.match(String(notice), /重新加载页面/u)
    assert.equal(buildBrowserNetworkCaptureNotice(null), null)
  })
})
