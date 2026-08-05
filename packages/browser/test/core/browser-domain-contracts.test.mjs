import assert from 'node:assert/strict'

import { test } from 'bun:test'

import {
  BrowserScreenshotDefaultDomStable,
  BrowserScreenshotDefaultModelImage,
  BrowserTargetActionScriptBuilder,
  buildBrowserLoginDetectionScript,
  buildBrowserScreenshotOptions,
  checkBrowserActionPolicy,
  resolveBrowserNavigationInput,
  resolveBrowserSearchOrNavigationInput,
} from '../../dist/core/index.js'

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
