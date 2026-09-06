/**
 * @test-meta
 * title: 浏览器目标引用、拖拽与恢复只操作可靠的唯一元素
 * summary: observation generation 防止短 ref 重绑定；external/embedded drag 都补全 ref；自愈与坐标恢复对模糊候选 fail closed。
 * area: packages
 */
import assert from 'node:assert/strict'

import { test } from 'bun:test'

import {
  BrowserTargetRefStore,
  CdpInteractionEngine,
} from '../../dist/core/index.js'
import { BrowserInteractionEngine } from '../../dist/runtime/BrowserInteractionEngine.js'
import {
  browserActSchema,
  parseBrowserActInput,
} from '../../dist/tools/BrowserActSchema.js'
import { performTargetActionWithRecovery } from '../../dist/tools/TargetActionRecovery.js'

function target(overrides = {}) {
  return {
    ref: null,
    css: null,
    role: null,
    text: null,
    name: null,
    attributes: {},
    ...overrides,
  }
}

function inspection({ actions = [], links = [], formFields = [], lines = [] } = {}) {
  return {
    url: 'https://example.test/',
    title: 'Example',
    metaDescription: null,
    text: '',
    textTruncated: false,
    headings: [],
    links,
    actions,
    formFields,
    snapshot: {
      mode: 'compact',
      source: 'dom-inspection',
      lines,
      refCount: lines.length,
      truncated: false,
    },
    capturedAt: Date.now(),
  }
}

function dragMiss() {
  return {
    url: 'https://example.test/',
    matched: false,
    source: { matched: false, selector: null, text: null, point: null },
    target: { matched: false, selector: null, text: null, point: null },
    startX: null,
    startY: null,
    endX: null,
    endY: null,
    steps: 10,
    failureReason: 'source-not-found',
    capturedAt: Date.now(),
  }
}

test('inspection refs are generation-scoped, fail closed, and keep stored targets authoritative', () => {
  const store = new BrowserTargetRefStore()
  const save = target({ ref: '@e1', css: '#save', role: 'button', text: 'Save' })
  const cancel = target({ ref: '@e2', css: '#cancel', role: 'button', text: 'Cancel' })
  const tenth = target({ ref: '@e10', css: '#tenth', role: 'button', text: 'Tenth' })
  const first = inspection({
    actions: [
      { text: 'Save', role: 'button', target: save },
      { text: 'Cancel', role: 'button', target: cancel },
      { text: 'Tenth', role: 'button', target: tenth },
    ],
    lines: [
      '- button "Save" [ref=@e1, type=button]',
      '- button "Cancel" (ref=@e2)',
      'custom ref=@e10; state=ready',
    ],
  })

  store.storeInspection('session', first)

  assert.equal(save.ref, '@e1:g1')
  assert.equal(cancel.ref, '@e2:g1')
  assert.equal(tenth.ref, '@e10:g1')
  assert.deepEqual(first.snapshot.lines, [
    '- button "Save" [ref=@e1:g1, type=button]',
    '- button "Cancel" (ref=@e2:g1)',
    'custom ref=@e10:g1; state=ready',
  ])
  assert.equal(
    store.hydrateTarget('session', target({ ref: '@e1' })).css,
    '#save',
  )

  const removeAccount = target({
    ref: '@e1',
    css: '#remove-account',
    role: 'button',
    text: 'Delete account',
  })
  store.storeInspection('session', inspection({
    actions: [{ text: 'Delete account', role: 'button', target: removeAccount }],
    lines: ['- button "Delete account" [ref=@e1]'],
  }))

  assert.equal(removeAccount.ref, '@e1:g2')
  assert.throws(
    () => store.hydrateTarget('session', target({ ref: '@e1:g1' })),
    (error) => error?.code === 'VALIDATION' && /ref 已失效/u.test(error.message),
  )
  assert.throws(
    () => store.hydrateTarget('session', target({ ref: '@e1' })),
    (error) => error?.context?.reason === 'stale-ref',
  )
  assert.equal(
    store.hydrateTarget('session', target({ ref: '@e1:g2' })).css,
    '#remove-account',
  )
  assert.throws(
    () => store.hydrateTarget('session', target({ ref: '@e1:g1', css: '#known-safe-target' })),
    (error) => error?.context?.reason === 'stale-ref',
  )
  assert.throws(
    () => store.hydrateTarget('session', target({ ref: 'not-a-ref', css: '#known-safe-target' })),
    (error) => error?.context?.reason === 'invalid-ref',
  )

  const authoritative = store.hydrateTarget('session', target({
    ref: '@e1:g2',
    css: '#caller-override',
    role: 'link',
    text: 'Caller override',
    name: 'Caller override',
    attributes: { 'data-qa': 'caller-override' },
  }))
  assert.deepEqual(authoritative, {
    ref: '@e1:g2',
    css: '#remove-account',
    role: 'button',
    text: 'Delete account',
    name: null,
    attributes: {},
  })
  assert.equal(
    store.hydrateTarget('session', target({ css: '#independent-target' })).css,
    '#independent-target',
  )
})

test('snapshot only publishes refs retained by the final target collection', () => {
  const store = new BrowserTargetRefStore()
  const retained = target({ ref: '@e1', css: '#primary', text: 'Primary' })
  const lowMaxElementsInspection = inspection({
    actions: [{ text: 'Primary', role: 'button', target: retained }],
    lines: [
      '- button "Primary" [ref=@e1]',
      '- button "Secondary" [ref=@e2]',
      '- button "Tertiary" [ref=@e3]',
    ],
  })

  store.storeInspection('low-max-elements', lowMaxElementsInspection)

  assert.deepEqual(lowMaxElementsInspection.snapshot.lines, [
    '- button "Primary" [ref=@e1:g1]',
  ])
  assert.equal(lowMaxElementsInspection.snapshot.refCount, 1)
  assert.equal(lowMaxElementsInspection.snapshot.truncated, true)
  for (const line of lowMaxElementsInspection.snapshot.lines) {
    const ref = line.match(/ref=(@e\d+:g\d+)/u)?.[1]
    assert.ok(ref)
    assert.equal(store.hydrateTarget('low-max-elements', target({ ref })).css, '#primary')
  }
})

test('external drag hydrates both sourceRef and targetRef before building the page script', async () => {
  const store = new BrowserTargetRefStore()
  const source = target({ ref: '@e1', css: '#source', text: 'Source' })
  const destination = target({ ref: '@e2', css: '#destination', text: 'Destination' })
  store.storeTargets('external', [source, destination])
  let scriptedOptions = null
  const driver = {
    kind: 'external',
    dragCoordinates: async () => {},
    executeJavaScript: async () => dragMiss(),
  }
  const engine = new CdpInteractionEngine(
    {
      getExternalPageSession: () => ({
        driver,
        visible: false,
        url: 'https://example.test/',
        title: 'Example',
      }),
    },
    {
      buildDragTargetScript: (options) => {
        scriptedOptions = options
        return 'drag'
      },
    },
    store,
  )

  await engine.dragTargets(
    'external',
    { url: 'https://example.test/' },
    {
      source: target({ ref: source.ref }),
      target: target({ ref: destination.ref }),
    },
  )

  assert.equal(scriptedOptions.source.css, '#source')
  assert.equal(scriptedOptions.target.css, '#destination')
})

test('embedded drag hydrates both sourceRef and targetRef before building the page script', async () => {
  const store = new BrowserTargetRefStore()
  const source = target({ ref: '@e1', css: '#embedded-source', text: 'Source' })
  const destination = target({ ref: '@e2', css: '#embedded-target', text: 'Target' })
  store.storeTargets('embedded', [source, destination])
  let scriptedOptions = null
  const driver = {
    kind: 'embedded',
    dragCoordinates: async () => {},
    executeJavaScript: async () => dragMiss(),
  }
  const engine = new BrowserInteractionEngine(
    {
      getExternalPageSession: () => null,
      getLivePageSession: async () => ({ webContents: {} }),
      wrapPageDriver: () => driver,
    },
    {
      buildDragTargetScript: (options) => {
        scriptedOptions = options
        return 'drag'
      },
    },
    {},
    store,
  )

  await engine.dragTargets(
    'embedded',
    { url: 'https://example.test/' },
    {
      source: target({ ref: source.ref }),
      target: target({ ref: destination.ref }),
    },
  )

  assert.equal(scriptedOptions.source.css, '#embedded-source')
  assert.equal(scriptedOptions.target.css, '#embedded-target')
})

test('target self-healing requires a reliable identity signal and a unique best match', () => {
  const engine = new CdpInteractionEngine({}, {}, new BrowserTargetRefStore())
  const find = (stale, candidates) => engine.findSelfHealingTarget(
    { action: 'click', target: stale },
    inspection({ actions: candidates.map((candidate) => ({
      text: candidate.text ?? '',
      role: 'button',
      target: candidate,
    })) }),
  )

  assert.equal(
    find(
      target({
        css: '#old-save',
        text: 'Save',
        attributes: { 'data-testid': 'save-primary' },
      }),
      [target({ css: '#new-save', text: 'Save', attributes: {} })],
    ),
    null,
  )
  assert.equal(
    find(
      target({
        css: '#old-save',
        text: 'Save',
        frame: {
          css: 'iframe#Checkout',
          name: null,
          title: 'Payment Frame',
          url: null,
        },
      }),
      [target({
        css: '#new-save',
        text: 'Save',
        frame: { css: null, name: null, title: 'Payment Frame', url: null },
      })],
    ),
    null,
  )
  assert.equal(
    find(
      target({
        css: '#old-save',
        text: 'Save',
        attributes: { 'data-testid': 'SavePrimary' },
      }),
      [target({
        css: '#new-save',
        text: 'Save',
        attributes: { 'data-testid': 'saveprimary' },
      })],
    ),
    null,
  )
  assert.equal(
    find(
      target({
        css: '#old-save',
        text: 'Save',
        frame: { css: 'iframe#Checkout', name: null, title: null, url: null },
      }),
      [target({
        css: '#new-save',
        text: 'Save',
        frame: { css: 'iframe#checkout', name: null, title: null, url: null },
      })],
    ),
    null,
  )
  assert.equal(
    find(
      target({
        css: '#old-save',
        text: 'Save',
        frame: { css: null, name: null, title: null, url: 'https://example.test/Checkout' },
      }),
      [target({
        css: '#new-save',
        text: 'Save',
        frame: { css: null, name: null, title: null, url: 'https://example.test/checkout' },
      })],
    ),
    null,
  )
  assert.equal(
    find(
      target({
        css: '#old-save',
        text: 'Save',
        frame: { css: null, name: null, title: 'Payment Frame', url: null },
      }),
      [target({
        css: '#new-save',
        text: 'Save',
        frame: { css: null, name: null, title: 'payment frame', url: null },
      })],
    )?.css,
    '#new-save',
  )
  assert.equal(
    find(
      target({ css: '#old-save', role: 'button' }),
      [target({ css: '#delete-account', role: 'button', text: 'Delete account' })],
    ),
    null,
  )
  assert.equal(
    find(
      target({ css: '#old-save', role: 'button', text: 'Save' }),
      [
        target({ css: '#delete-account', role: 'button', text: 'Delete account' }),
        target({ css: '#new-save', role: 'button', text: 'Save' }),
      ],
    )?.css,
    '#new-save',
  )
  assert.equal(
    find(
      target({ css: '#old-save', role: 'button', text: 'Save' }),
      [
        target({ css: '#save-primary', role: 'button', text: 'Save' }),
        target({ css: '#save-secondary', role: 'button', text: 'Save' }),
      ],
    ),
    null,
  )
})

test('failed internal self-heal inspection does not invalidate refs already shown to the model', async () => {
  const store = new BrowserTargetRefStore()
  const first = target({ ref: '@e1', css: '#first', text: 'First' })
  const second = target({ ref: '@e2', css: '#second', text: 'Second' })
  store.storeTargets('self-heal', [first, second])
  const failedResult = {
    action: 'click',
    url: 'https://example.test/',
    matched: false,
    selector: '#first',
    text: null,
    failureReason: 'not-found',
    capturedAt: Date.now(),
  }
  const driver = {
    kind: 'external',
    executeJavaScript: async () => inspection({
      actions: [{
        text: 'Different',
        role: 'button',
        target: target({ ref: '@e1', css: '#different', text: 'Different' }),
      }],
      lines: ['- button "Different" [ref=@e1]'],
    }),
  }
  const engine = new CdpInteractionEngine(
    {},
    { buildInspectionScript: () => 'inspect-for-self-heal' },
    store,
  )

  const result = await engine.selfHealTargetActionAfterNotFound({
    sessionId: 'self-heal',
    driver,
    options: { action: 'click', target: target({ ref: first.ref, css: '#first', text: 'First' }) },
    result: failedResult,
    clickMode: 'dom',
  })

  assert.equal(result, failedResult)
  assert.equal(store.hydrateTarget('self-heal', target({ ref: second.ref })).css, '#second')
})

function recoveryContext(labels, options = {}) {
  const clicks = []
  const controller = new AbortController()
  return {
    clicks,
    ctx: {
      abortSignal: controller.signal,
      browser: {
        performTargetAction: async (action) => ({
          action: action.action,
          url: 'https://example.test/',
          matched: false,
          selector: action.target.css,
          text: null,
          failureReason: 'not-found',
          capturedAt: Date.now(),
        }),
        captureScreenshot: async () => ({
          relativePath: 'artifacts/screenshots/recovery.png',
          metadata: { elementLabels: labels },
        }),
        evaluateScript: async (input) => {
          options.onEvaluate?.(input)
          return { result: options.boundsResult ?? { found: false } }
        },
        clickCoordinates: async (point) => {
          clicks.push(point)
          return { url: 'https://example.test/', ...point, capturedAt: Date.now() }
        },
      },
    },
  }
}

test('coordinate recovery refuses role-only and duplicate-label screenshot matches', async () => {
  const roleOnly = recoveryContext([
    { index: 1, tagName: 'button', role: 'button', text: 'Delete account', selector: '#delete', x: 10, y: 10, width: 80, height: 30 },
  ])
  const roleOnlyResult = await performTargetActionWithRecovery(
    { action: 'click', target: target({ role: 'button' }) },
    roleOnly.ctx,
  )
  assert.equal(roleOnlyResult.matched, false)
  assert.deepEqual(roleOnly.clicks, [])

  const duplicateText = recoveryContext([
    { index: 1, tagName: 'button', role: 'button', text: 'Save', selector: '#save-one', x: 10, y: 10, width: 80, height: 30 },
    { index: 2, tagName: 'button', role: 'button', text: 'Save', selector: '#save-two', x: 110, y: 10, width: 80, height: 30 },
  ])
  const duplicateResult = await performTargetActionWithRecovery(
    { action: 'click', target: target({ role: 'button', text: 'Save' }) },
    duplicateText.ctx,
  )
  assert.equal(duplicateResult.matched, false)
  assert.deepEqual(duplicateText.clicks, [])

  const conflictingStableAttribute = recoveryContext([
    { index: 1, tagName: 'button', role: 'button', text: 'Save', selector: '[data-qa="danger-save"]', x: 10, y: 10, width: 80, height: 30 },
  ])
  const conflictingResult = await performTargetActionWithRecovery(
    {
      action: 'click',
      target: target({ role: 'button', text: 'Save', attributes: { 'data-qa': 'safe-save' } }),
    },
    conflictingStableAttribute.ctx,
  )
  assert.equal(conflictingResult.matched, false)
  assert.deepEqual(conflictingStableAttribute.clicks, [])
})

test('coordinate recovery clicks one exact identity match and bounds fallback requires one selector match', async () => {
  const unique = recoveryContext([
    { index: 1, tagName: 'button', role: 'button', text: 'Save', selector: '#save', x: 20, y: 30, width: 100, height: 40 },
    { index: 2, tagName: 'button', role: 'button', text: 'Delete', selector: '#delete', x: 20, y: 90, width: 100, height: 40 },
  ])
  const uniqueResult = await performTargetActionWithRecovery(
    { action: 'click', target: target({ role: 'button', text: 'Save' }) },
    unique.ctx,
  )
  assert.equal(uniqueResult.matched, true)
  assert.deepEqual(unique.clicks, [{ x: 70, y: 50 }])

  const stableDataAttribute = recoveryContext([
    { index: 1, tagName: 'button', role: 'button', text: '', selector: '[data-qa="safe-save"]', x: 30, y: 40, width: 80, height: 20 },
  ])
  const stableResult = await performTargetActionWithRecovery(
    { action: 'click', target: target({ attributes: { 'data-qa': 'safe-save' } }) },
    stableDataAttribute.ctx,
  )
  assert.equal(stableResult.matched, true)
  assert.deepEqual(stableDataAttribute.clicks, [{ x: 70, y: 50 }])

  const ambiguousBounds = recoveryContext([], {
    boundsResult: { found: false, matchCount: 2 },
    onEvaluate: ({ script }) => {
      assert.match(script, /querySelectorAll/u)
      assert.match(script, /matches\.length !== 1/u)
    },
  })
  const boundsResult = await performTargetActionWithRecovery(
    { action: 'click', target: target({ css: '.save' }) },
    ambiguousBounds.ctx,
  )
  assert.equal(boundsResult.matched, false)
  assert.deepEqual(ambiguousBounds.clicks, [])
})

test('browser:act accepts generation refs for drag and exposes conditional requirements', () => {
  const parsed = parseBrowserActInput({
    action: 'drag',
    sourceRef: '@e3:g4',
    targetRef: '@e8:g4',
  })

  assert.equal(parsed.action, 'drag')
  assert.equal(parsed.source.ref, '@e3:g4')
  assert.equal(parsed.target.ref, '@e8:g4')
  assert.equal(browserActSchema.safeParse({ action: 'drag', targetRef: '@e8:g4' }).success, false)
  assert.match(browserActSchema.shape.action.description, /条件必填/u)
  assert.match(browserActSchema.shape.targetRef.description, /generation/u)
})
