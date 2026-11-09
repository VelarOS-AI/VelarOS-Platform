import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'

import { test } from 'bun:test'

import { buildDragTargetScript } from '../../utils/page-scripts/drag.js'
import { buildInspectionScript } from '../../utils/page-scripts/inspection.js'
import { browserElementSelector } from '../../utils/page-scripts/selector.js'

test('INV-33 observed selectors retain the correct data attribute and distinguish anonymous siblings', () => {
  const matches = new Map<string, unknown[]>()
  const owner = { querySelectorAll: (selector: string) => matches.get(selector) ?? [] }
  const node = (
    tagName: string,
    parentElement: unknown,
    attributes: Record<string, string> = {}
  ) => ({
    tagName,
    parentElement,
    ownerDocument: owner,
    children: [] as unknown[],
    getAttribute: (name: string) => attributes[name] ?? null,
  })
  const html = node('HTML', null)
  const body = node('BODY', html)
  html.children.push(body)
  const first = node('BUTTON', body)
  const second = node('BUTTON', body)
  body.children.push(first, second)
  matches.set('html > body:nth-of-type(1) > button:nth-of-type(1)', [first])
  matches.set('html > body:nth-of-type(1) > button:nth-of-type(2)', [second])
  const a = browserElementSelector(first as never)
  const b = browserElementSelector(second as never)
  assert.notEqual(a, b)
  assert.equal(owner.querySelectorAll(b!)[0], second)

  const tagged = node('INPUT', body, { 'data-test': 'upload' })
  matches.set('input[data-test="upload"]', [tagged])
  assert.equal(browserElementSelector(tagged as never), 'input[data-test="upload"]')
  matches.set('input[data-test="upload"]', [tagged, first])
  assert.equal(browserElementSelector(tagged as never), null)
})

test('相同 name 的观察元素各自使用唯一的完整结构路径', () => {
  const matches = new Map<string, unknown[]>()
  const owner = {
    querySelectorAll: (selector: string): unknown[] =>
      selector === 'input, textarea, select' ? [first, second] : (matches.get(selector) ?? []),
    querySelector: () => null,
    getElementById: () => null,
    body: { innerText: '' },
    documentElement: { outerHTML: '' },
    defaultView: {
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    },
  }
  const node = (tagName: string, parentElement: unknown, name?: string) => ({
    nodeType: 1,
    tagName,
    parentElement,
    ownerDocument: owner,
    children: [] as unknown[],
    offsetParent: {},
    closest: () => null,
    hasAttribute: () => false,
    getAttribute: (attribute: string) => (attribute === 'name' ? (name ?? null) : null),
  })
  const html = node('HTML', null)
  const body = node('BODY', html)
  const first = node('INPUT', body, 'email')
  const second = node('INPUT', body, 'email')
  html.children.push(body)
  body.children.push(first, second)
  matches.set('input[name="email"]', [first, second])
  const a = 'html > body:nth-of-type(1) > input:nth-of-type(1)'
  const b = 'html > body:nth-of-type(1) > input:nth-of-type(2)'
  matches.set(a, [first])
  matches.set(b, [second])
  assert.equal(browserElementSelector(first as never), a)
  assert.equal(browserElementSelector(second as never), b)
  const inspection = runInNewContext(
    buildInspectionScript({
      includeHtml: false,
      maxTextChars: 100,
      maxHtmlChars: 100,
      maxElements: 10,
    }),
    {
      document: owner,
      window: {},
      Element: class {},
      location: { href: 'https://example.test/' },
    }
  )
  assert.equal(inspection.formFields[0].target.css, a)
  assert.equal(inspection.formFields[1].target.css, b)
  assert.notEqual(inspection.formFields[0].target.ref, inspection.formFields[1].target.ref)
})

test('drag 在最终视口重新读取两端；无法共视时不返回可派发的坐标', () => {
  let scroll = 0
  class Element {
    public readonly tagName = 'DIV'
    public readonly textContent = ''
    constructor(public top: number) {}
    public getAttribute(): null {
      return null
    }
    public scrollIntoView(options: { block: string }): void {
      if (options.block === 'center') scroll = this.top - 200
      else if (this.top < scroll) scroll = this.top
      else if (this.top + 20 > scroll + 400) scroll = this.top + 20 - 400
    }
    public getBoundingClientRect() {
      return { left: 10, right: 30, top: this.top - scroll, bottom: this.top + 20 - scroll }
    }
  }
  const source = new Element(500)
  const target = new Element(600)
  const run = () =>
    runInNewContext(
      buildDragTargetScript({
        source: { css: '#source', role: null, text: null, name: null, attributes: {} },
        target: { css: '#target', role: null, text: null, name: null, attributes: {} },
      }),
      {
        Element,
        location: { href: 'https://example.test/' },
        window: { innerWidth: 1000, innerHeight: 400 },
        document: {
          querySelector: (selector: string) => (selector === '#source' ? source : target),
        },
      }
    )
  const result = run()
  assert.equal(result.matched, true)
  assert.equal(result.startY, source.getBoundingClientRect().top + 10)
  assert.equal(result.endY, target.getBoundingClientRect().top + 10)
  target.top = 2000
  const unreachable = run()
  assert.equal(unreachable.matched, false)
  assert.equal(unreachable.failureReason, 'not-interactable')
  assert.equal(unreachable.source.point, null)
})
