// 用途：钉住坐标恢复的开火条件。历史事故：display:none / 宽高为 0 的元素点击回
// not-interactable，恢复逻辑照样截图 + 取 getBoundingClientRect（全 0），在视口 (0,0) 点一下
// ——那通常是站点 logo，等于把页面导航回首页，回执还写 matched:true 说点成功了。
import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import type { BrowserOperationContext } from '../../contract/requires.js'
import type { BrowserElementTargetHint, BrowserTargetActionResult } from '../../types/browser.js'
import { performTargetActionWithRecovery } from '../../utils/target-recovery.js'

interface RecoveryProbeInput {
  failureReason: BrowserTargetActionResult['failureReason']
  bounds?: Record<string, unknown>
  elementLabels?: Array<Record<string, unknown>>
}

function createRecoveryProbe(input: RecoveryProbeInput) {
  const screenshots: Array<Record<string, unknown>> = []
  const clicks: Array<{ x: number; y: number }> = []
  const scripts: string[] = []
  const browser = {
    performTargetAction: async () => ({
      action: 'click',
      url: 'https://example.test/',
      matched: false,
      selector: '#buy',
      text: null,
      failureReason: input.failureReason,
      capturedAt: 0,
    }),
    captureScreenshot: async (options: Record<string, unknown>) => {
      screenshots.push(options)
      return {
        relativePath: 'artifacts/screenshots/recovery/target-action.png',
        metadata: { elementLabels: input.elementLabels ?? [] },
      }
    },
    evaluateScript: async (options: { script: string }) => {
      scripts.push(options.script)
      return {
        url: 'https://example.test/',
        ok: true,
        json: JSON.stringify(input.bounds ?? { found: false, matchCount: 0 }),
      }
    },
    clickCoordinates: async (point: { x: number; y: number }) => {
      clicks.push(point)
      return { matched: true }
    },
  }

  return { browser, screenshots, clicks, scripts }
}

function createToolContext(browser: unknown): BrowserOperationContext {
  return {
    browser,
    abortSignal: new AbortController().signal,
  } as unknown as BrowserOperationContext
}

function createTarget(frame?: BrowserElementTargetHint['frame']): BrowserElementTargetHint {
  return { css: '#buy', role: null, text: null, name: null, attributes: {}, frame }
}

async function runRecovery(input: RecoveryProbeInput, frame?: BrowserElementTargetHint['frame']) {
  const probe = createRecoveryProbe(input)
  const result = await performTargetActionWithRecovery(
    { action: 'click', target: createTarget(frame) },
    createToolContext(probe.browser)
  )
  return { ...probe, result }
}

void describe('target action 的坐标恢复', () => {
  void test('not-interactable 不做坐标恢复，如实回退未命中', async () => {
    const { result, screenshots, clicks } = await runRecovery({
      failureReason: 'not-interactable',
      bounds: { found: true, width: 0, height: 0, centerX: 0, centerY: 0 },
    })

    assert.equal(result.matched, false)
    assert.equal(result.selectorRecovery, undefined)
    assert.deepEqual(screenshots, [])
    assert.deepEqual(clicks, [])
  })

  void test('covered 不做坐标恢复', async () => {
    const { result, screenshots, clicks } = await runRecovery({ failureReason: 'covered' })

    assert.equal(result.matched, false)
    assert.deepEqual(screenshots, [])
    assert.deepEqual(clicks, [])
  })

  void test('带 frame 提示的 target 不做坐标恢复', async () => {
    const { result, screenshots } = await runRecovery(
      {
        failureReason: 'not-found',
        bounds: {
          found: true,
          width: 40,
          height: 20,
          centerX: 60,
          centerY: 80,
          viewportWidth: 1280,
          viewportHeight: 800,
        },
      },
      { css: 'iframe#checkout', name: null, title: null, url: 'https://embed.example.test/widget' }
    )

    assert.equal(result.matched, false)
    assert.deepEqual(screenshots, [])
  })

  void test('not-found 但元素宽高为 0 时不点 (0,0)，判恢复失败', async () => {
    const { result, clicks } = await runRecovery({
      failureReason: 'not-found',
      bounds: {
        found: true,
        width: 0,
        height: 0,
        centerX: 0,
        centerY: 0,
        viewportWidth: 1280,
        viewportHeight: 800,
      },
    })

    assert.equal(result.matched, false)
    assert.equal(result.selectorRecovery, undefined)
    assert.deepEqual(clicks, [])
  })

  void test('中心点落在视口外时不做坐标点击', async () => {
    const { result, clicks } = await runRecovery({
      failureReason: 'not-found',
      bounds: {
        found: true,
        width: 40,
        height: 20,
        centerX: 60,
        centerY: 2400,
        viewportWidth: 1280,
        viewportHeight: 800,
      },
    })

    assert.equal(result.matched, false)
    assert.deepEqual(clicks, [])
  })

  void test('not-found 且元素有真实尺寸时才按中心点恢复', async () => {
    const { result, clicks, screenshots } = await runRecovery({
      failureReason: 'not-found',
      bounds: {
        found: true,
        width: 120,
        height: 40,
        centerX: 300,
        centerY: 220,
        viewportWidth: 1280,
        viewportHeight: 800,
      },
    })

    assert.equal(result.matched, true)
    assert.deepEqual(clicks, [{ x: 300, y: 220 }])
    assert.deepEqual(result.selectorRecovery, {
      source: 'selector-coordinate-recovery',
      screenshotPath: 'artifacts/screenshots/recovery/target-action.png',
      x: 300,
      y: 220,
    })
    // 探针截图固定一份覆盖写，不产出面向模型的压缩图，只截视口（标注只标视口里的元素）。
    assert.equal(screenshots[0]?.path, 'artifacts/screenshots/recovery/target-action.png')
    assert.equal(screenshots[0]?.includeModelImage, false)
    assert.equal(screenshots[0]?.fullPage, false)
  })

  void test('截图标注里零尺寸的候选不参与坐标恢复', async () => {
    const { result, clicks } = await runRecovery({
      failureReason: 'not-found',
      elementLabels: [
        {
          index: 1,
          tagName: 'button',
          role: null,
          text: null,
          selector: '#buy',
          x: 10,
          y: 10,
          width: 0,
          height: 0,
        },
      ],
      bounds: { found: false, matchCount: 3 },
    })

    assert.equal(result.matched, false)
    assert.deepEqual(clicks, [])
  })
})
