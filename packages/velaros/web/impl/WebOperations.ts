/**
 * 网上查资料（`velaros:web`）的操作：`WebOperations` 与整个进程唯一的 `webOperations`。接口 `WebOperationsApi` 在本文件的类上方。
 * 浏览器由宿主经调用上下文里的端口 `WebSpacePort` 给（不显示的页面）；这里往页面里装地址、跑读取脚本，每一页用完都在 finally 里关掉。
 * 实例记着 Google 退避到什么时候：搜不通之后一段时间的搜索直接走 Bing。整个进程一份，因为网络通不通和哪个空间无关；
 * 宿主给了退避记忆（`WebEngineBackoff`）就同时记在那里，重启之后还在。
 */

import { isEmpty, isFiniteNumber, isPresent, Log, toNullable } from '@velaros-ai/core'
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
  WebSearchScan,
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
  blockedAddress,
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
import {
  closePage,
  closeWhenOpened,
  isNavigating,
  isPdfDocument,
  isPlainTextDocument,
  untilAborted,
} from '../utils/pages.js'
import { readableScanOf, searchScanOf, settleProbeOf } from '../utils/scans.js'
import { durationText, plainText, readableText, textSlice } from '../utils/text.js'
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
  /** @AgentView 打开一个网页、等它渲染完，读出正文（去掉脚本、导航、页眉页脚、侧栏与表单；源码、Markdown、JSON 这类纯文本文件原样读出），按字符分段交回：默认一次 8000 个字符、最多 20000 个字符。
   * 每次 read 都重新打开网页，长网页一次多读一些。
   * @OperationEffect none
   */
  read(input: WebReadInput, ctx: WebOperationContext): Promise<WebPageText>
}

export class WebOperations implements WebOperationsApi {
  /** 进程里记着的 Google 退避到什么时候（毫秒时间戳）；从没搜不通过、或者后来又搜通了是 null。 */
  private googleBackoffUntil: Nullable<number> = null
  /** 并行子任务共用搜索源，只允许一个 Google 探测在途，不把其他 query 的结果混用。 */
  private googleAttemptRunning = false
  /** 持久化失败时仍记住同一超长期限的收敛结果，成功探测后也不重启冷却。 */
  private clampedBackoff: Nullable<{ source: number; until: number }> = null

  constructor(private readonly clock: WebOperationsClock) {}

  public async search(input: WebSearchInput, ctx: WebOperationContext): Promise<WebSearchResults> {
    ctx.abortSignal.throwIfAborted()
    const request = searchRequest(input)
    const googleUntil = this.googleBackoff(ctx)
    const failures: WebEngineFailure[] = []
    for (const engine of engineOrder(ctx.web.searchEngine())) {
      const currentUntil = Math.max(googleUntil ?? 0, this.googleBackoffUntil ?? 0)
      if (engine === 'google' && this.googleAttemptRunning) {
        failures.push({ engine, reason: '已有搜索请求正在探测此来源，本次使用另一来源' })
        continue
      }
      if (engine === 'google' && this.clock.now() < currentUntil) {
        failures.push({
          engine,
          reason: `搜索暂缓，约${durationText(currentUntil - this.clock.now())}后可再试`,
        })
        continue
      }
      if (engine === 'google') this.googleAttemptRunning = true
      let attempt: WebEngineAttempt
      try {
        attempt = await this.searchWith(engine, request, ctx)
        if (engine === 'google') this.noteGoogle(attempt, ctx)
      } finally {
        if (engine === 'google') this.googleAttemptRunning = false
      }
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
      const loaded = await this.load(
        page,
        request.url,
        { loadMs: WebTuning.read.loadTimeoutMs, commitMs: null },
        ctx
      )
      if (loaded.kind === 'failed') throw loadFailedError(request.url, loaded.message)
      if (loaded.kind === 'loaded') await this.settle(page, ctx)
      const landed = landedUrl(page.url())
      if (loaded.kind !== 'loaded' && !landed) throw nothingLoadedError(request.url)
      const url = landed ?? request.url
      const scan = await this.readable(page, url, ctx)
      if (isPdfDocument(scan.contentType)) throw pdfPageError(url)
      // 纯文本文件的空白就是内容（缩进、对齐、空行）：原样留着；网页的 innerText 按排版收拾
      const text = isPlainTextDocument(scan.contentType)
        ? plainText(scan.text)
        : readableText(scan.text)
      if (loaded.kind !== 'loaded' && !text) throw nothingLoadedError(request.url)
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

  /**
   * Google 退避到什么时候：进程里记着的与宿主存着的取晚的那个（每次搜索只问宿主一次）；都没有交回 null。
   * 宿主的记忆读不出来只记一笔，照进程里的来。
   */
  private googleBackoff(ctx: WebOperationContext): Nullable<number> {
    let stored: Nullable<number> = null
    try {
      stored = toNullable(ctx.web.engineBackoff?.read('google'))
    } catch (error) {
      log.warn('reading the search engine backoff failed', { error: AppError.getMessage(error) })
    }
    const maximum = this.clock.now() + WebTuning.search.googleBlockedBackoffMs
    if (this.clampedBackoff && stored === this.clampedBackoff.source) {
      stored = this.clampedBackoff.until
    } else if (isPresent(stored) && stored > maximum) {
      // 旧版本或异常时钟写入的超长冷却只收敛一次，仍保留完整的验证页冷却窗口。
      this.clampedBackoff = { source: stored, until: maximum }
      stored = maximum
      try {
        ctx.web.engineBackoff?.write('google', maximum)
      } catch (error) {
        log.warn('收敛搜索来源退避期限失败', { error: AppError.getMessage(error) })
      }
    }
    const known = [this.googleBackoffUntil, stored].filter(isFiniteNumber)
    return isEmpty(known) ? null : Math.max(...known)
  }

  /**
   * 记下这次 Google 搜没搜通：搜通了就忘掉进程里的退避；搜不通就退避一段时间，宿主给了退避记忆也写进去（写不进去只记一笔）。
   */
  private noteGoogle(attempt: WebEngineAttempt, ctx: WebOperationContext): void {
    if (attempt.ok) {
      this.googleBackoffUntil = null
      return
    }
    const until =
      this.clock.now() +
      (attempt.blocked ? WebTuning.search.googleBlockedBackoffMs : WebTuning.search.googleBackoffMs)
    this.googleBackoffUntil = until
    try {
      ctx.web.engineBackoff?.write('google', until)
    } catch (error) {
      log.warn('writing the search engine backoff failed', { error: AppError.getMessage(error) })
    }
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
   * 在开好的页面里搜：装结果页，结果一出现在 DOM 里就抓（抓到了就叫停剩下的加载），没提前抓到就等加载有了结局再抓
   * （到点还没加载完的照抓）；再认验证页、整理结果。认出了结果、或者搜索引擎明说没有结果，算搜通了；否则交回为什么没搜通。
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
    // 只有 Google 限定多久必须落下文档：打不开的时候连接一直挂着，早点换 Bing；落下之后结果页慢慢出来照等
    const commitMs = engine === 'google' ? WebTuning.search.googleCommitMs : null
    const script = engine === 'google' ? GoogleResultsScript : BingResultsScript
    const stop = new AbortController()
    const loading = this.load(
      page,
      searchPageUrl(engine, request.query, request.limit),
      { loadMs: timeoutMs, commitMs, stop: stop.signal },
      ctx
    )
    let early: Nullable<WebSearchScan> = null
    try {
      early = await this.earlyResults(
        page,
        { engine, script, limit: request.limit, deadlineMs: timeoutMs },
        loading,
        ctx
      )
    } finally {
      stop.abort()
    }
    const loaded = await loading
    if (!early) {
      if (loaded.kind === 'failed') return { ok: false, reason: `打不开（${loaded.message}）` }
      if (loaded.kind === 'silent')
        return { ok: false, reason: `${durationText(commitMs ?? timeoutMs)}没有回应` }
      // 到点连一个文档都没落下：不往页面里跑脚本了（对没落下文档的页面跑脚本，宿主那边会一直卡着）
      if (loaded.kind !== 'loaded' && !landedUrl(page.url()))
        return { ok: false, reason: `${durationText(timeoutMs)}没加载出来` }
    }
    const scan = early ?? searchScanOf(await this.evaluate(page, script, ctx))
    const hits = await this.resolveRedirects(
      scan.hits.slice(0, request.limit + WebTuning.search.spareHits),
      ctx
    )
    const results = searchResults(engine, hits, request.limit)
    const blocked = blockedReason(page.url(), scan.text, results.length)
    if (blocked) return { ok: false, reason: blocked, blocked: true }
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
   * 文档落下之后隔一小段看一眼结果页：认出了结果，而且 DOM 已经解析完（readyState 不是 loading）或者条数稳住了一段时间，
   * 就交回这一眼，不等整页加载完。加载有了结局（加载完、到点、没回应、出错）、页面也没在跳走，就交回 null，照加载的结局来；
   * 加载完之后页面又自己跳走的（先落一个过渡页），接着看跳过去的那一页，直到加载时限；落在验证页、同意页上的当场交出去。
   * 一条结果都没有时绝不提前下结论：没搜通只在页面真加载完或到点之后才算。用户取消照样以取消原因失败。
   */
  private async earlyResults(
    page: WebPage,
    look: { engine: WebSearchEngineId; script: string; limit: number; deadlineMs: number },
    loading: Promise<WebLoadOutcome>,
    ctx: WebOperationContext
  ): Promise<Nullable<WebSearchScan>> {
    const started = this.clock.now()
    let settled = false
    const settling = loading.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    let seen = 0
    let steadySince = started
    for (;;) {
      const tick = this.clock.sleep(WebTuning.search.resultsPollMs, ctx.abortSignal)
      await (settled ? tick : Promise.race([settling, tick]))
      const expired = this.clock.now() - started >= look.deadlineMs
      if (settled && (expired || !isNavigating(page))) return null
      if (!landedUrl(page.url())) continue
      const scan = await this.peek(page, look.script, ctx)
      if (!scan) continue
      // 落在验证页、同意页上：不用再等，这一眼交出去，外面认成被拦
      if (blockedAddress(page.url())) return scan
      const found = searchResults(look.engine, scan.hits, look.limit).length
      const now = this.clock.now()
      if (found !== seen) {
        seen = found
        steadySince = now
      }
      const complete = scan.ready !== 'loading'
      if (found > 0 && (complete || now - steadySince >= WebTuning.search.resultsSteadyMs))
        return scan
    }
  }

  /** 加载途中看一眼结果页：限时，看不成（页面正在跳走、宿主要等加载完才跑脚本）只当还没出来；取消照样以取消原因失败。 */
  private async peek(
    page: WebPage,
    script: string,
    ctx: WebOperationContext
  ): Promise<Nullable<WebSearchScan>> {
    try {
      return searchScanOf(await this.evaluate(page, script, ctx, WebTuning.search.peekTimeoutMs))
    } catch (error) {
      ctx.abortSignal.throwIfAborted()
      log.debug('peeking at a search page failed', { error: AppError.getMessage(error) })
      return null
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
   * 装一个地址：限时，随时可取消。加载完交回 loaded；到了加载时限还在加载交回 slow（已经出来的内容照读）；
   * 给了 commitMs 时，到那一刻页面连一个文档都没落下就不再等，交回 silent；给了 stop 并且它触发了（要的已经抓到了）交回 stopped；
   * 宿主报加载出错交回 failed 与宿主的原话；用户取消就以取消原因失败。
   */
  private async load(
    page: WebPage,
    url: string,
    options: { loadMs: number; commitMs: Nullable<number>; stop?: AbortSignal },
    ctx: WebOperationContext
  ): Promise<WebLoadOutcome> {
    const silent = new AbortController()
    const commitCheck = isPresent(options.commitMs) ? this.clock.timeout(options.commitMs) : null
    const checkCommit = (): void => {
      if (!landedUrl(page.url())) silent.abort(new AppError('TIMEOUT', '页面一直没落下文档'))
    }
    commitCheck?.addEventListener('abort', checkCommit, { once: true })
    const deadline = this.clock.timeout(options.loadMs)
    const sources = [ctx.abortSignal, deadline, silent.signal]
    if (options.stop) sources.push(options.stop)
    const signal = AbortSignal.any(sources)
    try {
      await untilAborted(page.load(url, signal), signal)
      return { kind: 'loaded' }
    } catch (error) {
      ctx.abortSignal.throwIfAborted()
      if (options.stop?.aborted) return { kind: 'stopped' }
      if (silent.signal.aborted) return { kind: 'silent' }
      if (deadline.aborted) return { kind: 'slow' }
      log.debug('a hidden page failed to load', { error: AppError.getMessage(error) })
      return { kind: 'failed', message: AppError.getMessage(error) }
    } finally {
      commitCheck?.removeEventListener('abort', checkCommit)
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
   * 等单页应用渲染完：readyState 是 complete、正文长度隔一段时间不变、页面也没在跳走，就算完；有上限，到了也不再等。
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
      // 页面正在跳走（加载完之后又自己跳的）：旧文档的正文再稳也不算，等最后那一页
      if (isNavigating(page) || probe.ready !== 'complete' || probe.length !== last) {
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
