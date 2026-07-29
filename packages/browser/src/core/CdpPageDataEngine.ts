import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { isArray, isBoolean, isEmpty, isFalse, isFiniteNumber, isNonBlankString, isNotNull, isPlainObject, isString, isTrue, optionalWhen, toNullable, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import type {
  BrowserPageDriverCookie,
  BrowserPageDriverState,
} from './BrowserPageDriver'
import type { BrowserPageScriptBuilder } from './BrowserPageScriptBuilder'
import {
  type BrowserPageDriverKernel,
  clampInteger,
  type ExternalBrowserPageSession,
  readBoundedString,
  readFiniteNumber,
  resolveExternalPageUrl,
  resolveWorkspaceFilePath,
} from './BrowserRuntimeInternals'
import type { BrowserTargetRefStore } from './BrowserTargetRefStore'
import type { BrowserElementQueryOptions, BrowserElementQueryResult, BrowserEmulationOptions, BrowserEmulationResult, BrowserEvaluateScriptOptions, BrowserEvaluateScriptResult, BrowserExportPagePdfOptions, BrowserExportPagePdfResult, BrowserFetchResourceOptions, BrowserFetchResourceResult, BrowserInspectPageOptions, BrowserListMediaSourcesOptions, BrowserListMediaSourcesResult, BrowserListPageResourcesOptions, BrowserListPageResourcesResult, BrowserMediaSourceItem, BrowserNetworkControlOptions, BrowserNetworkControlResult, BrowserNetworkRequestDetailsOptions, BrowserNetworkRequestDetailsResult, BrowserNetworkResponseBodyOptions, BrowserNetworkResponseBodyResult, BrowserOriginStorage, BrowserPageDiagnostics, BrowserPageDiagnosticsOptions, BrowserPageInspection, BrowserPageStorageOptions, BrowserPageStorageResult, BrowserPageWaitOptions, BrowserPageWaitResult, BrowserSiteContext, BrowserStorageEntry, BrowserUploadFileOptions, BrowserUploadFileResult, BrowserWaitForSelectorOptions, BrowserWaitForSelectorResult } from './types.js'

const DefaultFetchResourceMaxBytes = 50 * 1024 * 1024

const DefaultListMediaSourcesLimit = 80

/** 诊断窗口上限的窄面（宿主的 BrowserDiagnosticsRecorder 结构满足它）。 */
export interface BrowserDiagnosticsLimits {
  maxEntries: number
}

/**
 * 页面数据域执行体的 host 无关外部核（走 CDP driver）。
 *
 * 承载页面检查/元素查询/脚本评估/存储读取/网络数据/媒体清单/诊断摘要/上传/PDF/等待的
 * external 分支与全部纯计算助手，以及嵌入/外部共用的 driver 多态方法（网络控制/响应体/
 * 请求详情/环境模拟）。Electron 宿主的 `BrowserPageDataEngine` 继承本类补 embedded 分支。
 *
 * 方法默认在 runtime 的 actionQueue 内被调用。
 */
export class CdpPageDataEngine {
  protected readonly log = logRuntime.tag('BrowserPageDataEngine')

  constructor(
    protected readonly kernel: BrowserPageDriverKernel,
    protected readonly scripts: BrowserPageScriptBuilder,
    protected readonly targetRefs: BrowserTargetRefStore,
    protected readonly diagnosticsLimits: BrowserDiagnosticsLimits
  ) {}

  // ---- kernel 桥接:保持搬入方法体零改写 ----
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
      this.scripts.buildInspectionScript({
        includeHtml: !!options.includeHtml,
        maxTextChars: options.maxTextChars ?? 20_000,
        maxHtmlChars: options.maxHtmlChars ?? 30_000,
        maxElements: options.maxElements ?? 80,
        ignoreSelectors: options.ignoreSelectors,
      }),
      true
    )
    this.targetRefs.storeInspection(sessionId, inspection)
    this.updateExternalPageStateFromInspection(sessionId, externalSession, inspection)
    return inspection
  }

  public async queryElements(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserElementQueryOptions,
    _abortSignal?: AbortSignal
  ): Promise<BrowserElementQueryResult> {
    _abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    const result = await externalSession.driver.executeJavaScript<BrowserElementQueryResult>(
      this.scripts.buildElementQueryScript(options),
      true
    )
    this.syncExternalPageStateFromScriptResult(sessionId, externalSession, result, context.url)
    return result
  }

  public async evaluateScript(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserEvaluateScriptOptions,
    _abortSignal?: AbortSignal
  ): Promise<BrowserEvaluateScriptResult> {
    _abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    const result = await externalSession.driver.executeJavaScript<BrowserEvaluateScriptResult>(
      this.scripts.buildEvaluateScript(options),
      true
    )
    this.syncExternalPageStateFromScriptResult(sessionId, externalSession, result, context.url)
    return result
  }

  public async readPageStorage(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserPageStorageOptions = {},
    _abortSignal?: AbortSignal
  ): Promise<BrowserPageStorageResult> {
    _abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    const result = await externalSession.driver.executeJavaScript<BrowserPageStorageResult>(
      this.scripts.buildPageStorageScript(options),
      true
    )
    this.syncExternalPageStateFromScriptResult(sessionId, externalSession, result, context.url)
    const origins = await this.readExternalStorageOrigins(externalSession, options)
    if (options.includeCookies && externalSession.driver.readCookies) {
      const cookies = await this.readExternalBrowserCookies(
        externalSession,
        options,
        result.cookies ?? []
      )
      return {
        ...result,
        origins: toOptional(origins),
        cookies,
      }
    }
    return {
      ...result,
      origins: toOptional(origins),
    }
  }

  protected async readExternalStorageOrigins(
    externalSession: ExternalBrowserPageSession,
    options: BrowserPageStorageOptions
  ): Promise<Nullable<BrowserOriginStorage[]>> {
    if (options.storageScope !== 'all-origins' || !externalSession.driver.readStorageOrigins) return null

    try {
      const limit = clampInteger(options.limit, 1, 300, 100)
      const maxValueChars = clampInteger(options.maxValueChars, 1, 50_000, 4_000)
      return await externalSession.driver.readStorageOrigins({
        includeLocalStorage: options.includeLocalStorage ?? true,
        includeSessionStorage: options.includeSessionStorage ?? true,
        limit,
        maxValueChars,
      })
    } catch (error) {
      this.log.debug('读取外部浏览器跨 origin storage 失败，回退当前页面 storage', {
        error: AppError.from(error).message,
      })
      return null
    }
  }

  protected async readExternalBrowserCookies(
    externalSession: ExternalBrowserPageSession,
    options: BrowserPageStorageOptions,
    fallbackCookies: BrowserStorageEntry[]
  ): Promise<BrowserStorageEntry[]> {
    if (!externalSession.driver.readCookies) return fallbackCookies

    try {
      const limit = clampInteger(options.limit, 1, 300, 100)
      const maxValueChars = clampInteger(options.maxValueChars, 1, 50_000, 4_000)
      const cookies = await externalSession.driver.readCookies({
        scope: options.cookieScope ?? 'current-url',
      })
      return cookies
        .map((cookie) => this.mapExternalCookieToStorageEntry(cookie, maxValueChars))
        .filter((entry): entry is BrowserStorageEntry => Boolean(entry))
        .slice(0, limit)
    } catch (error) {
      this.log.debug('读取外部浏览器 cookie jar 失败，回退页面脚本 cookie', {
        error: AppError.from(error).message,
      })
      return fallbackCookies
    }
  }

  private mapExternalCookieToStorageEntry(
    cookie: BrowserPageDriverCookie,
    maxValueChars: number
  ): Nullable<BrowserStorageEntry> {
    const name = cookie.name.trim()
    if (!name) return null

    const value = String(cookie.value ?? '')
    const details = this.buildExternalCookieDetails(cookie)
    const detailKeys = Object.keys(details)
    return {
      name,
      value: value.length > maxValueChars ? value.slice(0, maxValueChars) : value,
      valueTruncated: value.length > maxValueChars,
      ...(!isEmpty(detailKeys) ? { details } : {}),
    }
  }

  private buildExternalCookieDetails(cookie: BrowserPageDriverCookie): Record<string, unknown> {
    const details: Record<string, unknown> = {}
    this.assignCookieStringDetail(details, 'domain', cookie.domain)
    this.assignCookieStringDetail(details, 'path', cookie.path)
    this.assignCookieNumberDetail(details, 'expires', cookie.expires)
    this.assignCookieNumberDetail(details, 'size', cookie.size)
    this.assignCookieBooleanDetail(details, 'httpOnly', cookie.httpOnly)
    this.assignCookieBooleanDetail(details, 'secure', cookie.secure)
    this.assignCookieBooleanDetail(details, 'session', cookie.session)
    this.assignCookieStringDetail(details, 'sameSite', cookie.sameSite)
    return details
  }

  private assignCookieStringDetail(
    details: Record<string, unknown>,
    key: string,
    value: LooseOptional<string>
  ): void {
    if (isNonBlankString(value)) {
      details[key] = value
    }
  }

  private assignCookieNumberDetail(
    details: Record<string, unknown>,
    key: string,
    value: LooseOptional<number>
  ): void {
    if (isFiniteNumber(value)) {
      details[key] = value
    }
  }

  private assignCookieBooleanDetail(
    details: Record<string, unknown>,
    key: string,
    value: LooseOptional<boolean>
  ): void {
    if (isBoolean(value)) {
      details[key] = value
    }
  }

  public async fetchResource(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserFetchResourceOptions,
    _abortSignal?: AbortSignal
  ): Promise<BrowserFetchResourceResult> {
    _abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    const targetUrl = this.normalizeFetchResourceUrl(options.url)
    const artifactPath = resolveWorkspaceFilePath(context.workspaceRoot, options.savePath)
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
      response.contentLength > DefaultFetchResourceMaxBytes
    ) {
      throw new AppError(
        'VALIDATION',
        `资源过大（${response.contentLength} 字节），超过 ${DefaultFetchResourceMaxBytes} 字节上限。`,
        undefined,
        { url: targetUrl, bytes: response.contentLength }
      )
    }
    if (response.bytes.byteLength > DefaultFetchResourceMaxBytes) {
      throw new AppError(
        'VALIDATION',
        `资源过大（${response.bytes.byteLength} 字节），超过 ${DefaultFetchResourceMaxBytes} 字节上限。`,
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

  protected normalizeFetchResourceUrl(rawUrl: string): string {
    const trimmed = rawUrl.trim()
    if (!trimmed) {
      throw new AppError('VALIDATION', 'url 不能为空。')
    }

    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch (error) {
      throw new AppError('VALIDATION', `无效的资源 URL：${rawUrl}`, error)
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new AppError('VALIDATION', '仅支持 http(s) 资源 URL。', undefined, {
        protocol: parsed.protocol,
      })
    }

    return parsed.toString()
  }

  public async listMediaSources(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserListMediaSourcesOptions = {},
    _abortSignal?: AbortSignal
  ): Promise<BrowserListMediaSourcesResult> {
    _abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    const limit = clampInteger(options.limit, 1, 200, DefaultListMediaSourcesLimit)
    const includeDataUrls = !!options.includeDataUrls
    const includeBlobUrls = !!options.includeBlobUrls
    const result = await externalSession.driver.executeJavaScript<{
      items?: unknown
      truncated?: boolean
    }>(
      this.scripts.buildListMediaSourcesScript({
        limit,
        includeDataUrls,
        includeBlobUrls,
      }),
      true
    )
    this.syncExternalPageStateFromScriptResult(sessionId, externalSession, result, context.url)

    return {
      url: resolveExternalPageUrl(externalSession, context.url),
      items: this.normalizeMediaSourceItems(result.items),
      truncated: !!result.truncated,
      capturedAt: Date.now(),
    }
  }

  protected normalizeMediaSourceItems(value: unknown): BrowserMediaSourceItem[] {
    if (!isArray(value)) return []

    return value
      .map((item): Nullable<BrowserMediaSourceItem> => {
        if (!isPlainObject(item) || !isString(item.url)) return null

        const kind = item.kind
        const normalizedKind =
          kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'other'
            ? kind
            : 'other'

        return {
          kind: normalizedKind,
          url: item.url,
          fetchable: isTrue(item.fetchable),
          tagName: readBoundedString(item.tagName, 32),
          attribute: readBoundedString(item.attribute, 32),
          alt: readBoundedString(item.alt, 240),
          width: optionalWhen(isFiniteNumber, item.width) ? Math.round(item.width as number) : null,
          height: optionalWhen(isFiniteNumber, item.height)
            ? Math.round(item.height as number)
            : null,
        }
      })
      .filter((entry): entry is BrowserMediaSourceItem => !!entry)
  }

  public async listPageResources(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserListPageResourcesOptions = {},
    _abortSignal?: AbortSignal
  ): Promise<BrowserListPageResourcesResult> {
    _abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    const limit = clampInteger(options.limit, 1, 500, 120)
    const includeIframes = !isFalse(options.includeIframes)
    const result = await externalSession.driver.executeJavaScript<{
      links?: unknown
      iframes?: unknown
      resourceOrigins?: unknown
      mediaCount?: unknown
      truncated?: boolean
    }>(this.scripts.buildPageResourcesScript({ limit, includeIframes }), true)
    this.syncExternalPageStateFromScriptResult(sessionId, externalSession, result, context.url)

    return {
      url: resolveExternalPageUrl(externalSession, context.url),
      links: this.normalizePageResourceLinks(result.links),
      iframes: this.normalizePageResourceIframes(result.iframes),
      resourceOrigins: this.normalizePageResourceOrigins(result.resourceOrigins, context.url),
      mediaCount: clampInteger(readFiniteNumber(result.mediaCount), 0, 100_000, 0),
      truncated: !!result.truncated,
      capturedAt: Date.now(),
    }
  }

  protected normalizePageResourceLinks(value: unknown): BrowserListPageResourcesResult['links'] {
    if (!isArray(value)) return []

    return value
      .map((item): Nullable<BrowserListPageResourcesResult['links'][number]> => {
        if (!isPlainObject(item) || !isString(item.href)) return null
        return {
          text: readBoundedString(item.text, 240),
          href: item.href,
        }
      })
      .filter((entry): entry is BrowserListPageResourcesResult['links'][number] => !!entry)
  }

  protected normalizePageResourceIframes(value: unknown): BrowserListPageResourcesResult['iframes'] {
    if (!isArray(value)) return []

    return value
      .map((item): Nullable<BrowserListPageResourcesResult['iframes'][number]> => {
        if (!isPlainObject(item)) return null
        return {
          src: readBoundedString(item.src, 4096),
          title: readBoundedString(item.title, 240),
          sandbox: readBoundedString(item.sandbox, 240),
        }
      })
      .filter((entry): entry is BrowserListPageResourcesResult['iframes'][number] => !!entry)
  }

  protected normalizePageResourceOrigins(
    value: unknown,
    fallbackUrl: string
  ): BrowserListPageResourcesResult['resourceOrigins'] {
    const pageOrigin = this.resolveOrigin(fallbackUrl)
    if (!isPlainObject(value)) return {
        pageOrigin,
        sameOrigin: [],
        crossOrigin: [],
        totalUniqueOrigins: 0,
      }

    const sameOrigin = this.normalizeOriginList(value.sameOrigin)
    const crossOrigin = this.normalizeOriginList(value.crossOrigin)
    const uniqueOrigins = new Set([...sameOrigin, ...crossOrigin])

    return {
      pageOrigin: this.normalizeOriginValue(value.pageOrigin) ?? pageOrigin,
      sameOrigin,
      crossOrigin,
      totalUniqueOrigins: Math.max(
        uniqueOrigins.size,
        Math.round(readFiniteNumber(value.totalUniqueOrigins) ?? uniqueOrigins.size)
      ),
    }
  }

  private normalizeOriginList(value: unknown): string[] {
    if (!isArray(value)) return []

    return [...new Set(value.map((origin) => this.normalizeOriginValue(origin)).filter(isString))]
      .sort()
  }

  private normalizeOriginValue(value: unknown): Nullable<string> {
    if (!isString(value) || !URL.canParse(value)) return null

    return new URL(value).origin
  }

  protected resolveOrigin(url: string): string {
    return URL.canParse(url) ? new URL(url).origin : ''
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
      clear: options.clear,
    }) ?? []
    const state = await this.refreshExternalPageState(sessionId, externalSession, context.url)
    return {
      url: state.url || context.url,
      title: state.title || null,
      entries,
      summary: this.summarizePageDiagnostics(entries),
      capturedAt: Date.now(),
    }
  }

  protected summarizePageDiagnostics(
    entries: BrowserPageDiagnostics['entries']
  ): BrowserPageDiagnostics['summary'] {
    const byLevel: Record<string, number> = {}
    const byKind: Record<string, number> = {}
    const byOrigin: Record<string, number> = {}
    const byStatus: Record<string, number> = {}
    const byResourceType: Record<string, number> = {}

    for (const entry of entries) {
      this.incrementCount(byLevel, entry.level)
      this.incrementCount(byKind, entry.kind)

      const origin = entry.url ? this.resolveOrigin(entry.url) : ''
      if (origin) this.incrementCount(byOrigin, origin)

      const status = this.readDiagnosticNetworkStatus(entry)
      if (isNotNull(status)) this.incrementCount(byStatus, String(status))

      const resourceType = this.readDiagnosticResourceType(entry)
      if (resourceType) this.incrementCount(byResourceType, resourceType)
    }

    return {
      total: entries.length,
      byLevel: this.sortCountRecord(byLevel),
      byKind: this.sortCountRecord(byKind),
      byOrigin: this.sortCountRecord(byOrigin),
      byStatus: this.sortCountRecord(byStatus),
      byResourceType: this.sortCountRecord(byResourceType),
    }
  }

  private incrementCount(record: Record<string, number>, key: string): void {
    record[key] = (record[key] ?? 0) + 1
  }

  private sortCountRecord(record: Record<string, number>): Record<string, number> {
    return Object.fromEntries(
      Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
    )
  }

  private readDiagnosticNetworkStatus(
    entry: BrowserPageDiagnostics['entries'][number]
  ): Nullable<number> {
    if (entry.kind !== 'network') return null

    const detailStatus = isPlainObject(entry.details) ? entry.details.status : null
    const status = isFiniteNumber(detailStatus) ? detailStatus : entry.code
    if (!isFiniteNumber(status) || status <= 0) return null

    return Math.round(status)
  }

  private readDiagnosticResourceType(
    entry: BrowserPageDiagnostics['entries'][number]
  ): Nullable<string> {
    if (entry.kind !== 'network') return null
    if (!isPlainObject(entry.details)) return null

    const resourceType = entry.details.resourceType
    if (!isString(resourceType)) return null

    return resourceType.trim() || null
  }

  public async uploadFile(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserUploadFileOptions,
    _abortSignal?: AbortSignal
  ): Promise<BrowserUploadFileResult> {
    _abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    const absolutePath = this.resolveUploadFilePath(context.workspaceRoot, options.filePath)
    if (!externalSession.driver.setFileInputFiles) {
      throw new AppError('VALIDATION', '当前外部浏览器 driver 不支持文件上传。')
    }
    const locator = await externalSession.driver.executeJavaScript<{
      matched: boolean
      selector: Nullable<string>
    }>(this.scripts.buildResolveFileInputScript(options.target), true)
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

  protected resolveUploadFilePath(workspaceRoot: string, requestedPath: string): string {
    return resolveWorkspaceFilePath(workspaceRoot, requestedPath).path
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
    const artifactPath = resolveWorkspaceFilePath(
      context.workspaceRoot,
      options.savePath ?? defaultPath
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

  public async configureEmulation(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserEmulationOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserEmulationResult> {
    abortSignal?.throwIfAborted()
    // 多态:嵌入式 webview 与外部 CDP 都经 webContents.debugger/WebSocket 走 CDP Emulation。
    const pageSession = await this.kernel.getLivePageDriverSession(sessionId, abortSignal)
    if (!pageSession.driver.configureEmulation) {
      throw new AppError('VALIDATION', '当前浏览器页面 driver 不支持环境模拟。')
    }

    const emulationState = await pageSession.driver.configureEmulation(options)
    const pageState = await this.kernel.refreshPageDriverSessionState(
      sessionId,
      pageSession,
      context.url
    )
    return {
      url: pageState.url || context.url,
      colorScheme: emulationState.colorScheme,
      reducedMotion: emulationState.reducedMotion,
      timezoneId: emulationState.timezoneId,
      locale: emulationState.locale,
      geolocation: emulationState.geolocation,
      cpuThrottlingRate: emulationState.cpuThrottlingRate,
      networkThrottling: emulationState.networkThrottling,
      capturedAt: Date.now(),
    }
  }

  public async waitForSelector(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserWaitForSelectorOptions,
    _abortSignal?: AbortSignal
  ): Promise<BrowserWaitForSelectorResult> {
    _abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    const result = await externalSession.driver.executeJavaScript<BrowserWaitForSelectorResult>(
      this.scripts.buildWaitForSelectorScript(options),
      true
    )
    this.syncExternalPageStateFromScriptResult(sessionId, externalSession, result, context.url)
    return result
  }

  public async waitForPage(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserPageWaitOptions,
    _abortSignal?: AbortSignal
  ): Promise<BrowserPageWaitResult> {
    _abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    if (options.loadState === 'networkidle') {
      if (!externalSession.driver.waitForNetworkIdle) {
        throw new AppError('VALIDATION', '当前外部浏览器 driver 不支持 networkidle 等待。')
      }
      await externalSession.driver.waitForNetworkIdle({
        idleMs: 500,
        timeoutMs: options.timeoutMs ?? 5000,
      })
    }
    const result = await externalSession.driver.executeJavaScript<BrowserPageWaitResult>(
      this.scripts.buildPageWaitScript(options),
      true
    )
    this.syncExternalPageStateFromScriptResult(sessionId, externalSession, result, context.url)
    return result
  }
}
