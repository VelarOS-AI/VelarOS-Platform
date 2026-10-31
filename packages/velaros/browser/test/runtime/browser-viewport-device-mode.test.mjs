import assert from 'node:assert/strict'

import { test } from 'bun:test'

import { CdpBrowserPageDriver } from '../../../dist/browser/impl/cdp/CdpBrowserPageDriver.js'
import { ElectronWebContentsBrowserPageDriver } from '../../../dist/browser/impl/electron/ElectronWebContentsBrowserPageDriver.js'
import { CdpInteractionEngine } from '../../../dist/browser/impl/engines/CdpInteractionEngine.js'

const createCommandRecorder = () => {
  const commands = []
  return {
    commands,
    send: async (method, params) => {
      commands.push({ method, params })
      return {}
    },
  }
}

void test('external screenshots restore the latest explicit protocol owner without resizing the native window', async () => {
  const commands = []
  let attached = 0
  const transport = (owner) => ({
    send: async (method, params) => {
      commands.push({ owner, method, params })
      return method === 'Browser.getWindowForTarget' ? { windowId: 7 } : {}
    },
    onClose: () => () => {},
    onAnyEvent: () => () => {},
    dispose: () => commands.push({ owner, method: 'dispose' }),
  })
  const driver = new CdpBrowserPageDriver({
    transport: transport('host'),
    targets: {
      targetId: 'page',
      list: async () => [],
      attach: async () => transport(`channel-${++attached}`),
    },
  })
  await driver.setViewport({ width: 960, height: 720, mobile: false })
  const model = await driver.openProtocolChannel()
  const metrics = { width: 720, height: 540, mobile: false, deviceScaleFactor: 2 }
  await model.send('Emulation.setDeviceMetricsOverride', metrics)
  commands.length = 0
  const restore = await driver.temporaryViewport({ width: 820, height: 820 })
  await restore()
  assert.equal(
    commands.some(({ method }) => method.startsWith('Browser.')),
    false
  )
  assert.deepEqual(commands.slice(-2), [
    { owner: 'channel-1', method: 'Emulation.clearDeviceMetricsOverride', params: {} },
    { owner: 'channel-1', method: 'Emulation.setDeviceMetricsOverride', params: metrics },
  ])
  await driver.setViewport({ width: 900, height: 600, mobile: false })
  commands.length = 0
  await (
    await driver.temporaryViewport({ width: 820, height: 820 })
  )()
  assert.equal(commands.at(-1).owner, 'host')
  assert.equal(commands.at(-1).params.width, 900)
  await model.close()
})

void test('external CDP viewport switches mobile metrics and touch together', async () => {
  const recorder = createCommandRecorder()
  const driver = new CdpBrowserPageDriver({ transport: recorder })

  await driver.setViewport({ width: 390, height: 844, mobile: true })
  await driver.setViewport({ width: 1440, height: 900, mobile: false })

  assert.deepEqual(recorder.commands, [
    {
      method: 'Emulation.setDeviceMetricsOverride',
      params: {
        width: 390,
        height: 844,
        screenWidth: 390,
        screenHeight: 844,
        deviceScaleFactor: 1,
        mobile: true,
      },
    },
    { method: 'Emulation.setTouchEmulationEnabled', params: { enabled: true } },
    {
      method: 'Emulation.setDeviceMetricsOverride',
      params: {
        width: 1440,
        height: 900,
        screenWidth: 1440,
        screenHeight: 900,
        deviceScaleFactor: 1,
        mobile: false,
      },
    },
    { method: 'Emulation.setTouchEmulationEnabled', params: { enabled: false } },
  ])
})

void test('external visible viewport uses the native content size without guessed frame offsets', async () => {
  const commands = []
  const driver = new CdpBrowserPageDriver({
    targets: { targetId: 'page', list: async () => [] },
    transport: {
      send: async (method, params) => {
        commands.push({ method, params })
        return method === 'Browser.getWindowForTarget' ? { windowId: 7 } : {}
      },
    },
  })
  await driver.setViewport({ width: 1440, height: 900 })
  assert.deepEqual(commands.slice(0, 2), [
    { method: 'Browser.getWindowForTarget', params: { targetId: 'page' } },
    { method: 'Browser.setContentsSize', params: { windowId: 7, width: 1440, height: 900 } },
  ])
  assert.equal(commands[2].method, 'Emulation.setDeviceMetricsOverride')
})

void test('headless or unsupported native sizing preserves device simulation', async () => {
  const commands = []
  const driver = new CdpBrowserPageDriver({
    targets: { targetId: 'page', list: async () => [] },
    transport: {
      send: async (method) => {
        commands.push(method)
        if (method === 'Browser.getWindowForTarget') throw new Error('No native window')
        return {}
      },
    },
  })
  await driver.setViewport({ width: 390, height: 844, mobile: true })
  assert.deepEqual(commands, [
    'Browser.getWindowForTarget',
    'Emulation.setDeviceMetricsOverride',
    'Emulation.setTouchEmulationEnabled',
  ])
})

void test('embedded Electron viewport preserves the same device semantics', async () => {
  const recorder = createCommandRecorder()
  const webContents = {
    debugger: {
      once: () => {},
      attach: () => {},
      isAttached: () => true,
      sendCommand: recorder.send,
    },
  }
  const driver = new ElectronWebContentsBrowserPageDriver(webContents)

  await driver.setViewport({ width: 430.4, height: 931.6, mobile: true })

  assert.deepEqual(recorder.commands, [
    {
      method: 'Emulation.setDeviceMetricsOverride',
      params: {
        width: 430,
        height: 932,
        screenWidth: 430,
        screenHeight: 932,
        deviceScaleFactor: 1,
        mobile: true,
      },
    },
    { method: 'Emulation.setTouchEmulationEnabled', params: { enabled: true } },
  ])
})

void test('viewport interaction preserves mobile mode in the driver call and result', async () => {
  const driverCalls = []
  const driver = {
    setViewport: async (viewport) => {
      driverCalls.push(viewport)
    },
  }
  const engine = new CdpInteractionEngine(
    {
      getLivePageDriverSession: async () => ({ driver }),
      refreshPageDriverSessionState: async () => ({ url: 'https://example.com', title: '' }),
    },
    {}
  )

  const result = await engine.setViewport(
    'session-1',
    { url: 'https://example.com', title: 'Example' },
    { width: 390, height: 844, mobile: true }
  )

  assert.deepEqual(driverCalls, [{ width: 390, height: 844, mobile: true }])
  assert.deepEqual(
    { url: result.url, width: result.width, height: result.height, mobile: result.mobile },
    { url: 'https://example.com', width: 390, height: 844, mobile: true }
  )
})
