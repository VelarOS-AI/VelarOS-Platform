import { isString, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import type { BrowserPageDriver, BrowserPageDriverState } from './BrowserPageDriver'
import type { BrowserPageScriptBuilder } from './BrowserPageScriptBuilder'
import { BrowserPendingEventsBroker } from './BrowserPendingEventsBroker'
import { BrowserPerformanceOrchestrator } from './BrowserPerformanceOrchestrator'
import {
  type BrowserPageDriverKernel,
  type BrowserPageDriverSession,
  type ExternalBrowserPageSession,
} from './BrowserRuntimeInternals'
import { BrowserSessionActionQueue } from './BrowserSessionActionQueue'
import { BrowserTargetRefStore } from './BrowserTargetRefStore'
import { type BrowserExternalPageLauncher } from './CdpExternalBrowserLauncher'
import { CdpInteractionEngine } from './CdpInteractionEngine'
import { type BrowserDiagnosticsLimits, CdpPageDataEngine } from './CdpPageDataEngine'
import { CdpScreenshotEngine } from './CdpScreenshotEngine'
import type { BrowserCaptureScreenshotOptions, BrowserClickCoordinatesOptions, BrowserDragOptions, BrowserElementQueryOptions, BrowserEmulationOptions, BrowserEvaluateScriptOptions, BrowserExportPagePdfOptions, BrowserFetchResourceOptions, BrowserHandleDialogOptions, BrowserHandleDownloadOptions, BrowserHandlePermissionOptions, BrowserHeapSnapshotOptions, BrowserInspectPageOptions, BrowserListMediaSourcesOptions, BrowserListPageResourcesOptions, BrowserMoveMouseOptions, BrowserNetworkControlOptions, BrowserNetworkRequestDetailsOptions, BrowserNetworkResponseBodyOptions, BrowserPageDiagnosticsOptions, BrowserPageNavigationOptions, BrowserPageNavigationResult, BrowserPageScrollOptions, BrowserPageStorageOptions, BrowserPageTargetsResult, BrowserPageWaitOptions, BrowserPageWindowState, BrowserPageZoomOptions, BrowserPerformanceInsightOptions, BrowserPerformanceTraceStartOptions, BrowserPressKeyOptions, BrowserScreencastStartOptions, BrowserScreencastStopOptions, BrowserSiteContext, BrowserSwitchPageTargetOptions, BrowserSwitchPageTargetResult, BrowserTargetActionOptions, BrowserTypeTextOptions, BrowserUploadFileOptions, BrowserUserScriptManageRequest, BrowserUserScriptMutationResult, BrowserViewportOptions, BrowserWaitForSelectorOptions, ProjectReadFileResult, WorkspaceFileEntry, WorkspaceListOptions, WorkspaceWriteFileOptions, WorkspaceWriteFileResult } from './types.js'

const CdpBrowserRuntimeMaxDiagnosticEntries = 300

/**
 * 浏览器工作区文件访问（宿主按 member/site 注入数据根 browser 分区）。
 * 使用 Browser 领域自己的 artifact DTO，与 `ToolBrowserApi` 的
 * listFiles/readFile/writeFile 单源一致。
 */
export interface CdpWorkspaceFileAccess {
  listFiles(options?: WorkspaceListOptions): Promise<WorkspaceFileEntry[]>
  readFile(
    path: string,
    startLine?: number,
    endLine?: number,
    maxChars?: number
  ): Promise<ProjectReadFileResult>
  writeFile(
    path: string,
    content: string,
    options?: WorkspaceWriteFileOptions
  ): Promise<WorkspaceWriteFileResult>
}

/** host-injected 依赖:工作区文件访问、脚本构建、前/后台 launcher。 */
export interface CdpBrowserRuntimeOptions {
  /** 浏览器工作区文件访问（宿主按 member/site 注入数据根 browser 分区）。 */
  artifactAccess: CdpWorkspaceFileAccess
  /** 页面注入脚本构建器（`@velaros-ai/browser/core` 的 BrowserPageScriptBuilder）。 */
  scripts: BrowserPageScriptBuilder
  /** 前台可见外部浏览器 launcher（协助登录，`CdpExternalBrowserLauncher`）。 */
  foregroundBrowserLauncher?: LooseOptional<BrowserExternalPageLauncher>
  /** 后台 headless launcher（默认 `CloakBrowserLauncher`）。 */
  backgroundBrowserLauncher?: LooseOptional<BrowserExternalPageLauncher>
}

/**
 * host 无关的 CDP 浏览器运行时装配体（**净新建**）。
 *
 * ⚠️ **未经完整浏览器旅程电池验证**。本类把 `@velaros-ai/browser/core` 的零件
 * (actionQueue + 三引擎 external 核 + pending
 * broker + artifact manager + 双 launcher)组装成一个无 Electron 的浏览器自动化运行时,
 * 通过 `bindBrowserApi(sessionId, context)` 暴露结构上满足 `@velaros-ai/browser/tools` 的
 * `BrowserToolContext.browser`（`ToolBrowserApi`）的会话绑定面。它作为 Capabilities 中的
 * 可注入 Browser runtime 维护；生产宿主启用前仍必须通过无 Electron 的真实旅程验证。
 *
 * CDP 侧诚实缺席能力(见 `CdpScreenshotEngine` 与 README 能力矩阵):截图标注/模型图/diff、
 * 录屏 GIF 合成、隐藏 BrowserWindow 模型视图叠加——均无栅格编解码器等价物,不硬造。
 */
export class CdpBrowserRuntime {
  private readonly log = logRuntime.tag('CdpBrowserRuntime')
  private readonly actionQueue = new BrowserSessionActionQueue()
  private readonly targetRefs = new BrowserTargetRefStore()
  private readonly pendingEvents = new BrowserPendingEventsBroker()
  private readonly artifactAccess: CdpWorkspaceFileAccess
  private readonly foregroundBrowserLauncher?: LooseOptional<BrowserExternalPageLauncher>
  private readonly backgroundBrowserLauncher?: LooseOptional<BrowserExternalPageLauncher>

  /** 外部 CDP 页面会话注册表（headless 无 webview,全部是 external）。 */
  private readonly sessions = new Map<string, ExternalBrowserPageSession>()
  private readonly siteContexts = new Map<string, BrowserSiteContext>()

  /** engines 依赖的 driver 多态内核面（全部会话都是 external）。 */
  private readonly kernel: BrowserPageDriverKernel = {
    getLivePageDriverSession: (sessionId) => Promise.resolve(this.getPageDriverSession(sessionId)),
    getExternalPageSession: (sessionId) => toNullable(this.sessions.get(sessionId)),
    refreshPageDriverSessionState: (sessionId, pageSession, fallbackUrl) =>
      this.refreshDriverSessionState(pageSession.driver, this.sessions.get(sessionId), fallbackUrl),
    refreshExternalPageState: (sessionId, session, fallbackUrl) =>
      this.refreshDriverSessionState(session.driver, session, fallbackUrl),
    updateExternalPageStateFromInspection: (sessionId, session, inspection) => {
      const typed = inspection as { url?: string; title?: string }
      if (isString(typed.url) && typed.url) session.url = typed.url
      if (isString(typed.title)) session.title = typed.title
    },
    syncExternalPageStateFromScriptResult: (sessionId, session, result, fallbackUrl) => {
      const typed = result as Nullable<{ url?: string }>
      session.url = (typed && isString(typed.url) && typed.url) || session.url || fallbackUrl
    },
    syncSessionSiteContext: (sessionId, url) => {
      const session = this.sessions.get(sessionId)
      if (session) session.url = url
    },
    // @arch-guard:suspend code-style/forbid-raw-timers 理由：一次性 delay Promise 且 unref 防挂进程；纯内核面无生命周期作用域可挂 TimerScope。
    delay: (ms) => new Promise((resolveDelay) => {
      const timer = setTimeout(resolveDelay, ms)
      timer.unref?.()
    }),
  }

  private readonly performance = new BrowserPerformanceOrchestrator(this.kernel)
  private readonly interaction: CdpInteractionEngine
  private readonly screenshot = new CdpScreenshotEngine(this.kernel)
  private readonly pageData: CdpPageDataEngine

  constructor(options: CdpBrowserRuntimeOptions) {
    this.artifactAccess = options.artifactAccess
    this.foregroundBrowserLauncher = options.foregroundBrowserLauncher
    this.backgroundBrowserLauncher = options.backgroundBrowserLauncher
    this.interaction = new CdpInteractionEngine(this.kernel, options.scripts, this.targetRefs)
    const diagnosticsLimits: BrowserDiagnosticsLimits = {
      maxEntries: CdpBrowserRuntimeMaxDiagnosticEntries,
    }
    this.pageData = new CdpPageDataEngine(
      this.kernel,
      options.scripts,
      this.targetRefs,
      diagnosticsLimits
    )
  }

  /** 注册一个已由 launcher 建立的外部 CDP 页面会话（enterSite 落地点）。 */
  public registerSession(
    sessionId: string,
    session: ExternalBrowserPageSession,
    context: BrowserSiteContext
  ): void {
    this.sessions.set(sessionId, session)
    this.siteContexts.set(sessionId, context)
  }

  /** 回收会话:释放外部浏览器 host 与缓存态。 */
  public disposeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    session?.unsubscribeDownloads?.()
    session?.disposeHost?.()
    this.sessions.delete(sessionId)
    this.siteContexts.delete(sessionId)
    this.pendingEvents.clearSession(sessionId)
    this.targetRefs.clear(sessionId)
    this.actionQueue.clear(sessionId)
  }

  public dispose(): void {
    for (const sessionId of [...this.sessions.keys()]) this.disposeSession(sessionId)
    this.pendingEvents.dispose()
    this.performance.dispose()
  }

  /** 暴露双 launcher 供宿主启动会话（前台协助登录 / 后台 headless）。 */
  public getLaunchers(): {
    foreground: LooseOptional<BrowserExternalPageLauncher>
    background: LooseOptional<BrowserExternalPageLauncher>
  } {
    return {
      foreground: this.foregroundBrowserLauncher,
      background: this.backgroundBrowserLauncher,
    }
  }

  private getPageDriverSession(sessionId: string): BrowserPageDriverSession {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new AppError('NOT_FOUND', `外部浏览器会话不存在：${sessionId}`)
    }
    return { driver: session.driver, externalSession: session }
  }

  private async refreshDriverSessionState(
    driver: BrowserPageDriver,
    session: LooseOptional<ExternalBrowserPageSession>,
    fallbackUrl: string
  ): Promise<BrowserPageDriverState> {
    const state = await driver.refreshPageState()
    if (session) {
      session.url = state.url || session.url || fallbackUrl
      session.title = state.title || session.title
    }
    return { url: state.url || fallbackUrl, title: state.title }
  }

  /**
   * 会话绑定的浏览器能力面:结构上满足 `@velaros-ai/browser/tools` 的 `ToolBrowserApi`
   * （`BrowserToolContext.browser`）。不 import 该类型以免与 browser-tools 形成包环——
   * 与 `ElectronBrowserRuntime` 同款结构实现,契约一致性由 browser 40 工具 schema 基线 +
   * 构造冒烟的方法面校验守护。
   */
  public bindBrowserApi(sessionId: string, context: BrowserSiteContext) {
    const run = <T>(action: () => Promise<T>): Promise<T> => this.actionQueue.run(sessionId, action)
    const readOnly = <T>(action: () => Promise<T>): Promise<T> =>
      this.actionQueue.runReadOnly(sessionId, action)

    return {
      isActive: (): boolean => this.sessions.has(sessionId),
      getContext: (): Nullable<BrowserSiteContext> => toNullable(this.siteContexts.get(sessionId)),
      enterSite: (url: string): Promise<BrowserSiteContext> => {
        const next = { url, workspaceRoot: context.workspaceRoot }
        this.siteContexts.set(sessionId, next)
        return Promise.resolve(next)
      },
      leaveSite: (): Promise<void> => {
        this.disposeSession(sessionId)
        return Promise.resolve()
      },
      // headless CDP 无宿主 UI 窗口:show 诚实降级为「不可见的受控页面」状态。
      showPage: (): Promise<BrowserPageWindowState> =>
        Promise.resolve(this.buildWindowState(sessionId, false)),
      inspectPage: (options?: BrowserInspectPageOptions) =>
        run(() => this.pageData.inspectPage(sessionId, context, options)),
      captureScreenshot: (options?: BrowserCaptureScreenshotOptions) =>
        run(() => this.screenshot.captureScreenshot(sessionId, context, options)),
      performTargetAction: (options: BrowserTargetActionOptions) =>
        run(() => this.interaction.performTargetAction(sessionId, context, options)),
      navigatePage: (options: BrowserPageNavigationOptions) =>
        run(() => this.navigatePage(sessionId, context, options)),
      scrollPage: (options?: BrowserPageScrollOptions) =>
        run(() => this.interaction.scrollPage(sessionId, context, options)),
      queryElements: (options: BrowserElementQueryOptions) =>
        run(() => this.pageData.queryElements(sessionId, context, options)),
      getPageDiagnostics: (options?: BrowserPageDiagnosticsOptions) =>
        readOnly(() => this.pageData.getPageDiagnostics(sessionId, context, options)),
      typeText: (options: BrowserTypeTextOptions) =>
        run(() => this.interaction.typeText(sessionId, context, options)),
      pressKey: (options: BrowserPressKeyOptions) =>
        run(() => this.interaction.pressKey(sessionId, context, options)),
      moveMouse: (options: BrowserMoveMouseOptions) =>
        run(() => this.interaction.moveMouse(sessionId, context, options)),
      clickCoordinates: (options: BrowserClickCoordinatesOptions) =>
        run(() => this.interaction.clickCoordinates(sessionId, context, options)),
      dragTargets: (options: BrowserDragOptions) =>
        run(() => this.interaction.dragTargets(sessionId, context, options)),
      waitForSelector: (options: BrowserWaitForSelectorOptions) =>
        run(() => this.pageData.waitForSelector(sessionId, context, options)),
      waitForPage: (options: BrowserPageWaitOptions) =>
        run(() => this.pageData.waitForPage(sessionId, context, options)),
      setViewport: (options: BrowserViewportOptions) =>
        run(() => this.interaction.setViewport(sessionId, context, options)),
      setPageZoom: (options: BrowserPageZoomOptions) =>
        run(() => this.interaction.setPageZoom(sessionId, context, options)),
      configureNetwork: (options: BrowserNetworkControlOptions) =>
        run(() => this.pageData.configureNetwork(sessionId, context, options)),
      readNetworkResponseBody: (options: BrowserNetworkResponseBodyOptions) =>
        run(() => this.pageData.readNetworkResponseBody(sessionId, context, options)),
      readNetworkRequestDetails: (options: BrowserNetworkRequestDetailsOptions) =>
        run(() => this.pageData.readNetworkRequestDetails(sessionId, context, options)),
      configureEmulation: (options: BrowserEmulationOptions) =>
        run(() => this.pageData.configureEmulation(sessionId, context, options)),
      startPerformanceTrace: (options: BrowserPerformanceTraceStartOptions) =>
        run(() => this.performance.startTrace(sessionId, context, options)),
      stopPerformanceTrace: () => run(() => this.performance.stopTrace(sessionId, context)),
      analyzePerformanceInsight: (options: BrowserPerformanceInsightOptions) =>
        run(() => this.performance.analyzeInsight(sessionId, options)),
      captureHeapSnapshot: (options?: BrowserHeapSnapshotOptions) =>
        run(() => this.performance.captureHeapSnapshot(sessionId, context, options ?? {})),
      startScreencast: (_options?: BrowserScreencastStartOptions) =>
        run(() => this.screenshot.startScreencast(sessionId, context)),
      stopScreencast: (_options?: BrowserScreencastStopOptions) =>
        run(() => this.screenshot.stopScreencast(sessionId, context)),
      listPendingEvents: () =>
        readOnly(() =>
          Promise.resolve({
            pending: this.pendingEvents.listPendingEvents(sessionId),
            capturedAt: Date.now(),
          })
        ),
      listPageTargets: (): Promise<BrowserPageTargetsResult> =>
        readOnly(() => this.listPageTargets(sessionId, context)),
      switchPageTarget: (options: BrowserSwitchPageTargetOptions) =>
        run(() => this.switchPageTarget(sessionId, context, options)),
      handleDialog: (options: BrowserHandleDialogOptions) =>
        run(() => Promise.resolve(this.pendingEvents.resolveDialog({ sessionId, ...options }))),
      handleDownload: (options: BrowserHandleDownloadOptions) =>
        run(() => Promise.resolve(this.pendingEvents.resolveDownload({ sessionId, ...options }))),
      handlePermission: (options: BrowserHandlePermissionOptions) =>
        run(() => Promise.resolve(this.pendingEvents.resolvePermission({ sessionId, ...options }))),
      uploadFile: (options: BrowserUploadFileOptions) =>
        run(() => this.pageData.uploadFile(sessionId, context, options)),
      fetchResource: (options: BrowserFetchResourceOptions) =>
        run(() => this.pageData.fetchResource(sessionId, context, options)),
      listMediaSources: (options?: BrowserListMediaSourcesOptions) =>
        readOnly(() => this.pageData.listMediaSources(sessionId, context, options)),
      listPageResources: (options?: BrowserListPageResourcesOptions) =>
        readOnly(() => this.pageData.listPageResources(sessionId, context, options)),
      exportPagePdf: (options?: BrowserExportPagePdfOptions) =>
        run(() => this.pageData.exportPagePdf(sessionId, context, options)),
      readPageStorage: (options?: BrowserPageStorageOptions) =>
        readOnly(() => this.pageData.readPageStorage(sessionId, context, options)),
      evaluateScript: (options: BrowserEvaluateScriptOptions) =>
        run(() => this.pageData.evaluateScript(sessionId, context, options)),
      getPageState: () => readOnly(() => this.getPageState(sessionId, context)),
      listFiles: (options?: WorkspaceListOptions) => this.artifactAccess.listFiles(options),
      readFile: (path: string, startLine?: number, endLine?: number, maxChars?: number) =>
        this.artifactAccess.readFile(path, startLine, endLine, maxChars),
      writeFile: (path: string, content: string, options?: WorkspaceWriteFileOptions) =>
        this.artifactAccess.writeFile(path, content, options),
      manageUserScripts: (request: BrowserUserScriptManageRequest) =>
        run(() => this.manageUserScripts(sessionId, request)),
    }
  }

  private buildWindowState(sessionId: string, visible: boolean): BrowserPageWindowState {
    const session = this.sessions.get(sessionId)
    return {
      active: this.sessions.has(sessionId),
      visible,
      driverKind: 'external',
      url: toNullable(session?.url),
      title: toNullable(session?.title),
      canGoBack: false,
      canGoForward: false,
      viewport: toNullable(session?.viewport),
    }
  }

  private async navigatePage(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserPageNavigationOptions
  ): Promise<BrowserPageNavigationResult> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new AppError('NOT_FOUND', `外部浏览器会话不存在：${sessionId}`)
    const driver = session.driver
    if (options.action === 'goto' && options.url) {
      await driver.navigateTo(options.url)
    } else {
      // back/forward/reload:经页面脚本触发（driver 无专用导航动词）。
      const expression =
        options.action === 'back'
          ? 'history.back()'
          : options.action === 'forward'
            ? 'history.forward()'
            : 'location.reload()'
      await driver.executeJavaScript(`(() => { ${expression}; return true; })()`, true)
    }
    const state = await this.refreshDriverSessionState(driver, session, context.url)
    return {
      action: options.action ?? 'goto',
      navigated: true,
      url: state.url || context.url,
      title: state.title,
      canGoBack: false,
      canGoForward: false,
      capturedAt: Date.now(),
    }
  }

  private async listPageTargets(
    sessionId: string,
    _context: BrowserSiteContext
  ): Promise<BrowserPageTargetsResult> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new AppError('NOT_FOUND', `外部浏览器会话不存在：${sessionId}`)
    const targets = (await session.driver.listPageTargets?.()) ?? []
    return {
      driverKind: 'external',
      activeTargetId: null,
      targets,
      capturedAt: Date.now(),
    }
  }

  private async switchPageTarget(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserSwitchPageTargetOptions
  ): Promise<BrowserSwitchPageTargetResult> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new AppError('NOT_FOUND', `外部浏览器会话不存在：${sessionId}`)
    if (!session.driver.switchPageTarget) {
      throw new AppError('VALIDATION', '当前外部浏览器 driver 不支持 target 切换。')
    }
    const nextDriver = await session.driver.switchPageTarget(options)
    session.driver = nextDriver
    const state = await this.refreshDriverSessionState(nextDriver, session, context.url)
    const targets = (await nextDriver.listPageTargets?.()) ?? []
    const activeTarget = toNullable(targets.find((entry) => entry.id === options.targetId) ?? targets[0])
    return {
      driverKind: 'external',
      activeTargetId: activeTarget ? activeTarget.id : options.targetId,
      target: activeTarget ?? {
        id: options.targetId,
        type: 'page',
        url: state.url || context.url,
        title: state.title,
        active: true,
      },
      targets,
      url: state.url || context.url,
      title: state.title,
      capturedAt: Date.now(),
    }
  }

  private async getPageState(sessionId: string, context: BrowserSiteContext): Promise<{
    url: string
    title: string
    loadState: 'loaded' | 'error' | 'unknown'
    viewport: Nullable<BrowserViewportOptions>
    lastNavigationError: LooseOptional<{
      url: string
      errorCode: number
      errorDescription: string
      failedAt: number
    }>
  }> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new AppError('NOT_FOUND', `外部浏览器会话不存在：${sessionId}`)
    const state = await this.refreshDriverSessionState(session.driver, session, context.url)
    return {
      url: state.url || context.url,
      title: state.title,
      loadState: state.url ? 'loaded' : 'unknown',
      viewport: toNullable(session.viewport),
      lastNavigationError: null,
    }
  }

  private async manageUserScripts(
    _sessionId: string,
    _request: BrowserUserScriptManageRequest
  ): Promise<BrowserUserScriptMutationResult> {
    // 用户脚本管理需要绑定持久 store（BrowserUserScriptManager）——本装配体默认不接，
    // 由宿主在真机接入时按 member 数据根注入;当前诚实缺席。
    throw new AppError(
      'VALIDATION',
      'CdpBrowserRuntime 默认未接入用户脚本 store（诚实缺席）。宿主可在真机接入时注入 BrowserUserScriptManager。'
    )
  }
}
