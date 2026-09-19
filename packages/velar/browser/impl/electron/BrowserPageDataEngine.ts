import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import electron from 'electron'

import { isFalse, isNumber, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { BrowserFetchLimits } from '../../contract/constants'
import type { BrowserPageDriver } from '../../contract/requires.js'
import type {
  BrowserEvaluateScriptOptions,
  BrowserExportPagePdfOptions,
  BrowserExportPagePdfResult,
  BrowserFetchResourceOptions,
  BrowserFetchResourceResult,
  BrowserFrameInfo,
  BrowserInspectPageOptions,
  BrowserPageDiagnostics,
  BrowserPageDiagnosticsOptions,
  BrowserPageInspection,
  BrowserPageWaitOptions,
  BrowserPageWaitResult,
  BrowserScriptOutcome,
  BrowserSiteContext,
  BrowserUploadFileOptions,
  BrowserUploadFileResult,
} from '../../types/browser'
import type { BrowserSession } from '../../types/electron'
import type { BrowserRuntimeKernel } from '../../types/electron.js'
import { normalizeFetchResourceUrl, resolveUploadFilePath, summarizePageDiagnostics } from '../../utils/cdp/page-data.js'
import { buildBrowserNetworkCaptureNotice, clearBrowserDiagnosticEntries, takeBrowserDiagnosticWindow } from '../../utils/diagnostics.js'
import { evaluateInFrame, evaluateInWebContents } from '../../utils/electron/evaluate'
import { listWebContentsFrames } from '../../utils/electron/webcontents'
import { clampInteger } from '../../utils/numbers.js'
import { buildEvaluateScript } from '../../utils/page-scripts/evaluate'
import { buildResolveFileInputScript } from '../../utils/page-scripts/file-upload'
import { buildInspectionScript } from '../../utils/page-scripts/inspection'
import { buildPageWaitScript } from '../../utils/page-scripts/page-wait'
import { BrowserTuning } from '../../utils/tuning'
import { resolveWorkspaceFilePath } from '../../utils/workspace-paths.js'
import { CdpPageDataEngine } from '../engines/CdpPageDataEngine'
import type { BrowserTargetRefStore } from '../session/BrowserTargetRefStore'

import type { BrowserDiagnosticsRecorder } from './BrowserDiagnosticsRecorder'
import type { BrowserInteractionEngine } from './BrowserInteractionEngine'
import type { BrowserPageWaiter } from './BrowserPageWaiter'

type ElectronNetFetchOptions = Parameters<typeof electron.net.fetch>[1] & {
  session?: Electron.Session
}

/**
 * 页面数据域执行体（Electron 宿主）：embedded 分支（webContents 脚本执行、electron.net.fetch、
 * webContents.debugger 上传、诊断合并、PDF 打印）+ 委托 external 核（`CdpPageDataEngine`）。
 *
 * 每个 public 方法先探 external 会话：命中 → `super`（driver 路径）；否则跑 embedded 分支。
 * 方法默认在 runtime 的 actionQueue 内被调用。
 */
export interface BrowserPageDataEngineApi {
  /** 读页面：正文、标题结构、链接、可交互元素与它们的 ref。 */
  inspectPage(sessionId: string, context: BrowserSiteContext, options?: BrowserInspectPageOptions, abortSignal?: AbortSignal): Promise<BrowserPageInspection>
  /** 在页面上下文里跑一段受控脚本并取回结果。 */
  evaluateScript(sessionId: string, context: BrowserSiteContext, options: BrowserEvaluateScriptOptions, abortSignal?: AbortSignal): Promise<BrowserScriptOutcome>
  /** 列出页面的框架树（顶层页面与各层 iframe，含跨源的）。 */
  listFrames(sessionId: string, context: BrowserSiteContext, abortSignal?: AbortSignal): Promise<BrowserFrameInfo[]>
  /** 带页面会话的 cookie 下载一个 http(s) 资源到站点工作区。 */
  fetchResource(sessionId: string, context: BrowserSiteContext, options: BrowserFetchResourceOptions, abortSignal?: AbortSignal): Promise<BrowserFetchResourceResult>
  /** 读最近的 console、加载错误与网络诊断，并给一份汇总。 */
  getPageDiagnostics(sessionId: string, context: BrowserSiteContext, options?: BrowserPageDiagnosticsOptions, abortSignal?: AbortSignal): Promise<BrowserPageDiagnostics>
  /** 把站点工作区里的文件放进页面的 file input。 */
  uploadFile(sessionId: string, context: BrowserSiteContext, options: BrowserUploadFileOptions, abortSignal?: AbortSignal): Promise<BrowserUploadFileResult>
  /** 把当前页面导出成 PDF 存进站点工作区。 */
  exportPagePdf(sessionId: string, context: BrowserSiteContext, options?: BrowserExportPagePdfOptions, abortSignal?: AbortSignal): Promise<BrowserExportPagePdfResult>
  /** 等页面加载状态稳定，或等一小段时间。 */
  waitForPage(sessionId: string, context: BrowserSiteContext, options: BrowserPageWaitOptions, abortSignal?: AbortSignal): Promise<BrowserPageWaitResult>
}

export class BrowserPageDataEngine extends CdpPageDataEngine implements BrowserPageDataEngineApi {
  constructor(
    private readonly electronKernel: BrowserRuntimeKernel,
    private readonly pageWaiter: BrowserPageWaiter,
    private readonly diagnosticsRecorder: BrowserDiagnosticsRecorder,
    targetRefs: BrowserTargetRefStore,
    private readonly interaction: BrowserInteractionEngine
  ) {
    super(electronKernel, targetRefs, diagnosticsRecorder)
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
    const maxTextChars = options.maxTextChars ?? BrowserTuning.page.inspectTextChars
    const maxHtmlChars = options.maxHtmlChars ?? BrowserTuning.page.inspectHtmlChars
    const maxElements = options.maxElements ?? BrowserTuning.page.inspectElements

    // 检查脚本在页面上下文中执行，返回纯 JSON 结构。
    const driver = this.getPageDriver(sessionId, session)
    const inspection = await driver.executeJavaScript<BrowserPageInspection>(
      buildInspectionScript({
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

  public override async evaluateScript(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserEvaluateScriptOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserScriptOutcome> {
    abortSignal?.throwIfAborted()
    const externalSession = this.getExternalPageSession(sessionId)
    if (externalSession) return super.evaluateScript(sessionId, context, options, abortSignal)

    const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)
    const script = buildEvaluateScript(options)
    // 主进程上限 = 页内超时 + 注入/序列化余量。页内那道 `Promise.race` 只在渲染进程还肯
    // 回话时才有效；被脚本卡死或中途导航走时它永远不触发，兜底必须由这一侧拿着
    // （AGENT-12 的第一因：一个永不 settle 的求值占死会话队列，把整条会话焊死）。
    const deadline = { label: 'evaluateScript', timeoutMs: clampInteger(options.timeoutMs, 1, 30_000, 5_000) + 10_000 }
    return options.frame
      ? evaluateInFrame<BrowserScriptOutcome>(session.webContents, options.frame, script, true, deadline)
      : evaluateInWebContents<BrowserScriptOutcome>(session.webContents, script, true, deadline)
  }

  public override async listFrames(sessionId: string, context: BrowserSiteContext, abortSignal?: AbortSignal): Promise<BrowserFrameInfo[]> {
    abortSignal?.throwIfAborted()
    if (this.getExternalPageSession(sessionId)) return super.listFrames(sessionId, context, abortSignal)
    const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)
    return listWebContentsFrames(session.webContents)
  }

  public override async fetchResource(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserFetchResourceOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserFetchResourceResult> {
    abortSignal?.throwIfAborted()
    const externalSession = this.getExternalPageSession(sessionId)
    const targetUrl = normalizeFetchResourceUrl(options.url)
    const artifactPath = await resolveWorkspaceFilePath(
      context.workspaceRoot,
      options.savePath,
      'savePath'
    )
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
      if (Number.isFinite(contentLength) && contentLength > BrowserFetchLimits.fileBytes) {
        throw new AppError(
          'VALIDATION',
          `资源过大（${contentLength} 字节），超过 ${BrowserFetchLimits.fileBytes} 字节上限。`,
          undefined,
          { url: targetUrl, bytes: contentLength }
        )
      }
    }

    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > BrowserFetchLimits.fileBytes) {
      throw new AppError(
        'VALIDATION',
        `资源过大（${bytes.byteLength} 字节），超过 ${BrowserFetchLimits.fileBytes} 字节上限。`,
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
    const kinds = options.kinds
    // 嵌入式:控制台诊断在 session.diagnostics,网络诊断在 driver 的网络采集缓冲。
    // 两处各自先按种类过滤再取窗口,合并后按 capturedAt 排序再取一次窗口。
    const driverSession = await this.electronKernel.getLivePageDriverSession(sessionId, abortSignal)
    const wantsNetwork = !kinds || kinds.includes('network')
    // 内嵌页面的网络采集是惰性建立的:不在这里建起来,模型照提示词「先列网络事件找 requestId」
    // 永远只会拿到空数组。建立之后如实告诉它「采集从现在开始」。
    const networkCapture = wantsNetwork ? await driverSession.driver.ensureNetworkCapture?.() : null
    const networkEntries = wantsNetwork
      ? driverSession.driver.readDiagnostics?.({ limit, kinds, clear: options.clear }) ?? []
      : []
    const entries = [...takeBrowserDiagnosticWindow(session.diagnostics, limit, kinds), ...networkEntries]
      .sort((left, right) => left.capturedAt - right.capturedAt)
      .slice(-limit)

    if (options.clear) {
      // clear=true 只清这次读的种类:读一次网络事件不该把 console 与页面异常一起清掉。
      clearBrowserDiagnosticEntries(session.diagnostics, kinds)
    }

    const diagnostics: BrowserPageDiagnostics = {
      url: this.resolveCurrentPageUrl(session, context.url),
      title: session.webContents.getTitle() || null,
      entries,
      summary: summarizePageDiagnostics(entries),
      capturedAt: Date.now(),
    }
    const notice = buildBrowserNetworkCaptureNotice(networkCapture)
    if (notice) diagnostics.networkCaptureNotice = notice

    return diagnostics
  }

  public override async uploadFile(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserUploadFileOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserUploadFileResult> {
    abortSignal?.throwIfAborted()
    const externalSession = this.getExternalPageSession(sessionId)
    const absolutePath = await resolveUploadFilePath(context.workspaceRoot, options.filePath)
    if (externalSession) return super.uploadFile(sessionId, context, options, abortSignal)

    const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)
    const hydratedTarget = this.targetRefs.hydrateTarget(sessionId, options.target, 'target')

    const locator = (await evaluateInWebContents(
      session.webContents,
      buildResolveFileInputScript(hydratedTarget),
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
    const artifactPath = await resolveWorkspaceFilePath(
      context.workspaceRoot,
      options.savePath ?? defaultPath,
      'savePath'
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
    const networkIdle = options.loadState === 'networkidle'
      ? await this.pageWaiter.waitForNetworkIdle(session.webContents, BrowserTuning.page.networkIdleMs, options.timeoutMs ?? BrowserTuning.page.networkIdleTimeoutMs)
      : true
    const result = await evaluateInWebContents<BrowserPageWaitResult>(session.webContents, buildPageWaitScript(options), true)
    // 页面脚本只认 readyState：网络空闲没等到时如实回没到。
    return networkIdle ? result : { ...result, matched: false, timedOut: true }
  }
}
