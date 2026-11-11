import assert from 'node:assert/strict'

import { test } from 'bun:test'

import { BrowserScreenshotEngine } from '../../../dist/browser/impl/electron/BrowserScreenshotEngine.js'

for (const visible of [true, false]) {
  test(`native-view capture cover follows actual visibility: ${visible}`, async () => {
    const captures = []
    const frames = []
    const kernel = {
      freezePageForCapture: async (sessionId, captureFrame) => {
        frames.push([sessionId, await captureFrame()])
        return () => frames.push('released')
      },
    }
    const engine = new BrowserScreenshotEngine(kernel, null, null)
    const release = await engine.freezeForCapture('native-session', {
      visible,
      webContents: {
        isDestroyed: () => false,
        getType: () => 'webContentsView',
        getURL: () => 'https://example.com/',
        getTitle: () => 'Example',
        capturePage: async () => {
          captures.push('capture')
          return {
            isEmpty: () => false,
            getSize: () => ({ width: 800, height: 600 }),
            toJPEG: () => Buffer.from('frame'),
          }
        },
      },
    })
    assert.equal(captures.length, visible ? 1 : 0)
    if (visible) {
      assert.equal(frames[0][0], 'native-session')
      assert.equal(frames[0][1].dataUrl, 'data:image/jpeg;base64,ZnJhbWU=')
      release()
      assert.equal(frames.at(-1), 'released')
    } else assert.equal(release, null)
  })
}
