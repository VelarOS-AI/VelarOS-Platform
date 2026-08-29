import { describe, expect, test } from 'bun:test'

import { BrowserDiagnosticsRecorder } from '../../src/runtime/BrowserDiagnosticsRecorder'

describe('BrowserDiagnosticsRecorder', () => {
  test('drops Electron host security notices without suppressing site CSP warnings', () => {
    const recorder = new BrowserDiagnosticsRecorder()

    expect(
      recorder.shouldRecordConsoleMessage(
        '%cElectron Security Warning (Insecure Content-Security-Policy)',
        'node:electron/js2c/sandbox_bundle'
      )
    ).toBe(false)
    expect(
      recorder.shouldRecordConsoleMessage(
        'Refused to execute inline script because of Content Security Policy',
        'https://example.com/app.js'
      )
    ).toBe(true)
  })
})
