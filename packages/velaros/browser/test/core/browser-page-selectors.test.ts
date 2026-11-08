import assert from 'node:assert/strict'

import { test } from 'bun:test'

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
