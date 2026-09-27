/**
 * 网上查资料的实现细节测试：对外承诺在 spec/acceptance.test.ts，这里补纯函数的边角——拼结果页地址、解跳转链接、整理与去重、
 * 认验证页、收拾正文与切段、收页面脚本交回的怪东西、入参的规范写法，以及页面脚本至少是合法的 JavaScript、拼进去的数就是可调参数表里的。
 * 页面脚本在真 DOM 上跑出来对不对，由 test/probes/electron-web.probe.mjs 在真的 Electron 里核对。
 */

import { describe, expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import type { WebPage } from '../contract/requires'
import { bingLink, googleLink } from '../spec/support'
import {
  bingTarget,
  blockedAddress,
  blockedReason,
  engineOrder,
  googleTarget,
  needsResolving,
  resultUrl,
  searchFailedMessage,
  searchPageUrl,
  searchResults,
} from '../utils/engines'
import { readRequest, searchRequest } from '../utils/input'
import {
  BingResultsScript,
  GoogleResultsScript,
  ReadableTextScript,
  SettleProbeScript,
} from '../utils/page-scripts'
import { closePage, closeWhenOpened, isPdfDocument, untilAborted } from '../utils/pages'
import { readableScanOf, searchScanOf, settleProbeOf } from '../utils/scans'
import { durationText, readableText, textSlice } from '../utils/text'
import { WebTuning } from '../utils/tuning'
import { httpUrl, landedUrl } from '../utils/urls'

describe('结果页地址', () => {
  test('Google 只带 q；Bing 另带 count；搜索词里的中文、&、#、+ 都编码好', () => {
    const google = new URL(searchPageUrl('google', 'C++ & C# 区别', 8))
    expect(google.origin + google.pathname).toBe('https://www.google.com/search')
    expect([...google.searchParams.keys()]).toEqual(['q'])
    expect(google.searchParams.get('q')).toBe('C++ & C# 区别')
    const bing = new URL(searchPageUrl('bing', 'C++ & C# 区别', 20))
    expect(bing.origin + bing.pathname).toBe('https://www.bing.com/search')
    expect(Object.fromEntries(bing.searchParams)).toEqual({ q: 'C++ & C# 区别', count: '20' })
  })

  test('用户选 Bing 就 Bing 在前，其余都是 Google 在前', () => {
    expect(engineOrder('bing')).toEqual(['bing', 'google'])
    expect(engineOrder('google')).toEqual(['google', 'bing'])
    expect(engineOrder('duckduckgo' as never)).toEqual(['google', 'bing'])
  })
})

describe('解开跳转链接', () => {
  test('Bing：去掉 a1 再按 base64url 解；中文路径、cn.bing.com、没有 a1 前缀的都解得开', () => {
    const target = 'https://example.com/路径?q=一&x=2'
    expect(bingTarget(new URL(bingLink(target)))?.href).toBe(new URL(target).href)
    const cn = new URL(bingLink('https://example.com/cn'))
    cn.hostname = 'cn.bing.com'
    expect(bingTarget(cn)?.href).toBe('https://example.com/cn')
    const bare = `https://www.bing.com/ck/a?u=${Buffer.from('https://example.com/bare').toString('base64url')}`
    expect(bingTarget(new URL(bare))?.href).toBe('https://example.com/bare')
  })

  test('Bing：u 不是 base64url、解出来不是 http(s) 的交回 null；不是跳转链接的原样交回', () => {
    expect(bingTarget(new URL('https://www.bing.com/ck/a?u=a1***'))).toBeNull()
    expect(bingTarget(new URL('https://www.bing.com/ck/a?p=1'))).toBeNull()
    expect(bingTarget(new URL(bingLink('javascript:alert(1)')))).toBeNull()
    expect(bingTarget(new URL(bingLink('ftp://example.com/file')))).toBeNull()
    const plain = new URL('https://example.com/ck/a?u=a1aHR0cHM6Ly9ldmlsLmV4YW1wbGUv')
    expect(bingTarget(plain)).toBe(plain)
  })

  test('Google：/url?q= 与 /url?url= 都认，各地域名都算；别的站的 /url 不是跳转', () => {
    expect(googleTarget(new URL(googleLink('https://example.com/a?b=1')))?.href).toBe(
      'https://example.com/a?b=1'
    )
    expect(
      googleTarget(
        new URL('https://www.google.com.hk/url?sa=t&url=https%3A%2F%2Fexample.com%2Fhk&q=')
      )?.href
    ).toBe('https://example.com/hk')
    expect(googleTarget(new URL('https://www.google.co.jp/url?q=https://example.jp/'))?.href).toBe(
      'https://example.jp/'
    )
    expect(googleTarget(new URL('https://www.google.com/url?q=javascript:alert(1)'))).toBeNull()
    const elsewhere = new URL('https://example.com/url?q=https://other.example/')
    expect(googleTarget(elsewhere)).toBe(elsewhere)
  })

  test('Google 的 /goto 链接本地解不开，要问一次；别的站、别的路径都不用问', () => {
    expect(needsResolving('https://www.google.com/goto?url=CAESiQEB6zsw')).toBe(true)
    expect(needsResolving('https://www.google.com.hk/goto?url=CAES')).toBe(true)
    expect(needsResolving('https://www.google.com/url?q=https://example.com/')).toBe(false)
    expect(needsResolving('https://example.com/goto?url=x')).toBe(false)
    expect(needsResolving('not a url')).toBe(false)
    // 问不出来就原样留着：它是 Google 的跳转，不算搜索引擎自己的页面
    expect(resultUrl('google', 'https://www.google.com/goto?url=CAES')).toBe(
      'https://www.google.com/goto?url=CAES'
    )
  })

  test('结果地址：相对的 /url?q= 按 Google 解开；搜索引擎自己的页面不算结果；别的站的同名路径照留', () => {
    expect(resultUrl('google', '/url?q=https://example.com/rel&sa=U')).toBe(
      'https://example.com/rel'
    )
    expect(resultUrl('google', 'https://www.google.com/search?q=more')).toBeNull()
    expect(resultUrl('google', 'https://www.google.com/imgres?imgurl=x')).toBeNull()
    expect(resultUrl('google', 'https://support.google.com/websearch')).toBe(
      'https://support.google.com/websearch'
    )
    expect(resultUrl('bing', 'https://www.bing.com/images/search?q=x')).toBeNull()
    expect(resultUrl('bing', 'https://www.bing.com/maps')).toBe('https://www.bing.com/maps')
    expect(resultUrl('bing', 'https://example.com/search?q=x')).toBe(
      'https://example.com/search?q=x'
    )
    expect(resultUrl('bing', 'mailto:someone@example.com')).toBeNull()
  })
})

describe('整理结果', () => {
  test('只差锚点的算一个、留第一条；标题与摘要按上限截断；截到 limit 条', () => {
    const long = '长'.repeat(WebTuning.search.snippetChars + 50)
    const results = searchResults(
      'google',
      [
        { title: '甲', href: 'https://example.com/a#one', snippet: long },
        { title: '甲的另一处', href: 'https://example.com/a#two', snippet: '' },
        {
          title: 'T'.repeat(WebTuning.search.titleChars + 10),
          href: 'https://example.com/b',
          snippet: '',
        },
        { title: '丙', href: 'https://example.com/c', snippet: '' },
      ],
      2
    )
    expect(results.map((result) => result.url)).toEqual([
      'https://example.com/a#one',
      'https://example.com/b',
    ])
    expect(results[0]!.snippet.length).toBe(WebTuning.search.snippetChars + 1)
    expect(results[0]!.snippet.endsWith('…')).toBe(true)
    expect(results[1]!.title.length).toBe(WebTuning.search.titleChars + 1)
  })

  test('两边都没搜成的话：搜索词与两边的原因都在', () => {
    const message = searchFailedMessage('天气', [
      { engine: 'google', reason: '打不开（net::ERR_TIMED_OUT）' },
      { engine: 'bing', reason: '结果页里没认出搜索结果' },
    ])
    expect(message).toContain('「天气」')
    expect(message).toContain('Google：打不开（net::ERR_TIMED_OUT）；Bing：结果页里没认出搜索结果')
  })
})

describe('认验证页', () => {
  test('只看地址：/sorry/ 与同意页认得出，别的站的同名路径不算', () => {
    expect(blockedAddress('https://www.google.com.hk/sorry/index')).toContain('/sorry/index')
    expect(blockedAddress('https://consent.google.com/ml')).toContain('consent.google.com')
    expect(blockedAddress('https://example.com/sorry/index')).toBeNull()
    expect(blockedAddress('about:blank')).toBeNull()
  })

  test('Google 的 /sorry/ 与同意页看地址就认，认没认出结果都算', () => {
    expect(blockedReason('https://www.google.com/sorry/index?continue=x', '', 3)).toContain(
      '验证页'
    )
    expect(blockedReason('https://ipv4.google.com/sorry/index', '', 0)).toContain('/sorry/index')
    expect(blockedReason('https://consent.google.com/ml?continue=x', '', 5)).toContain(
      'consent.google.com'
    )
    expect(blockedReason('https://example.com/sorry/index', '', 1)).toBeNull()
  })

  test('字样只在一条结果都没认出来时才看', () => {
    for (const text of [
      'Our systems have detected unusual traffic from your computer network.',
      '我们的系统检测到您的计算机网络中存在异常流量。',
      '请进行人机验证',
      'Please verify you are a human',
      'Solve this CAPTCHA to continue',
    ]) {
      expect({
        text,
        blocked: blockedReason('https://www.bing.com/search?q=x', text, 0) !== null,
      }).toEqual({ text, blocked: true })
      expect(blockedReason('https://www.bing.com/search?q=x', text, 1)).toBeNull()
    }
    expect(blockedReason('https://www.bing.com/search?q=x', '普通的结果页', 0)).toBeNull()
    expect(blockedReason('about:blank', '', 0)).toBeNull()
  })
})

describe('正文', () => {
  test('收拾 innerText：CRLF、制表符、不换行空格、全角空格、行首尾空白、成串的空行', () => {
    expect(readableText('')).toBe('')
    expect(readableText(' \n\n \t ')).toBe('')
    expect(readableText('a\r\nb\rc')).toBe('a\nb\nc')
    expect(readableText('第一段\n\n\n\n\n第二段\n第三行')).toBe('第一段\n\n第二段\n第三行')
    expect(readableText('  x  y\t\tz　w  ')).toBe('x y z w')
    expect(readableText('a\n  \n\t\nb')).toBe('a\n\nb')
  })

  test('切段：起点落在代理对中间往前收，终点落在中间往前退，至少前进一个字', () => {
    const text = '😀😀x'
    expect(textSlice(text, 0, 1)).toEqual({ text: '😀', start: 0, nextOffset: 2 })
    expect(textSlice(text, 1, 1)).toEqual({ text: '😀', start: 0, nextOffset: 2 })
    expect(textSlice(text, 0, 3)).toEqual({ text: '😀', start: 0, nextOffset: 2 })
    expect(textSlice(text, 2, 10)).toEqual({ text: '😀x', start: 2, nextOffset: null })
    expect(textSlice(text, 5, 10)).toEqual({ text: '', start: 5, nextOffset: null })
    expect(textSlice(text, 99, 10)).toEqual({ text: '', start: 5, nextOffset: null })
    expect(textSlice('', 0, 10)).toEqual({ text: '', start: 0, nextOffset: null })
  })

  test('时长：整小时说小时，整分钟说分钟，别的说秒（最多一位小数）', () => {
    expect(durationText(8_000)).toBe('8 秒')
    expect(durationText(4_500)).toBe('4.5 秒')
    expect(durationText(90_000)).toBe('90 秒')
    expect(durationText(600_000)).toBe('10 分钟')
    expect(durationText(WebTuning.search.googleBackoffMs)).toBe('12 小时')
  })

  test('PDF 按媒体类型认', () => {
    expect(isPdfDocument('application/pdf')).toBe(true)
    expect(isPdfDocument(' Application/PDF; charset=binary')).toBe(true)
    expect(isPdfDocument('text/html')).toBe(false)
    expect(isPdfDocument('')).toBe(false)
  })

  test('网址：只认 http 与 https；落在 about:blank、出错页上的算没落下', () => {
    expect(httpUrl('https://example.com/a b')?.href).toBe('https://example.com/a%20b')
    expect(httpUrl('/x', 'https://example.com/y')?.href).toBe('https://example.com/x')
    expect(httpUrl('ftp://example.com/')).toBeNull()
    expect(httpUrl('not a url')).toBeNull()
    expect(landedUrl('about:blank')).toBeNull()
    expect(landedUrl('chrome-error://chromewebdata/')).toBeNull()
    expect(landedUrl('')).toBeNull()
    expect(landedUrl('HTTPS://Example.COM')).toBe('https://example.com/')
  })
})

describe('收页面脚本交回的值', () => {
  test('结果页：不是对象当作什么都没抓到；形状不对的条目丢掉，缺的字段按空算', () => {
    expect(searchScanOf(null)).toEqual({ hits: [], text: '', noResults: false, ready: 'complete' })
    expect(searchScanOf('oops')).toEqual({
      hits: [],
      text: '',
      noResults: false,
      ready: 'complete',
    })
    expect(
      searchScanOf({
        hits: [{ title: 1, href: 'https://a.example/', snippet: null }, { href: 2 }, 'x', null],
        text: 42,
        noResults: 'yes',
      })
    ).toEqual({
      hits: [{ title: '', href: 'https://a.example/', snippet: '' }],
      text: '',
      noResults: false,
      ready: 'complete',
    })
    expect(searchScanOf({ hits: [], ready: 'loading' }).ready).toBe('loading')
    expect(searchScanOf({ hits: 'nope', noResults: true }).noResults).toBe(true)
  })

  test('等渲染的那一眼与读正文：缺的按还在加载、空字符串算', () => {
    expect(settleProbeOf(undefined)).toEqual({ ready: 'loading', length: 0 })
    expect(settleProbeOf({ ready: 'complete', length: Number.NaN })).toEqual({
      ready: 'complete',
      length: 0,
    })
    expect(readableScanOf({ title: '  标题  ', text: 7 })).toEqual({
      title: '标题',
      text: '',
      contentType: '',
    })
  })
})

describe('入参的规范写法', () => {
  test('搜索词去首尾空白，缺省条数；网址补协议、规范成 URL 的写法', () => {
    expect(searchRequest({ query: '  a b  ' })).toEqual({ query: 'a b', limit: 8 })
    expect(readRequest({ url: 'Example.com:8080/x?y=1#z' })).toEqual({
      url: 'https://example.com:8080/x?y=1#z',
      offset: 0,
      maxChars: 8_000,
    })
    expect(readRequest({ url: 'http://localhost:3000/', offset: 10, maxChars: 5 })).toEqual({
      url: 'http://localhost:3000/',
      offset: 10,
      maxChars: 5,
    })
  })

  test('报错点名字段', () => {
    const messageOf = (run: () => unknown): string => {
      try {
        run()
      } catch (error) {
        return AppError.from(error).message
      }
      return ''
    }
    expect(messageOf(() => searchRequest({ query: 'x', count: 3 }))).toContain('不认 count')
    expect(messageOf(() => searchRequest({ query: 'x', limit: 99 }))).toContain('limit')
    expect(messageOf(() => readRequest({ url: 'ftp://example.com/' }))).toContain(
      '只读 http、https'
    )
    expect(messageOf(() => readRequest({ url: 'https://example.com', offset: -2 }))).toContain(
      'nextOffset'
    )
    expect(messageOf(() => readRequest({ url: 'https://example.com', maxChars: 'all' }))).toContain(
      'maxChars'
    )
  })
})

describe('页面脚本', () => {
  test('四段脚本都是合法的 JavaScript 表达式，拼进去的数就是可调参数表里的', () => {
    for (const script of [
      BingResultsScript,
      GoogleResultsScript,
      SettleProbeScript,
      ReadableTextScript,
    ]) {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval -- 只编译不执行，核对拼出来的脚本没有语法错误。
      expect(() => new Function(`return ${script}`)).not.toThrow()
    }
    expect(BingResultsScript).toContain(`slice(0, ${WebTuning.search.probeTextChars})`)
    expect(GoogleResultsScript).toContain(`slice(0, ${WebTuning.search.probeTextChars})`)
    expect(ReadableTextScript).toContain(`total * ${WebTuning.read.wrapperShare}`)
    expect(ReadableTextScript).toContain(`remaining * ${WebTuning.read.mainShare}`)
    expect(BingResultsScript).toContain('.algoSlug_icon')
    expect(BingResultsScript).toContain('#b_results .b_no')
  })
})

describe('和宿主的页面打交道', () => {
  test('撒手：先到的赢；被撒手的那件事后来失败也没人漏接', async () => {
    expect(await untilAborted(Promise.resolve(7), new AbortController().signal)).toBe(7)
    const controller = new AbortController()
    let fail = (_: unknown): void => {}
    const work = new Promise<number>((_, reject) => {
      fail = reject
    })
    const pending = untilAborted(work, controller.signal)
    controller.abort(new AppError('ABORTED', '撒手'))
    expect(await pending.catch((error: unknown) => AppError.from(error).message)).toBe('撒手')
    fail(new AppError('NETWORK', '后来才失败'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const already = new AbortController()
    already.abort(new AppError('ABORTED', '早就停了'))
    expect(
      await untilAborted(Promise.resolve(1), already.signal).catch(
        (error: unknown) => AppError.from(error).message
      )
    ).toBe('早就停了')
  })

  test('关页面：宿主的 close 抛了也不往外抛；晚开出来的页面关掉，开失败了什么也不做', async () => {
    const page: WebPage = {
      load: async () => {},
      evaluate: async <T>() => undefined as T,
      url: () => '',
      close: () => {
        throw new AppError('CLOSED', '窗口已经没了')
      },
    }
    expect(() => closePage(page)).not.toThrow()
    let closed = 0
    closeWhenOpened(Promise.resolve({ ...page, close: () => (closed += 1) }))
    closeWhenOpened(Promise.reject(new AppError('PLATFORM', '开不出来')))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(closed).toBe(1)
  })
})
