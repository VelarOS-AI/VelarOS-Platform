// 用途：钉住「页面先没了，再停画面流」不抛错。Electron 的 webContents 销毁后，碰它的 debugger 会同步抛
// 「Object has been destroyed」：老写法 send(...).catch() 接不住同步错误，finally 里退订又抛一次，
// 画中画关窗口（后台页面已经关掉时）就在主进程里报错。
import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import { CdpScreencastRecorder } from '../../impl/cdp/CdpScreencastRecorder.js'
import type { WebContentsDebuggerLike } from '../../types/cdp.js'
import { createWebContentsCdpTraceTransport } from '../../utils/cdp/tracing.js'

/** 像 Electron 的 webContents：销毁之后读 debugger 就同步抛错。 */
function createContents(): WebContentsDebuggerLike & { destroy(): void; sent: string[] } {
  let destroyed = false
  const sent: string[] = []
  const debuggerFace = {
    sendCommand: async (method: string) => {
      sent.push(method)
      return {}
    },
    on: () => undefined,
    off: () => undefined,
  }
  return {
    sent,
    destroy: () => {
      destroyed = true
    },
    isDestroyed: () => destroyed,
    get debugger() {
      if (destroyed) throw new TypeError('Object has been destroyed')
      return debuggerFace
    },
  }
}

const options = { maxWidth: 640, maxHeight: 360, everyNthFrame: 1, maxFrames: 10 }

void describe('screencast on a page that is already gone', () => {
  void test('stopping after the page was destroyed returns what was captured instead of throwing', async () => {
    const contents = createContents()
    const recorder = new CdpScreencastRecorder(createWebContentsCdpTraceTransport(contents))
    await recorder.start(options)
    assert.deepEqual(contents.sent, ['Page.startScreencast'])

    contents.destroy()
    assert.deepEqual(await recorder.stop(), { frames: [], frameLimitReached: false })
    assert.equal(recorder.isRunning(), false)
  })

  void test('sending to a destroyed page rejects instead of throwing synchronously', async () => {
    const contents = createContents()
    const transport = createWebContentsCdpTraceTransport(contents)
    const unsubscribe = transport.onEvent('Page.screencastFrame', () => undefined)
    contents.destroy()

    const sending = transport.send('Page.stopScreencast')
    await assert.rejects(sending)
    assert.doesNotThrow(unsubscribe)
  })
})
