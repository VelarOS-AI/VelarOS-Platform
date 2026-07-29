import assert from 'node:assert/strict'

import { test } from 'bun:test'

import {
  BrowserScreenshotDefaultDomStable,
  BrowserScreenshotDefaultModelImage,
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

void test('browser action policy owns deny, confirm, allow and alias precedence', () => {
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
    confirm: ['click'],
    deny: ['evaluate'],
  }

  assert.equal(
    checkBrowserActionPolicy(policy, {
      action: 'target_action.click',
      aliases: ['target_action', 'click'],
    }).kind,
    'confirm',
  )
  assert.equal(checkBrowserActionPolicy(policy, { action: 'evaluate' }).kind, 'deny')
  assert.equal(checkBrowserActionPolicy(policy, { action: 'navigate' }).kind, 'allow')
  assert.equal(checkBrowserActionPolicy(policy, { action: 'download' }).kind, 'deny')
})

void test('browser action policy supports wildcard matches and explicit default deny', () => {
  assert.deepEqual(
    checkBrowserActionPolicy({ confirm: ['*'] }, { action: 'upload' }),
    {
      kind: 'confirm',
      action: 'upload',
      matchedAction: '*',
      reason: '浏览器动作需要用户确认：upload',
    },
  )
  assert.equal(checkBrowserActionPolicy({ default: 'deny' }, { action: 'inspect' }).kind, 'deny')
})
