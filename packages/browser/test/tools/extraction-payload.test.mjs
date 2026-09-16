/**
 * @test-meta
 * title: 浏览器结构化提取从求值信封取完整载荷并真正落盘
 * summary: browser:extract 的 table/list/content/paginate 经真实 evaluate 包装取回完整载荷，save 写出 extracts 产物，超限与页面报错明确失败。
 * area: packages
 */
import assert from 'node:assert/strict'

import { test } from 'bun:test'

import { buildEvaluateScript } from '../../dist/exports/core.js'
import { browserTools } from '../../dist/exports/tools.js'

const TEXT_NODE = 3
const ELEMENT_NODE = 1
const PAGE_URL = 'https://example.test/catalog'
// 只属于 evaluate 信封的键：工具结果和落盘产物里一个都不许出现。
const EnvelopeOnlyKeys = ['mode', 'result', 'resultText', 'resultTruncated', 'durationMs']

class FakeText {
  constructor(text) {
    this.nodeType = TEXT_NODE
    this.textContent = text
    this.childNodes = []
  }
}

class FakeElement {
  constructor(tagName, attributes, children) {
    this.nodeType = ELEMENT_NODE
    this.tagName = tagName.toUpperCase()
    this.attributes = attributes
    this.childNodes = children.map((child) => (typeof child === 'string' ? new FakeText(child) : child))
    this.onClick = null
  }

  get textContent() {
    return this.childNodes.map((child) => child.textContent).join('')
  }

  get innerText() {
    return this.textContent
  }

  get href() {
    return this.attributes.href ?? ''
  }

  getAttribute(name) {
    return this.attributes[name] ?? null
  }

  hasAttribute(name) {
    return name in this.attributes
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value)
  }

  querySelectorAll(selector) {
    const matches = []
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (!(child instanceof FakeElement)) continue
        if (matchesSelectorList(child, selector)) matches.push(child)
        walk(child)
      }
    }
    walk(this)
    return matches
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }

  click() {
    this.onClick?.()
  }
}

class FakeAnchor extends FakeElement {}

function h(tagName, attributes = {}, ...children) {
  const ElementClass = tagName === 'a' ? FakeAnchor : FakeElement
  return new ElementClass(tagName, attributes, children)
}

// 只认不带组合符的复合选择器（tag、#id、.class、[attr]、[attr="v"]、[attr*="v"]），其余一律不匹配，
// 足够覆盖这些用例驱动到的选择器。
function matchesCompoundSelector(element, selector) {
  const match = /^([a-z][a-z0-9]*)?((?:[#.][\w-]+|\[[^\]]+\])*)$/i.exec(selector)
  if (!match) return false
  const [, tagName, qualifiers] = match
  if (tagName && element.tagName !== tagName.toUpperCase()) return false
  const classNames = String(element.attributes.class ?? '').split(/\s+/)
  for (const qualifier of qualifiers.match(/[#.][\w-]+|\[[^\]]+\]/g) ?? []) {
    if (qualifier.startsWith('#') && element.attributes.id !== qualifier.slice(1)) return false
    if (qualifier.startsWith('.') && !classNames.includes(qualifier.slice(1))) return false
    if (qualifier.startsWith('[')) {
      const [, name, operator, value] = /^\[([\w-]+)(?:(\*?=)"([^"]*)")?\]$/.exec(qualifier) ?? []
      if (!name || !(name in element.attributes)) return false
      if (operator === '=' && element.attributes[name] !== value) return false
      if (operator === '*=' && !element.attributes[name].includes(value)) return false
    }
  }
  return true
}

function matchesSelectorList(element, selectorList) {
  return selectorList.split(',').some((selector) => matchesCompoundSelector(element, selector.trim()))
}

/**
 * 假页面：evaluateScript 与 engine 做的完全一样——用真实 buildEvaluateScript 包装转发来的
 * 脚本，再在页面里执行，所以工具拿到的就是生产环境的信封，而不是手写的替身。
 */
function createFakePage(body) {
  const root = h('html', {}, body)
  const document = {
    body,
    querySelector: (selector) => root.querySelector(selector),
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    evaluate: () => {
      throw new Error('XPath is not available in the fake page')
    },
  }
  const forwarded = []
  const evaluateScript = async (options) => {
    forwarded.push(options)
    const runInPage = new Function(
      'window',
      'document',
      'location',
      'Element',
      'Node',
      'HTMLAnchorElement',
      'XPathResult',
      'getComputedStyle',
      `return ${buildEvaluateScript(options)}`
    )
    return runInPage(
      {},
      document,
      { href: PAGE_URL },
      FakeElement,
      { TEXT_NODE },
      FakeAnchor,
      { ORDERED_NODE_SNAPSHOT_TYPE: 7 },
      () => ({ display: 'block', visibility: 'visible' })
    )
  }
  return { document, evaluateScript, forwarded }
}

function createToolContext(page) {
  const files = new Map()
  const targetActions = []
  const workspaceRoot = '/workspace/example.test'
  const browser = {
    isActive: () => true,
    getContext: () => ({ url: 'https://example.test/', workspaceRoot }),
    evaluateScript: page.evaluateScript,
    readFile: async (path) => {
      if (!files.has(path)) throw Object.assign(new Error(`${path} not found`), { code: 'NOT_FOUND' })
      return { path, content: files.get(path) }
    },
    writeFile: async (path, content) => {
      files.set(path, content)
      return { path: `${workspaceRoot}/${path}`, bytes: content.length, created: true, changed: true }
    },
    listFiles: async () => [],
    // 翻页的点击走宿主端口（不再在页面里 el.click()）：这里按 target.css 找到元素并触发它。
    performTargetAction: async ({ action, target }) => {
      targetActions.push({ action, target })
      const element = page.document.querySelector(target.css)
      if (!element)
        return {
          action,
          url: PAGE_URL,
          matched: false,
          selector: target.css,
          text: null,
          failureReason: 'not-found',
          capturedAt: Date.now(),
        }

      element.click()
      return {
        action,
        url: PAGE_URL,
        matched: true,
        selector: target.css,
        text: null,
        capturedAt: Date.now(),
      }
    },
  }
  return { ctx: { abortSignal: new AbortController().signal, browser }, files, targetActions }
}

function assertNoEnvelopeKeys(value) {
  for (const key of EnvelopeOnlyKeys) {
    assert.equal(key in value, false, `${key} leaked from the evaluate envelope`)
  }
}

function resultItem(label) {
  return h('div', { class: 'result' }, h('a', { href: `https://example.test/${label}` }, label))
}

test('browser:extract content unwraps the envelope and saves an article longer than the evaluate default', async () => {
  // 约 4.5 万字符：超过 evaluate 默认的 2 万字符上限，旧实现在这里整份载荷变成 null。
  const articleText = 'Lorem "ipsum" dolor sit amet. '.repeat(1_500)
  const page = createFakePage(h('body', {}, h('article', { id: 'story' }, articleText)))
  const { ctx, files } = createToolContext(page)

  const result = await browserTools['browser:extract'].execute(
    { action: 'content', format: 'plain', selector: '#story', save: true, name: 'story' },
    ctx
  )

  assertNoEnvelopeKeys(result)
  assert.equal(result.ok, true)
  assert.equal(result.format, 'plain')
  assert.equal(result.truncated, false)
  assert.equal(result.content, articleText)
  assert.equal(result.savedPath, '/workspace/example.test/extracts/story.txt')
  assert.equal(result.savedRelativePath, 'extracts/story.txt')
  assert.equal(files.get('extracts/story.txt'), articleText)
})

test('browser:extract table returns and saves every row rather than the envelope', async () => {
  const rows = Array.from({ length: 150 }, (_, index) =>
    h('tr', {}, h('td', {}, `sku-${index}`), h('td', {}, String(index)))
  )
  const table = h('table', {}, h('tr', {}, h('th', {}, 'sku'), h('th', {}, 'stock')), ...rows)
  const { ctx, files } = createToolContext(createFakePage(h('body', {}, table)))

  const result = await browserTools['browser:extract'].execute({ action: 'table', save: true, name: 'stock' }, ctx)

  assertNoEnvelopeKeys(result)
  assert.equal(result.ok, true)
  assert.deepEqual(result.headers, ['sku', 'stock'])
  // evaluate 的 simplify 会把数组截到 100 项，提取不许继承这道截断。
  assert.equal(result.rows.length, 150)
  assert.equal(result.rowCount, 150)
  assert.deepEqual(result.rows.at(-1), ['sku-149', '149'])
  assert.equal(result.savedRelativePath, 'extracts/stock.json')
  const saved = JSON.parse(files.get('extracts/stock.json'))
  assertNoEnvelopeKeys(saved)
  assert.deepEqual(saved.headers, ['sku', 'stock'])
  assert.equal(saved.rows.length, 150)
})

test('browser:extract list saves the extracted items', async () => {
  const items = [1, 2, 3].map((index) =>
    h(
      'div',
      { class: 'result' },
      h('h3', {}, h('a', { href: `https://example.test/item/${index}` }, `Item ${index}`)),
      h('p', {}, `Description ${index}`)
    )
  )
  const { ctx, files } = createToolContext(createFakePage(h('body', {}, ...items)))

  const result = await browserTools['browser:extract'].execute(
    { action: 'list', selector: '.result', save: true, name: 'results' },
    ctx
  )

  assertNoEnvelopeKeys(result)
  assert.equal(result.itemCount, 3)
  assert.deepEqual(result.items[0], {
    title: 'Item 1',
    href: 'https://example.test/item/1',
    description: 'Description 1',
  })
  assert.equal(result.savedRelativePath, 'extracts/results.json')
  const saved = JSON.parse(files.get('extracts/results.json'))
  assertNoEnvelopeKeys(saved)
  assert.deepEqual(saved.items, result.items)
})

test('a missing table reports ok=false and writes no artifact', async () => {
  const { ctx, files } = createToolContext(createFakePage(h('body', {}, h('p', {}, 'no tables here'))))

  const result = await browserTools['browser:extract'].execute({ action: 'table', save: true }, ctx)

  assert.equal(result.ok, false)
  assert.equal(result.error, '页面上没找到表格')
  assert.equal('savedPath' in result, false)
  assert.equal(files.size, 0)
})

test('a payload beyond the evaluate transport ceiling fails instead of returning a partial result', async () => {
  const page = createFakePage(h('body', {}, h('article', { id: 'huge' }, 'x'.repeat(200_000))))
  const { ctx, files } = createToolContext(page)

  await assert.rejects(
    browserTools['browser:extract'].execute(
      { action: 'content', format: 'plain', selector: '#huge', maxChars: 200_000, save: true },
      ctx
    ),
    (error) => error.code === 'EXECUTION_FAILED' && /上限/.test(error.message)
  )
  assert.equal(files.size, 0)
})

test('a page-side extraction error surfaces as a tool failure', async () => {
  const table = h('table', {}, h('tr', {}, h('td', {}, 'cell')))
  const { ctx, files } = createToolContext(createFakePage(h('body', {}, table)))

  await assert.rejects(
    browserTools['browser:extract'].execute({ action: 'table', selector: '//table', save: true }, ctx),
    (error) => error.code === 'EXECUTION_FAILED' && /XPath is not available in the fake page/.test(error.message)
  )
  assert.equal(files.size, 0)
})

test('browser:extract paginate collects every page and stops at a disabled next button', async () => {
  const list = h('section', {}, resultItem('p1-a'), resultItem('p1-b'))
  const next = h('button', { class: 'next' }, 'Next')
  next.onClick = () => {
    list.childNodes = [resultItem('p2-a')]
    // disabled 是布尔属性：getAttribute 拿到空串，按真假判断会被误当成「未禁用」。
    next.setAttribute('disabled', '')
  }
  const page = createFakePage(h('body', {}, list, next))
  const { ctx, files, targetActions } = createToolContext(page)

  const result = await browserTools['browser:extract'].execute(
    { action: 'paginate', selector: '.result', nextPageSelector: 'button.next', maxPages: 5, name: 'pages' },
    ctx
  )

  assert.equal(result.pagesVisited, 2)
  assert.equal(result.totalItems, 3)
  assert.deepEqual(result.items.map((item) => item.title), ['p1-a', 'p1-b', 'p2-a'])
  assert.equal(page.forwarded.filter((options) => options.script.includes('el.click()')).length, 0)
  assert.deepEqual(targetActions.map((entry) => entry.action), ['click'])
  assert.equal(result.savedRelativePath, 'extracts/pages.json')
  assert.equal(JSON.parse(files.get('extracts/pages.json')).totalItems, 3)
})

test('browser:extract paginate stops when clicking next leaves the page unchanged', async () => {
  const list = h('section', {}, resultItem('only-a'), resultItem('only-b'))
  const next = h('button', { class: 'next' }, 'Next')
  const { ctx, files } = createToolContext(createFakePage(h('body', {}, list, next)))

  const result = await browserTools['browser:extract'].execute(
    { action: 'paginate', selector: '.result', nextPageSelector: 'button.next', maxPages: 5, save: false },
    ctx
  )

  assert.equal(result.pagesVisited, 1)
  assert.deepEqual(result.items.map((item) => item.title), ['only-a', 'only-b'])
  assert.equal('savedPath' in result, false)
  assert.equal(files.size, 0)
})
