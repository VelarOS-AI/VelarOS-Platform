import { expect, test } from 'bun:test'

import { BrowserViewportState } from '../../impl/cdp/BrowserViewportState'
import { ElectronDebuggerHolds } from '../../impl/electron/ElectronDebuggerHolds'

const setup = () => {
  const viewport = new BrowserViewportState()
  const events: unknown[] = []
  const owner = {}
  const channel = {
    send: async (method: string, params: Record<string, unknown> | undefined) => {
      events.push({ method, params })
      viewport.record(channel, method, params, channel.send)
    },
    close: async () => {
      events.push('close')
      viewport.forget(channel)
    },
    onClose: () => () => {},
    onEvent: () => () => {},
  }
  const explicit = (params: Record<string, unknown>) => {
    viewport.record(owner, 'Emulation.setDeviceMetricsOverride', params, async (method, saved) => {
      events.push({ restored: { method, params: saved } })
    })
  }
  return { viewport, events, channel, owner, explicit }
}

test('temporary metrics restore the original owner and full mobile/DPR/orientation parameters', async () => {
  const h = setup()
  const original = {
    width: 960,
    height: 720,
    mobile: true,
    deviceScaleFactor: 2,
    screenOrientation: { type: 'landscapePrimary', angle: 90 },
  }
  h.explicit(original)
  const restore = await h.viewport.temporary({ width: 820, height: 820 }, async () => h.channel)
  original.screenOrientation.angle = 0
  await restore()
  await restore()
  expect(h.events).toEqual([
    {
      method: 'Emulation.setDeviceMetricsOverride',
      params: {
        width: 820,
        height: 820,
        screenWidth: 820,
        screenHeight: 820,
        deviceScaleFactor: 1,
        mobile: true,
      },
    },
    { method: 'Emulation.clearDeviceMetricsOverride', params: {} },
    'close',
    { restored: { method: 'Emulation.clearDeviceMetricsOverride', params: {} } },
    {
      restored: {
        method: 'Emulation.setDeviceMetricsOverride',
        params: { ...original, screenOrientation: { type: 'landscapePrimary', angle: 90 } },
      },
    },
  ])
})

test('natural viewport is cleared rather than replaced with a fixed snapshot', async () => {
  const h = setup()
  const restore = await h.viewport.temporary({ width: 820, height: 820 }, async () => h.channel)
  await restore()
  expect(h.events.length).toBe(3)
  expect(h.events.at(-1)).toBe('close')
})

test('failure after an override was applied still clears, closes and restores the prior owner', async () => {
  const h = setup()
  h.explicit({ width: 960, height: 720, mobile: false, deviceScaleFactor: 1 })
  const send = h.channel.send
  h.channel.send = async (method, params) => {
    await send(method, params)
    if (method === 'Emulation.setDeviceMetricsOverride')
      throw new Error('transport failed after apply')
  }
  await expect(
    h.viewport.temporary({ width: 820, height: 820 }, async () => h.channel)
  ).rejects.toThrow('transport failed after apply')
  expect(h.events[1]).toEqual({ method: 'Emulation.clearDeviceMetricsOverride', params: {} })
  expect(h.events[2]).toBe('close')
  expect(h.events.length).toBe(5)
})

test('an explicit clear is respected and a closed owner is not resurrected', async () => {
  const h = setup()
  h.explicit({ width: 960, height: 720 })
  const restore = await h.viewport.temporary({ width: 820, height: 820 }, async () => h.channel)
  h.viewport.forget(h.owner)
  await restore()
  expect(h.events.length).toBe(3)
  h.explicit({ width: 900, height: 600 })
  h.viewport.record(h.owner, 'Emulation.clearDeviceMetricsOverride', {}, async () => {})
  h.events.length = 0
  await (
    await h.viewport.temporary({ width: 820, height: 820 }, async () => h.channel)
  )()
  expect(h.events.length).toBe(3)
})

test('closing screenshot protocol does not release the concurrently open model protocol hold', () => {
  const holds = new ElectronDebuggerHolds()
  const page = {} as Parameters<typeof holds.setProtocol>[0]
  holds.setProtocol(page, { sessionId: 'model' })
  holds.setProtocol(page, { sessionId: 'screenshot' })
  holds.deleteProtocol(page, 'screenshot')
  expect(holds.hasPersistentHold(page)).toBe(true)
  holds.deleteProtocol(page, 'model')
  expect(holds.hasPersistentHold(page)).toBe(false)
})
