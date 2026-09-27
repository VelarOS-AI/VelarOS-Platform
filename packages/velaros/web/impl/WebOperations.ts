/**
 * 网上查资料（`velaros:web`）的操作：`WebOperations` 与整个进程唯一的 `webOperations`。接口 `WebOperationsApi` 在本文件的类上方。
 * 浏览器由宿主经调用上下文里的端口 `WebSpacePort` 给（不显示的页面）；这里往页面里装地址、跑读取脚本，每一页用完都在 finally 里关掉。
 * 实例记着 Google 最近一次搜不通的时刻：之后一段时间的搜索直接走 Bing。整个进程一份，因为网络通不通和哪个空间无关。
 */

import { isPresent, Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import { WebErrorCodes } from '../contract/constants.js'
import type { WebOperationContext, WebPage } from '../contract/requires.js'
import type {
  WebEngineAttempt,
  WebEngineFailure,
  WebLoadOutcome,
  WebRawHit,
  WebReadableScan,
  WebSearchRequest,
  WebSettleProbe,
} from '../types/page.js'
import type {
  WebPageText,
  WebReadInput,
  WebSearchEngineId,
  WebSearchInput,
  WebSearchResults,
} from '../types/web.js'
import {
  blockedReason,
  engineOrder,
  needsResolving,
  searchFailedMessage,
  searchPageUrl,
  searchResults,
} from '../utils/engines.js'
import {
  loadFailedError,
  nothingLoadedError,
  pdfPageError,
  unreadablePageError,
} from '../utils/errors.js'
import { readRequest, searchRequest } from '../utils/input.js'
import {
  BingResultsScript,
  GoogleResultsScript,
  ReadableTextScript,
  SettleProbeScript,
} from '../utils/page-scripts.js'
import { closePage, closeWhenOpened, isPdfDocument, untilAborted } from '../utils/pages.js'
import { readableScanOf, searchScanOf, settleProbeOf } from '../utils/scans.js'
import { durationText, readableText, textSlice } from '../utils/text.js'
import { WebTuning } from '../utils/tuning.js'
import { httpUrl, landedUrl } from '../utils/urls.js'

const log = Log.tag('WebOperations')

/** WebOperations 读时间、等待与限时用的钟：宿主进程里是真钟；测试换成能快进的假钟，不用真等十分钟、真等超时。 */
export interface WebOperationsClock {
  /** 现在的时间戳，毫秒。 */
  now(): number
  /** 等 ms 毫秒；signal 触发就提前以它的原因失败。 */
  sleep(ms: number, signal: AbortSignal): Promise<void>
  /** 一个 ms 毫秒之后触发的信号。 */
  timeout(ms: number): AbortSignal
}

/**
 * @AgentView
 * 网上查资料：search 用搜索引擎搜，read 把一个网页读成文字。都在一个不显示的浏览器里跑：用户看不到，不留浏览痕迹，也碰不到用户的登录。
 * 搜索引擎按用户的设置（Google 或 Bing）；它打不开、被拦成验证页或认不出结果时自动换另一个，结果里的 engine 写着实际用的是哪个。
 * 搜索结果只是线索：要紧的事读原文核对，交给用户时带上出处（url）。
 * 要在网页上动手（登录、填表、点按钮）、看页面长什么样、读登录之后才看得到的内容，用浏览器（velaros:browser），不用这个。
 * 失败抛的错误带 code：WEB_SEARCH_FAILED 两个搜索引擎都搜不了（message 写着两边各自为什么）；
 * WEB_PAGE_UNREACHABLE 网页打不开（连不上、加载出错，或者超时了什么都没出来）；WEB_PAGE_UNREADABLE 打开了却读不成文字（比如是 PDF）。入参不对是 VALIDATION。
 */
export interface WebOperationsApi {
  /** @AgentView 用搜索引擎搜一次，交回前几条结果的标题、真实地址与摘要（默认 8 条、最多 20 条）。
   * @OperationEffect none
   */
  search(input: WebSearchInput, ctx: WebOperationContext): Promise<WebSearchResults>
  /** @AgentView 打开一个网页、等它渲染完，读出正文（去掉脚本、导航、页眉页脚、侧栏与表单），按字符分段交回：默认一次 8000 个字符、最多 20000 个字符。
   * 每次 read 都重新打开网页，长网页一次多读一些。
   * @OperationEffect none
   */
  read(input: WebReadInput, ctx: WebOperationContext): Promise<WebPageText>
}

export class WebOperations implements WebOperationsApi {
  /** Google 最近一次搜不通的时刻（毫秒）；从没搜不通过、或者后来又搜通了是 null。 */
  private googleFailedAt: Nullable<number> = null

  constructor(private readonly clock: WebOperationsClock) {}

  public async search(input: WebSearchInput, ctx: WebOperationContext): Promise<WebSearchResults> {
    ctx.abortSignal.throwIfAborted()
    const request = searchRequest(input)
    const failures: WebEngineFailure[] = []
    for (const engine of engineOrder(ctx.web.searchEngine())) {
      const resting = this.googleResting(engine)
      if (resting) {
        failures.push({ engine, reason: resting })
        continue
      }
      const attempt = await this.searchWith(engine, request, ctx)
      if (engine === 'google') this.googleFailedAt = attempt.ok ? null : this.clock.now()
      if (attempt.ok) return { query: request.query, engine, results: attempt.results }
      failures.push({ engine, reason: attempt.reason })
    }
    throw new AppError(WebErrorCodes.searchFailed, searchFailedMessage(request.query, failures))
  }

  public async read(input: WebReadInput, ctx: WebOperationContext): Promise<WebPageText> {
    ctx.abortSignal.throwIfAborted()
    const request = readRequest(input)
    const page = await this.openPage(ctx)
    try {
      const loaded = await this.load(page, request.url, WebTuning.read.loadTimeoutMs, ctx)
      if (loaded.kind === 'failed') throw loadFailedError(request.url, loaded.message)
      if (loaded.kind === 'loaded') await this.settle(page, ctx)
      const landed = landedUrl(page.url())
      if (loaded.kind === 'slow' && !landed) throw nothingLoadedError(request.url)
      const url = landed ?? request.url
      const scan = await this.readable(page, url, ctx)
      if (isPdfDocument(scan.contentType)) throw pdfPageError(url)
      const text = readableText(scan.text)
      if (loaded.kind === 'slow' && !text) throw nothingLoadedError(request.url)
      const slice = textSlice(text, request.offset, request.maxChars)
      return {
        url,
        title: scan.title,
        text: slice.text,
        offset: slice.start,
        totalChars: text.length,
        nextOffset: slice.nextOffset,
      }
    } finally {
      closePage(page)
    }
  }

  /** Google 还在「刚搜不通」的记忆窗口里：交回一句原因（这次跳过它）；不在窗口里、或者问的不是 Google，交回 null。 */
  private googleResting(engine: WebSearchEngineId): Nullable<string> {
    if (engine !== 'google' || !isPresent(this.googleFailedAt)) return null
    if (this.clock.now() - this.googleFailedAt >= WebTuning.search.googleRestMs) return null
    return `${durationText(WebTuning.search.googleRestMs)}内搜不通过，这次没再试`
  }

  /** 用一个搜索引擎搜一次：开一页、抓结果、关页。搜不通交回原因、不抛；只有取消与开不出页面才抛。 */
  private async searchWith(
    engine: WebSearchEngineId,
    request: WebSearchRequest,
    ctx: WebOperationContext
  ): Promise<WebEngineAttempt> {
    const page = await this.openPage(ctx)
    try {
      return await this.scanResults(page, engine, request, ctx)
    } catch (error) {
      ctx.abortSignal.throwIfAborted()
      log.debug('a search engine attempt failed', { engine, error: AppError.getMessage(error) })
      return { ok: false, reason: AppError.getMessage(error) }
    } finally {
      closePage(page)
    }
  }

  /**
   * 在开好的页面里搜：装结果页（到点还没加载完的照抓）、抓原始结果、认验证页、整理结果。
   * 认出了结果、或者搜索引擎明说没有结果，算搜通了；否则交回为什么没搜通。
   */
  private async scanResults(
    page: WebPage,
    engine: WebSearchEngineId,
    request: WebSearchRequest,
    ctx: WebOperationContext
  ): Promise<WebEngineAttempt> {
    const timeoutMs =
      engine === 'google'
        ? WebTuning.search.googleLoadTimeoutMs
        : WebTuning.search.bingLoadTimeoutMs
    const loaded = await this.load(
      page,
      searchPageUrl(engine, request.query, request.limit),
      timeoutMs,
      ctx
    )
    if (loaded.kind === 'failed') return { ok: false, reason: `打不开（${loaded.message}）` }
    // 到点连一个文档都没落下：不往页面里跑脚本了（对没落下文档的页面跑脚本，宿主那边会一直卡着）
    if (loaded.kind === 'slow' && !landedUrl(page.url()))
      return { ok: false, reason: `${durationText(timeoutMs)}没加载出来` }
    const scan = searchScanOf(
      await this.evaluate(page, engine === 'google' ? GoogleResultsScript : BingResultsScript, ctx)
    )
    const hits = await this.resolveRedirects(
      scan.hits.slice(0, request.limit + WebTuning.search.spareHits),
      ctx
    )
    const results = searchResults(engine, hits, request.limit)
    const blocked = blockedReason(page.url(), scan.text, results.length)
    if (blocked) return { ok: false, reason: blocked }
    if (results.length > 0 || scan.noResults) return { ok: true, results }
    return {
      ok: false,
      reason:
        loaded.kind === 'slow'
          ? `${durationText(timeoutMs)}没加载完，页面里也没认出搜索结果`
          : '结果页里没认出搜索结果',
    }
  }

  /**
   * 把 Google 的 /goto 跳转链接问宿主一次换成真实地址：一批并发、共用一个时限；宿主不给这个口子、问不出来、
   * 问出来的不是 http(s) 地址的都原样留着（read 照样读得了）。用户取消照样以取消原因失败。
   */
  private async resolveRedirects(
    hits: readonly WebRawHit[],
    ctx: WebOperationContext
  ): Promise<WebRawHit[]> {
    const resolveRedirect = ctx.web.resolveRedirect?.bind(ctx.web)
    if (!resolveRedirect || !hits.some((hit) => needsResolving(hit.href))) return [...hits]
    const deadline = this.clock.timeout(WebTuning.search.redirectTimeoutMs)
    const signal = AbortSignal.any([ctx.abortSignal, deadline])
    const resolved = await Promise.all(
      hits.map(async (hit): Promise<WebRawHit> => {
        if (!needsResolving(hit.href)) return hit
        try {
          const target = await untilAborted(resolveRedirect(hit.href, signal), signal)
          const url = isPresent(target) ? httpUrl(target, hit.href) : null
          return url ? { ...hit, href: url.href } : hit
        } catch (error) {
          log.debug('resolving a search redirect failed', { error: AppError.getMessage(error) })
          return hit
        }
      })
    )
    ctx.abortSignal.throwIfAborted()
    return resolved
  }

  /** 请宿主开一页：限时，随时可取消；撒手之后才开出来的页面也关掉，不留一个看不见的窗口。 */
  private async openPage(ctx: WebOperationContext): Promise<WebPage> {
    ctx.abortSignal.throwIfAborted()
    const deadline = this.clock.timeout(WebTuning.page.openTimeoutMs)
    const signal = AbortSignal.any([ctx.abortSignal, deadline])
    const opening = ctx.web.openPage(signal)
    try {
      return await untilAborted(opening, signal)
    } catch (error) {
      closeWhenOpened(opening)
      ctx.abortSignal.throwIfAborted()
      if (deadline.aborted)
        throw new AppError(
          'TIMEOUT',
          `宿主 ${durationText(WebTuning.page.openTimeoutMs)}没开出不显示的页面`
        )
      throw AppError.from(error)
    }
  }

  /**
   * 装一个地址：限时，随时可取消。加载完交回 loaded；到点还在加载交回 slow（已经出来的内容照读）；
   * 宿主报加载出错交回 failed 与宿主的原话；用户取消就以取消原因失败。
   */
  private async load(
    page: WebPage,
    url: string,
    timeoutMs: number,
    ctx: WebOperationContext
  ): Promise<WebLoadOutcome> {
    const deadline = this.clock.timeout(timeoutMs)
    const signal = AbortSignal.any([ctx.abortSignal, deadline])
    try {
      await untilAborted(page.load(url, signal), signal)
      return { kind: 'loaded' }
    } catch (error) {
      ctx.abortSignal.throwIfAborted()
      if (deadline.aborted) return { kind: 'slow' }
      log.debug('a hidden page failed to load', { error: AppError.getMessage(error) })
      return { kind: 'failed', message: AppError.getMessage(error) }
    }
  }

  /** 在页面里跑一段脚本：限时，随时可取消；到点抛 TIMEOUT，页面里抛的错原样抛出。 */
  private async evaluate(
    page: WebPage,
    script: string,
    ctx: WebOperationContext,
    timeoutMs: number = WebTuning.page.evaluateTimeoutMs
  ): Promise<unknown> {
    const deadline = this.clock.timeout(timeoutMs)
    const signal = AbortSignal.any([ctx.abortSignal, deadline])
    try {
      return await untilAborted(page.evaluate<unknown>(script), signal)
    } catch (error) {
      ctx.abortSignal.throwIfAborted()
      if (deadline.aborted)
        throw new AppError('TIMEOUT', `页面里的脚本 ${durationText(timeoutMs)}没跑完`)
      throw AppError.from(error)
    }
  }

  /**
   * 等单页应用渲染完：readyState 是 complete、正文长度隔一段时间不变就算完；有上限，到了也不再等。
   * 看的那一眼读不到（页面正在跳走、脚本超时）只当还没稳，不算失败。
   */
  private async settle(page: WebPage, ctx: WebOperationContext): Promise<void> {
    const started = this.clock.now()
    let last: Nullable<number> = null
    let stableSince = started
    for (;;) {
      const remaining = WebTuning.read.settleMs - (this.clock.now() - started)
      const probe = await this.probe(page, ctx, Math.max(remaining, WebTuning.read.pollMs))
      const now = this.clock.now()
      if (probe.ready !== 'complete' || probe.length !== last) {
        last = probe.length
        stableSince = now
      } else if (now - stableSince >= WebTuning.read.stableMs) return
      if (now - started >= WebTuning.read.settleMs) return
      await this.clock.sleep(WebTuning.read.pollMs, ctx.abortSignal)
    }
  }

  /** 等渲染时看一眼：读不到就当还在加载；取消照样以取消原因失败。 */
  private async probe(
    page: WebPage,
    ctx: WebOperationContext,
    timeoutMs: number
  ): Promise<WebSettleProbe> {
    try {
      return settleProbeOf(await this.evaluate(page, SettleProbeScript, ctx, timeoutMs))
    } catch (error) {
      ctx.abortSignal.throwIfAborted()
      log.debug('a settle probe failed', { error: AppError.getMessage(error) })
      return { ready: 'loading', length: 0 }
    }
  }

  /** 读正文：跑读正文的页面脚本；脚本没跑成算读不成文字（WEB_PAGE_UNREADABLE）。 */
  private async readable(
    page: WebPage,
    url: string,
    ctx: WebOperationContext
  ): Promise<WebReadableScan> {
    try {
      return readableScanOf(await this.evaluate(page, ReadableTextScript, ctx))
    } catch (error) {
      ctx.abortSignal.throwIfAborted()
      throw unreadablePageError(url, AppError.getMessage(error))
    }
  }
}

/** 整个进程只有一份的 web 操作；宿主把它挂在代码面的 `web` 命名空间上，每次调用时把自己的无头浏览器端口塞进 ctx。 */
export const webOperations: WebOperationsApi = new WebOperations({
  now: () => Date.now(),
  // 取消时以取消原因失败（TimerScope 自己的取消错误不带原因）；那一小段计时自己走完就散
  sleep: (ms, signal) =>
    untilAborted(TimerScope.sleep(ms, { label: 'velaros:web.settle' }), signal),
  timeout: (ms) => AbortSignal.timeout(ms),
})
