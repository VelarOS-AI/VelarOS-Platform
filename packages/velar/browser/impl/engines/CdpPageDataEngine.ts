import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { isFalse, isFiniteNumber, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { Log } from '@velaros-ai/core/logger'

import { BrowserFetchLimits } from '../../contract/constants'
import type { BrowserEvaluateScriptOptions, BrowserExportPagePdfOptions, BrowserExportPagePdfResult, BrowserFetchResourceOptions, BrowserFetchResourceResult, BrowserFrameInfo, BrowserInspectPageOptions, BrowserNetworkControlOptions, BrowserNetworkControlResult, BrowserNetworkRequestDetailsOptions, BrowserNetworkRequestDetailsResult, BrowserNetworkResponseBodyOptions, BrowserNetworkResponseBodyResult, BrowserPageDiagnostics, BrowserPageDiagnosticsOptions, BrowserPageInspection, BrowserPageWaitOptions, BrowserPageWaitResult, BrowserScriptOutcome, BrowserSiteContext, BrowserUploadFileOptions, BrowserUploadFileResult } from '../../types/browser.js'
import type {
  BrowserPageDriverState,
} from '../../types/driver'
import type { BrowserDiagnosticsLimits,BrowserPageDriverKernel, ExternalBrowserPageSession } from '../../types/runtime.js'
import { normalizeFetchResourceUrl, resolveUploadFilePath } from '../../utils/cdp/page-data'
import { summarizePageDiagnostics } from '../../utils/cdp/page-data'
import { clampInteger } from '../../utils/numbers.js'
import { buildEvaluateScript } from '../../utils/page-scripts/evaluate'
import { buildResolveFileInputScript } from '../../utils/page-scripts/file-upload'
import { buildInspectionScript } from '../../utils/page-scripts/inspection'
import { buildPageWaitScript } from '../../utils/page-scripts/page-wait'
import { BrowserTuning } from '../../utils/tuning'
import { resolveExternalPageUrl } from '../../utils/url.js'
import { resolveWorkspaceFilePath } from '../../utils/workspace-paths.js'
import type { BrowserTargetRefStore } from '../session/BrowserTargetRefStore'

/**
 * 页面数据域执行体的 host 无关外部核（走 CDP driver）。
 *
 * 承载页面检查/脚本评估/框架/下载/诊断摘要/上传/PDF/等加载的 external 分支与全部纯计算助手，
 * 以及嵌入/外部共用的 driver 多态方法（网络控制/响应体/请求详情）。Electron 宿主的 `BrowserPageDataEngine` 继承本类补 embedded 分支。
 *
 * 方法默认在 runtime 的 actionQueue 内被调用。
 */
export interface CdpPageDataEngineApi {
  /** 读页面：正文、标题结构、链接、可交互元素与它们的 ref。 */
  inspectPage(sessionId: string, _context: BrowserSiteContext, options?: BrowserInspectPageOptions, _abortSignal?: AbortSignal): Promise<BrowserPageInspection>
  /** 在页面上下文里跑一段受控脚本并取回结果。 */
  evaluateScript(sessionId: string, context: BrowserSiteContext, options: BrowserEvaluateScriptOptions, _abortSignal?: AbortSignal): Promise<BrowserScriptOutcome>
  /** 列出页面的框架树（顶层页面与各层 iframe）。 */
  listFrames(sessionId: string, context: BrowserSiteContext, abortSignal?: AbortSignal): Promise<BrowserFrameInfo[]>
  /** 带页面会话的 cookie 下载一个 http(s) 资源到站点工作区。 */
  fetchResource(sessionId: string, context: BrowserSiteContext, options: BrowserFetchResourceOptions, _abortSignal?: AbortSignal): Promise<BrowserFetchResourceResult>
  /** 读最近的 console、加载错误与网络诊断，并给一份汇总。 */
  getPageDiagnostics(sessionId: string, context: BrowserSiteContext, options?: BrowserPageDiagnosticsOptions, _abortSignal?: AbortSignal): Promise<BrowserPageDiagnostics>
  /** 把站点工作区里的文件放进页面的 file input。 */
  uploadFile(sessionId: string, context: BrowserSiteContext, options: BrowserUploadFileOptions, _abortSignal?: AbortSignal): Promise<BrowserUploadFileResult>
  /** 把当前页面导出成 PDF 存进站点工作区。 */
  exportPagePdf(sessionId: string, context: BrowserSiteContext, options?: BrowserExportPagePdfOptions, _abortSignal?: AbortSignal): Promise<BrowserExportPagePdfResult>
  /** 配置页面网络：离线、请求头、拦截与 mock。 */
  configureNetwork(sessionId: string, context: BrowserSiteContext, options: BrowserNetworkControlOptions, abortSignal?: AbortSignal): Promise<BrowserNetworkControlResult>
  /** 按 requestId 读响应体；不在缓存里就如实回报读不到。 */
  readNetworkResponseBody(sessionId: string, context: BrowserSiteContext, options: BrowserNetworkResponseBodyOptions, abortSignal?: AbortSignal): Promise<BrowserNetworkResponseBodyResult>
  /** 按 requestId 读请求、响应与 timing 详情。 */
  readNetworkRequestDetails(sessionId: string, context: BrowserSiteContext, options: BrowserNetworkRequestDetailsOptions, abortSignal?: AbortSignal): Promise<BrowserNetworkRequestDetailsResult>
  /** 等页面加载状态稳定，或等一小段时间。 */
  waitForPage(sessionId: string, context: BrowserSiteContext, options: BrowserPageWaitOptions, _abortSignal?: AbortSignal): Promise<BrowserPageWaitResult>
}

export class CdpPageDataEngine implements CdpPageDataEngineApi {
  protected readonly log = Log.tag('BrowserPageDataEngine')

  constructor(
    protected readonly kernel: BrowserPageDriverKernel,
    protected readonly targetRefs: BrowserTargetRefStore,
    protected readonly diagnosticsLimits: BrowserDiagnosticsLimits
  ) {}

  // ---- kernel 桥接 ----
  // 这些 protected 一行方法是 runtime 拆分期的搬运脚手架（“方法体零改写”地平移进 engine）。
  // 现在拆分已定形，它们的**退场条件**是：把 engine 内的调用点直接改成 `this.kernel.X(...)`，
  // 然后整段删除。在那之前别逐个删——半删会让同一个 engine 里两种取会话写法并存（§0.1 条 2）。
  protected getExternalPageSession(sessionId: string): Nullable<ExternalBrowserPageSession> {
    return this.kernel.getExternalPageSession(sessionId)
  }

  protected refreshExternalPageState(
    sessionId: string,
    session: ExternalBrowserPageSession,
    fallbackUrl: string
  ): Promise<BrowserPageDriverState> {
    return this.kernel.refreshExternalPageState(sessionId, session, fallbackUrl)
  }

  protected updateExternalPageStateFromInspection(
    sessionId: string,
    session: ExternalBrowserPageSession,
    inspection: BrowserPageInspection
  ): void {
    this.kernel.updateExternalPageStateFromInspection(sessionId, session, inspection)
  }

  protected syncExternalPageStateFromScriptResult(
    sessionId: string,
    session: ExternalBrowserPageSession,
    result: unknown,
    fallbackUrl: string
  ): void {
    this.kernel.syncExternalPageStateFromScriptResult(sessionId, session, result, fallbackUrl)
  }

  private requireExternalPageSession(sessionId: string): ExternalBrowserPageSession {
    const externalSession = this.getExternalPageSession(sessionId)
    if (!externalSession) {
      throw new AppError('NOT_FOUND', `外部浏览器会话不存在：${sessionId}`)
    }
    return externalSession
  }

  public async inspectPage(
    sessionId: string,
    _context: BrowserSiteContext,
    options: BrowserInspectPageOptions = {},
    _abortSignal?: AbortSignal
  ): Promise<BrowserPageInspection> {
    _abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    const inspection = await externalSession.driver.executeJavaScript<BrowserPageInspection>(
      buildInspectionScript({
        includeHtml: !!options.includeHtml,
        maxTextChars: options.maxTextChars ?? BrowserTuning.page.inspectTextChars,
        maxHtmlChars: options.maxHtmlChars ?? BrowserTuning.page.inspectHtmlChars,
        maxElements: options.maxElements ?? BrowserTuning.page.inspectElements,
        ignoreSelectors: options.ignoreSelectors,
      }),
      true
    )
    this.targetRefs.storeInspection(sessionId, inspection)
    this.updateExternalPageStateFromInspection(sessionId, externalSession, inspection)
    return inspection
  }

  public async evaluateScript(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserEvaluateScriptOptions,
    _abortSignal?: AbortSignal
  ): Promise<BrowserScriptOutcome> {
    _abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    const script = buildEvaluateScript(options)
    const driver = externalSession.driver
    if (options.frame) {
      if (!driver.executeJavaScriptInFrame) throw new AppError('VALIDATION', '当前外部浏览器 driver 不支持在指定框架里跑脚本。')
      return driver.executeJavaScriptInFrame<BrowserScriptOutcome>(options.frame, script, true)
    }
    const result = await driver.executeJavaScript<BrowserScriptOutcome>(script, true)
    this.syncExternalPageStateFromScriptResult(sessionId, externalSession, result, context.url)
    return result
  }

  public async listFrames(sessionId: string, _context: BrowserSiteContext, abortSignal?: AbortSignal): Promise<BrowserFrameInfo[]> {
    abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    if (!externalSession.driver.listFrames) throw new AppError('VALIDATION', '当前外部浏览器 driver 不支持列框架树。')
    return externalSession.driver.listFrames()
  }

  

  

  

  

  

  public async fetchResource(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserFetchResourceOptions,
    _abortSignal?: AbortSignal
  ): Promise<BrowserFetchResourceResult> {
    _abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    const targetUrl = normalizeFetchResourceUrl(options.url)
    const artifactPath = await resolveWorkspaceFilePath(
      context.workspaceRoot,
      options.savePath,
      'savePath'
    )
    if (!externalSession.driver.fetchResource) {
      throw new AppError('VALIDATION', '当前外部浏览器 driver 不支持资源抓取。')
    }
    const referer =
      options.referer?.trim() || resolveExternalPageUrl(externalSession, context.url)
    const response = await externalSession.driver.fetchResource({
      url: targetUrl,
      referer,
    })
    const status = response.status
    if (!response.ok) {
      throw new AppError('VALIDATION', `资源下载失败：HTTP ${status}`, undefined, {
        url: targetUrl,
        status,
      })
    }
    if (
      isFiniteNumber(response.contentLength) &&
      response.contentLength > BrowserFetchLimits.fileBytes
    ) {
      throw new AppError(
        'VALIDATION',
        `资源过大（${response.contentLength} 字节），超过 ${BrowserFetchLimits.fileBytes} 字节上限。`,
        undefined,
        { url: targetUrl, bytes: response.contentLength }
      )
    }
    if (response.bytes.byteLength > BrowserFetchLimits.fileBytes) {
      throw new AppError(
        'VALIDATION',
        `资源过大（${response.bytes.byteLength} 字节），超过 ${BrowserFetchLimits.fileBytes} 字节上限。`,
        undefined,
        { url: targetUrl, bytes: response.bytes.byteLength }
      )
    }

    await mkdir(dirname(artifactPath.path), { recursive: true })
    await writeFile(artifactPath.path, response.bytes)

    return {
      url: targetUrl,
      path: artifactPath.path,
      relativePath: artifactPath.relativePath,
      mimeType: response.mimeType,
      bytes: response.bytes.byteLength,
      status,
      capturedAt: Date.now(),
    }
  }

  

  

  

  

  

  

  

  

  public async getPageDiagnostics(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserPageDiagnosticsOptions = {},
    _abortSignal?: AbortSignal
  ): Promise<BrowserPageDiagnostics> {
    _abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    const limit = clampInteger(options.limit, 1, this.diagnosticsLimits.maxEntries, 100)
    const entries = externalSession.driver.readDiagnostics?.({
      limit,
      kinds: options.kinds,
      clear: options.clear,
    }) ?? []
    const state = await this.refreshExternalPageState(sessionId, externalSession, context.url)
    return {
      url: state.url || context.url,
      title: state.title || null,
      entries,
      summary: summarizePageDiagnostics(entries),
      capturedAt: Date.now(),
    }
  }

  

  

  

  

  

  public async uploadFile(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserUploadFileOptions,
    _abortSignal?: AbortSignal
  ): Promise<BrowserUploadFileResult> {
    _abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    const absolutePath = await resolveUploadFilePath(context.workspaceRoot, options.filePath)
    const hydratedTarget = this.targetRefs.hydrateTarget(sessionId, options.target, 'target')
    if (!externalSession.driver.setFileInputFiles) {
      throw new AppError('VALIDATION', '当前外部浏览器 driver 不支持文件上传。')
    }
    const locator = await externalSession.driver.executeJavaScript<{
      matched: boolean
      selector: Nullable<string>
    }>(buildResolveFileInputScript(hydratedTarget), true)
    this.syncExternalPageStateFromScriptResult(sessionId, externalSession, locator, context.url)

    if (!locator.matched || !locator.selector)
      return {
        matched: false,
        selector: toNullable(locator.selector),
        files: [],
        capturedAt: Date.now(),
      }

    const matched = await externalSession.driver.setFileInputFiles({
      selector: locator.selector,
      files: [absolutePath],
    })
    if (!matched)
      return {
        matched: false,
        selector: locator.selector,
        files: [],
        capturedAt: Date.now(),
      }

    return {
      matched: true,
      selector: locator.selector,
      files: [absolutePath],
      capturedAt: Date.now(),
    }
  }

  

  public async exportPagePdf(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserExportPagePdfOptions = {},
    _abortSignal?: AbortSignal
  ): Promise<BrowserExportPagePdfResult> {
    _abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    if (!externalSession.driver.printToPdf) {
      throw new AppError('VALIDATION', '当前外部浏览器 driver 不支持 PDF 导出。')
    }
    const pdfBuffer = await externalSession.driver.printToPdf({
      printBackground: !isFalse(options.printBackground),
    })
    const defaultPath = `artifacts/exports/page-${new Date().toISOString().replace(/[:.]/g, '-')}.pdf`
    const artifactPath = await resolveWorkspaceFilePath(
      context.workspaceRoot,
      options.savePath ?? defaultPath,
      'savePath'
    )
    const state = await this.refreshExternalPageState(sessionId, externalSession, context.url)

    await mkdir(dirname(artifactPath.path), { recursive: true })
    await writeFile(artifactPath.path, pdfBuffer)

    return {
      url: state.url || context.url,
      path: artifactPath.path,
      relativePath: artifactPath.relativePath,
      bytes: pdfBuffer.byteLength,
      capturedAt: Date.now(),
    }
  }

  public async configureNetwork(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserNetworkControlOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserNetworkControlResult> {
    abortSignal?.throwIfAborted()
    // 多态:嵌入式 webview 与外部 CDP 都经 webContents.debugger/WebSocket 走同一套网络控制。
    const pageSession = await this.kernel.getLivePageDriverSession(sessionId, abortSignal)
    if (!pageSession.driver.configureNetwork) {
      throw new AppError('VALIDATION', '当前浏览器页面 driver 不支持网络控制。')
    }

    const networkState = await pageSession.driver.configureNetwork(options)
    const state = await this.kernel.refreshPageDriverSessionState(sessionId, pageSession, context.url)
    return {
      url: state.url || context.url,
      offline: networkState.offline,
      extraHTTPHeaders: networkState.extraHTTPHeaders,
      blockedURLPatterns: networkState.blockedURLPatterns,
      blockedResourceTypes: networkState.blockedResourceTypes,
      mockResponses: networkState.mockResponses,
      capturedAt: Date.now(),
    }
  }

  public async readNetworkResponseBody(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserNetworkResponseBodyOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserNetworkResponseBodyResult> {
    abortSignal?.throwIfAborted()
    const pageSession = await this.kernel.getLivePageDriverSession(sessionId, abortSignal)
    if (!pageSession.driver.readNetworkResponseBody) {
      throw new AppError('VALIDATION', '当前浏览器页面 driver 不支持网络响应体读取。')
    }

    const body = await pageSession.driver.readNetworkResponseBody(options)
    const state = await this.kernel.refreshPageDriverSessionState(sessionId, pageSession, context.url)
    return {
      url: state.url || context.url,
      requestId: body.requestId,
      body: body.body,
      base64Encoded: body.base64Encoded,
      bodyLength: body.bodyLength,
      returnedChars: body.returnedChars,
      bodyTruncated: body.bodyTruncated,
      capturedAt: Date.now(),
    }
  }

  public async readNetworkRequestDetails(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserNetworkRequestDetailsOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserNetworkRequestDetailsResult> {
    abortSignal?.throwIfAborted()
    const pageSession = await this.kernel.getLivePageDriverSession(sessionId, abortSignal)
    if (!pageSession.driver.readNetworkRequestDetails) {
      throw new AppError('VALIDATION', '当前浏览器页面 driver 不支持网络请求详情读取。')
    }

    const details = await pageSession.driver.readNetworkRequestDetails(options)
    const state = await this.kernel.refreshPageDriverSessionState(sessionId, pageSession, context.url)
    return {
      url: state.url || context.url,
      requestId: details.requestId,
      request: details.request,
      response: details.response,
      failure: details.failure,
      durationMs: details.durationMs,
      responseBody: details.responseBody,
      capturedAt: Date.now(),
    }
  }

  public async waitForPage(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserPageWaitOptions,
    _abortSignal?: AbortSignal
  ): Promise<BrowserPageWaitResult> {
    _abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    let networkIdle = true
    if (options.loadState === 'networkidle') {
      if (!externalSession.driver.waitForNetworkIdle) {
        throw new AppError('VALIDATION', '当前外部浏览器 driver 不支持 networkidle 等待。')
      }
      networkIdle = await externalSession.driver.waitForNetworkIdle({
        idleMs: BrowserTuning.page.networkIdleMs,
        timeoutMs: options.timeoutMs ?? BrowserTuning.page.networkIdleTimeoutMs,
      })
    }
    const result = await externalSession.driver.executeJavaScript<BrowserPageWaitResult>(
      buildPageWaitScript(options),
      true
    )
    this.syncExternalPageStateFromScriptResult(sessionId, externalSession, result, context.url)
    // 页面脚本只认 readyState：网络空闲没等到时如实回没到。
    return networkIdle ? result : { ...result, matched: false, timedOut: true }
  }
}

