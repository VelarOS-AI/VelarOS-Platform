/**
 * 网上查资料的验收测试：每一条对应 spec/invariants.md 里的一个编号。只测对外承诺的行为，实现细节的测试在 test/ 目录。
 * 浏览器用 `spec/support.ts` 的假无头浏览器（按地址给写好的结果、记下开关了几页），钟用能快进的假钟，记住 Google 搜不通的十分钟不用真等；
 * 页面脚本在真浏览器里的那一半由 Electron 探针核对（INV-17）。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import { VelarWebModule } from '../contract/surface'
import { WebErrorCodes, WebLimits } from '../index'
import { WebTuning } from '../utils/tuning'

import {
  bingLink,
  failureOf,
  fakeClock,
  googleGoto,
  googleLink,
  runModelProgram,
  scanOf,
  sitesOf,
  typecheckTemplate,
  WebDeclarations,
  webSpace,
} from './support'

/** 一页正常的 Google 结果：两条直接链接。 */
const GoogleResults = scanOf([
  {
    title: 'Node.js 事件循环',
    href: 'https://nodejs.org/en/learn/event-loop',
    snippet: '事件循环是……',
  },
  { title: 'MDN：并发模型', href: 'https://developer.mozilla.org/docs/Web/JavaScript/Event_loop' },
])

/** 一页正常的 Bing 结果：一条跳转链接。 */
const BingResults = scanOf([
  { title: 'Bing 找到的', href: bingLink('https://example.com/from-bing'), snippet: '摘要' },
])

/** 等手上排着的微任务都跑完（宿主晚开出来的页面被关掉要走好几步）。 */
function settled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** 一个正常的网页：写好的标题与正文。 */
function pageSite(text: string, extra: { title?: string; landed?: string } = {}) {
  return {
    readable: { title: extra.title ?? '标题', text, contentType: 'text/html' },
    landed: extra.landed,
  }
}

describe('搜索', () => {
  test('INV-1 按用户选的搜索引擎先搜：结果页地址拼好，交回搜索词、实际用的搜索引擎与结果，用完的页面关掉', async () => {
    const google = webSpace({ sites: sitesOf({ google: { scan: GoogleResults } }) })
    const found = await google.operations.search(
      { query: '  Node.js 事件循环  ', limit: 5 },
      google.context
    )
    expect(found).toEqual({
      query: 'Node.js 事件循环',
      engine: 'google',
      results: [
        {
          title: 'Node.js 事件循环',
          url: 'https://nodejs.org/en/learn/event-loop',
          snippet: '事件循环是……',
        },
        {
          title: 'MDN：并发模型',
          url: 'https://developer.mozilla.org/docs/Web/JavaScript/Event_loop',
          snippet: '',
        },
      ],
    })
    expect(google.record.loads).toHaveLength(1)
    const googleUrl = new URL(google.record.loads[0]!)
    expect(googleUrl.origin + googleUrl.pathname).toBe('https://www.google.com/search')
    expect(googleUrl.searchParams.get('q')).toBe('Node.js 事件循环')
    expect(google.record).toMatchObject({ opened: 1, closed: 1, scripts: ['google'] })

    const bing = webSpace({ engine: 'bing', sites: sitesOf({ bing: { scan: BingResults } }) })
    const fromBing = await bing.operations.search({ query: '事件循环', limit: 12 }, bing.context)
    expect(fromBing.engine).toBe('bing')
    const bingUrl = new URL(bing.record.loads[0]!)
    expect(bingUrl.origin + bingUrl.pathname).toBe('https://www.bing.com/search')
    expect([bingUrl.searchParams.get('q'), bingUrl.searchParams.get('count')]).toEqual([
      '事件循环',
      '12',
    ])
    expect(bing.record).toMatchObject({ opened: 1, closed: 1, scripts: ['bing'] })
  })

  test('INV-2 结果的地址是真实目标：跳转链接解开，用不了的丢掉，按地址去重，截到 limit 条', async () => {
    const hits = [
      { title: '第一条', href: bingLink('https://example.com/a'), snippet: '  摘要  有  空白 ' },
      { title: '同一页只差锚点', href: bingLink('https://example.com/a#part-2') },
      { title: '没解开的跳转', href: 'https://www.bing.com/ck/a?!&&p=1&u=a1%%%&ntb=1' },
      { title: '再搜一次', href: 'https://www.bing.com/search?q=more' },
      { title: '脚本链接', href: 'javascript:void(0)' },
      { title: '', href: bingLink('https://example.com/no-title') },
      { title: '直接链接', href: 'https://example.org/direct' },
      { title: '第四条', href: bingLink('https://example.net/4') },
    ]
    const bing = webSpace({ engine: 'bing', sites: sitesOf({ bing: { scan: scanOf(hits) } }) })
    const { results } = await bing.operations.search({ query: 'x', limit: 3 }, bing.context)
    expect(results).toEqual([
      { title: '第一条', url: 'https://example.com/a', snippet: '摘要 有 空白' },
      {
        title: 'https://example.com/no-title',
        url: 'https://example.com/no-title',
        snippet: '',
      },
      { title: '直接链接', url: 'https://example.org/direct', snippet: '' },
    ])

    const google = webSpace({
      sites: sitesOf({
        google: {
          scan: scanOf([
            { title: '老式跳转', href: googleLink('https://example.com/old?x=1&y=2') },
            { title: '图片', href: 'https://www.google.com/search?q=x&tbm=isch' },
            { title: '跳转里没有地址', href: 'https://www.google.com/url?sa=U' },
            { title: '直接链接', href: 'https://example.com/direct' },
          ]),
        },
      }),
    })
    const fromGoogle = await google.operations.search({ query: 'x' }, google.context)
    expect(fromGoogle.results.map((result) => result.url)).toEqual([
      'https://example.com/old?x=1&y=2',
      'https://example.com/direct',
    ])

    // 不给 limit 就是缺省条数，最多就是上限
    const many = Array.from({ length: 30 }, (_, index) => ({
      title: `第 ${index + 1} 条`,
      href: `https://example.com/${index + 1}`,
    }))
    const plenty = webSpace({ sites: sitesOf({ google: { scan: scanOf(many) } }) })
    expect((await plenty.operations.search({ query: 'x' }, plenty.context)).results).toHaveLength(
      WebLimits.defaultResults
    )
    expect(
      (await plenty.operations.search({ query: 'x', limit: WebLimits.maxResults }, plenty.context))
        .results
    ).toHaveLength(WebLimits.maxResults)
  })

  test('INV-18 Google 的 /goto 跳转链接问宿主一次换成真实地址：并发、限时、只问够用的几条；问不出来的原样留着', async () => {
    const hits = [
      { title: '甲', href: googleGoto('A') },
      { title: '甲的另一处', href: googleGoto('B') },
      { title: '问出错', href: googleGoto('C') },
      { title: '不是跳转', href: googleGoto('D') },
      { title: '跳去脚本', href: googleGoto('E') },
      { title: '直接链接', href: 'https://example.com/direct' },
    ]
    const space = webSpace({
      sites: sitesOf({ google: { scan: scanOf(hits) } }),
      redirects: {
        [googleGoto('A')]: 'https://example.com/a',
        [googleGoto('B')]: 'https://example.com/a#section',
        [googleGoto('C')]: new AppError('NETWORK', 'net::ERR_CONNECTION_RESET'),
        [googleGoto('E')]: 'javascript:alert(1)',
      },
    })
    const { results } = await space.operations.search({ query: 'x', limit: 4 }, space.context)
    expect(results.map((result) => result.url)).toEqual([
      'https://example.com/a',
      googleGoto('C'),
      googleGoto('D'),
      googleGoto('E'),
    ])
    expect(space.record.resolved).toEqual(hits.slice(0, 5).map((hit) => hit.href))

    // 宿主一直不回：到点撒手，全部原样留着，搜索照样成
    const stuck = webSpace({
      sites: sitesOf({ google: { scan: scanOf(hits) } }),
      redirects: { [googleGoto('A')]: 'hang' },
    })
    const kept = await stuck.operations.search({ query: 'x', limit: 2 }, stuck.context)
    expect([kept.engine, kept.results.map((result) => result.url)]).toEqual([
      'google',
      [googleGoto('A'), googleGoto('B')],
    ])

    // 宿主没给这个口子：原样留着
    const bare = webSpace({ sites: sitesOf({ google: { scan: scanOf(hits) } }) })
    expect(
      (await bare.operations.search({ query: 'x', limit: 1 }, bare.context)).results[0]?.url
    ).toBe(googleGoto('A'))

    // 只问要的条数外加几条备用的
    const many = Array.from({ length: 20 }, (_, index) => ({
      title: `第 ${index + 1} 条`,
      href: googleGoto(`T${index}`),
    }))
    const counted = webSpace({ sites: sitesOf({ google: { scan: scanOf(many) } }), redirects: {} })
    await counted.operations.search({ query: 'x', limit: 2 }, counted.context)
    expect(counted.record.resolved).toHaveLength(2 + WebTuning.search.spareHits)
  })

  test('INV-3 Google 搜不通就换 Bing：加载出错、到点没加载完、验证页、同意页、验证字样、认不出结果都算', async () => {
    const failures = {
      加载出错: { load: new AppError('NETWORK', 'net::ERR_CONNECTION_RESET') },
      到点没加载完: { load: 'slow' as const, landed: 'about:blank' },
      验证页: {
        landed: 'https://www.google.com/sorry/index?continue=x',
        scan: scanOf([], { text: 'Our systems have detected unusual traffic' }),
      },
      同意页: {
        landed: 'https://consent.google.com/ml?continue=x',
        scan: scanOf([{ title: '接受', href: 'https://policies.google.com/terms' }]),
      },
      验证字样: { scan: scanOf([], { text: '我们的系统检测到您的计算机网络中存在异常流量' }) },
      认不出结果: { scan: scanOf([], { text: '一个改了版的结果页' }) },
    }
    for (const [name, google] of Object.entries(failures)) {
      const space = webSpace({ sites: sitesOf({ google, bing: { scan: BingResults } }) })
      const found = await space.operations.search({ query: name }, space.context)
      expect({ name, engine: found.engine, first: found.results[0]?.url }).toEqual({
        name,
        engine: 'bing',
        first: 'https://example.com/from-bing',
      })
      expect({ name, opened: space.record.opened, closed: space.record.closed }).toEqual({
        name,
        opened: 2,
        closed: 2,
      })
      // 到点连一个文档都没落下的页面不再跑脚本：宿主那边对它跑脚本会一直卡着
      if (name === '到点没加载完') expect(space.record.scripts).toEqual(['bing'])
    }

    // Google 认出了结果：不碰 Bing；正常结果里碰巧有「unusual traffic」也不算被拦
    const fine = webSpace({
      sites: sitesOf({
        google: {
          scan: scanOf([{ title: 'What is unusual traffic', href: 'https://example.com/t' }], {
            text: 'unusual traffic from your network',
          }),
        },
        bing: { scan: BingResults },
      }),
    })
    const found = await fine.operations.search({ query: 'unusual traffic' }, fine.context)
    expect(found.engine).toBe('google')
    expect(fine.record.loads.some((url) => url.includes('bing.com'))).toBe(false)
  })

  test('INV-4 记住 Google 搜不通：窗口内直接走 Bing、一个 Google 页面都不开；过了窗口再试，搜通了就忘掉；用户选 Bing 时 Bing 搜不通才试 Google', async () => {
    let googleUp = false
    const sites = sitesOf({ bing: { scan: BingResults } })
    const clock = fakeClock()
    const space = webSpace({
      clock,
      sites: (url) =>
        url.startsWith('https://www.google.com/')
          ? googleUp
            ? { scan: GoogleResults }
            : { load: new AppError('NETWORK', 'net::ERR_CONNECTION_TIMED_OUT') }
          : sites(url),
    })
    const googleLoads = () =>
      space.record.loads.filter((url) => url.startsWith('https://www.google.com/')).length

    expect((await space.operations.search({ query: '一' }, space.context)).engine).toBe('bing')
    expect(googleLoads()).toBe(1)
    clock.advance(WebTuning.search.googleRestMs - 1)
    googleUp = true
    expect((await space.operations.search({ query: '二' }, space.context)).engine).toBe('bing')
    expect(googleLoads()).toBe(1)

    clock.advance(1)
    expect((await space.operations.search({ query: '三' }, space.context)).engine).toBe('google')
    expect(googleLoads()).toBe(2)
    expect((await space.operations.search({ query: '四' }, space.context)).engine).toBe('google')
    expect(googleLoads()).toBe(3)
    expect(space.record.opened).toBe(space.record.closed)

    // 用户选 Bing：Bing 搜通就不碰 Google；Bing 搜不通才试 Google
    const bingFirst = webSpace({
      engine: 'bing',
      sites: sitesOf({ google: { scan: GoogleResults }, bing: { scan: BingResults } }),
    })
    expect((await bingFirst.operations.search({ query: 'x' }, bingFirst.context)).engine).toBe(
      'bing'
    )
    expect(bingFirst.record.loads.every((url) => url.startsWith('https://www.bing.com/'))).toBe(
      true
    )
    const bingDown = webSpace({
      engine: 'bing',
      sites: sitesOf({
        google: { scan: GoogleResults },
        bing: { load: 'slow', landed: 'about:blank' },
      }),
    })
    expect((await bingDown.operations.search({ query: 'x' }, bingDown.context)).engine).toBe(
      'google'
    )
  })

  test('INV-5 两边都搜不了抛 WEB_SEARCH_FAILED，写明两边各自为什么；Bing 明说没有结果交回空的 results', async () => {
    const space = webSpace({
      sites: sitesOf({
        google: { load: new AppError('NETWORK', 'net::ERR_CONNECTION_RESET') },
        bing: { scan: scanOf([], { text: '请完成人机验证' }) },
      }),
    })
    const failure = await failureOf(
      space.operations.search({ query: '量子计算入门' }, space.context)
    )
    expect(failure.code).toBe(WebErrorCodes.searchFailed)
    expect(failure.message).toContain('量子计算入门')
    expect(failure.message).toContain('Google：打不开（net::ERR_CONNECTION_RESET）')
    expect(failure.message).toContain('Bing：被拦成了验证页')
    expect(space.record).toMatchObject({ opened: 2, closed: 2 })

    // Google 还在记忆窗口里：这一次写明没再试它
    const again = await failureOf(space.operations.search({ query: '再搜' }, space.context))
    expect(again.code).toBe(WebErrorCodes.searchFailed)
    expect(again.message).toContain('Google：10 分钟内搜不通过，这次没再试')

    const nothing = webSpace({
      engine: 'bing',
      sites: sitesOf({ bing: { scan: scanOf([], { noResults: true }) } }),
    })
    expect(await nothing.operations.search({ query: 'qzxv 没有这个词' }, nothing.context)).toEqual({
      query: 'qzxv 没有这个词',
      engine: 'bing',
      results: [],
    })
    expect(nothing.record.loads).toHaveLength(1)
  })
})

describe('读网页', () => {
  test('INV-6 加载完先等渲染：readyState 是 complete、正文长度稳住一段时间才读，有上限；看不到的那一眼只当没稳；到点还在加载的不等', async () => {
    const url = 'https://app.example.com/'
    const rendering = webSpace({
      sites: sitesOf({
        pages: {
          [url]: {
            ...pageSite('渲染出来的正文'),
            settle: [
              { ready: 'interactive', length: 0 },
              new AppError('UNKNOWN', 'Execution context was destroyed'),
              { ready: 'complete', length: 10 },
              { ready: 'complete', length: 200 },
              { ready: 'complete', length: 200 },
            ],
          },
        },
      }),
    })
    const started = rendering.clock.now()
    const page = await rendering.operations.read({ url }, rendering.context)
    const waited = rendering.clock.now() - started
    expect(page.text).toBe('渲染出来的正文')
    expect(waited).toBeGreaterThanOrEqual(WebTuning.read.stableMs)
    expect(waited).toBeLessThan(WebTuning.read.settleMs)
    const scripts = rendering.record.scripts
    expect(scripts.at(-1)).toBe('readable')
    expect(scripts.filter((name) => name === 'settle').length).toBeGreaterThanOrEqual(5)

    // 一直在变的页面：等到上限就读
    let length = 0
    const ticking = webSpace({
      sites: () => ({
        ...pageSite('一直在变'),
        settle: Array.from({ length: 200 }, () => ({ ready: 'complete', length: (length += 1) })),
      }),
    })
    const tickStart = ticking.clock.now()
    expect((await ticking.operations.read({ url }, ticking.context)).text).toBe('一直在变')
    const tickWaited = ticking.clock.now() - tickStart
    expect(tickWaited).toBeGreaterThanOrEqual(WebTuning.read.settleMs)
    expect(tickWaited).toBeLessThan(WebTuning.read.settleMs + WebTuning.read.pollMs * 2)

    // 到点还在加载：不等渲染，已经出来的正文照读
    const slow = webSpace({
      sites: sitesOf({ pages: { [url]: { ...pageSite('先出来的一半'), load: 'slow' } } }),
    })
    const partial = await slow.operations.read({ url }, slow.context)
    expect(partial.text).toBe('先出来的一半')
    expect(slow.record.scripts).toEqual(['readable'])
  })

  test('INV-7 正文收拾过：换行统一、空白并好、段落之间空一行；url 是跳转之后的地址，title 是网页标题', async () => {
    const url = 'https://example.com/old'
    const space = webSpace({
      sites: sitesOf({
        pages: {
          [url]: pageSite(
            '  标题行 \r\n\r\n\r\n\r\n第一段\t有  空白 和　全角  \r\n第二行\n\n\n\n第二段  ',
            {
              title: '文章',
              landed: 'https://example.com/new#top',
            }
          ),
        },
      }),
    })
    const page = await space.operations.read({ url }, space.context)
    expect(page).toEqual({
      url: 'https://example.com/new#top',
      title: '文章',
      text: '标题行\n\n第一段 有 空白 和 全角\n第二行\n\n第二段',
      offset: 0,
      totalChars: '标题行\n\n第一段 有 空白 和 全角\n第二行\n\n第二段'.length,
      nextOffset: null,
    })
  })

  test('INV-8 按字符切段：offset 起最多 maxChars 个，缺省与上限按常量表；切口不劈开代理对；读到头 nextOffset 是 null', async () => {
    const url = 'https://example.com/long'
    const body = 'x'.repeat(WebLimits.defaultReadChars + WebLimits.maxReadChars + 5_000)
    const space = webSpace({ sites: sitesOf({ pages: { [url]: pageSite(body) } }) })
    const first = await space.operations.read({ url }, space.context)
    expect([first.offset, first.text.length, first.totalChars, first.nextOffset]).toEqual([
      0,
      WebLimits.defaultReadChars,
      body.length,
      WebLimits.defaultReadChars,
    ])
    const most = await space.operations.read(
      { url, offset: first.nextOffset!, maxChars: WebLimits.maxReadChars },
      space.context
    )
    expect([most.offset, most.text.length, most.nextOffset]).toEqual([
      WebLimits.defaultReadChars,
      WebLimits.maxReadChars,
      WebLimits.defaultReadChars + WebLimits.maxReadChars,
    ])
    const rest = await space.operations.read({ url, offset: most.nextOffset! }, space.context)
    expect([rest.text.length, rest.nextOffset]).toEqual([body.length - most.nextOffset!, null])
    const beyond = await space.operations.read({ url, offset: body.length + 10 }, space.context)
    expect([beyond.text, beyond.totalChars, beyond.nextOffset]).toEqual(['', body.length, null])

    // 表情是一对代理项：切口落在一对中间时整对留给下一段；每段至少前进一个字，接着读永远不会原地打转
    const emoji = webSpace({ sites: sitesOf({ pages: { [url]: pageSite('ab😀cd') } }) })
    const pieces: string[] = []
    let offset: Nullable<number> = 0
    while (offset !== null) {
      const piece = await emoji.operations.read({ url, offset, maxChars: 3 }, emoji.context)
      pieces.push(piece.text)
      offset = piece.nextOffset
    }
    expect(pieces).toEqual(['ab', '😀c', 'd'])
    const single = await emoji.operations.read({ url, offset: 2, maxChars: 1 }, emoji.context)
    expect([single.text, single.nextOffset]).toEqual(['😀', 4])
  })

  test('INV-9 打不开抛 WEB_PAGE_UNREACHABLE，PDF 与读正文的脚本没跑成抛 WEB_PAGE_UNREADABLE，message 带网址与原因', async () => {
    const url = 'https://example.com/doc'
    const cases = [
      {
        site: { load: new AppError('NETWORK', 'net::ERR_NAME_NOT_RESOLVED') },
        code: WebErrorCodes.pageUnreachable,
        says: 'net::ERR_NAME_NOT_RESOLVED',
      },
      {
        site: { load: 'slow' as const, landed: 'about:blank' },
        code: WebErrorCodes.pageUnreachable,
        says: '没加载出内容',
      },
      {
        site: { ...pageSite('   '), load: 'slow' as const },
        code: WebErrorCodes.pageUnreachable,
        says: '没加载出内容',
      },
      {
        site: { readable: { title: '', text: '', contentType: 'application/pdf' } },
        code: WebErrorCodes.pageUnreadable,
        says: 'PDF',
      },
      {
        site: {
          settle: [{ ready: 'complete', length: 0 }],
          evaluateError: new AppError('UNKNOWN', 'Script failed to execute'),
        },
        code: WebErrorCodes.pageUnreadable,
        says: 'Script failed to execute',
      },
      {
        site: { evaluateHangs: true },
        code: WebErrorCodes.pageUnreadable,
        says: '没跑完',
      },
    ]
    for (const { site, code, says } of cases) {
      const space = webSpace({ sites: sitesOf({ pages: { [url]: site } }) })
      const failure = await failureOf(space.operations.read({ url }, space.context))
      expect({
        code: failure.code,
        url: failure.message.includes(url),
        says: failure.message.includes(says),
      }).toEqual({
        code,
        url: true,
        says: true,
      })
      expect(space.record).toMatchObject({ opened: 1, closed: 1 })
    }
  })

  test('INV-10 页面一定关：开页面、跑脚本到点就撒手；撒手之后宿主才开出来的页面也关掉', async () => {
    // 宿主一直开不出页面：到点撒手（假钟拨过时限），之后开出来的那一页当场关掉
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const clock = fakeClock()
    const late = webSpace({ clock, openGate: gate, sites: sitesOf({}) })
    const pending = failureOf(late.operations.read({ url: 'https://example.com/' }, late.context))
    clock.advance(WebTuning.page.openTimeoutMs)
    const failure = await pending
    expect(failure.code).toBe('TIMEOUT')
    expect(late.record.opened).toBe(0)
    release()
    await settled()
    expect(late.record).toMatchObject({ opened: 1, closed: 1 })

    // 结果页的脚本卡死：到点撒手，这个搜索引擎算搜不通，页面照关
    const stuck = webSpace({
      sites: sitesOf({ google: { evaluateHangs: true }, bing: { scan: BingResults } }),
    })
    expect((await stuck.operations.search({ query: 'x' }, stuck.context)).engine).toBe('bing')
    expect(stuck.record).toMatchObject({ opened: 2, closed: 2 })

    // 到点连一个文档都没落下：不再往页面里跑脚本，页面照关
    const empty = webSpace({
      sites: sitesOf({
        pages: { 'https://example.com/': { load: 'slow', landed: 'about:blank' } },
      }),
    })
    const nothing = await failureOf(
      empty.operations.read({ url: 'https://example.com/' }, empty.context)
    )
    expect(nothing.code).toBe(WebErrorCodes.pageUnreachable)
    expect(empty.record).toMatchObject({ opened: 1, closed: 1, scripts: [] })
  })

  test('INV-11 取消：调用之前就取消的一页都不开；中途取消立刻以取消原因失败、不试下一个搜索引擎，页面照关', async () => {
    const before = new AbortController()
    before.abort(new AppError('ABORTED', '用户没等它开始就停了'))
    const idle = webSpace({ abortSignal: before.signal, sites: sitesOf({}) })
    expect(await failureOf(idle.operations.search({ query: 'x' }, idle.context))).toEqual({
      code: 'ABORTED',
      message: '用户没等它开始就停了',
    })
    expect(
      await failureOf(idle.operations.read({ url: 'https://example.com/' }, idle.context))
    ).toEqual({
      code: 'ABORTED',
      message: '用户没等它开始就停了',
    })
    expect(idle.record.opened).toBe(0)

    // 读网页时页面卡在加载：用户一停就失败，页面关掉
    const reading = new AbortController()
    const url = 'https://example.com/slow'
    const hanging = webSpace({
      abortSignal: reading.signal,
      sites: sitesOf({
        pages: {
          [url]: {
            load: 'hang',
            onLoad: () => reading.abort(new AppError('ABORTED', '用户中途停了')),
          },
        },
      }),
    })
    expect(await failureOf(hanging.operations.read({ url }, hanging.context))).toEqual({
      code: 'ABORTED',
      message: '用户中途停了',
    })
    expect(hanging.record).toMatchObject({ opened: 1, closed: 1 })

    // 等渲染等到一半用户停了：以取消原因失败，页面关掉，正文不读
    const settling = new AbortController()
    const midway = webSpace({
      abortSignal: settling.signal,
      sites: sitesOf({
        pages: {
          [url]: {
            onProbe: (count) => {
              if (count === 3) settling.abort(new AppError('ABORTED', '等渲染时停了'))
            },
          },
        },
      }),
    })
    expect(await failureOf(midway.operations.read({ url }, midway.context))).toEqual({
      code: 'ABORTED',
      message: '等渲染时停了',
    })
    expect(midway.record.scripts).toEqual(['settle', 'settle', 'settle'])
    expect(midway.record).toMatchObject({ opened: 1, closed: 1 })

    // 搜索时 Google 卡在加载：用户一停就失败，不再试 Bing
    const searching = new AbortController()
    const stopped = webSpace({
      abortSignal: searching.signal,
      sites: sitesOf({
        google: { load: 'hang', onLoad: () => searching.abort(new AppError('ABORTED', '不搜了')) },
        bing: { scan: BingResults },
      }),
    })
    expect(await failureOf(stopped.operations.search({ query: 'x' }, stopped.context))).toEqual({
      code: 'ABORTED',
      message: '不搜了',
    })
    expect(stopped.record.loads.some((address) => address.includes('bing.com'))).toBe(false)
    expect(stopped.record).toMatchObject({ opened: 1, closed: 1 })

    // 宿主还没开出页面用户就停了：立刻失败，之后开出来的那一页关掉
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const opening = new AbortController()
    const waiting = webSpace({ abortSignal: opening.signal, openGate: gate, sites: sitesOf({}) })
    const pending = failureOf(waiting.operations.read({ url }, waiting.context))
    opening.abort(new AppError('ABORTED', '等不及了'))
    expect(await pending).toEqual({ code: 'ABORTED', message: '等不及了' })
    release()
    await settled()
    expect(waiting.record).toMatchObject({ opened: 1, closed: 1 })
  })

  test('INV-12 入参不对当场 VALIDATION，一个页面都不开', async () => {
    const space = webSpace({ sites: sitesOf({}) })
    const bad: Array<[string, unknown]> = [
      ['search', null],
      ['search', 'Node.js'],
      ['search', {}],
      ['search', { query: '   ' }],
      ['search', { query: 'x'.repeat(WebLimits.queryChars + 1) }],
      ['search', { query: 'x', limit: 0 }],
      ['search', { query: 'x', limit: WebLimits.maxResults + 1 }],
      ['search', { query: 'x', limit: 2.5 }],
      ['search', { query: 'x', engine: 'bing' }],
      ['read', { url: '' }],
      ['read', { url: 'file:///etc/hosts' }],
      ['read', { url: 'javascript:alert(1)' }],
      ['read', { url: 'https://' }],
      ['read', { url: `https://example.com/${'x'.repeat(WebLimits.urlChars)}` }],
      ['read', { url: 'https://example.com', offset: -1 }],
      ['read', { url: 'https://example.com', offset: 1.5 }],
      ['read', { url: 'https://example.com', maxChars: 0 }],
      ['read', { url: 'https://example.com', maxChars: WebLimits.maxReadChars + 1 }],
      ['read', { url: 'https://example.com', selector: 'main' }],
    ]
    for (const [operation, input] of bad) {
      const call =
        operation === 'search'
          ? space.operations.search(input as never, space.context)
          : space.operations.read(input as never, space.context)
      expect({ operation, input, code: (await failureOf(call)).code }).toEqual({
        operation,
        input,
        code: 'VALIDATION',
      })
    }
    expect(space.record.opened).toBe(0)

    // 没写协议的网址按 https 读；null 当作没给
    const page = webSpace({
      sites: sitesOf({ pages: { 'https://example.com/a': pageSite('正文') } }),
    })
    const read = await page.operations.read(
      { url: ' example.com/a ', offset: null, maxChars: null } as never,
      page.context
    )
    expect([read.url, read.text]).toEqual(['https://example.com/a', '正文'])
  })
})

describe('代码面 web 命名空间', () => {
  test('INV-13 模型写的程序照生成的声明调到真实操作；失败时程序接得住 error.code 与 error.message', async () => {
    const space = webSpace({
      sites: sitesOf({
        google: { scan: GoogleResults },
        pages: {
          'https://nodejs.org/en/learn/event-loop': pageSite('事件循环\n\n第二段', {
            title: '事件循环',
          }),
        },
      }),
    })
    const result = await runModelProgram(
      space,
      `import { read, search } from 'velaros:web'

const { engine, results } = await search({ query: '事件循环', limit: 2 })
const page = await read({ url: results[0].url })
let failed
try {
  await read({ url: 'https://nowhere.example/' })
} catch (error) {
  failed = { code: error.code, unreachable: error.message.includes('nowhere.example') }
}
export default { engine, urls: results.map((r) => r.url), title: page.title, text: page.text, next: page.nextOffset, failed }`
    )
    expect(result.failed).toBeUndefined()
    expect(result.value).toEqual({
      engine: 'google',
      urls: [
        'https://nodejs.org/en/learn/event-loop',
        'https://developer.mozilla.org/docs/Web/JavaScript/Event_loop',
      ],
      title: '事件循环',
      text: '事件循环\n\n第二段',
      next: null,
      failed: { code: WebErrorCodes.pageUnreachable, unreachable: true },
    })
    expect(space.record.opened).toBe(space.record.closed)
  }, 60_000)
})

describe('模型面', () => {
  test('INV-14 代码模版整份照真实声明过类型检查；它不嵌进声明，随模型面发布的就是这份文件', () => {
    const template = readFileSync(fileURLToPath(new URL('../template.js', import.meta.url)), 'utf8')
    expect(typecheckTemplate(template)).toEqual([])
    expect(template.match(/^import /gmu)).toHaveLength(1)
    expect(VelarWebModule.template).toBe(template.trim())
    expect(WebDeclarations).not.toContain('的代码模版')
  })

  test('INV-15 声明里的条数、字符数都是常量表里的；两个操作都没有效果、各只有一个入参；端口与上下文不进模型面', () => {
    expect(WebDeclarations).toContain(`默认 ${WebLimits.defaultResults} 条`)
    expect(WebDeclarations).toContain(`最多 ${WebLimits.maxResults} 条`)
    expect(WebDeclarations).toContain(`默认一次 ${WebLimits.defaultReadChars} 个字符`)
    expect(WebDeclarations).toContain(`最多 ${WebLimits.maxReadChars} 个字符`)
    const limitsByUnit: Record<string, number[]> = {
      条: [WebLimits.defaultResults, WebLimits.maxResults],
      个字符: [
        WebLimits.queryChars,
        WebLimits.urlChars,
        WebLimits.defaultReadChars,
        WebLimits.maxReadChars,
      ],
    }
    const mentioned = [...WebDeclarations.matchAll(/(\d+)\s*(条|个字符)/gu)].map((match) => ({
      unit: match[2]!,
      value: Number(match[1]),
    }))
    expect(mentioned.length).toBeGreaterThanOrEqual(6)
    for (const { unit, value } of mentioned)
      expect({ unit, value, isLimit: limitsByUnit[unit]!.includes(value) }).toEqual({
        unit,
        value,
        isLimit: true,
      })
    // 「默认 8000、最多 20000」这种省了单位的写法也得是常量表里的数
    for (const match of WebDeclarations.matchAll(/(?:默认|最多)\s*(\d+)/gu))
      expect(Object.values(WebLimits)).toContain(Number(match[1]))

    expect(
      [...WebDeclarations.matchAll(/export function (\w+)\(([^)]*)\)/gu)].map((match) => [
        match[1],
        match[2],
      ])
    ).toEqual([
      ['search', 'input: WebSearchInput'],
      ['read', 'input: WebReadInput'],
    ])
    expect(VelarWebModule.methods).toEqual(['search', 'read'])
    expect(VelarWebModule.operations.search.effects).toBe('none')
    expect(VelarWebModule.operations.read.effects).toBe('none')

    const hidden = [
      'WebSpacePort',
      'WebPage',
      'WebOperationContext',
      'WebOperationsClock',
      'openPage',
      'searchEngine',
      'evaluate',
      'abortSignal',
      'AbortSignal',
    ]
    for (const name of hidden)
      expect({ name, shown: new RegExp(`\\b${name}\\b`, 'u').test(WebDeclarations) }).toEqual({
        name,
        shown: false,
      })
  })
})
