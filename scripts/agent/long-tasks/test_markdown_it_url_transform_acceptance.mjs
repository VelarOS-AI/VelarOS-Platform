import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'

const root = process.cwd()
const { default: MarkdownIt } = await import(pathToFileURL(join(root, 'index.mjs')).href)
const require = createRequire(join(root, 'package.json'))

function capture(options = {}, callback = (url) => `/proxy?url=${encodeURIComponent(url)}`) {
  const calls = []
  const md = new MarkdownIt({
    linkify: true,
    ...options,
    urlTransform(url, info) {
      calls.push({ url, info, receiver: this })
      return callback.call(this, url, info)
    },
  })
  return { md, calls }
}

function resources(tokens, result = []) {
  for (const token of tokens) {
    if (token.type === 'link_open' || token.type === 'image') result.push(token)
    if (token.children) resources(token.children, result)
  }
  return result
}

function destination(token) {
  return token.attrGet(token.type === 'image' ? 'src' : 'href')
}

function transformed(md, source, env = {}, inline = false) {
  const tokens = inline ? md.parseInline(source, env) : md.parse(source, env)
  const links = resources(tokens)
  assert(links.length > 0, 'the original input must generate resource tokens')
  assert(
    links.every((token) => destination(token).startsWith('/proxy?url=')),
    'URL transformation must be available on every built-in resource path'
  )
  return links
}

const cases = [
  ['inline link', '[**label**](https://example.test/a "title")', 'link', 'inline'],
  ['empty destination', '[empty]()', 'link', 'inline'],
  ['inline image', '![alt *text*](https://example.test/i.png "title")', 'image', 'inline'],
  ['full reference link', '[label][target]\n\n[target]: /doc "title"', 'link', 'reference'],
  ['collapsed reference link', '[label][]\n\n[label]: /doc', 'link', 'reference'],
  ['shortcut reference link', '[label]\n\n[label]: /doc', 'link', 'reference'],
  ['full reference image', '![alt][target]\n\n[target]: /i.png', 'image', 'reference'],
  ['collapsed reference image', '![alt][]\n\n[alt]: /i.png', 'image', 'reference'],
  ['shortcut reference image', '![alt]\n\n[alt]: /i.png', 'image', 'reference'],
  ['URL autolink', '<https://example.test/a>', 'link', 'autolink'],
  ['email autolink', '<person@example.test>', 'link', 'autolink'],
  ['scheme linkification', 'https://example.com/path', 'link', 'linkify'],
  ['fuzzy linkification', 'www.example.com/path', 'link', 'linkify'],
  ['email linkification', 'person@example.com', 'link', 'linkify'],
]

test('baseline: default rendering and reference metadata remain ordinary', () => {
  const md = new MarkdownIt()
  const env = {}
  assert.equal(
    md.render('[a][x]\n\n[x]: /original "T"', env),
    '<p><a href="/original" title="T">a</a></p>\n'
  )
  assert.equal(env.references.X.href, '/original')
})

for (const [name, source, kind, syntax] of cases)
  test(`resource path: ${name}`, () => {
    const { md, calls } = capture()
    const env = { tenant: name }
    const links = transformed(md, source, env)
    assert.equal(links.length, 1)
    assert.equal(calls.length, 1, 'one call per generated resource, without silent-probe calls')
    assert.equal(calls[0].receiver, md)
    assert.equal(calls[0].info.env, env)
    assert.equal(calls[0].info.kind, kind)
    assert.equal(calls[0].info.source, syntax)
    assert.equal(destination(links[0]), `/proxy?url=${encodeURIComponent(calls[0].url)}`)
  })

for (const preset of ['default', 'commonmark', 'zero'])
  test(`option works with the ${preset} preset and explicit rule configuration`, () => {
    let count = 0
    const md = new MarkdownIt(preset, {
      urlTransform: () => {
        count++
        return '/changed'
      },
    })
    if (preset === 'zero') md.enable(['paragraph', 'link', 'image'])
    assert.match(md.render('[x](/old)'), /href="\/changed"/)
    assert.equal(count, 1)
  })

test('renderInline transforms nested labels, images and automatic links', () => {
  const { md, calls } = capture()
  const env = {}
  const html = md.renderInline('[**x** ![a](/image)](/outer) <https://example.test>', env)
  assert.equal(calls.length, 3)
  assert.match(html, /<strong>x<\/strong>/)
  assert.match(html, /src="\/proxy\?url=%2Fimage"/)
  assert.match(html, /href="\/proxy\?url=%2Fouter"/)
  assert(calls.every((call) => call.info.env === env))
})

test('parseInline exposes transformed token attributes before rendering', () => {
  const { md, calls } = capture()
  transformed(md, '[x](/a) ![y](/b)', {}, true)
  assert.equal(calls.length, 2)
})

test('reference definitions stay reusable and callbacks run at every use', () => {
  const { md, calls } = capture({}, (url, info) => `/proxy?url=${info.env.tenant}`)
  const env = { tenant: 'first' }
  transformed(md, '[a][id] ![b][id]\n\n[id]: /source "T"', env)
  assert.equal(calls.length, 2)
  assert.equal(env.references.ID.href, '/source')
  assert.equal(env.references.ID.title, 'T')
  env.tenant = 'second'
  const links = transformed(md, '[id]', env, true)
  assert.equal(destination(links[0]), '/proxy?url=second')
  assert.equal(calls.length, 3)
  assert.equal(calls[2].url, '/source')
})

test('separate callback info objects preserve each resource identity', () => {
  const { md, calls } = capture()
  transformed(md, '[a](/a) ![b](/b) <https://example.test>')
  assert.equal(calls.length, 3)
  assert.equal(new Set(calls.map((call) => call.info)).size, 3)
  assert.deepEqual(
    calls.map((call) => [call.info.kind, call.info.source]),
    [
      ['link', 'inline'],
      ['image', 'inline'],
      ['link', 'autolink'],
    ]
  )
})

test('reentrant rendering on one instance preserves outer and inner environments', () => {
  const inner = { depth: 'inner' },
    outer = { depth: 'outer' }
  const calls = []
  const md = new MarkdownIt({
    urlTransform(url, info) {
      calls.push([url, info.env, this])
      if (info.env === outer && url === '/a')
        assert.match(this.renderInline('[i](/i)', inner), /href="\/inner\/i"/)
      return `/${info.env.depth}${url}`
    },
  })
  assert.equal(
    md.renderInline('[a](/a) [b](/b)', outer),
    '<a href="/outer/a">a</a> <a href="/outer/b">b</a>'
  )
  assert.deepEqual(
    calls.map(([url, env]) => [url, env.depth]),
    [
      ['/a', 'outer'],
      ['/i', 'inner'],
      ['/b', 'outer'],
    ]
  )
  assert(calls.every(([, , receiver]) => receiver === md))
})

test('independent MarkdownIt instances retain independent policies', () => {
  const a = new MarkdownIt({ urlTransform: () => '/a' })
  const b = new MarkdownIt({ urlTransform: () => '/b' })
  for (const md of [a, b, a])
    assert.match(md.renderInline('[x](/original)'), md === a ? /href="\/a"/ : /href="\/b"/)
  assert.match(new MarkdownIt().renderInline('[x](/original)'), /href="\/original"/)
})

test('sequential render environments do not retain the first caller identity', () => {
  const { md, calls } = capture({}, (url, info) => `/${info.env.tenant}${url}`)
  const first = { tenant: 'one' },
    second = { tenant: 'two' }
  assert.equal(md.renderInline('[x](/doc)', first), '<a href="/one/doc">x</a>')
  assert.equal(md.renderInline('[x](/doc)', second), '<a href="/two/doc">x</a>')
  assert.equal(calls[0].info.env, first)
  assert.equal(calls[1].info.env, second)
})

test('blockquotes, lists and table cells preserve all resource transformations', () => {
  const { md, calls } = capture()
  transformed(md, '> [quote](/q)\n\n- ![list](/i)\n\n| head |\n| --- |\n| www.example.com |')
  assert.equal(calls.length, 3)
})

test('set installs, replaces and disables the policy without replacing the instance', () => {
  const md = new MarkdownIt()
  assert.equal(md.set({ urlTransform: () => '/one' }), md)
  assert.match(md.renderInline('[x](/a)'), /href="\/one"/)
  md.set({ urlTransform: () => '/two' })
  assert.match(md.renderInline('![x](/a)'), /src="\/two"/)
  md.set({ urlTransform: null })
  assert.match(md.renderInline('[x](/a)'), /href="\/a"/)
  md.set({ urlTransform: undefined })
  assert.match(md.renderInline('[x](/a)'), /href="\/a"/)
})

for (const [name, value] of [
  ['false', false],
  ['number', 1],
  ['string', 'bad'],
  ['array', []],
  ['object', {}],
])
  test(`invalid option ${name} fails construction and set before changing existing options`, () => {
    assert.throws(() => new MarkdownIt({ urlTransform: value }), {
      name: 'TypeError',
      message: /urlTransform/,
    })
    const policy = () => '/kept'
    const md = new MarkdownIt({ html: false, urlTransform: policy })
    assert.throws(() => md.set({ html: true, urlTransform: value }), {
      name: 'TypeError',
      message: /urlTransform/,
    })
    assert.equal(md.options.html, false)
    assert.equal(md.options.urlTransform, policy)
    assert.match(md.renderInline('[x](/a)'), /href="\/kept"/)
  })

for (const [name, value] of [
  ['null', null],
  ['boolean', false],
  ['number', 0],
  ['array', []],
  ['object', {}],
  ['promise', Promise.resolve('/later')],
  ['symbol', Symbol('url')],
])
  test(`invalid callback result ${name} is rejected synchronously`, () => {
    const md = new MarkdownIt({ urlTransform: () => value })
    assert.throws(() => md.renderInline('[x](/original)'), {
      name: 'TypeError',
      message: /urlTransform/,
    })
  })

for (const [name, reason] of [
  ['error', new Error('caller error')],
  ['object', { caller: true }],
  ['null', null],
  ['zero', 0],
])
  test(`callback thrown ${name} keeps exact identity and leaves the next render usable`, () => {
    let first = true,
      caught = false
    const md = new MarkdownIt({
      urlTransform: () => {
        if (first) {
          first = false
          throw reason
        }
        return '/next'
      },
    })
    try {
      md.renderInline('[x](/old)')
    } catch (error) {
      caught = true
      assert.equal(error, reason)
    }
    assert(caught, 'the callback must execute and its error must propagate')
    assert.match(md.renderInline('[x](/old)'), /href="\/next"/)
  })

test('undefined callback result preserves normalized URL and ordinary labels', () => {
  const { md, calls } = capture({}, () => undefined)
  const source = '[**label**](https://example.test/a%20b "Title")'
  assert.equal(md.render(source), new MarkdownIt().render(source))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://example.test/a%20b')
})

test('empty callback string is a valid destination', () => {
  const { md, calls } = capture({}, () => '')
  assert.equal(md.renderInline('[x](/a) ![y](/b)'), '<a href="">x</a> <img src="" alt="y">')
  assert.equal(calls.length, 2)
})

test('transformed URL is normalized and escaped once for HTML', () => {
  const { md, calls } = capture({}, () => '/space here?x=1&y="two"')
  assert.equal(
    md.renderInline('[*x*](/old "T")'),
    '<a href="/space%20here?x=1&amp;y=%22two%22" title="T"><em>x</em></a>'
  )
  assert.equal(calls.length, 1)
  const env = {}
  assert.equal(
    destination(resources(md.parseInline('[x](/old)', env))[0]),
    '/space%20here?x=1&y=%22two%22'
  )
})

for (const unsafe of [
  'javascript:alert(1)',
  'vbscript:evil',
  'data:text/html,evil',
  'JaVaScRiPt:evil',
])
  test(`transformed unsafe destination is rejected: ${unsafe.split(':')[0]}`, () => {
    const md = new MarkdownIt({ urlTransform: () => unsafe })
    assert.throws(() => md.renderInline('[x](/safe)'), {
      name: 'TypeError',
      message: /urlTransform/,
    })
  })

test('existing normalization and validation overrides also apply to replacement URLs', () => {
  const { md, calls } = capture({}, () => '/replacement')
  const checked = []
  const normalize = md.normalizeLink
  md.normalizeLink = (url) => normalize(url) + '?normalized'
  md.validateLink = (url) => {
    checked.push(url)
    return !url.startsWith('/replacement')
  }
  assert.throws(() => md.renderInline('[x](/initial)'), {
    name: 'TypeError',
    message: /urlTransform/,
  })
  assert.equal(calls[0].url, '/initial?normalized')
  assert(checked.includes('/replacement?normalized'))
})

test('unsafe original destinations never reach the callback', () => {
  const { md, calls } = capture({ linkify: false })
  transformed(md, '[warm](/ok)')
  calls.length = 0
  const source = '[x](javascript:alert) ![y](data:text/html,evil) <javascript:alert>'
  assert.equal(md.render(source), new MarkdownIt({ linkify: false }).render(source))
  assert.equal(calls.length, 0)
})

test('unused references, raw HTML and code do not invoke the policy', () => {
  const { md, calls } = capture({ html: true, linkify: false })
  transformed(md, '[warm](/ok)')
  calls.length = 0
  const source =
    '[unused]: /definition\n\n`[x](/code)`\n\n<a href="/raw">raw</a><img src="/raw-image">\n\n```\n![x](/fenced)\n```'
  assert.equal(md.render(source), new MarkdownIt({ html: true, linkify: false }).render(source))
  assert.equal(calls.length, 0)
})

test('speculative nested label parsing does not invoke the policy twice', () => {
  const { md, calls } = capture({ linkify: false })
  const source = '[outer [inner](/inside)](/outside) ![[child](/child)](/image)'
  const tokens = md.parseInline(source, {})
  const links = resources(tokens)
  assert.equal(calls.length, links.length)
  assert(calls.length >= 3)
  assert(links.every((token) => destination(token).startsWith('/proxy?url=')))
})

test('automatic links preserve their displayed text while destinations change', () => {
  const { md, calls } = capture()
  const source = '<person@example.test> www.example.com https://example.org/a'
  const html = md.renderInline(source)
  assert.equal(calls.length, 3)
  assert.match(html, />person@example\.test<\/a>/)
  assert.match(html, />www\.example\.com<\/a>/)
  assert.match(html, />https:\/\/example\.org\/a<\/a>/)
  assert(!html.includes('href="http'))
})

test('plugin renderers observe transformed attributes through ordinary token APIs', () => {
  const { md, calls } = capture()
  md.renderer.rules.link_open = (tokens, index) =>
    `<custom data-url="${tokens[index].attrGet('href')}">`
  md.renderer.rules.link_close = () => '</custom>'
  assert.match(
    md.renderInline('[x](/before)'),
    /<custom data-url="\/proxy\?url=%2Fbefore">x<\/custom>/
  )
  assert.equal(calls.length, 1)
})

test('custom core-produced tokens are preserved without an implicit second transformation', () => {
  const { md, calls } = capture()
  md.core.ruler.push('application-resource', (state) => {
    const token = new state.Token('image', 'img', 0)
    token.attrs = [
      ['src', '/application'],
      ['alt', 'custom'],
    ]
    token.children = []
    state.tokens.push(token)
  })
  assert.match(md.render('[x](/builtin)'), /src="\/application"/)
  assert.equal(calls.length, 1)
})

test('built CommonJS entry exposes the same maintained behavior', () => {
  const Factory = require(join(root, 'dist/index.cjs.js'))
  let count = 0
  const md = Factory({
    urlTransform: () => {
      count++
      return '/cjs'
    },
  })
  assert.equal(
    md.renderInline('[x](/old) ![y](/image)'),
    '<a href="/cjs">x</a> <img src="/cjs" alt="y">'
  )
  assert.equal(count, 2)
})

test('built browser bundle works without Node globals or modules', async () => {
  const context = {}
  runInNewContext(await readFile(join(root, 'dist/markdown-it.js'), 'utf8'), context)
  let count = 0
  const env = { browser: true }
  const md = context.markdownit({
    urlTransform(url, info) {
      count++
      assert.equal(info.env, env)
      return '/browser'
    },
  })
  assert.equal(
    md.renderInline('[x](/old) ![y](/image)', env),
    '<a href="/browser">x</a> <img src="/browser" alt="y">'
  )
  assert.equal(count, 2)
})
