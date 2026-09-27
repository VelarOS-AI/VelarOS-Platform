/**
 * 验收测试与实现测试共用的假对象：一只能快进的假钟、一个按地址给罐头结果的假无头浏览器（开了几页、关了几页、装过哪些地址、
 * 跑过哪些脚本都记下来）、造 Bing 与 Google 结果链接的小工具，以及跑一段模型程序的代码面会话。
 * 页面脚本在真浏览器里认不认得出结果，由 `test/probes/electron-web.probe.mjs` 在真的 Electron 里核对；这里的假页面只认脚本是哪一段，交回写好的东西。
 * 放在 spec 下，因为验收测试依赖它们；实现测试从这里取，不再各抄一份。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { AppError, createTimeoutError } from '@velaros-ai/core/error'
import type { CapabilityOperationContext } from '@velaros-ai/script'
import {
  codeProgramChecker,
  createCapabilityPort,
  createCodeSurfaceSession,
  nodeSubprocessCodeRunner,
} from '@velaros-ai/script'

import { WebOperations, type WebOperationsClock } from '../impl/WebOperations'
import type { WebOperationContext, WebPage, WebSearchEngineId, WebSpacePort } from '../index'
import {
  BingResultsScript,
  GoogleResultsScript,
  ReadableTextScript,
  SettleProbeScript,
} from '../utils/page-scripts'

// ── 假钟 ────────────────────────────────────────────────────────

/** 假钟：现在几点由测试说了算；sleep 不真等，只把时间往前拨；到点的限时信号在拨过去的那一刻触发。 */
export interface FakeClock extends WebOperationsClock {
  /** 把时间往前拨 ms 毫秒，到点的限时信号当场触发。 */
  advance(ms: number): void
}

/** 造一只假钟，从一个固定时刻起走。 */
export function fakeClock(start = Date.UTC(2026, 8, 27)): FakeClock {
  let now = start
  const timers: Array<{ at: number; controller: AbortController }> = []
  const advance = (ms: number): void => {
    now += ms
    for (const timer of timers) {
      if (!timer.controller.signal.aborted && timer.at <= now)
        timer.controller.abort(createTimeoutError('假钟到点了'))
    }
  }
  return {
    now: () => now,
    sleep: async (ms, signal) => {
      signal.throwIfAborted()
      advance(ms)
    },
    timeout: (ms) => {
      const controller = new AbortController()
      timers.push({ at: now + ms, controller })
      return controller.signal
    },
    advance,
  }
}

/** 假页面「加载很慢」「一直没回应」时最多拨过去的时长：比哪个加载时限都长，又远短于 Google 搜不通之后的退避。 */
export const SlowLoadMs = 60_000

/** 假页面加载时拨钟的一小步：操作的各个时限都是它的整数倍，量出来的放手时刻正好落在时限上。 */
const TickMs = 100

// ── 假网页 ──────────────────────────────────────────────────────

/** 一个地址在假浏览器里的样子。 */
export interface FakeSite {
  /**
   * load 的结局：缺省加载完；'slow' 文档落下了、再把假钟拨过所有时限，到点还在加载；
   * 'silent' 连一个文档都没落下、假钟拨过所有时限（像打不开的 Google：连接一直挂着）；
   * 'streaming' 文档马上落下、不拨钟，结果页一边传一边能看（`scans`），到 `finishMs` 才加载完（不给就一直不完，由操作到点撒手）；
   * 'hang' 一直卡着、不拨钟，直到调用方撒手；给一个错误就是宿主报加载出错。
   */
  load?: 'ok' | 'slow' | 'silent' | 'streaming' | 'hang' | Error
  /** 'streaming' 的页面在假钟几毫秒之后加载完（从装地址那一刻算）。 */
  finishMs?: number
  /** 装地址时顺手做的事（比如测试在这里按下取消）。 */
  onLoad?: () => void
  /** 跳转之后落在哪个地址；缺省就是装的那个地址。 */
  landed?: string
  /** 结果页脚本交回什么（Bing、Google 的脚本都交它）。 */
  scan?: unknown
  /** 结果页脚本一次一次看到的东西（加载途中结果一条条传过来），看完了一直重复最后一个；给了它就不用 scan。 */
  scans?: unknown[]
  /** 读正文的脚本交回什么。 */
  readable?: unknown
  /** 每看一眼渲染之前顺手做的事，参数是第几眼（比如测试在这里按下取消）。 */
  onProbe?: (count: number) => void
  /** 页面是不是正在跳走（加载完之后又自己跳的），参数是这一页已经跑过几段脚本；不给就是没在跳。 */
  navigating?: (evaluations: number) => boolean
  /** 等渲染时一眼一眼看到的东西（给一个错误就是那一眼没看成），看完了一直重复最后一眼；缺省是 complete、长度不变。 */
  settle?: Array<{ ready: string; length: number } | Error>
  /** 页面里跑脚本时抛的错。 */
  evaluateError?: Error
  /** 跑脚本一直不回：把假钟拨过去，由操作到点撒手。 */
  evaluateHangs?: boolean
}

/**
 * 假浏览器记下的事：开了几页、关了几页、装过哪些地址（与装的时候假钟几点、'streaming' 的页面被叫停时假钟几点）、跑过哪几段脚本（按名字）、问过哪些跳转链接，
 * 以及退避记忆被读过几次、写进过什么（与写的时候假钟几点）。
 */
export interface FakeBrowserRecord {
  opened: number
  closed: number
  loads: string[]
  loadedAt: number[]
  loadsStoppedAt: number[]
  scripts: string[]
  resolved: string[]
  backoffReads: WebSearchEngineId[]
  backoffWrites: Array<{ engine: WebSearchEngineId; until: number; at: number }>
}

/** 假的退避记忆：存着的值（按搜索引擎）、读或写的时候抛错。 */
export interface FakeBackoff {
  stored?: Partial<Record<WebSearchEngineId, number>>
  readFails?: boolean
  writeFails?: boolean
}

/** 认出是哪一段页面脚本。 */
function scriptName(expression: string): string {
  if (expression === BingResultsScript) return 'bing'
  if (expression === GoogleResultsScript) return 'google'
  if (expression === SettleProbeScript) return 'settle'
  if (expression === ReadableTextScript) return 'readable'
  return 'unknown'
}

/**
 * 'streaming' 的加载：不拨钟，操作自己等的时候钟往前走；到 finishMs 加载完，被撒手（叫停、到点、取消）就以撒手的原因失败，
 * 并记下被叫停的那一刻。
 */
function streamingLoad(
  site: FakeSite,
  clock: FakeClock,
  record: FakeBrowserRecord,
  signal: AbortSignal
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abandon = (): void => {
      record.loadsStoppedAt.push(clock.now())
      reject(signal.reason)
    }
    if (signal.aborted) return abandon()
    signal.addEventListener('abort', abandon, { once: true })
    if (site.finishMs === undefined) return
    clock.timeout(site.finishMs).addEventListener(
      'abort',
      () => {
        signal.removeEventListener('abort', abandon)
        resolve()
      },
      { once: true }
    )
  })
}

/** 一页假页面：按装的地址找到那个站，脚本按名字交回站里写好的东西。 */
function fakePage(
  sites: (url: string) => FakeSite,
  clock: FakeClock,
  record: FakeBrowserRecord
): WebPage {
  let current = 'about:blank'
  let site: FakeSite = {}
  let probes = 0
  let scanned = 0
  let evaluations = 0
  let closed = false
  return {
    load: (url, signal) => {
      record.loads.push(url)
      record.loadedAt.push(clock.now())
      site = sites(url)
      probes = 0
      scanned = 0
      evaluations = 0
      site.onLoad?.()
      const outcome = site.load ?? 'ok'
      if (outcome instanceof Error) return Promise.reject(outcome)
      if (outcome === 'ok' || outcome === 'slow' || outcome === 'streaming')
        current = site.landed ?? url
      if (outcome === 'ok') return Promise.resolve()
      if (outcome === 'streaming') return streamingLoad(site, clock, record, signal)
      // 慢的与没回应的：一小步一小步拨钟，直到操作到点撒手（最多拨过所有时限），量得出操作在哪一刻放手
      for (
        let waited = 0;
        outcome !== 'hang' && !signal.aborted && waited < SlowLoadMs;
        waited += TickMs
      )
        clock.advance(TickMs)
      return new Promise<void>((_, reject) => {
        if (signal.aborted) reject(signal.reason)
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    },
    evaluate: async <T>(expression: string): Promise<T> => {
      if (closed) throw new AppError('CLOSED', '页面已经关了')
      const name = scriptName(expression)
      record.scripts.push(name)
      evaluations += 1
      if (site.evaluateError) throw site.evaluateError
      if (site.evaluateHangs) {
        clock.advance(SlowLoadMs)
        return new Promise<T>(() => {})
      }
      if (name === 'settle') {
        const seen = site.settle ?? [{ ready: 'complete', length: 1 }]
        probes += 1
        site.onProbe?.(probes)
        const probe = seen[Math.min(probes, seen.length) - 1]
        if (probe instanceof Error) throw probe
        return probe as T
      }
      if (name === 'readable')
        return (site.readable ?? { title: '', text: '', contentType: 'text/html' }) as T
      if (name === 'bing' || name === 'google') {
        scanned += 1
        const scans = site.scans ?? [site.scan ?? { hits: [], text: '', noResults: false }]
        return scans[Math.min(scanned, scans.length) - 1] as T
      }
      throw new AppError('VALIDATION', '假页面不认这段脚本')
    },
    url: () => current,
    loading: () => site.navigating?.(evaluations) ?? false,
    close: () => {
      if (closed) return
      closed = true
      record.closed += 1
    },
  }
}

/** 装一个站点表：Google、Bing 的结果页各对一个站，其余地址按原样查表，查不到算宿主报域名解析失败。 */
export function sitesOf(table: {
  google?: FakeSite
  bing?: FakeSite
  pages?: Record<string, FakeSite>
}): (url: string) => FakeSite {
  return (url) => {
    if (url.startsWith('https://www.google.com/search')) return table.google ?? {}
    if (url.startsWith('https://www.bing.com/search')) return table.bing ?? {}
    return table.pages?.[url] ?? { load: new AppError('NETWORK', 'net::ERR_NAME_NOT_RESOLVED') }
  }
}

/**
 * 一个假的无头浏览器空间：用户选的搜索引擎、站点表、假钟都能按用例换；`openGate` 给了就等它放行才开出页面（宿主开页面很慢）。
 * 给了 `redirects` 才有 resolveRedirect 这个口子：按地址查表，查到字符串就是跳去的地址，查到错误就抛，'hang' 把假钟拨过时限、一直不回，查不到交回 null。
 * 给了 `backoff` 才有退避记忆：存着的值、读写抛错都能按用例换，读写都记下来。
 * 交回端口、一份用假钟的操作（Google 搜不通的记忆各用例互不串）、调用上下文、代码面宿主装上下文的写法，以及记下的事。
 */
export function webSpace(options: {
  sites: (url: string) => FakeSite
  engine?: WebSearchEngineId
  clock?: FakeClock
  abortSignal?: AbortSignal
  openGate?: Promise<void>
  redirects?: Record<string, string | Error | 'hang'>
  backoff?: FakeBackoff
}) {
  const clock = options.clock ?? fakeClock()
  const record: FakeBrowserRecord = {
    opened: 0,
    closed: 0,
    loads: [],
    loadedAt: [],
    loadsStoppedAt: [],
    scripts: [],
    resolved: [],
    backoffReads: [],
    backoffWrites: [],
  }
  const port: WebSpacePort = {
    searchEngine: () => options.engine ?? 'google',
    openPage: async () => {
      await options.openGate
      record.opened += 1
      return fakePage(options.sites, clock, record)
    },
  }
  const backoff = options.backoff
  if (backoff) {
    port.engineBackoff = {
      read: (engine) => {
        record.backoffReads.push(engine)
        if (backoff.readFails) throw new AppError('IO', '退避记忆读不出来')
        return backoff.stored?.[engine] ?? null
      },
      write: (engine, until) => {
        record.backoffWrites.push({ engine, until, at: clock.now() })
        if (backoff.writeFails) throw new AppError('IO', '退避记忆写不进去')
      },
    }
  }
  const redirects = options.redirects
  if (redirects) {
    port.resolveRedirect = async (url) => {
      record.resolved.push(url)
      const target = redirects[url]
      if (target instanceof Error) throw target
      if (target !== 'hang') return target ?? null
      clock.advance(SlowLoadMs)
      return new Promise<never>(() => {})
    }
  }
  const operations = new WebOperations(clock)
  const context: WebOperationContext = {
    abortSignal: options.abortSignal ?? new AbortController().signal,
    web: port,
  }
  /** 代码面宿主给每次调用装的上下文：同一个端口，取消信号用这次调用的。 */
  const hostContext = (call: CapabilityOperationContext): WebOperationContext => ({
    abortSignal: call.signal ?? new AbortController().signal,
    web: port,
  })
  return { port, operations, context, hostContext, clock, record }
}

/** 等一个调用失败，交出它的码与说明。 */
export async function failureOf(
  call: Promise<unknown>
): Promise<{ code: string; message: string }> {
  try {
    await call
  } catch (error) {
    const failure = AppError.from(error)
    return { code: failure.code, message: failure.message }
  }
  throw new AppError('ASSERTION', '应当失败，却成功了')
}

// ── 造结果 ──────────────────────────────────────────────────────

/** Bing 的跳转链接：u 参数是「a1」接上目标地址的 base64url。 */
export function bingLink(target: string): string {
  return `https://www.bing.com/ck/a?!&&p=abc123&u=a1${Buffer.from(target, 'utf8').toString('base64url')}&ntb=1`
}

/** Google 老式的跳转链接：/url?q= 带着目标地址。 */
export function googleLink(target: string): string {
  return `https://www.google.com/url?q=${encodeURIComponent(target)}&sa=U&ved=2ahUKE`
}

/** Google 现在的跳转链接：/goto?url= 带一串本地解不开的令牌，要问一次 Google 才知道跳去哪。 */
export function googleGoto(token: string): string {
  return `https://www.google.com/goto?url=CAES${token}`
}

/** 一页结果页脚本交回的东西：几条原始结果，正文开头缺省是空的，文档缺省已经加载完。 */
export function scanOf(
  hits: Array<{ title: string; href: string; snippet?: string }>,
  extra: { text?: string; noResults?: boolean; ready?: string } = {}
) {
  return {
    hits: hits.map((hit) => ({ snippet: '', ...hit })),
    text: extra.text ?? '',
    noResults: extra.noResults ?? false,
    ready: extra.ready ?? 'complete',
  }
}

// ── 代码面 ──────────────────────────────────────────────────────

/** 模型这一轮读到的 `velaros:web` 声明：就是提交进仓的那份生成物；程序照它核对 import，代码模版照它过类型检查。 */
export const WebDeclarations = readFileSync(
  fileURLToPath(new URL('../../../../baselines/script/web.d.ts', import.meta.url)),
  'utf8'
)

/** 这一轮授给程序的模块：只有 `web` 一个命名空间。 */
const Granted = [{ namespace: 'web', declarations: WebDeclarations }]

/** 代码模版照生成的声明做完整类型检查、不执行：交回诊断，过了就是空的。模型交的程序只查语法，不走这里。 */
export function typecheckTemplate(source: string) {
  const checked = codeProgramChecker.typecheck({ source, granted: Granted })
  return checked.ok ? [] : checked.diagnostics
}

/**
 * 让一段真程序过语法检查，再在隔离里跑完。能力端口由一张只有 `web.search`、`web.read` 的操作表接出来，
 * 每次调用经 `hostContext` 装一份 `WebOperationContext`；交出程序的结果。
 */
export async function runModelProgram(
  space: ReturnType<typeof webSpace>,
  source: string,
  timeoutMs = 30_000
) {
  const capabilities = createCapabilityPort({
    web: {
      search: async (input, context) => space.operations.search(input, space.hostContext(context)),
      read: async (input, context) => space.operations.read(input, space.hostContext(context)),
    },
  })
  const session = createCodeSurfaceSession({
    checker: codeProgramChecker,
    runner: nodeSubprocessCodeRunner,
    capabilities,
  })
  const outcome = await session.submit({ program: { source }, granted: Granted, timeoutMs })
  if (!outcome.checked) {
    const why =
      'needsModules' in outcome
        ? `要先补模块 ${outcome.needsModules.join(', ')}`
        : JSON.stringify(outcome.check.diagnostics)
    throw new AppError('ASSERTION', `程序没过检查：${why}`)
  }
  return outcome.result
}
