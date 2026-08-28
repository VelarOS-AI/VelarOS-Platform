import assert from 'node:assert/strict'

import { test } from 'bun:test'

import {
  BrowserFallbackVirtualPointer,
  BrowserScreenshotDefaultDomStable,
  BrowserScreenshotDefaultModelImage,
  BrowserTargetActionScriptBuilder,
  buildBrowserFallbackVirtualPointerSvg,
  buildBrowserLoginDetectionScript,
  buildBrowserScreenshotOptions,
  CdpInteractionEngine,
  checkBrowserActionPolicy,
  resolveBrowserNavigationInput,
  resolveBrowserSearchOrNavigationInput,
} from '../../dist/core/index.js'

class SystemPointerTestEngine extends CdpInteractionEngine {
  constructor() {
    super({}, {}, {})
  }

  moveSystemPointer(driver, point, visible, durationMs) {
    return this.tryMoveSystemPointer(driver, point, visible, durationMs)
  }
}

void test('browser fallback pointer has one shared host-neutral appearance', () => {
  const svg = buildBrowserFallbackVirtualPointerSvg()

  assert.equal(BrowserFallbackVirtualPointer.width, 24)
  assert.equal(BrowserFallbackVirtualPointer.height, 24)
  assert.equal(BrowserFallbackVirtualPointer.viewBox, '0 0 24 24')
  assert.equal(BrowserFallbackVirtualPointer.hotspotX, 7)
  assert.equal(BrowserFallbackVirtualPointer.hotspotY, 2)
  assert.match(svg, new RegExp(BrowserFallbackVirtualPointer.path.replaceAll('.', '\\.')))
  assert.match(svg, /stroke="#ffffff"/u)
  assert.match(BrowserFallbackVirtualPointer.path, /10\.13,16\.76/u)
  assert.doesNotMatch(BrowserFallbackVirtualPointer.path, /56\.57/u)
  assert.doesNotMatch(svg, /circle|polyline/u)
})

void test('visible external pages map CSS points to the native system pointer', async () => {
  const moves = []
  const engine = new SystemPointerTestEngine()
  engine.setSystemPointerDriver({
    move: async (options) => {
      moves.push(options)
      return true
    },
  })
  const driver = {
    kind: 'external',
    bringToFront: async () => {},
    executeJavaScript: async () => ({
      focused: true,
      screenX: 100,
      screenY: 50,
      outerWidth: 1_200,
      outerHeight: 900,
      innerWidth: 1_180,
      innerHeight: 800,
    }),
  }

  assert.equal(await engine.moveSystemPointer(driver, { x: 200, y: 300 }, true, 220), true)
  assert.deepEqual(moves, [{ x: 310, y: 440, durationMs: 220 }])
})

void test('hidden pages never take over the operating-system pointer', async () => {
  let moved = false
  const engine = new SystemPointerTestEngine()
  engine.setSystemPointerDriver({
    move: async () => {
      moved = true
      return true
    },
  })

  assert.equal(
    await engine.moveSystemPointer(
      { kind: 'external', bringToFront: async () => {}, executeJavaScript: async () => ({}) },
      { x: 20, y: 30 },
      false,
      200,
    ),
    false,
  )
  assert.equal(moved, false)
})

void test('browser login detection remains owned by browser-core', () => {
  const script = buildBrowserLoginDetectionScript()

  assert.match(script, /passkey-text/u)
  assert.match(script, /human-challenge-text/u)
  assert.match(script, /signals\.includes\('passkey-text'\)/u)
  assert.match(script, /signals\.includes\('human-challenge-text'\)/u)
})

void test('browser address policy distinguishes navigation from search', () => {
  assert.equal(resolveBrowserNavigationInput('localhost:4173'), 'http://localhost:4173/')
  assert.equal(resolveBrowserNavigationInput('velaros.ai/docs'), 'https://velaros.ai/docs')
  assert.equal(
    resolveBrowserSearchOrNavigationInput('browser capability boundary', {
      searchEngine: 'bing',
    }),
    'https://www.bing.com/search?q=browser%20capability%20boundary',
  )
})

void test('browser screenshot policy owns stable model-facing defaults', () => {
  const options = buildBrowserScreenshotOptions({ modelFacing: true })

  assert.deepEqual(options.waitForDomStable, BrowserScreenshotDefaultDomStable)
  assert.deepEqual(options.includeModelImage, BrowserScreenshotDefaultModelImage)
  assert.equal(options.fullPage, true)
  assert.equal(options.compareWithPrevious, true)
})

void test('browser fill actions return the resulting control value as direct evidence', () => {
  const script = new BrowserTargetActionScriptBuilder().buildTargetActionScript({
    action: 'fill',
    target: { css: 'input[name="answer"]' },
    value: '2000',
  })

  assert.match(script, /controlState: readControlState\(element\)/u)
  assert.match(script, /return \{ kind: 'text', value, valueLength: value\.length \}/u)
  assert.match(script, /node\.type\.toLowerCase\(\) === 'password'/u)
})

void test('browser action policy owns deny, allow and alias precedence', () => {
  assert.deepEqual(
    checkBrowserActionPolicy(undefined, { action: 'navigate' }),
    {
      kind: 'allow',
      action: 'navigate',
      matchedAction: null,
      reason: null,
    },
  )

  const policy = {
    allow: ['navigate', 'target_action'],
    deny: ['evaluate'],
  }

  assert.equal(
    checkBrowserActionPolicy(policy, {
      action: 'target_action.click',
      aliases: ['target_action', 'click'],
    }).kind,
    'allow',
  )
  assert.equal(checkBrowserActionPolicy(policy, { action: 'evaluate' }).kind, 'deny')
  assert.equal(checkBrowserActionPolicy(policy, { action: 'navigate' }).kind, 'allow')
  assert.equal(checkBrowserActionPolicy(policy, { action: 'download' }).kind, 'deny')
})

void test('browser action policy supports wildcard deny matches and explicit default deny', () => {
  assert.deepEqual(
    checkBrowserActionPolicy({ deny: ['*'] }, { action: 'upload' }),
    {
      kind: 'deny',
      action: 'upload',
      matchedAction: '*',
      reason: '浏览器动作被策略拒绝：upload',
    },
  )
  assert.equal(checkBrowserActionPolicy({ default: 'deny' }, { action: 'inspect' }).kind, 'deny')
})
