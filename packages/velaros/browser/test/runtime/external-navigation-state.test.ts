import { expect, test } from 'bun:test'

import type { BrowserPageDriver } from '../../contract/requires.js'
import { ElectronBrowserRuntime } from '../../impl/electron/ElectronBrowserRuntime.js'
import {
  getBrowserUrlCandidate,
  resolveBrowserNavigationInput,
  resolveBrowserSearchOrNavigationInput,
} from '../../utils/address.js'
import { normalizeUrl } from '../../utils/electron/runtime.js'

test('about:blank remains a navigation target without admitting executable opaque schemes', () => {
  for (const value of ['about:blank', 'about:blank#preview']) {
    expect(getBrowserUrlCandidate(value)).toBe(value)
    expect(resolveBrowserNavigationInput(value)).toBe(value)
    expect(resolveBrowserSearchOrNavigationInput(value)).toBe(value)
    expect(normalizeUrl(value)).toBe(value)
  }
  expect(resolveBrowserNavigationInput('javascript:alert(1)')).toBeUndefined()
  expect(resolveBrowserNavigationInput('data:text/html,hello')).toBeUndefined()
  expect(resolveBrowserNavigationInput('about:settings')).toBeUndefined()
  expect(resolveBrowserSearchOrNavigationInput('coffee gear')).toContain('/search?q=coffee%20gear')
})

test('show and state follow raw CDP navigation while explicit open still navigates to its target', async () => {
  const original = 'https://example.com/'
  let actual = original
  let cached = original
  const navigations: string[] = []
  const runtime = new ElectronBrowserRuntime()
  const driver = {
    isDestroyed: () => false,
    getURL: () => cached,
    getTitle: () => (cached === original ? 'Old title' : ''),
    bringToFront: async () => undefined,
    refreshPageState: async () => {
      cached = actual
      return { url: actual, title: actual === original ? 'Old title' : '' }
    },
    navigateTo: async (url: string) => {
      navigations.push(url)
      actual = cached = url
      return { url, title: url === original ? 'Old title' : '' }
    },
    openProtocolChannel: async () => ({
      send: async (_method: string, params: { url: string }) => {
        actual = params.url
        return { frameId: 'main' }
      },
      onEvent: () => () => undefined,
      onClose: () => () => undefined,
      close: async () => undefined,
    }),
  } as unknown as BrowserPageDriver
  runtime.attachExternalPageDriver('s', driver)
  const context = { url: original, workspaceRoot: 'D:/test-browser' }
  try {
    await runtime.sendProtocolCommand('s', context, {
      method: 'Page.navigate',
      params: { url: 'about:blank' },
    })
    const shown = await runtime.showPage('s', context)
    expect(shown.url).toBe('about:blank')
    expect(shown.title).toBe('')
    expect(navigations).toEqual([])
    await runtime.sendProtocolCommand('s', context, {
      method: 'Page.navigate',
      params: { url: 'https://example.net/new' },
    })
    expect((await runtime.getPageState('s', context)).url).toBe('https://example.net/new')
    await runtime.openPage('s', context)
    expect(navigations).toEqual([original])
  } finally {
    runtime.dispose()
  }
})
