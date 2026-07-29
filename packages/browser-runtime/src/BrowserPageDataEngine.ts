import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import electron from 'electron'

import type { BrowserElementQueryOptions, BrowserElementQueryResult, BrowserEvaluateScriptOptions, BrowserEvaluateScriptResult, BrowserExportPagePdfOptions, BrowserExportPagePdfResult, BrowserFetchResourceOptions, BrowserFetchResourceResult, BrowserInspectPageOptions, BrowserListMediaSourcesOptions, BrowserListMediaSourcesResult, BrowserListPageResourcesOptions, BrowserListPageResourcesResult, BrowserPageDiagnostics, BrowserPageDiagnosticsOptions, BrowserPageInspection, BrowserPageStorageOptions, BrowserPageStorageResult, BrowserPageWaitOptions, BrowserPageWaitResult, BrowserSiteContext, BrowserUploadFileOptions, BrowserUploadFileResult, BrowserWaitForSelectorOptions, BrowserWaitForSelectorResult } from '@velaros-ai/browser-core'
import {
  type BrowserPageDriver,
  type BrowserPageScriptBuilder,
  type BrowserTargetRefStore,
  CdpPageDataEngine,
  clampInteger,
  readFiniteNumber,
  resolveWorkspaceFilePath,
} from '@velaros-ai/browser-core'
import { isFalse, isNumber, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { BrowserDiagnosticsRecorder } from './BrowserDiagnosticsRecorder'
import type { BrowserInteractionEngine } from './BrowserInteractionEngine'
import type { BrowserPageWaiter } from './BrowserPageWaiter'
import type { BrowserRuntimeKernel } from './BrowserRuntimeInternals'
import type { BrowserSession } from './BrowserRuntimeTypes'

type ElectronNetFetchOptions = Parameters<typeof electron.net.fetch>[1] & {
  session?: Electron.Session
}

const DefaultFetchResourceMaxBytes = 50 * 1024 * 1024

/**
 * 页面数据域执行体（Electron 宿主）：embedded 分支（webContents 脚本执行、electron.net.fetch、
 * webContents.debugger 上传、诊断合并、PDF 打印）+ 委托 external 核（`CdpPageDataEngine`）。
 *
 * 每个 public 方法先探 external 会话：命中 → `super`（driver 路径）；否则跑 embedded 分支。
 * 方法默认在 runtime 的 actionQueue 内被调用。
 */
export class BrowserPageDataEngine extends CdpPageDataEngine {
  constructor(
    private readonly electronKernel: BrowserRuntimeKernel,
    scripts: BrowserPageScriptBuilder,
    private readonly pageWaiter: BrowserPageWaiter,
    private readonly diagnosticsRecorder: BrowserDiagnosticsRecorder,
    targetRefs: BrowserTargetRefStore,
    private readonly interaction: BrowserInteractionEngine
  ) {
    super(electronKernel, scripts, targetRefs, diagnosticsRecorder)
  }

  // ---- webview 专属 kernel 桥接 ----
  private getLivePageSessionUnlocked(
    sessionId: string,
    abortSignal?: AbortSignal
  ): Promise<BrowserSession> {
    return this.electronKernel.getLivePageSession(sessionId, abortSignal)
  }

  private getPageDriver(sessionId: string, session: BrowserSession): BrowserPageDriver {
    return this.electronKernel.wrapPageDriver(sessionId, session)
  }

  private resolveCurrentPageUrl(session: BrowserSession, fallbackUrl: string): string {
    return this.electronKernel.resolveCurrentPageUrl(session, fallbackUrl)
  }

  public override async inspectPage(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserInspectPageOptions = {},
    abortSignal?: AbortSignal
  ): Promise<BrowserPageInspection> {
    abortSignal?.throwIfAborted()
    const externalSession = this.getExternalPageSession(sessionId)
    if (externalSession) return super.inspectPage(sessionId, context, options, abortSignal)

    const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)
    // E1: network idle 等待 — SPA 渲染完成后再抓取，避免拿到旧内容
    if (options.waitForNetworkIdle) {
      await this.pageWaiter.waitForNetworkIdle(
        session.webContents,
        isNumber(options.waitForNetworkIdle) ? options.waitForNetworkIdle : 500
      )
    }
    const maxTextChars = options.maxTextChars ?? 20_000
    const maxHtmlChars = options.maxHtmlChars ?? 30_000
    const maxElements = options.maxElements ?? 80

    // 检查脚本在页面上下文中执行，返回纯 JSON 结构。
    const driver = this.getPageDriver(sessionId, session)
    const inspection = await driver.executeJavaScript<BrowserPageInspection>(
      this.scripts.buildInspectionScript({
        includeHtml: !!options.includeHtml,
        maxTextChars,
        maxHtmlChars,
        maxElements,
        ignoreSelectors: options.ignoreSelectors,
      }),
      true
    )
    this.targetRefs.storeInspection(sessionId, inspection)
    return inspection
  }

  public override async queryElements(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserElementQueryOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserElementQueryResult> {
    abortSignal?.throwIfAborted()
    const externalSession = this.getExternalPageSession(sessionId)
    if (externalSession) return super.queryElements(sessionId, context, options, abortSignal)

    const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)

    const result = (await session.webContents.executeJavaScript(
      this.scripts.buildElementQueryScript(options),
      true
    )) as BrowserElementQueryResult

    const firstElement = result.elements[0]
    if (firstElement?.target?.css || options.selector) {
      void this.interaction.highlightTarget(
        session,
        firstElement?.target ?? {
          css: options.selector,
          role: null,
          text: null,
          name: null,
          attributes: {},
        },
        firstElement?.text ?? options.selector
      )
    }

    return result
  }

  public override async evaluateScript(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserEvaluateScriptOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserEvaluateScriptResult> {
    abortSignal?.throwIfAborted()
    const externalSession = this.getExternalPageSession(sessionId)
    if (externalSession) return super.evaluateScript(sessionId, context, options, abortSignal)

    const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)

    return session.webContents.executeJavaScript(
      this.scripts.buildEvaluateScript(options),
      true
    ) as Promise<BrowserEvaluateScriptResult>
  }

  public override async readPageStorage(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserPageStorageOptions = {},
    abortSignal?: AbortSignal
  ): Promise<BrowserPageStorageResult> {
    abortSignal?.throwIfAborted()
    const externalSession = this.getExternalPageSession(sessionId)
    if (externalSession) return super.readPageStorage(sessionId, context, options, abortSignal)

    const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)

    return session.webContents.executeJavaScript(
      this.scripts.buildPageStorageScript(options),
      true
    ) as Promise<BrowserPageStorageResult>
  }

  public override async fetchResource(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserFetchResourceOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserFetchResourceResult> {
    abortSignal?.throwIfAborted()
    const externalSession = this.getExternalPageSession(sessionId)
    const targetUrl = this.normalizeFetchResourceUrl(options.url)
    const artifactPath = resolveWorkspaceFilePath(context.workspaceRoot, options.savePath)
    if (externalSession) return super.fetchResource(sessionId, context, options, abortSignal)

    const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)
    const referer =
      options.referer?.trim() || this.resolveCurrentPageUrl(session, context.url) || context.url

    const fetchOptions: ElectronNetFetchOptions = {
      session: session.webContents.session,
      headers: {
        Referer: referer,
      },
    }
    const response = await electron.net.fetch(targetUrl, fetchOptions)

    const status = response.status
    if (!response.ok) {
      throw new AppError('VALIDATION', `资源下载失败：HTTP ${status}`, undefined, {
        url: targetUrl,
        status,
      })
    }

    const contentLengthHeader = response.headers.get('content-length')
    if (contentLengthHeader) {
      const contentLength = Number(contentLengthHeader)
      if (Number.isFinite(contentLength) && contentLength > DefaultFetchResourceMaxBytes) {
        throw new AppError(
          'VALIDATION',
          `资源过大（${contentLength} 字节），超过 ${DefaultFetchResourceMaxBytes} 字节上限。`,
          undefined,
          { url: targetUrl, bytes: contentLength }
        )
      }
    }

    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > DefaultFetchResourceMaxBytes) {
      throw new AppError(
        'VALIDATION',
        `资源过大（${bytes.byteLength} 字节），超过 ${DefaultFetchResourceMaxBytes} 字节上限。`,
        undefined,
        { url: targetUrl, bytes: bytes.byteLength }
      )
    }

    await mkdir(dirname(artifactPath.path), { recursive: true })
    await writeFile(artifactPath.path, bytes)

    return {
      url: targetUrl,
      path: artifactPath.path,
      relativePath: artifactPath.relativePath,
      mimeType: response.headers.get('content-type'),
      bytes: bytes.byteLength,
      status,
      capturedAt: Date.now(),
    }
  }

  public override async listMediaSources(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserListMediaSourcesOptions = {},
    abortSignal?: AbortSignal
  ): Promise<BrowserListMediaSourcesResult> {
    abortSignal?.throwIfAborted()
    const externalSession = this.getExternalPageSession(sessionId)
    const limit = clampInteger(options.limit, 1, 200, 80)
    const includeDataUrls = !!options.includeDataUrls
    const includeBlobUrls = !!options.includeBlobUrls
    if (externalSession) return super.listMediaSources(sessionId, context, options, abortSignal)

    const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)

    const result = (await session.webContents.executeJavaScript(
      this.scripts.buildListMediaSourcesScript({
        limit,
        includeDataUrls,
        includeBlobUrls,
      }),
      true
    )) as { items?: unknown; truncated?: boolean }

    return {
      url: this.resolveCurrentPageUrl(session, context.url),
      items: this.normalizeMediaSourceItems(result.items),
      truncated: !!result.truncated,
      capturedAt: Date.now(),
    }
  }

  public override async listPageResources(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserListPageResourcesOptions = {},
    abortSignal?: AbortSignal
  ): Promise<BrowserListPageResourcesResult> {
    abortSignal?.throwIfAborted()
    const externalSession = this.getExternalPageSession(sessionId)
    const limit = clampInteger(options.limit, 1, 500, 120)
    const includeIframes = !isFalse(options.includeIframes)
    if (externalSession) return super.listPageResources(sessionId, context, options, abortSignal)

    const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)

    const result = (await session.webContents.executeJavaScript(
      this.scripts.buildPageResourcesScript({ limit, includeIframes }),
      true
    )) as {
      links?: unknown
      iframes?: unknown
      resourceOrigins?: unknown
      mediaCount?: unknown
      truncated?: boolean
    }

    return {
      url: this.resolveCurrentPageUrl(session, context.url),
      links: this.normalizePageResourceLinks(result.links),
      iframes: this.normalizePageResourceIframes(result.iframes),
      resourceOrigins: this.normalizePageResourceOrigins(result.resourceOrigins, context.url),
      mediaCount: clampInteger(readFiniteNumber(result.mediaCount), 0, 100_000, 0),
      truncated: !!result.truncated,
      capturedAt: Date.now(),
    }
  }

  public override async getPageDiagnostics(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserPageDiagnosticsOptions = {},
    abortSignal?: AbortSignal
  ): Promise<BrowserPageDiagnostics> {
    abortSignal?.throwIfAborted()
    const externalSession = this.getExternalPageSession(sessionId)
    if (externalSession) return super.getPageDiagnostics(sessionId, context, options, abortSignal)

    const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)
    const limit = clampInteger(options.limit, 1, this.diagnosticsRecorder.maxEntries, 100)
    // 嵌入式:控制台诊断在 session.diagnostics,网络诊断在 driver 的网络采集缓冲(惰性建立)。
    // 两处按 capturedAt 合并再取窗口,list_network_events 才能拿到嵌入式的网络事件。
    const driverSession = await this.electronKernel.getLivePageDriverSession(sessionId, abortSignal)
    const networkEntries =
      driverSession.driver.readDiagnostics?.({ limit, clear: options.clear }) ?? []
    const entries = [...session.diagnostics.slice(-limit), ...networkEntries]
      .sort((left, right) => left.capturedAt - right.capturedAt)
      .slice(-limit)

    if (options.clear) {
      // clear=true 用于 UI 读取后清空本次诊断窗口。
      session.diagnostics = []
    }

    return {
      url: this.resolveCurrentPageUrl(session, context.url),
      title: session.webContents.getTitle() || null,
      entries,
      summary: this.summarizePageDiagnostics(entries),
      capturedAt: Date.now(),
    }
  }

  public override async uploadFile(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserUploadFileOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserUploadFileResult> {
    abortSignal?.throwIfAborted()
    const externalSession = this.getExternalPageSession(sessionId)
    const absolutePath = this.resolveUploadFilePath(context.workspaceRoot, options.filePath)
    if (externalSession) return super.uploadFile(sessionId, context, options, abortSignal)

    const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)

    const locator = (await session.webContents.executeJavaScript(
      this.scripts.buildResolveFileInputScript(options.target),
      true
    )) as { matched: boolean; selector: Nullable<string> }

    if (!locator.matched || !locator.selector)
      return {
        matched: false,
        selector: toNullable(locator.selector),
        files: [],
        capturedAt: Date.now(),
      }

    const webContents = session.webContents
    const wasAttached = webContents.debugger.isAttached()
    try {
      if (!wasAttached) {
        webContents.debugger.attach('1.3')
      }

      await webContents.debugger.sendCommand('DOM.enable')
      const document = (await webContents.debugger.sendCommand('DOM.getDocument')) as {
        root?: { nodeId?: number }
      }
      const rootNodeId = document.root?.nodeId
      if (!isNumber(rootNodeId)) {
        throw new AppError('VALIDATION', '无法定位页面 DOM 根节点。')
      }

      const query = (await webContents.debugger.sendCommand('DOM.querySelector', {
        nodeId: rootNodeId,
        selector: locator.selector,
      })) as { nodeId?: number }

      if (!isNumber(query.nodeId))
        return {
          matched: false,
          selector: locator.selector,
          files: [],
          capturedAt: Date.now(),
        }

      await webContents.debugger.sendCommand('DOM.setFileInputFiles', {
        nodeId: query.nodeId,
        files: [absolutePath],
      })
    } finally {
      if (!wasAttached && webContents.debugger.isAttached()) {
        try {
          webContents.debugger.detach()
        } catch (error) {
          this.log.debug('分离 debugger 失败', { error: AppError.from(error).message })
        }
      }
    }

    void this.interaction.highlightTarget(session, options.target, locator.selector)

    return {
      matched: true,
      selector: locator.selector,
      files: [absolutePath],
      capturedAt: Date.now(),
    }
  }

  public override async exportPagePdf(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserExportPagePdfOptions = {},
    abortSignal?: AbortSignal
  ): Promise<BrowserExportPagePdfResult> {
    abortSignal?.throwIfAborted()
    const externalSession = this.getExternalPageSession(sessionId)
    if (externalSession) return super.exportPagePdf(sessionId, context, options, abortSignal)

    const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)
    const pdfBuffer = await session.webContents.printToPDF({
      printBackground: !isFalse(options.printBackground),
    })
    const defaultPath = `artifacts/exports/page-${new Date().toISOString().replace(/[:.]/g, '-')}.pdf`
    const artifactPath = resolveWorkspaceFilePath(
      context.workspaceRoot,
      options.savePath ?? defaultPath
    )

    await mkdir(dirname(artifactPath.path), { recursive: true })
    await writeFile(artifactPath.path, pdfBuffer)

    return {
      url: this.resolveCurrentPageUrl(session, context.url),
      path: artifactPath.path,
      relativePath: artifactPath.relativePath,
      bytes: pdfBuffer.byteLength,
      capturedAt: Date.now(),
    }
  }

  public override async waitForSelector(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserWaitForSelectorOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserWaitForSelectorResult> {
    abortSignal?.throwIfAborted()
    const externalSession = this.getExternalPageSession(sessionId)
    if (externalSession) return super.waitForSelector(sessionId, context, options, abortSignal)

    const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)

    return session.webContents.executeJavaScript(
      this.scripts.buildWaitForSelectorScript(options),
      true
    ) as Promise<BrowserWaitForSelectorResult>
  }

  public override async waitForPage(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserPageWaitOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserPageWaitResult> {
    abortSignal?.throwIfAborted()
    const externalSession = this.getExternalPageSession(sessionId)
    if (externalSession) return super.waitForPage(sessionId, context, options, abortSignal)

    const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)
    if (options.loadState === 'networkidle') {
      await this.pageWaiter.waitForNetworkIdle(
        session.webContents,
        500,
        options.timeoutMs ?? 5000
      )
    }

    return session.webContents.executeJavaScript(
      this.scripts.buildPageWaitScript(options),
      true
    ) as Promise<BrowserPageWaitResult>
  }
}
