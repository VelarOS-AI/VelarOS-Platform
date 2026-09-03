/**
 * @test-meta
 * title: 页面导航桥不抢占站点点击
 * summary: 新窗口策略只由主进程处理，页面脚本不得捕获链接或改写 window.open。
 * area: packages
 */
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'

import { test } from 'bun:test'

import { buildSameViewNavigationBridgeScript } from '../../dist/core/index.js'

void test('legacy same-view bridge is side-effect free', () => {
  let pageListenerCount = 0
  const nativeWindowOpen = () => ({})
  const window = {
    location: {
      href: 'https://example.test/current',
      assign: () => assert.fail('page bridge must not navigate before site handlers run'),
    },
    open: nativeWindowOpen,
  }
  const document = {
    addEventListener: () => {
      pageListenerCount += 1
    },
  }

  assert.equal(
    runInNewContext(buildSameViewNavigationBridgeScript(), { document, URL, window }),
    true
  )
  assert.equal(pageListenerCount, 0)
  assert.equal(window.open, nativeWindowOpen)
})
