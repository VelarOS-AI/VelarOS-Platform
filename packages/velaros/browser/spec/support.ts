/**
 * 验收测试与实现测试共用的夹具：
 * - 一份空间端口替身：记下操作调了端口的哪些方法、带了什么参数，按固定的一页假页面回答（标题、正文、表单、框架、诊断……）；
 *   页面脚本按脚本里的特征认出来、交回对应的 JSON（表格行、搜索结果、下拉框的值、元素位置……），别的求值交回页面标题。
 *   模型的 CDP 会话是一张事件表：命令按方法名交回固定结果，Page.reload、Runtime.evaluate 这类会往表里推它们会引出的事件。
 * - 经真的能力端口挂上 `velaros:browser`、`velaros:devtools` 与 `velaros:cdp` 的空间，以及照生成的声明跑一段模型程序的代码面会话。
 * 放在 spec 下，因为验收测试依赖它们；实现测试也从这里取。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { AppError } from '@velaros-ai/core/error'
import type { CapabilityOperationContext } from '@velaros-ai/script'
import {
  codeProgramChecker,
  createCapabilityPort,
  createCodeSurfaceSession,
  nodeSubprocessCodeRunner,
} from '@velaros-ai/script'
import type { ImageAttachment } from '@velaros-ai/velaros/images'

import type {
  BrowserMouseButton,
  BrowserOperationContext,
  BrowserProtocolEvent,
  BrowserScriptOutcome,
  BrowserSiteContext,
  BrowserSpacePort,
} from '../index.js'
import { browserOperations, cdpOperations, devtoolsOperations } from '../index.js'

/** 端口上的一次调用：方法名与参数。 */
export interface PortCall {
  method: string
  args: unknown[]
}

/** 一份空间端口替身与它的调用记录。 */
export interface BrowserHarness {
  context: BrowserOperationContext
  port: BrowserSpacePort
  calls: PortCall[]
  attached: ImageAttachment[]
  /** 端口上被调过的方法名（按顺序、不去重）。 */
  methods(): string[]
}

/** 替身的站点：进站之后就是它。 */
export const HarnessSite: BrowserSiteContext = {
  url: 'https://example.com/',
  workspaceRoot: '/tmp/velaros-browser-site/example.com',
}

const page = {
  url: 'https://example.com/',
  title: 'Example Domain',
  loadState: 'loaded' as const,
  viewport: null,
  lastNavigationError: null,
}
const target = (css: string) => ({
  ref: '@e1:g1',
  css,
  role: null,
  text: null,
  name: null,
  attributes: {},
})

/** 页面脚本交回什么：按脚本里的特征认出是哪一种读法，交回那一页假页面上的结果。 */
function pageScriptValue(script: string, args: unknown[]): unknown {
  if (script.includes('row.cells')) return [['华北', '1200']]
  if (script.includes("'.result').length > 0")) return true
  if (script.includes("'.result a')].map") || script.includes("'.result')].map"))
    return [{ title: '第一条', href: 'https://example.com/1' }]
  if (script.includes('a[rel=next]')) return false
  if (script.includes('select[name=country]')) return args[0]
  if (script.includes("includes('提交成功')")) return true
  if (script.includes("querySelector('.result a')?.href !== previous")) return true
  if (script.includes('getBoundingClientRect')) return { x: 100, y: 200 }
  if (script.includes('innerText.slice(0, 2000)')) return 'iframe 里的正文'
  return page.title
}

/** 模型 CDP 会话里一条命令的固定结果，与它会引出的事件。 */
function protocolReply(
  method: string,
  fetchEnabled: boolean
): { result: unknown; events: Array<{ method: string; params: unknown }> } {
  if (method === 'Network.getCookies')
    return {
      result: { cookies: [{ name: 'sid', domain: 'example.com', httpOnly: true }] },
      events: [],
    }
  if (method === 'Page.addScriptToEvaluateOnNewDocument')
    return { result: { identifier: 'script-1' }, events: [] }
  if (method === 'Runtime.evaluate')
    return {
      result: { result: { type: 'undefined' } },
      events: [
        {
          method: 'Network.requestWillBeSent',
          params: {
            requestId: 'r1',
            request: { method: 'GET', url: 'https://example.com/api/more' },
          },
        },
        { method: 'Network.loadingFinished', params: { requestId: 'r1' } },
      ],
    }
  if (method === 'Page.reload' && fetchEnabled)
    return {
      result: {},
      events: [
        {
          method: 'Fetch.requestPaused',
          params: {
            requestId: 'paused-1',
            request: { method: 'GET', url: 'https://example.com/api/profile' },
          },
        },
      ],
    }
  return { result: {}, events: [] }
}

/**
 * 造一份空间端口替身。`open` 为假时替身报告「还没进站点」，直到 enterSite 被调用。
 * `attach` 为假时上下文里没有交图通道。
 */
export function createHarness(options: { open?: boolean; attach?: boolean } = {}): BrowserHarness {
  const calls: PortCall[] = []
  const attached: ImageAttachment[] = []
  let active = options.open !== false
  const record = (method: string, args: unknown[]) => calls.push({ method, args })
  const pending = {
    id: 'download-1',
    kind: 'download' as const,
    createdAt: 1,
    details: { filename: 'report.pdf' },
  }
  const userScript = {
    id: 'script-1',
    name: '隐藏订阅弹窗',
    version: '1.0.0',
    revision: 1,
    position: 0,
    match: ['https://example.com/*'],
    runAt: 'document-end' as const,
    world: 'isolated' as const,
    enabled: false,
    source: 'agent' as const,
    relativePath: 'user-scripts/script-1.js',
    createdAt: 1,
    updatedAt: 1,
  }
  const overview = {
    browserContext: HarnessSite,
    globalEnabled: true,
    scripts: [userScript],
    matchedScriptIds: ['script-1'],
  }
  const inputState = { held: new Set<string>(), buttons: new Set<BrowserMouseButton>(), x: 0, y: 0 }
  const mouse = () => ({
    url: page.url,
    x: inputState.x,
    y: inputState.y,
    buttons: [...inputState.buttons],
  })
  const protocol = { events: [] as BrowserProtocolEvent[], lastSeq: 0, fetchEnabled: false }
  const pushProtocolEvent = (method: string, params: unknown) => {
    protocol.lastSeq += 1
    protocol.events.push({ seq: protocol.lastSeq, method, params, session: null })
  }
  const outcome = (value: unknown): BrowserScriptOutcome => ({
    url: page.url,
    ok: true,
    json: JSON.stringify(value),
  })
  const port: BrowserSpacePort = {
    isActive: () => active,
    getContext: () => (active ? HarnessSite : null),
    enterSite: async (url) => {
      record('enterSite', [url])
      active = true
      return HarnessSite
    },
    leaveSite: async () => {
      record('leaveSite', [])
      active = false
    },
    showPage: async () => {
      record('showPage', [])
      return {
        active: true,
        visible: true,
        driverKind: 'webview',
        url: page.url,
        title: page.title,
        canGoBack: false,
        canGoForward: false,
        viewport: null,
      }
    },
    inspectPage: async (input) => {
      record('inspectPage', [input])
      return {
        url: page.url,
        title: page.title,
        metaDescription: null,
        text: 'Example Domain 正文',
        textTruncated: false,
        headings: [{ level: 1, text: 'Example Domain' }],
        links: [
          {
            text: 'More information',
            href: 'https://www.iana.org/domains/example',
            target: target('a'),
          },
        ],
        actions: [{ text: '登录', role: 'button', target: target('button.login') }],
        formFields: [
          {
            label: '搜索',
            type: 'search',
            name: 'q',
            placeholder: null,
            required: false,
            target: target('input[name=q]'),
          },
          {
            label: '邮箱',
            type: 'email',
            name: 'email',
            placeholder: null,
            required: true,
            target: target('input[name=email]'),
          },
          {
            label: '姓名',
            type: 'text',
            name: 'name',
            placeholder: null,
            required: false,
            target: target('input[name=name]'),
          },
        ],
        capturedAt: 1,
      }
    },
    captureScreenshot: async (input) => {
      record('captureScreenshot', [input])
      return {
        url: page.url,
        path: `${HarnessSite.workspaceRoot}/screenshots/shot.png`,
        relativePath: 'screenshots/shot.png',
        width: 1280,
        height: 800,
        bytes: 1000,
        capturedAt: 1,
        metadata: {
          viewportWidth: 1280,
          viewportHeight: 800,
          scrollX: 0,
          scrollY: 0,
          documentWidth: 1280,
          documentHeight: 800,
          deviceScaleFactor: 1,
          zoomFactor: 1,
          cursor: null,
          elementLabels: [],
          elementLegend: [
            {
              index: 1,
              label: '1',
              role: 'button',
              text: '登录',
              selector: 'button.login',
              description: '按钮「登录」',
              target: target('button.login'),
            },
          ],
          stability: null,
          recentEvents: [],
          login: {
            requiresLogin: false,
            confidence: 0,
            reason: '',
            signals: [],
            passwordInputs: 0,
            usernameInputs: 0,
            loginButtons: 0,
            loginLinks: 0,
            forms: 0,
          },
        },
        modelImage: input?.includeModelImage
          ? {
              data: 'aW1hZ2U=',
              mediaType: 'image/jpeg',
              width: 640,
              height: 400,
              bytes: 6,
              sourceWidth: 1280,
              sourceHeight: 800,
              scale: 0.5,
              quality: 72,
            }
          : undefined,
      }
    },
    performTargetAction: async (input) => {
      record('performTargetAction', [input])
      return {
        action: input.action,
        url: page.url,
        matched: true,
        selector: input.target.css,
        text: null,
        capturedAt: 1,
      }
    },
    navigatePage: async (options) => {
      record('navigatePage', [options])
      return {
        action: options.action,
        navigated: true,
        url: options.url ?? page.url,
        title: page.title,
        canGoBack: true,
        canGoForward: false,
        capturedAt: 1,
      }
    },
    getPageDiagnostics: async (input) => {
      record('getPageDiagnostics', [input])
      const all = [
        {
          kind: 'console' as const,
          level: 'error' as const,
          message: 'TypeError: boom',
          url: page.url,
          line: 1,
          column: 1,
          code: null,
          capturedAt: 1,
        },
        {
          kind: 'network' as const,
          level: 'error' as const,
          message: 'GET /api/profile 500',
          url: 'https://example.com/api/profile',
          line: null,
          column: null,
          code: 500,
          capturedAt: 1,
          details: { requestId: 'req-1', status: 500, failed: true, resourceType: 'fetch' },
        },
      ]
      const entries = input?.kinds ? all.filter((entry) => input.kinds!.includes(entry.kind)) : all
      return {
        url: page.url,
        title: page.title,
        entries,
        summary: {
          total: 2,
          byLevel: {},
          byKind: {},
          byOrigin: {},
          byStatus: {},
          byResourceType: {},
        },
        capturedAt: 1,
      }
    },
    insertText: async (options) => {
      record('insertText', [options])
      return { url: page.url, textLength: options.text.length, capturedAt: 1 }
    },
    pressKey: async (options) => {
      record('pressKey', [options])
      return { url: page.url, key: options.key, repeat: options.repeat ?? 1, capturedAt: 1 }
    },
    keyDown: async (key) => {
      record('keyDown', [key])
      inputState.held.add(key.key)
      return { url: page.url, key: key.key, held: [...inputState.held] }
    },
    keyUp: async (key) => {
      record('keyUp', [key])
      inputState.held.delete(key.key)
      return { url: page.url, key: key.key, held: [...inputState.held] }
    },
    moveMouse: async (move) => {
      record('moveMouse', [move])
      inputState.x = move.x
      inputState.y = move.y
      return mouse()
    },
    mouseDown: async (press) => {
      record('mouseDown', [press])
      inputState.buttons.add(press.button ?? 'left')
      return mouse()
    },
    mouseUp: async (release) => {
      record('mouseUp', [release])
      inputState.buttons.delete(release.button ?? 'left')
      return mouse()
    },
    mouseWheel: async (delta) => {
      record('mouseWheel', [delta])
      return mouse()
    },
    clickCoordinates: async (click) => {
      record('clickCoordinates', [click])
      inputState.x = click.x
      inputState.y = click.y
      return {
        url: page.url,
        x: click.x,
        y: click.y,
        button: click.button ?? 'left',
        clickCount: click.clickCount ?? 1,
        capturedAt: 1,
      }
    },
    dragTargets: async (input) => {
      record('dragTargets', [input])
      const end = { matched: true, selector: null, text: null, point: { x: 1, y: 1 } }
      return {
        url: page.url,
        matched: true,
        source: end,
        target: end,
        startX: 1,
        startY: 1,
        endX: 2,
        endY: 2,
        steps: input.steps ?? 1,
        failureReason: null,
        capturedAt: 1,
      }
    },
    waitForPage: async (input) => {
      record('waitForPage', [input])
      return {
        url: page.url,
        loadState: 'complete',
        requestedLoadState: input.loadState ?? null,
        matched: true,
        timeoutMs: input.timeoutMs ?? 0,
        elapsedMs: 1,
        timedOut: false,
        capturedAt: 1,
      }
    },
    setPageZoom: async (input) => {
      record('setPageZoom', [input])
      return {
        url: page.url,
        zoomFactor: input.zoomFactor ?? 1,
        previousZoomFactor: 1,
        capturedAt: 1,
      }
    },
    configureNetwork: async (input) => {
      record('configureNetwork', [input])
      return {
        url: page.url,
        offline: !!input.offline,
        extraHTTPHeaders: input.extraHTTPHeaders ?? {},
        blockedURLPatterns: input.blockedURLPatterns ?? [],
        blockedResourceTypes: input.blockedResourceTypes ?? [],
        mockResponses: input.mockResponses ?? [],
        capturedAt: 1,
      }
    },
    readNetworkRequestDetails: async (input) => {
      record('readNetworkRequestDetails', [input])
      return {
        url: page.url,
        requestId: input.requestId,
        request: {
          method: 'GET',
          url: 'https://example.com/api/profile',
          headers: {},
          resourceType: 'fetch',
          timestamp: null,
          wallTime: null,
        },
        response: {
          status: 500,
          statusText: 'Internal Server Error',
          headers: {},
          mimeType: 'application/json',
          protocol: 'h2',
          fromDiskCache: false,
          fromServiceWorker: false,
          encodedDataLength: 20,
          remoteIPAddress: null,
          remotePort: null,
          timing: null,
        },
        failure: null,
        durationMs: 12,
        responseBody: input.includeResponseBody
          ? {
              body: '{"error":"boom"}',
              base64Encoded: false,
              bodyLength: 16,
              returnedChars: 16,
              bodyTruncated: false,
            }
          : undefined,
        capturedAt: 1,
      }
    },
    startPerformanceTrace: async (input) => {
      record('startPerformanceTrace', [input])
      if (input.autoStopMs === null)
        return { status: 'recording', url: page.url, startedAt: 1, note: '录到 stopTrace 为止' }
      return {
        status: 'completed',
        url: page.url,
        keyMetrics: 'NAVIGATION_0: LCP 258 ms, CLS 0.00',
        summary: '摘要',
        insightSetIds: ['NAVIGATION_0'],
        rawTracePath: '/tmp/trace.json.gz',
        rawTraceRelativePath: 'artifacts/performance/trace.json.gz',
        durationMs: 5000,
        capturedAt: 1,
      }
    },
    stopPerformanceTrace: async () => {
      record('stopPerformanceTrace', [])
      return {
        url: page.url,
        keyMetrics: 'NAVIGATION_0: LCP 258 ms',
        summary: '摘要',
        insightSetIds: ['NAVIGATION_0'],
        rawTracePath: '/tmp/trace.json.gz',
        rawTraceRelativePath: 'artifacts/performance/trace.json.gz',
        durationMs: 5000,
        capturedAt: 1,
      }
    },
    analyzePerformanceInsight: async (input) => {
      record('analyzePerformanceInsight', [input])
      return {
        insightSetId: input.insightSetId,
        insightName: input.insightName,
        output: 'LCP 分解：TTFB 40 ms',
        capturedAt: 1,
      }
    },
    captureHeapSnapshot: async (input) => {
      record('captureHeapSnapshot', [input])
      return {
        url: page.url,
        path: '/tmp/heap.heapsnapshot',
        relativePath: input?.path ?? 'artifacts/memory/heap.heapsnapshot',
        bytes: 100,
        capturedAt: 1,
      }
    },
    startScreencast: async (input) => {
      record('startScreencast', [input])
      return { url: page.url, status: 'recording', startedAt: 1, note: 'stopRecording 结束' }
    },
    stopScreencast: async (input) => {
      record('stopScreencast', [input])
      return {
        url: page.url,
        path: '/tmp/flow.gif',
        relativePath: `artifacts/recordings/${input?.name ?? 'flow'}.gif`,
        frameCount: 12,
        durationMs: 1000,
        bytes: 100,
        frameLimitReached: false,
        capturedAt: 1,
      }
    },
    listPendingEvents: async () => {
      record('listPendingEvents', [])
      return { pending: [pending], capturedAt: 1 }
    },
    listPageTargets: async () => {
      record('listPageTargets', [])
      return {
        driverKind: 'webview',
        activeTargetId: 'page-1',
        targets: [{ id: 'page-1', type: 'page', url: page.url, title: page.title, active: true }],
        capturedAt: 1,
      }
    },
    switchPageTarget: async (input) => {
      record('switchPageTarget', [input])
      const info = {
        id: input.targetId,
        type: 'page' as const,
        url: page.url,
        title: page.title,
        active: true,
      }
      return {
        driverKind: 'external',
        activeTargetId: input.targetId,
        target: info,
        targets: [info],
        url: page.url,
        title: page.title,
        capturedAt: 1,
      }
    },
    handleDialog: async (input) => {
      record('handleDialog', [input])
      return {
        handled: true,
        eventId: input.eventId ?? 'dialog-1',
        accept: input.accept,
        promptText: input.promptText ?? '',
      }
    },
    handleDownload: async (input) => {
      record('handleDownload', [input])
      return {
        handled: true,
        eventId: input.eventId ?? pending.id,
        action: input.action,
        savePath: input.savePath ?? null,
        state: input.action === 'accept' ? 'completed' : 'cancelled',
      }
    },
    handlePermission: async (input) => {
      record('handlePermission', [input])
      return { handled: true, eventId: input.eventId ?? 'permission-1', granted: input.grant }
    },
    uploadFile: async (input) => {
      record('uploadFile', [input])
      return { matched: true, selector: input.target.css, files: [input.filePath], capturedAt: 1 }
    },
    fetchResource: async (input) => {
      record('fetchResource', [input])
      return {
        url: input.url,
        path: `${HarnessSite.workspaceRoot}/${input.savePath}`,
        relativePath: input.savePath,
        mimeType: 'image/png',
        bytes: 100,
        status: 200,
        capturedAt: 1,
      }
    },
    exportPagePdf: async (input) => {
      record('exportPagePdf', [input])
      return {
        url: page.url,
        path: '/tmp/page.pdf',
        relativePath: input?.savePath ?? 'exports/page.pdf',
        bytes: 100,
        capturedAt: 1,
      }
    },
    listFrames: async () => {
      record('listFrames', [])
      return [
        { id: '1', parentId: null, url: page.url, name: '', crossOrigin: false },
        {
          id: '2',
          parentId: '1',
          url: 'https://pay.example.net/checkout',
          name: 'pay',
          crossOrigin: true,
        },
      ]
    },
    evaluateScript: async (options) => {
      record('evaluateScript', [options])
      // 两种失败：脚本里写 __throws__ 就当页面抛了错，写 __huge__ 就当结果超了上限。
      if (options.script.includes('__throws__'))
        return {
          url: page.url,
          ok: false,
          error: {
            name: 'TypeError',
            message: "Cannot read properties of null (reading 'innerText')",
            line: 2,
            column: 7,
          },
        }
      if (options.script.includes('__huge__'))
        return { url: page.url, ok: false, tooLargeChars: options.maxResultChars + 1 }
      return outcome(pageScriptValue(options.script, options.args ?? []))
    },
    sendProtocolCommand: async (command) => {
      record('sendProtocolCommand', [command])
      if (command.method === 'Fetch.enable') protocol.fetchEnabled = true
      if (command.method === 'Fetch.disable') protocol.fetchEnabled = false
      const reply = protocolReply(command.method, protocol.fetchEnabled)
      for (const event of reply.events) pushProtocolEvent(event.method, event.params)
      return reply.result
    },
    readProtocolEvents: async (query) => {
      record('readProtocolEvents', [query])
      const matches = (method: string) =>
        !query.method ||
        (query.method.endsWith('.') ? method.startsWith(query.method) : method === query.method)
      return {
        events: protocol.events.filter(
          (event) => event.seq > (query.after ?? 0) && matches(event.method)
        ),
        last: protocol.lastSeq,
        dropped: 0,
      }
    },
    resetProtocolSession: async () => {
      record('resetProtocolSession', [])
      protocol.events = []
      protocol.fetchEnabled = false
    },
    getPageState: async () => {
      record('getPageState', [])
      return page
    },
    manageUserScripts: async (request) => {
      record('manageUserScripts', [request])
      if (request.action === 'create')
        return {
          overview,
          script: { ...userScript, name: request.script.name, enabled: !!request.script.enabled },
        }
      if (request.action === 'read')
        return { overview, script: userScript, code: "console.info('hi')" }
      return { overview, script: userScript }
    },
  }
  const context: BrowserOperationContext = {
    abortSignal: new AbortController().signal,
    browser: port,
  }
  if (options.attach !== false) context.attachImage = (image) => attached.push(image)
  return { context, port, calls, attached, methods: () => calls.map((call) => call.method) }
}

/** 一个挂着 `velaros:browser`、`velaros:devtools` 与 `velaros:cdp` 的空间：经真的能力端口调三件能力，取消信号跟着每次调用，图经代码面的 attach 交出去。 */
export function browserSpace(harness: BrowserHarness) {
  const hostContext = (call: CapabilityOperationContext): BrowserOperationContext => {
    const scoped: BrowserOperationContext = {
      ...harness.context,
      abortSignal: call.signal ?? new AbortController().signal,
    }
    if (harness.context.attachImage) {
      scoped.attachImage = (image) => {
        harness.context.attachImage?.(image)
        call.attach({ type: 'image-data', ...image })
      }
    }
    return scoped
  }
  const table = (operations: object) =>
    Object.fromEntries(
      Object.getOwnPropertyNames(Object.getPrototypeOf(operations))
        .filter((name) => name !== 'constructor')
        .map((name) => {
          const method = (operations as Record<string, (...args: unknown[]) => Promise<unknown>>)[
            name
          ]!.bind(operations)
          // 没有入参的操作（leave、state、back……）只收上下文。
          return [
            name,
            (input: unknown, call: CapabilityOperationContext) =>
              method.length === 1 ? method(hostContext(call)) : method(input, hostContext(call)),
          ]
        })
    )
  const capabilities = createCapabilityPort({
    browser: table(browserOperations),
    devtools: table(devtoolsOperations),
    cdp: table(cdpOperations),
  })
  /** 像模型的程序那样调一次：成功交回返回值，失败抛带 code 的错误。入参与返回值都过一遍 JSON。 */
  const call = async (
    namespace: 'browser' | 'devtools' | 'cdp',
    operation: string,
    input?: unknown
  ): Promise<any> => {
    const outcome = await capabilities.invoke({
      namespace,
      operation,
      input: input === undefined ? undefined : JSON.parse(JSON.stringify(input)),
    })
    if (outcome.error)
      throw Object.assign(new Error(outcome.error.message), { code: outcome.error.code })
    return outcome.value === undefined ? undefined : JSON.parse(JSON.stringify(outcome.value))
  }
  return { capabilities, call }
}

/** 等一个调用失败，交出它的码与说明。 */
export async function failureOf(
  call: Promise<unknown>
): Promise<{ code: string; message: string }> {
  try {
    await call
  } catch (error) {
    const failure = error as { code?: string; message?: string }
    return {
      code: failure.code ?? AppError.from(error).code,
      message: failure.message ?? String(error),
    }
  }
  throw new Error('应当失败，却成功了')
}

// ── 代码面 ──────────────────────────────────────────────────────

/** 模型读到的 `velaros:browser` 声明：就是提交进仓的那份生成物。 */
export const BrowserDeclarations = readFileSync(
  fileURLToPath(new URL('../../../../baselines/script/browser.d.ts', import.meta.url)),
  'utf8'
)
/** 模型读到的 `velaros:devtools` 声明。 */
export const DevtoolsDeclarations = readFileSync(
  fileURLToPath(new URL('../../../../baselines/script/devtools.d.ts', import.meta.url)),
  'utf8'
)
/** 模型读到的 `velaros:cdp` 声明。 */
export const CdpDeclarations = readFileSync(
  fileURLToPath(new URL('../../../../baselines/script/cdp.d.ts', import.meta.url)),
  'utf8'
)

/** 这一轮授给程序的模块：browser、devtools 与 cdp。 */
const Granted = [
  { namespace: 'browser', declarations: BrowserDeclarations },
  { namespace: 'devtools', declarations: DevtoolsDeclarations },
  { namespace: 'cdp', declarations: CdpDeclarations },
]

/** 只照生成的声明做 typecheck、不执行：交回诊断，过了就是空的。 */
export function checkModelProgram(source: string) {
  const checked = codeProgramChecker.check({ source, granted: Granted })
  return checked.ok ? [] : checked.diagnostics
}

/** 让一段真程序照生成的声明过 typecheck，再在隔离里跑完：交出程序的结果与交出去的图。 */
export async function runModelProgram(
  space: ReturnType<typeof browserSpace>,
  source: string,
  timeoutMs = 60_000
) {
  const session = createCodeSurfaceSession({
    checker: codeProgramChecker,
    runner: nodeSubprocessCodeRunner,
    capabilities: space.capabilities,
  })
  const outcome = await session.submit({ program: { source }, granted: Granted, timeoutMs })
  if (!outcome.checked) {
    const why =
      'needsModules' in outcome
        ? `要先补模块 ${outcome.needsModules.join(', ')}`
        : JSON.stringify(outcome.check.diagnostics)
    throw new Error(`程序没过 typecheck：${why}`)
  }
  return outcome.result
}
