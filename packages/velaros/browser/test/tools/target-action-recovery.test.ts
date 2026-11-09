// 用途：钉住坐标恢复的开火条件。历史事故：display:none / 宽高为 0 的元素点击回
// not-interactable，恢复逻辑照样截图 + 取 getBoundingClientRect（全 0），在视口 (0,0) 点一下
// ——那通常是站点 logo，等于把页面导航回首页，回执还写 matched:true 说点成功了。
import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import type { BrowserOperationContext, BrowserPageDriver } from '../../contract/requires.js'
import { BrowserInteractionEngine } from '../../impl/electron/BrowserInteractionEngine.js'
import { ElectronWebContentsBrowserPageDriver } from '../../impl/electron/ElectronWebContentsBrowserPageDriver.js'
import { CdpInteractionEngine } from '../../impl/engines/CdpInteractionEngine.js'
import { BrowserTargetRefStore } from '../../impl/session/BrowserTargetRefStore.js'
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

void describe('输入已经开始后的失败不重放', () => {
  void test('坐标点击回包失败不会再执行 DOM click', async () => {
    const failure = new Error('mouse reply missing after dispatch')
    const scripts: string[] = []
    let clicks = 0
    const driver = {
      kind: 'external',
      executeJavaScript: async (script: string) => {
        scripts.push(script)
        if (script.includes('__velarosActionEffectSnapshot')) return null
        return {
          action: 'click',
          url: 'https://example.test/',
          matched: true,
          clickMethod: 'coordinate',
          clickPoint: { x: 40, y: 60 },
          failureReason: null,
        }
      },
      clickCoordinates: async () => {
        clicks++
        throw failure
      },
    } as unknown as BrowserPageDriver
    const engine = new CdpInteractionEngine(
      {
        getExternalPageSession: () => ({ driver, visible: false }),
      } as never,
      new BrowserTargetRefStore()
    )
    await assert.rejects(
      engine.performTargetAction('s', { url: 'https://example.test/' } as never, {
        action: 'click',
        target: createTarget(),
      }),
      (error) => error === failure
    )
    assert.equal(clicks, 1)
    assert.equal(
      scripts.filter((script) => !script.includes('__velarosActionEffectSnapshot')).length,
      1
    )
  })

  void test('embedded CDP 点击和拖拽部分派发失败后不换 sendInputEvent 重放', async () => {
    for (const action of ['click', 'drag'] as const) {
      const failure = new Error('mousePressed accepted but reply lost')
      const sent: string[] = []
      let nativeInputs = 0
      const driver = new ElectronWebContentsBrowserPageDriver({
        isDestroyed: () => false,
        focus: () => undefined,
        debugger: {
          isAttached: () => true,
          sendCommand: async (_method: string, event: { type: string }) => {
            sent.push(event.type)
            if (event.type === 'mousePressed') throw failure
          },
        },
        sendInputEvent: () => {
          nativeInputs++
        },
      } as never)
      const pending =
        action === 'click'
          ? driver.clickCoordinates({ x: 20, y: 30 })
          : driver.dragCoordinates({ startX: 20, startY: 30, endX: 80, endY: 90 })
      await assert.rejects(pending, (error) => error === failure)
      assert.deepEqual(sent, ['mouseMoved', 'mousePressed'])
      assert.equal(nativeInputs, 0)
    }
  })

  void test('embedded 注入的 driver 缺坐标能力时，在任何输入或画面反馈前拒绝', async () => {
    let scripts = 0
    const engine = new BrowserInteractionEngine(
      {
        getExternalPageSession: () => null,
        getLivePageSession: async () => ({ webContents: {} }),
        wrapPageDriver: () => ({
          executeJavaScript: async () => {
            scripts++
          },
        }),
      } as never,
      {} as never,
      new BrowserTargetRefStore()
    )
    await assert.rejects(
      engine.clickCoordinates('s', { url: 'https://example.test/' } as never, { x: 20, y: 30 }),
      { code: 'VALIDATION' }
    )
    assert.equal(scripts, 0)
  })
})
