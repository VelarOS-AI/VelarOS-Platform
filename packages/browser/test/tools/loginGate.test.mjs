import assert from 'node:assert/strict'

import { test } from 'bun:test'

import {
  BrowserInspectionScriptBuilder,
  BrowserLoginGateLedger,
  buildBrowserLoginGateMessage,
  buildBrowserLoginGateRecord,
  resolveBrowserLoginGateOrigin,
} from '../../dist/core/index.js'
import { withBrowserLoginGate } from '../../dist/tools/index.js'

const requiresLoginDetection = {
  requiresLogin: true,
  confidence: 0.88,
  reason: '页面看起来停在登录、身份验证或会话过期状态，需要用户手动完成。',
  signals: ['password-input', 'login-form'],
  passwordInputs: 1,
  usernameInputs: 1,
  loginButtons: 1,
  loginLinks: 0,
  forms: 1,
}

const cleanDetection = {
  ...requiresLoginDetection,
  requiresLogin: false,
  confidence: 0.1,
  signals: [],
}

function createStubBrowserApi(pages) {
  const calls = { inspect: 0, capture: 0 }
  const readPage = (index) => pages[Math.min(index, pages.length - 1)]
  return {
    calls,
    api: {
      inspectPage: async () => {
        const page = readPage(calls.inspect)
        calls.inspect += 1
        return { url: page.url, title: 'page', text: page.text, login: page.login, capturedAt: 1 }
      },
      captureScreenshot: async () => {
        const page = readPage(calls.capture)
        calls.capture += 1
        return {
          url: page.url,
          path: `/tmp/shot-${calls.capture}.png`,
          relativePath: `screenshots/shot-${calls.capture}.png`,
          width: 100,
          height: 100,
          bytes: 10,
          capturedAt: 1,
          metadata: { login: page.login },
        }
      },
    },
  }
}

void test('login detection ships inside the inspection script (no extra evaluateScript round trip)', () => {
  const script = new BrowserInspectionScriptBuilder().buildInspectionScript({
    includeHtml: false,
    maxTextChars: 100,
    maxHtmlChars: 100,
    maxElements: 10,
  })

  assert.match(script, /const detectLogin = \(\) =>/u)
  assert.match(script, /login: detectLogin\(\)/u)
})

void test('login gate origin follows the space identity strategy', () => {
  assert.equal(resolveBrowserLoginGateOrigin('https://example.com/login?next=1'), 'https://example.com')
  assert.equal(resolveBrowserLoginGateOrigin('about:blank'), 'about:blank')
  assert.equal(resolveBrowserLoginGateOrigin(null), '')
})

void test('login gate message names the site and never dumps detector signals', () => {
  const message = buildBrowserLoginGateMessage(requiresLoginDetection, 'https://example.com/login')

  assert.match(message, /https:\/\/example\.com/u)
  assert.doesNotMatch(message, /password-input/u)
})

void test('ledger asks once per origin, whatever the answer was', () => {
  const ledger = new BrowserLoginGateLedger()

  assert.equal(ledger.shouldPrompt('https://a.com', requiresLoginDetection), true)
  ledger.markPrompted('https://a.com')
  assert.equal(ledger.shouldPrompt('https://a.com', requiresLoginDetection), false)
  ledger.markResolved('https://a.com', false)
  assert.equal(ledger.shouldPrompt('https://a.com', requiresLoginDetection), false)
  assert.equal(ledger.shouldPrompt('https://b.com', requiresLoginDetection), true)
  assert.equal(ledger.shouldPrompt('https://b.com', cleanDetection), false)
})

void test('gate record carries the user verdict, not just the detection', () => {
  const record = buildBrowserLoginGateRecord({
    detection: requiresLoginDetection,
    url: 'https://example.com/login',
    approved: false,
    message: '用户拒绝登录。',
  })

  assert.equal(record.prompted, true)
  assert.equal(record.approved, false)
  assert.equal(record.origin, 'https://example.com')
  assert.equal(record.reason, '用户拒绝登录。')
})

void test('approved gate re-reads the page instead of handing back the login screen', async () => {
  const stub = createStubBrowserApi([
    { url: 'https://example.com/login', text: 'sign in', login: requiresLoginDetection },
    { url: 'https://example.com/home', text: 'welcome back', login: cleanDetection },
  ])
  const prompts = []
  const gated = withBrowserLoginGate(stub.api, {
    requestLoginCompletion: async (input) => {
      prompts.push(input.origin)
      return { approved: true }
    },
  })

  const inspection = await gated.inspectPage({})

  assert.deepEqual(prompts, ['https://example.com'])
  assert.equal(stub.calls.inspect, 2)
  assert.equal(inspection.text, 'welcome back')
  assert.equal(inspection.loginGate.approved, true)
})

void test('declined gate annotates the artifact and does not re-read', async () => {
  const stub = createStubBrowserApi([
    { url: 'https://example.com/login', text: 'sign in', login: requiresLoginDetection },
  ])
  const gated = withBrowserLoginGate(stub.api, {
    requestLoginCompletion: async () => ({ approved: false, message: '没有审批通道' }),
  })

  const artifact = await gated.captureScreenshot({})

  assert.equal(stub.calls.capture, 1)
  assert.equal(artifact.loginGate.prompted, true)
  assert.equal(artifact.loginGate.approved, false)
  assert.equal(artifact.loginGate.reason, '没有审批通道')
})

void test('clean pages never touch the approval channel', async () => {
  const stub = createStubBrowserApi([
    { url: 'https://example.com/home', text: 'welcome', login: cleanDetection },
  ])
  let prompted = 0
  const gated = withBrowserLoginGate(stub.api, {
    requestLoginCompletion: async () => {
      prompted += 1
      return { approved: true }
    },
  })

  const inspection = await gated.inspectPage({})

  assert.equal(prompted, 0)
  assert.equal(stub.calls.inspect, 1)
  assert.equal(inspection.loginGate, undefined)
})

void test('concurrent observations on one origin share a single prompt', async () => {
  const stub = createStubBrowserApi([
    { url: 'https://example.com/login', text: 'sign in', login: requiresLoginDetection },
    { url: 'https://example.com/login', text: 'sign in', login: requiresLoginDetection },
    { url: 'https://example.com/home', text: 'welcome', login: cleanDetection },
  ])
  let prompted = 0
  const gated = withBrowserLoginGate(stub.api, {
    requestLoginCompletion: async () => {
      prompted += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { approved: true }
    },
  })

  await Promise.all([gated.inspectPage({}), gated.captureScreenshot({})])

  assert.equal(prompted, 1)
})

void test('an aborted prompt does not count as asked', async () => {
  const stub = createStubBrowserApi([
    { url: 'https://example.com/login', text: 'sign in', login: requiresLoginDetection },
    { url: 'https://example.com/login', text: 'sign in', login: requiresLoginDetection },
    { url: 'https://example.com/home', text: 'welcome', login: cleanDetection },
  ])
  let attempts = 0
  const gated = withBrowserLoginGate(stub.api, {
    requestLoginCompletion: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('aborted')
      return { approved: true }
    },
  })

  await assert.rejects(() => gated.inspectPage({}), /aborted/u)
  const inspection = await gated.inspectPage({})

  assert.equal(attempts, 2)
  assert.equal(inspection.loginGate.approved, true)
})
