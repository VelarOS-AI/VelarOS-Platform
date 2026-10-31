import { EventEmitter } from 'node:events'

import { expect, test } from 'bun:test'

import { ElectronWebContentsBrowserPageDriver } from '../../impl/electron/ElectronWebContentsBrowserPageDriver'

const harness = (throttling = true) => {
  const events: unknown[] = []
  let destroyed = false
  let resolveFrame!: () => void
  let enterFrame!: () => void
  const entered = new Promise<void>((resolve) => {
    enterFrame = resolve
  })
  const frame = new Promise<void>((resolve) => {
    resolveFrame = resolve
  })
  const page = Object.assign(new EventEmitter(), {
    debugger: new EventEmitter(),
    isDestroyed: () => destroyed,
    getBackgroundThrottling: () => throttling,
    setBackgroundThrottling: (value: boolean) => {
      events.push({ throttling: value })
    },
    executeJavaScript: async (script: string) => {
      events.push(script)
      enterFrame()
      await frame
    },
  })
  const driver = new ElectronWebContentsBrowserPageDriver(page as never)
  driver.openProtocolChannel = async () => ({
    send: async (method) => {
      events.push(method)
    },
    close: async () => {
      events.push('close')
    },
    onClose: () => () => {},
    onEvent: () => () => {},
  })
  return {
    events,
    entered,
    resolveFrame,
    driver,
    page,
    destroy: () => {
      destroyed = true
      page.emit('destroyed')
    },
  }
}

for (const throttled of [true, false]) {
  test(`native viewport waits for new frames and restores background throttling=${throttled}`, async () => {
    const h = harness(throttled)
    let returned = false
    const pending = h.driver.temporaryViewport({ width: 820, height: 820 }).then((restore) => {
      returned = true
      return restore
    })
    await h.entered
    expect(returned).toBe(false)
    expect(
      String(h.events.find((entry) => typeof entry === 'string' && entry.includes('new Promise')))
    ).toContain('requestAnimationFrame(() => requestAnimationFrame(')
    h.resolveFrame()
    const restore = await pending
    expect(h.events.filter((entry) => typeof entry === 'object')).toEqual(
      throttled ? [{ throttling: false }, { throttling: true }] : []
    )
    await restore()
    expect(h.events.slice(-2)).toEqual(['Emulation.clearDeviceMetricsOverride', 'close'])
    expect(h.page.listenerCount('destroyed')).toBe(0)
  })
}

test('cancelling frame synchronization restores viewport and throttling without waiting for a frame', async () => {
  const h = harness()
  const controller = new AbortController()
  const reason = new Error('cancel screenshot while waiting for compositor')
  const pending = h.driver.temporaryViewport({ width: 820, height: 820 }, controller.signal)
  await h.entered
  controller.abort(reason)
  await expect(pending).rejects.toBe(reason)
  expect(h.events.slice(-3)).toEqual([
    { throttling: true },
    'Emulation.clearDeviceMetricsOverride',
    'close',
  ])
  expect(h.page.listenerCount('destroyed')).toBe(0)
})

test('page destruction interrupts the frame wait and does not touch the destroyed WebContents settings', async () => {
  const h = harness()
  const pending = h.driver.temporaryViewport({ width: 820, height: 820 })
  await h.entered
  h.destroy()
  await expect(pending).rejects.toMatchObject({ code: 'CLOSED' })
  expect(h.events.filter((entry) => typeof entry === 'object')).toEqual([{ throttling: false }])
  expect(h.events.slice(-2)).toEqual(['Emulation.clearDeviceMetricsOverride', 'close'])
  expect(h.page.listenerCount('destroyed')).toBe(0)
})

test('a compositor that never supplies a frame reports timeout and restores both settings', async () => {
  const h = harness()
  await expect(h.driver.temporaryViewport({ width: 820, height: 820 })).rejects.toThrow(
    '未在 1500 毫秒内产生新绘制帧'
  )
  expect(h.events.slice(-3)).toEqual([
    { throttling: true },
    'Emulation.clearDeviceMetricsOverride',
    'close',
  ])
  expect(h.page.listenerCount('destroyed')).toBe(0)
})
