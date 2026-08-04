// 域：Electron 宿主侧的浏览器运行时装配根——会话表 + 四个领域 engine 的组装与编排。
//
// **为什么需要这份导览**：本文件是「装配 + 门面」，不是「实现」。真正的页面能力分散在四个
// engine 里，读者最容易在这里找错地方（想改截图逻辑却往 runtime 加分支）。
//
// ## engine 四分与 kernel 接缝（跨层接缝）
//   performance（trace / insight / 堆快照）
//   screenshot （截图 / 标注 / 模型图 / diff / 预览流）
//   interaction（target action / 自愈 / 键鼠合成 / viewport / zoom）
//   pageData   （检查 / 存储 / 网络数据 / 媒体 / 诊断 / 上传 / 导出 / 等待）
// **方向铁律**：engine 只能经 `this.kernel`（`BrowserRuntimeKernel`）回取会话与共享工具，
// **不许反向持有 runtime**。这条窄接缝是拆分的全部意义——runtime 曾是 5797 行单体，engine
// 一旦能反向抓 runtime，几个月内就会长回去。新增页面能力应落在**某个 engine 内**，runtime
// 只加一行转发；若一条能力不属于任何 engine，先问它是不是第五个域。
//
// ## 并发与时序（改这些会破什么）
//  - **同一 session 的 WebContents 操作串行**：全部经 `actionQueue`。Electron 的 webContents
//    在导航中途接受新指令会得到不可预期的结果，串行是这里唯一的正确性来源。
//  - **`latestPresentationTargets` 只留最新**：renderer 的 URL 同步可能在 agent 导航仍占队列时
//    连续触发 present；不做「只留最新」，旧请求出队后会把页面拉回旧 URL（真机踩过的振荡）。
//  - **`activityCoordinator` 是构造期单例依赖**：广播总线由宿主装配注入，刻意**不并入**
//    `options` 回调袋——并进去会经 `setOptions` / `setCallbacks` 被反复重放。
//
// ## 三种页面后端，一条驱动接口（非显然的妥协）
// 内嵌 WebContents / 外部 Chrome（CDP）/ 后台 CloakBrowser 都收敛到 `BrowserPageDriver`。
// 外部会话住 `externalPageSessions`，不占 Electron WebContents。两类会话的状态刷新路径
// （`refreshPageDriverSessionState` vs `refreshExternalPageState`）刻意分开：内嵌侧拿得到
// Electron 原生事件，外部侧只能靠 CDP 回读，强行合并会让其中一侧退化成轮询。
import electron from 'electron'

import type { TurnContextAppendHub } from '@velaros-ai/agent/run-context'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { BrowserTurnContextDeltaSource } from '../core'
import type { BrowserCaptureScreenshotOptions, BrowserClickCoordinatesOptions, BrowserClickCoordinatesResult, BrowserDragOptions, BrowserDragResult, BrowserElementQueryOptions, BrowserElementQueryResult, BrowserEmulationOptions, BrowserEmulationResult, BrowserEvaluateScriptOptions, BrowserEvaluateScriptResult, BrowserExportPagePdfOptions, BrowserExportPagePdfResult, BrowserFetchResourceOptions, BrowserFetchResourceResult, BrowserHandleDialogOptions, BrowserHandleDialogResult, BrowserHandleDownloadOptions, BrowserHandleDownloadResult, BrowserHandlePermissionOptions, BrowserHandlePermissionResult, BrowserHeapSnapshotOptions, BrowserHeapSnapshotResult, BrowserInspectPageOptions, BrowserListMediaSourcesOptions, BrowserListMediaSourcesResult, BrowserListPageResourcesOptions, BrowserListPageResourcesResult, BrowserMoveMouseOptions, BrowserMoveMouseResult, BrowserNavigationHistoryRestore, BrowserNetworkControlOptions, BrowserNetworkControlResult, BrowserNetworkRequestDetailsOptions, BrowserNetworkRequestDetailsResult, BrowserNetworkResponseBodyOptions, BrowserNetworkResponseBodyResult, BrowserPageDiagnostics, BrowserPageDiagnosticsOptions, BrowserPageInspection, BrowserPageNavigationOptions, BrowserPageNavigationResult, BrowserPagePreviewFrame, BrowserPagePreviewStreamEvent, BrowserPageScrollOptions, BrowserPageScrollResult, BrowserPageStorageOptions, BrowserPageStorageResult, BrowserPageTargetInfo, BrowserPageTargetsResult, BrowserPageWaitOptions, BrowserPageWaitResult, BrowserPageWindowState, BrowserPageZoomOptions, BrowserPageZoomResult, BrowserPendingEventsResult, BrowserPerformanceInsightOptions, BrowserPerformanceInsightResult, BrowserPerformanceTraceStartOptions, BrowserPerformanceTraceStartResult, BrowserPerformanceTraceStopResult, BrowserPressKeyOptions, BrowserPressKeyResult, BrowserScreencastStartOptions, BrowserScreencastStartResult, BrowserScreencastStopOptions, BrowserScreencastStopResult, BrowserScreenshotArtifact, BrowserSiteContext, BrowserSwitchPageTargetOptions, BrowserSwitchPageTargetResult, BrowserTargetActionOptions, BrowserTargetActionResult, BrowserTurnContextSnapshot, BrowserTypeTextOptions, BrowserTypeTextResult, BrowserUploadFileOptions, BrowserUploadFileResult, BrowserUserScriptLastRun, BrowserUserScriptRecord, BrowserViewportOptions, BrowserViewportResult, BrowserWaitForSelectorOptions, BrowserWaitForSelectorResult } from '../core'
import {
  BrowserActivityCoordinator,
  type BrowserPageDriver,
  type BrowserPageDriverState,
  BrowserPageScriptBuilder,
  BrowserPerformanceOrchestrator,
  BrowserSessionActionQueue,
  BrowserTargetRefStore,
  type BrowserUserActivityWaitState,
  CdpExternalBrowserLauncher,
  type CdpExternalBrowserLaunchOptions,
  CloakBrowserLauncher,
} from '../core'
import {
  getBrowserUrlCandidate,
  resolveBrowserSearchFallbackUrl,
} from '../core'

import { BrowserDiagnosticsRecorder } from './BrowserDiagnosticsRecorder'
import { BrowserInteractionEngine } from './BrowserInteractionEngine'
import { BrowserPageDataEngine } from './BrowserPageDataEngine'
import { BrowserPageWaiter } from './BrowserPageWaiter'
import {
  type BrowserRuntimeKernel,
  type BrowserRuntimePageDriverSession,
  clampInteger,
  type ExternalBrowserPageSession,
  resolveWorkspaceFilePath,
} from './BrowserRuntimeInternals'
import {
  type BrowserExternalPageLauncher,
  type BrowserSession,
  type ElectronBrowserRuntimeOptions,
} from './BrowserRuntimeTypes'
import { BrowserScreenshotEngine } from './BrowserScreenshotEngine'
import { BrowserSessionManager } from './BrowserSessionManager'
import {
  type BrowserPageDriverFactory,
  createElectronWebContentsBrowserPageDriver,
} from './ElectronWebContentsBrowserPageDriver'

function buildBrowserUserScriptExecutionSource(
  script: BrowserUserScriptRecord,
  code: string,
  force: boolean
): string {
  const scriptKey = `${script.id}@${script.revision}`
  const idlePrelude =
    script.runAt === 'document-idle'
      ? `await new Promise((resolve) => {
        if (typeof globalThis.requestIdleCallback === 'function') {
          globalThis.requestIdleCallback(() => resolve(undefined), { timeout: 1500 });
        } else {
          globalThis.setTimeout(() => resolve(undefined), 0);
        }
      });`
      : ''
  return `(async () => {
    const stateKey = '__velarosUserScriptsV1__';
    const state = globalThis[stateKey] || Object.defineProperty(globalThis, stateKey, {
      value: { documentId: 'doc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2), attempts: Object.create(null) },
      configurable: false,
      enumerable: false,
      writable: false
    })[stateKey];
    const key = ${JSON.stringify(scriptKey)};
    if (!${JSON.stringify(force)} && state.attempts[key]) {
      return { ok: state.attempts[key] === 'success', alreadyInjected: true, documentId: state.documentId };
    }
    state.attempts[key] = 'running';
    try {
      ${idlePrelude}
      await (async () => (0, eval)(${JSON.stringify(code)}))();
      state.attempts[key] = 'success';
      return { ok: true, alreadyInjected: false, documentId: state.documentId };
    } catch (error) {
      state.attempts[key] = 'error';
      return {
        ok: false,
        alreadyInjected: false,
        documentId: state.documentId,
        error: error && typeof error.message === 'string' ? error.message : String(error)
      };
    }
  })()`
}
import { isNonBlankString, isObject, isPresent,isString, optionalWhen, toNullable } from '@velaros-ai/core'

const TurnContextRecentErrorWindowMs = 5 * 60 * 1000

interface BrowserPagePresentationTarget {
  context: BrowserSiteContext
  webContentsId: number
  navigationHistory?: BrowserNavigationHistoryRestore
}

/**
 * Electron 内嵌浏览器运行时。
 *
 * 实现 ToolBrowserRuntimeApi，统一管理 WebContents 会话、导航、页面检查、
 * 截图、输入事件、脚本执行和诊断读取。所有同 session 操作通过队列串行化。
 */
class ElectronBrowserRuntime {
  private readonly log = logRuntime.tag('ElectronBrowserRuntime')
  /** 串行化同一个 session 的 WebContents 操作。 */
  private readonly actionQueue = new BrowserSessionActionQueue()
  /** 收集 console/load/render 诊断。 */
  private readonly diagnostics = new BrowserDiagnosticsRecorder()
  /** 处理导航和动作后的等待逻辑。 */
  private readonly pageWaiter = new BrowserPageWaiter()
  /** 页面注入脚本构造器。 */
  private readonly scripts = new BrowserPageScriptBuilder()
  /** 当前页面自动化驱动。默认包裹 Electron WebContents，未来可接外部浏览器驱动。 */
  private createPageDriver: BrowserPageDriverFactory
  /** 外部浏览器启动器，负责启动 Chrome/Chromium 并返回 page-level CDP driver。 */
  private externalBrowserLauncher: BrowserExternalPageLauncher
  /** 后台浏览器启动器，默认使用 CloakBrowser/Playwright，不占用前台 WebView。 */
  private backgroundBrowserLauncher: BrowserExternalPageLauncher
  /** 会话和 WebContents 事件管理器。 */
  private readonly sessionManager: BrowserSessionManager
  /** 外部浏览器页面会话；当前通过 CDP driver 接入，不依赖 Electron WebContents。 */
  private readonly externalPageSessions = new Map<string, ExternalBrowserPageSession>()
  /**
   * Renderer URL 同步可能在 Agent 导航仍占用 action queue 时连续触发 present。
   * 只保留每个 session 最新的展示目标，避免旧请求出队后把页面拉回旧 URL。
   */
  private readonly latestPresentationTargets = new Map<string, BrowserPagePresentationTarget>()
  /** 各领域 engine 依赖的内核面；只暴露取会话/刷状态/共享工具，防止 engine 反向抓 runtime。 */
  private readonly kernel: BrowserRuntimeKernel = {
    getLivePageDriverSession: (sessionId, abortSignal) =>
      this.getLivePageDriverSessionUnlocked(sessionId, abortSignal),
    getLivePageSession: (sessionId, abortSignal) =>
      this.getLivePageSessionUnlocked(sessionId, abortSignal),
    refreshPageDriverSessionState: (sessionId, pageSession, fallbackUrl) =>
      this.refreshPageDriverSessionState(sessionId, pageSession, fallbackUrl),
    getExternalPageSession: (sessionId) => this.getExternalPageSession(sessionId),
    resolveCurrentPageUrl: (session, fallbackUrl) =>
      this.resolveCurrentPageUrl(session, fallbackUrl),
    wrapPageDriver: (sessionId, session) => this.getPageDriver(sessionId, session),
    syncSessionSiteContext: (sessionId, url) =>
      this.sessionManager.syncSessionSiteContext(sessionId, url),
    refreshExternalPageState: (sessionId, session, fallbackUrl) =>
      this.refreshExternalPageState(sessionId, session, fallbackUrl),
    updateExternalPageStateFromInspection: (sessionId, session, inspection) =>
      this.updateExternalPageStateFromInspection(
        sessionId,
        session,
        inspection as BrowserPageInspection
      ),
    syncExternalPageStateFromScriptResult: (sessionId, session, result, fallbackUrl) =>
      this.syncExternalPageStateFromScriptResult(sessionId, session, result, fallbackUrl),
    delay: (ms) => this.delay(ms),
  }
  /** 最近一次页面检查或 annotated screenshot 产出的 ref 定位表（截图/交互域共享）。 */
  private readonly targetRefs = new BrowserTargetRefStore()
  /** 性能域执行体（trace/insight/堆快照）。 */
  private readonly performance = new BrowserPerformanceOrchestrator(this.kernel)
  /** 截图域执行体（截图/标注/模型图/diff/元数据）。 */
  private readonly screenshot = new BrowserScreenshotEngine(
    this.kernel,
    this.pageWaiter,
    this.targetRefs
  )
  /** 交互域执行体（target action/自愈/键鼠合成/指针动画/viewport/zoom）。 */
  private readonly interaction = new BrowserInteractionEngine(
    this.kernel,
    this.scripts,
    this.pageWaiter,
    this.targetRefs,
    (sessionId, pointer) => this.screenshot.notifyPreviewPointer(sessionId, pointer)
  )
  /** 页面数据域执行体（检查/存储/网络数据/媒体/诊断/上传/导出/等待）。 */
  private readonly pageData = new BrowserPageDataEngine(
    this.kernel,
    this.scripts,
    this.pageWaiter,
    this.diagnostics,
    this.targetRefs,
    this.interaction
  )
  /** 用户与模型浏览器操作协调器。 */
  private readonly activityCoordinator: BrowserActivityCoordinator

  constructor(
    options: ElectronBrowserRuntimeOptions = {},
    turnContextAppendHub?: TurnContextAppendHub
  ) {
    // 可见活动写入广播总线由宿主装配注入（每宿主一个实例）；不并入 options 回调袋，
    // 避免经 setOptions/setCallbacks 反复重放这个构造期单例依赖。
    this.activityCoordinator = new BrowserActivityCoordinator({ turnContextAppendHub })
    this.createPageDriver = options.createPageDriver ?? createElectronWebContentsBrowserPageDriver
    this.externalBrowserLauncher =
      options.externalBrowserLauncher ?? new CdpExternalBrowserLauncher()
    this.backgroundBrowserLauncher = options.backgroundBrowserLauncher ?? new CloakBrowserLauncher()
    this.sessionManager = new BrowserSessionManager({
      callbacks: this.withActivityCallbacks(options),
      diagnostics: this.diagnostics,
      pageWaiter: this.pageWaiter,
      normalizeUrl: (rawUrl) => this.normalizeUrl(rawUrl),
    })
  }

  /** 更新运行时回调。 */
  public setOptions(options: ElectronBrowserRuntimeOptions): void {
    if (options.createPageDriver) {
      this.createPageDriver = options.createPageDriver
    }
    if (options.externalBrowserLauncher) {
      this.externalBrowserLauncher = options.externalBrowserLauncher
    }
    if (options.backgroundBrowserLauncher) {
      this.backgroundBrowserLauncher = options.backgroundBrowserLauncher
    }
    this.sessionManager.setCallbacks(this.withActivityCallbacks(options))
  }

  /** 等待用户停止操作当前浏览器页面。 */
  public waitForUserActivityIdle(
    sessionId: string,
    abortSignal?: AbortSignal,
    onWaitStateChange?: (sessionId: string, state: BrowserUserActivityWaitState) => void
  ): Promise<{ waited: boolean; waitedMs: number }> {
    return this.activityCoordinator.waitForUserIdle(sessionId, abortSignal, onWaitStateChange)
  }

  /** 标记模型浏览器动作租约，避免把模型自身动作记录成用户活动。 */
  public withModelAction<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    return this.activityCoordinator.withModelAction(sessionId, action)
  }

  /** 环境回合上下文：用户浏览器活动 source adapter（browser.manual-activity）。 */
  public createUserActivityTurnContextSource(): BrowserTurnContextDeltaSource {
    return this.activityCoordinator.createTurnContextSource()
  }

  // B1: 轻量页面状态查询（只读，走 runReadOnly）
  public async getPageState(
    sessionId: string,
    context: BrowserSiteContext,
    abortSignal?: AbortSignal
  ): Promise<{
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
    return this.actionQueue.runReadOnly(sessionId, async () => {
      abortSignal?.throwIfAborted()
      const externalSession = this.getExternalPageSession(sessionId)
      if (externalSession) {
        const state = await this.refreshExternalPageState(sessionId, externalSession)
        return {
          url: state.url || context.url,
          title: state.title,
          loadState: state.url ? 'loaded' : 'unknown',
          viewport: toNullable(externalSession.viewport),
          lastNavigationError: null,
        }
      }

      const session = this.sessionManager.getSession(sessionId)
      if (!session) throw new AppError('NOT_FOUND', `浏览器会话不存在：${sessionId}`)
      const wc = session.webContents
      // getPageState 不注入脚本，只读取 WebContents 已知状态。
      const url = this.getLoadedPageUrl(session) ?? session.url ?? ''
      const title = wc.getTitle() || ''
      const loadState = session.lastNavigationError ? 'error' : url ? 'loaded' : 'unknown'
      return {
        url,
        title,
        loadState,
        viewport: toNullable(session.viewport),
        lastNavigationError: toNullable(session.lastNavigationError),
      }
    })
  }

  /**
   * 每回合浏览器上下文快照：只读取事件驱动的缓存态，同步返回。
   *
   * 与 getPageState 不同，这里不进 actionQueue、不等待在跑动作、不触发 CDP 往返，
   * 专供消息发送路径附加上下文使用；会话不存在或已销毁时返回 null。
   */
  public getTurnContextSnapshot(sessionId: string): Nullable<BrowserTurnContextSnapshot> {
    const pending = this.sessionManager.getPendingEventsBroker().listPendingEvents(sessionId)
    const pendingEvents = {
      dialog: pending.filter((event) => event.kind === 'dialog').length,
      download: pending.filter((event) => event.kind === 'download').length,
      permission: pending.filter((event) => event.kind === 'permission').length,
    }

    const externalSession = this.externalPageSessions.get(sessionId)
    if (externalSession)
      return {
        url: externalSession.url,
        title: externalSession.title,
        loadState: externalSession.url ? 'loaded' : 'unknown',
        lastNavigationError: null,
        visible: externalSession.visible,
        viewport: toNullable(externalSession.viewport),
        pendingEvents,
        recentErrorCount: 0,
        capturedAt: Date.now(),
      }

    const session = this.sessionManager.getSession(sessionId)
    if (!session || session.webContents.isDestroyed()) return null

    const url = this.getLoadedPageUrl(session) ?? session.url
    const lastNavigationError = session.lastNavigationError
    return {
      url,
      title: session.webContents.getTitle() || null,
      loadState: lastNavigationError ? 'error' : url ? 'loaded' : 'unknown',
      lastNavigationError: lastNavigationError
        ? {
            url: lastNavigationError.url,
            errorCode: lastNavigationError.errorCode,
            errorDescription: lastNavigationError.errorDescription,
          }
        : null,
      visible: session.visible,
      viewport: toNullable(session.viewport),
      pendingEvents,
      recentErrorCount: session.diagnostics.filter(
        (entry) =>
          entry.level === 'error' && entry.capturedAt >= Date.now() - TurnContextRecentErrorWindowMs
      ).length,
      capturedAt: Date.now(),
    }
  }

  /** 枚举当前受控页面 target。WebView 暴露单页 synthetic target，外部 CDP 读取真实 target list。 */
  public async listPageTargets(
    sessionId: string,
    context: BrowserSiteContext,
    abortSignal?: AbortSignal
  ): Promise<BrowserPageTargetsResult> {
    return this.actionQueue.runReadOnly(sessionId, async () => {
      abortSignal?.throwIfAborted()
      const externalSession = this.getExternalPageSession(sessionId)
      if (externalSession) {
        const state = await this.refreshExternalPageState(sessionId, externalSession, context.url)
        const driverTargets = externalSession.driver.listPageTargets
          ? await externalSession.driver.listPageTargets()
          : []
        const targets = driverTargets.at(0)
          ? driverTargets
          : [this.buildExternalCurrentPageTarget(externalSession, state)]
        const activeTargetId = toNullable(targets.find((target) => target.active)?.id)

        return {
          driverKind: 'external',
          activeTargetId,
          targets,
          capturedAt: Date.now(),
        }
      }

      const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)
      const target = this.buildWebviewCurrentPageTarget(session, context.url)

      return {
        driverKind: 'webview',
        activeTargetId: target.id,
        targets: [target],
        capturedAt: Date.now(),
      }
    })
  }

  /** 切换当前受控的外部 CDP page target。 */
  public async switchPageTarget(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserSwitchPageTargetOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserSwitchPageTargetResult> {
    return this.actionQueue.run(sessionId, async () => {
      abortSignal?.throwIfAborted()
      const targetId = options.targetId.trim()
      if (!targetId) throw new AppError('VALIDATION', '浏览器 page target id 不能为空。')

      const externalSession = this.getExternalPageSession(sessionId)
      if (!externalSession) {
        throw new AppError('VALIDATION', '当前受控浏览器不是外部 CDP 页面，无法切换 page target。')
      }
      if (!externalSession.driver.switchPageTarget) {
        throw new AppError('VALIDATION', '当前外部浏览器 driver 不支持 page target 切换。')
      }

      const nextDriver = await externalSession.driver.switchPageTarget({ targetId })
      this.attachExternalPageDriver(sessionId, nextDriver, {
        disposeHost: externalSession.disposeHost,
        disposePreviousHost: false,
      })
      const nextSession = this.getExternalPageSession(sessionId)
      if (!nextSession) {
        throw new AppError('EXECUTION_FAILED', '外部浏览器 page target 切换后无法挂接。')
      }

      await nextSession.driver.bringToFront()
      nextSession.visible = true
      const state = await this.refreshExternalPageState(sessionId, nextSession, context.url)
      const targets = nextSession.driver.listPageTargets
        ? await nextSession.driver.listPageTargets()
        : [this.buildExternalCurrentPageTarget(nextSession, state)]
      const activeTarget =
        targets.find((target) => target.active) ??
        targets.find((target) => target.id === targetId) ??
        this.buildExternalCurrentPageTarget(nextSession, state)
      const capturedAt = Date.now()

      return {
        driverKind: 'external',
        activeTargetId: toNullable(activeTarget.id),
        target: activeTarget,
        targets,
        url: state.url || activeTarget.url || context.url,
        title: toNullable(state.title || activeTarget.title),
        capturedAt,
      }
    })
  }

  /** 确保浏览器会话打开到 context.url。 */
  public async openPage(
    sessionId: string,
    context: BrowserSiteContext,
    abortSignal?: AbortSignal
  ): Promise<void> {
    await this.actionQueue.run(sessionId, async () => {
      const externalSession = this.getExternalPageSession(sessionId)
      if (externalSession) {
        await this.ensureExternalContextPageUnlocked(sessionId, externalSession, context)
        return
      }

      await this.ensureContextPageUnlocked(sessionId, context, abortSignal)
    })
  }

  /** 展示浏览器页面并聚焦 WebContents。 */
  public async showPage(
    sessionId: string,
    context: BrowserSiteContext,
    abortSignal?: AbortSignal
  ): Promise<BrowserPageWindowState> {
    return this.actionQueue.run(sessionId, async () => {
      abortSignal?.throwIfAborted()
      const externalSession = this.getExternalPageSession(sessionId)
      if (externalSession) {
        await this.ensureExternalContextPageUnlocked(sessionId, externalSession, context)
        await externalSession.driver.bringToFront()
        externalSession.visible = true
        return this.buildExternalWindowState(externalSession)
      }

      const session = await this.ensureContextPageUnlocked(sessionId, context, abortSignal)
      session.visible = true
      this.interaction.focusWebContents(session)

      return this.buildWindowState(session)
    })
  }

  /** 接管 renderer webContents，并恢复历史记录后打开目标页面。 */
  public async presentPage(
    sessionId: string,
    context: BrowserSiteContext,
    webContentsId: number,
    navigationHistory?: BrowserNavigationHistoryRestore,
    abortSignal?: AbortSignal
  ): Promise<BrowserPageWindowState> {
    this.latestPresentationTargets.set(sessionId, {
      context,
      webContentsId,
      navigationHistory,
    })

    return this.actionQueue.run(sessionId, async () => {
      abortSignal?.throwIfAborted()
      const target = this.latestPresentationTargets.get(sessionId) ?? {
        context,
        webContentsId,
        navigationHistory,
      }
      const embeddedWebContents = electron.webContents.fromId(target.webContentsId)
      if (!embeddedWebContents || embeddedWebContents.isDestroyed()) {
        throw new AppError('VALIDATION', '内嵌浏览器页面不可用，无法接管页面会话。')
      }

      const session = this.sessionManager.attachWebContents(sessionId, embeddedWebContents)
      session.visible = true

      // attach 只负责展示，绝不按 context.url 反向纠偏活页面：attach 请求在 IPC 到达时
      // 快照 context，却排在 actionQueue 里模型/用户导航之后执行——用滞后的 context 强制
      // loadURL 会把刚导航到的页面拉回去，形成两 URL 之间的自持振荡（页面来回闪烁的根因）。
      // 页面 URL 是运行态唯一权威，context 经 did-finish-load 的 site-change 回调跟随页面。
      if (this.getLoadedPageUrl(session)) {
        if (this.isWebContentsLoading(session.webContents)) {
          await this.pageWaiter.waitForNavigationToSettle(session.webContents, abortSignal)
        }
        session.url = this.getLoadedPageUrl(session) ?? session.url
      } else {
        // 全新/占位 webview：先尝试恢复历史；恢复不了才按 context.url 加载。
        const restored = await this.restoreNavigationHistory(
          embeddedWebContents,
          target.navigationHistory,
          abortSignal
        )
        if (restored) {
          await this.pageWaiter.waitForNavigationToSettle(session.webContents, abortSignal)
          session.url = this.getLoadedPageUrl(session) ?? session.url
        }
        if (!this.getLoadedPageUrl(session)) {
          await this.ensureContextPageUnlocked(sessionId, target.context, abortSignal)
        }
      }

      if (session.viewport) {
        await this.getPageDriver(sessionId, session).setViewport?.(session.viewport)
      }

      return this.buildWindowState(session)
    })
  }

  /** 启动外部 CDP 浏览器窗口并挂接为当前 session 的页面 driver。 */
  public async launchExternalBrowserPage(
    sessionId: string,
    context: BrowserSiteContext,
    options: CdpExternalBrowserLaunchOptions = {},
    abortSignal?: AbortSignal
  ): Promise<BrowserPageWindowState> {
    return this.launchBrowserPageWithLauncher(
      sessionId,
      context,
      options,
      this.externalBrowserLauncher,
      { activate: true, visible: true },
      abortSignal
    )
  }

  public async launchBackgroundBrowserPage(
    sessionId: string,
    context: BrowserSiteContext,
    options: CdpExternalBrowserLaunchOptions = {},
    abortSignal?: AbortSignal
  ): Promise<BrowserPageWindowState> {
    return this.launchBrowserPageWithLauncher(
      sessionId,
      context,
      options,
      this.backgroundBrowserLauncher,
      { activate: false, visible: false },
      abortSignal
    )
  }

  private async launchBrowserPageWithLauncher(
    sessionId: string,
    context: BrowserSiteContext,
    options: CdpExternalBrowserLaunchOptions,
    launcher: BrowserExternalPageLauncher,
    behavior: { activate: boolean; visible: boolean },
    abortSignal?: AbortSignal
  ): Promise<BrowserPageWindowState> {
    return this.actionQueue.run(sessionId, async () => {
      abortSignal?.throwIfAborted()
      const launchUrl = options.url?.trim() || context.url
      const launchSession = await launcher.launch({
        ...options,
        url: launchUrl,
      })
      abortSignal?.throwIfAborted()
      const externalSession = this.attachExternalPageDriver(sessionId, launchSession.driver, {
        disposeHost: launchSession.dispose,
      })
      if (externalSession.driver.isDestroyed()) {
        this.disposeExternalPageSession(externalSession)
        this.externalPageSessions.delete(sessionId)
        throw new AppError('EXECUTION_FAILED', '外部浏览器页面启动后无法挂接。')
      }

      await this.ensureExternalContextPageUnlocked(sessionId, externalSession, {
        ...context,
        url: launchUrl,
      })
      this.sessionManager.notifyPageReady(
        sessionId,
        externalSession.url || externalSession.driver.getURL() || launchUrl
      )
      if (behavior.activate) {
        await externalSession.driver.bringToFront()
      }
      externalSession.visible = behavior.visible
      return this.buildExternalWindowState(externalSession)
    })
  }

  /** 接入外部浏览器页面 driver，用于 CDP/远程浏览器路径复用同一页面协议。 */
  public attachExternalPageDriver(
    sessionId: string,
    driver: BrowserPageDriver,
    options: {
      disposeHost?: LooseOptional<() => void>
      disposePreviousHost?: LooseOptional<boolean>
    } = {}
  ): ExternalBrowserPageSession {
    const previous = this.externalPageSessions.get(sessionId)
    if (previous?.driver !== driver) {
      this.disposeExternalPageSession(previous, {
        disposeHost: options.disposePreviousHost ?? true,
      })
    }
    const disposeHost =
      options.disposeHost ?? (previous?.driver === driver ? previous.disposeHost : null)
    const session: ExternalBrowserPageSession = {
      driver,
      visible: true,
      viewport: previous?.driver === driver ? previous.viewport : null,
      url: toNullable(driver.getURL()),
      title: toNullable(driver.getTitle()),
      disposeHost,
    }
    session.unsubscribeDownloads = this.registerExternalDownloadEvents(sessionId, session)
    this.externalPageSessions.set(sessionId, session)
    return session
  }

  /** 隐藏会话但不销毁 WebContents。 */
  public async hideSession(sessionId: string): Promise<BrowserPageWindowState> {
    return this.actionQueue.run(sessionId, async () => {
      const externalSession = this.getExternalPageSession(sessionId)
      if (externalSession) {
        externalSession.visible = false
        return this.buildExternalWindowState(externalSession)
      }

      const session = this.sessionManager.getSession(sessionId)

      if (!session || session.webContents.isDestroyed())
        return {
          active: false,
          visible: false,
          driverKind: 'webview',
          url: null,
          title: null,
          canGoBack: false,
          canGoForward: false,
          viewport: null,
        }

      session.visible = false
      return this.buildWindowState(session)
    })
  }

  /** 关闭会话并清空队列。 */
  public async closeSession(sessionId: string): Promise<void> {
    await this.actionQueue.run(sessionId, async () => {
      this.latestPresentationTargets.delete(sessionId)
      const externalSession = this.externalPageSessions.get(sessionId)
      if (externalSession) {
        this.disposeExternalPageSession(externalSession)
        this.externalPageSessions.delete(sessionId)
      }

      const session = this.sessionManager.getSession(sessionId)
      if (session) {
        this.interaction.clearPointerState(session.webContents.id)
      }
      this.sessionManager.closeSession(sessionId)
    })
    this.actionQueue.clear(sessionId)
    this.activityCoordinator.clearSession(sessionId)
    this.targetRefs.clear(sessionId)
  }

  /** 关闭当前窗口的全部页面会话，保留 runtime 供重开窗口后继续使用。 */
  public closeAllSessions(): void {
    this.actionQueue.clearAll()
    this.interaction.dispose()
    this.targetRefs.clearAll()
    this.latestPresentationTargets.clear()
    this.performance.dispose()
    this.externalPageSessions.forEach((session) => this.disposeExternalPageSession(session))
    this.externalPageSessions.clear()
    this.activityCoordinator.clearAll()
    this.sessionManager.closeAllSessions()
  }

  /** 主进程退出时永久释放浏览器 runtime。 */
  public dispose(): void {
    this.closeAllSessions()
    this.sessionManager.dispose()
  }

  private withActivityCallbacks(
    options: ElectronBrowserRuntimeOptions
  ): ElectronBrowserRuntimeOptions {
    return {
      ...options,
      onUserActivity: (activity) => {
        this.activityCoordinator.recordUserActivity(activity)
        options.onUserActivity?.(activity)
      },
    }
  }

  private getExternalPageSession(sessionId: string): Nullable<ExternalBrowserPageSession> {
    const session = this.externalPageSessions.get(sessionId)
    if (!session) return null
    if (session.driver.isDestroyed()) {
      this.disposeExternalPageSession(session)
      this.externalPageSessions.delete(sessionId)
      return null
    }

    return session
  }

  private disposeExternalPageSession(
    session?: LooseOptional<ExternalBrowserPageSession>,
    options: { disposeHost?: boolean } = {}
  ): void {
    if (!session) return

    session.unsubscribeDownloads?.()
    this.disposeExternalPageDriver(session.driver)
    if (options.disposeHost ?? true) {
      session.disposeHost?.()
    }
  }

  private disposeExternalPageDriver(driver?: LooseOptional<BrowserPageDriver>): void {
    const disposable = driver as LooseOptional<{ dispose?: () => void }>
    disposable?.dispose?.()
  }

  private registerExternalDownloadEvents(
    sessionId: string,
    session: ExternalBrowserPageSession
  ): LooseOptional<() => void> {
    return session.driver.onDownload?.((event) => {
      const current = this.externalPageSessions.get(sessionId)
      if (current?.driver !== session.driver) return

      this.sessionManager.getPendingEventsBroker().handleIncomingDownload({
        sessionId,
        item: event.item,
        url: event.url,
      })
    })
  }

  private getPageDriver(sessionId: string, session: BrowserSession): BrowserPageDriver {
    return this.createPageDriver({
      sessionId,
      webContents: session.webContents,
    })
  }

  private async getLivePageDriverSessionUnlocked(
    sessionId: string,
    abortSignal?: AbortSignal
  ): Promise<BrowserRuntimePageDriverSession> {
    const externalSession = this.getExternalPageSession(sessionId)
    if (externalSession) return { driver: externalSession.driver, externalSession }

    const browserSession = await this.getLivePageSessionUnlocked(sessionId, abortSignal)
    return {
      driver: this.getPageDriver(sessionId, browserSession),
      browserSession,
    }
  }

  private async refreshPageDriverSessionState(
    sessionId: string,
    pageSession: BrowserRuntimePageDriverSession,
    fallbackUrl: string
  ): Promise<BrowserPageDriverState> {
    if (pageSession.externalSession)
      return this.refreshExternalPageState(sessionId, pageSession.externalSession, fallbackUrl)

    if (pageSession.browserSession)
      return {
        url: this.resolveCurrentPageUrl(pageSession.browserSession, fallbackUrl),
        title: pageSession.driver.getTitle(),
      }

    return pageSession.driver.refreshPageState()
  }

  /** 检查页面结构。 */
  /** 截图并保存到浏览器工作区。 */
  public async captureScreenshot(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserCaptureScreenshotOptions = {},
    abortSignal?: AbortSignal
  ): Promise<BrowserScreenshotArtifact> {
    return this.actionQueue.run(sessionId, () =>
      this.screenshot.captureScreenshot(sessionId, context, options, abortSignal)
    )
  }

  /** 捕获不落盘的轻量页面预览帧，供宿主侧观察后台 browser lane。 */
  public async capturePreviewFrame(
    sessionId: string,
    context: BrowserSiteContext,
    options: { maxWidth?: number; quality?: number } = {},
    abortSignal?: AbortSignal
  ): Promise<BrowserPagePreviewFrame> {
    return this.actionQueue.run(sessionId, () =>
      this.screenshot.capturePreviewFrame(sessionId, context, options, abortSignal)
    )
  }

  /** 启动画中画的 CDP 持续帧流，不占用浏览器 actionQueue。 */
  public startPreviewFrameStream(
    sessionId: string,
    context: BrowserSiteContext,
    options: { maxWidth?: number; quality?: number },
    onEvent: (event: BrowserPagePreviewStreamEvent) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    return this.screenshot.startPreviewFrameStream(
      sessionId,
      context,
      options,
      onEvent,
      abortSignal
    )
  }

  /** 停止画中画实时帧流。 */
  public stopPreviewFrameStream(sessionId: string): Promise<void> {
    return this.screenshot.stopPreviewFrameStream(sessionId)
  }

  public async performTargetAction(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserTargetActionOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserTargetActionResult> {
    return this.actionQueue.run(sessionId, () =>
      this.interaction.performTargetAction(sessionId, context, options, abortSignal)
    )
  }

  public async scrollPage(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserPageScrollOptions = {},
    abortSignal?: AbortSignal
  ): Promise<BrowserPageScrollResult> {
    return this.actionQueue.run(sessionId, () =>
      this.interaction.scrollPage(sessionId, context, options, abortSignal)
    )
  }

  public async typeText(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserTypeTextOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserTypeTextResult> {
    return this.actionQueue.run(sessionId, () =>
      this.interaction.typeText(sessionId, context, options, abortSignal)
    )
  }

  public async pressKey(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserPressKeyOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserPressKeyResult> {
    return this.actionQueue.run(sessionId, () =>
      this.interaction.pressKey(sessionId, context, options, abortSignal)
    )
  }

  public async clickCoordinates(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserClickCoordinatesOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserClickCoordinatesResult> {
    return this.actionQueue.run(sessionId, () =>
      this.interaction.clickCoordinates(sessionId, context, options, abortSignal)
    )
  }

  public async dragTargets(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserDragOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserDragResult> {
    return this.actionQueue.run(sessionId, () =>
      this.interaction.dragTargets(sessionId, context, options, abortSignal)
    )
  }

  public async moveMouse(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserMoveMouseOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserMoveMouseResult> {
    return this.actionQueue.run(sessionId, () =>
      this.interaction.moveMouse(sessionId, context, options, abortSignal)
    )
  }

  public async setViewport(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserViewportOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserViewportResult> {
    return this.actionQueue.run(sessionId, async () => {
      const result = await this.interaction.setViewport(sessionId, context, options, abortSignal)
      const viewport = { width: result.width, height: result.height }
      const externalSession = this.getExternalPageSession(sessionId)
      if (externalSession) {
        externalSession.viewport = viewport
      } else {
        const browserSession = this.sessionManager.getSession(sessionId)
        if (browserSession) browserSession.viewport = viewport
      }
      this.sessionManager.notifyViewportChanged(sessionId, viewport)
      return result
    })
  }

  public async setPageZoom(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserPageZoomOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserPageZoomResult> {
    return this.actionQueue.run(sessionId, () =>
      this.interaction.setPageZoom(sessionId, context, options, abortSignal)
    )
  }

  public async inspectPage(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserInspectPageOptions = {},
    abortSignal?: AbortSignal
  ): Promise<BrowserPageInspection> {
    // inspectPage 会触碰共享 WebContents，需要通过 runReadOnly 跟导航保持顺序。
    return this.actionQueue.runReadOnly(sessionId, () =>
      this.pageData.inspectPage(sessionId, context, options, abortSignal)
    )
  }

  public async queryElements(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserElementQueryOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserElementQueryResult> {
    return this.actionQueue.run(sessionId, () =>
      this.pageData.queryElements(sessionId, context, options, abortSignal)
    )
  }

  public async evaluateScript(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserEvaluateScriptOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserEvaluateScriptResult> {
    return this.actionQueue.run(sessionId, () =>
      this.pageData.evaluateScript(sessionId, context, options, abortSignal)
    )
  }

  /**
   * 在当前嵌入式页面执行一个持久用户脚本。
   *
   * v1 明确不伪装能力：external CDP 和真正的 document-start 需要 driver 级
   * evaluate-on-new-document 注册，当前返回 unsupported，由 UI/工具展示。
   */
  public async runUserScript(
    sessionId: string,
    context: BrowserSiteContext,
    input: { script: BrowserUserScriptRecord; code: string; force?: boolean },
    abortSignal?: AbortSignal
  ): Promise<BrowserUserScriptLastRun> {
    return this.actionQueue.run(sessionId, async () => {
      abortSignal?.throwIfAborted()
      const startedAt = Date.now()
      const unsupported = (error: string): BrowserUserScriptLastRun => ({
        status: 'unsupported',
        url: this.externalPageSessions.get(sessionId)?.driver.getURL() || context.url,
        documentId: `unsupported-${startedAt}`,
        scriptRevision: input.script.revision,
        startedAt,
        finishedAt: Date.now(),
        error,
      })
      if (this.externalPageSessions.has(sessionId))
        return unsupported('external CDP 尚未实现 evaluate-on-new-document 用户脚本注册。')
      if (input.script.runAt === 'document-start' && !input.force)
        return unsupported('嵌入式浏览器尚未实现 document-start 预加载；请改用 document-end。')

      const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)
      const url = this.resolveCurrentPageUrl(session, context.url)
      const source = buildBrowserUserScriptExecutionSource(input.script, input.code, !!input.force)
      try {
        const result =
          input.script.world === 'main'
            ? await session.webContents.executeJavaScript(source, false)
            : await session.webContents.executeJavaScriptInIsolatedWorld(
                1201,
                [{ code: source, url: `velaros-userscript://${input.script.id}.js` }],
                false
              )
        const payload = isObject(result) ? (result as Record<string, unknown>) : {}
        return {
          status: payload.ok ? 'success' : 'error',
          url,
          documentId: isNonBlankString(payload.documentId)
            ? payload.documentId
            : `embedded-${startedAt}`,
          scriptRevision: input.script.revision,
          startedAt,
          finishedAt: Date.now(),
          error: optionalWhen(isNonBlankString, payload.error),
        }
      } catch (error) {
        return {
          status: 'error',
          url,
          documentId: `embedded-${startedAt}`,
          scriptRevision: input.script.revision,
          startedAt,
          finishedAt: Date.now(),
          error: AppError.from(error).message,
        }
      }
    })
  }

  public async readPageStorage(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserPageStorageOptions = {},
    abortSignal?: AbortSignal
  ): Promise<BrowserPageStorageResult> {
    return this.actionQueue.run(sessionId, () =>
      this.pageData.readPageStorage(sessionId, context, options, abortSignal)
    )
  }

  public async fetchResource(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserFetchResourceOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserFetchResourceResult> {
    return this.actionQueue.run(sessionId, () =>
      this.pageData.fetchResource(sessionId, context, options, abortSignal)
    )
  }

  public async listMediaSources(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserListMediaSourcesOptions = {},
    abortSignal?: AbortSignal
  ): Promise<BrowserListMediaSourcesResult> {
    return this.actionQueue.runReadOnly(sessionId, () =>
      this.pageData.listMediaSources(sessionId, context, options, abortSignal)
    )
  }

  public async listPageResources(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserListPageResourcesOptions = {},
    abortSignal?: AbortSignal
  ): Promise<BrowserListPageResourcesResult> {
    return this.actionQueue.runReadOnly(sessionId, () =>
      this.pageData.listPageResources(sessionId, context, options, abortSignal)
    )
  }

  public async getPageDiagnostics(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserPageDiagnosticsOptions = {},
    abortSignal?: AbortSignal
  ): Promise<BrowserPageDiagnostics> {
    return this.actionQueue.run(sessionId, () =>
      this.pageData.getPageDiagnostics(sessionId, context, options, abortSignal)
    )
  }

  public async uploadFile(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserUploadFileOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserUploadFileResult> {
    return this.actionQueue.run(sessionId, () =>
      this.pageData.uploadFile(sessionId, context, options, abortSignal)
    )
  }

  public async exportPagePdf(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserExportPagePdfOptions = {},
    abortSignal?: AbortSignal
  ): Promise<BrowserExportPagePdfResult> {
    return this.actionQueue.run(sessionId, () =>
      this.pageData.exportPagePdf(sessionId, context, options, abortSignal)
    )
  }

  public async configureNetwork(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserNetworkControlOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserNetworkControlResult> {
    return this.actionQueue.run(sessionId, () =>
      this.pageData.configureNetwork(sessionId, context, options, abortSignal)
    )
  }

  public async readNetworkResponseBody(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserNetworkResponseBodyOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserNetworkResponseBodyResult> {
    return this.actionQueue.run(sessionId, () =>
      this.pageData.readNetworkResponseBody(sessionId, context, options, abortSignal)
    )
  }

  public async readNetworkRequestDetails(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserNetworkRequestDetailsOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserNetworkRequestDetailsResult> {
    return this.actionQueue.run(sessionId, () =>
      this.pageData.readNetworkRequestDetails(sessionId, context, options, abortSignal)
    )
  }

  public async configureEmulation(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserEmulationOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserEmulationResult> {
    return this.actionQueue.run(sessionId, () =>
      this.pageData.configureEmulation(sessionId, context, options, abortSignal)
    )
  }

  public async waitForSelector(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserWaitForSelectorOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserWaitForSelectorResult> {
    return this.actionQueue.run(sessionId, () =>
      this.pageData.waitForSelector(sessionId, context, options, abortSignal)
    )
  }

  public async waitForPage(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserPageWaitOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserPageWaitResult> {
    return this.actionQueue.run(sessionId, () =>
      this.pageData.waitForPage(sessionId, context, options, abortSignal)
    )
  }

  /** 执行目标元素动作：点击或填充。 */
  /** 执行浏览器导航动作。 */
  public async navigatePage(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserPageNavigationOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserPageNavigationResult> {
    return this.actionQueue.run(sessionId, async () => {
      abortSignal?.throwIfAborted()
      const externalSession = this.getExternalPageSession(sessionId)
      if (externalSession)
        return this.navigateExternalPage(sessionId, externalSession, context, options)

      const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)
      let navigated = false

      if (options.action === 'goto') {
        if (!options.url?.trim()) {
          throw new AppError('VALIDATION', 'goto 导航必须提供 URL。')
        }

        const previousCommittedUrl = this.getLoadedPageUrl(session) ?? session.url
        const previousUrl = previousCommittedUrl ?? this.normalizeUrl(context.url)
        let targetUrl = this.normalizeUrl(options.url)
        let didStartControlledPageLoad = false
        if (previousUrl === targetUrl) {
          // 目标 URL 已加载时避免重复 loadURL 打断页面状态。
          return this.buildNavigationResult(session, options.action, false)
        }

        try {
          // 先用隐藏窗口探测，避免失败导航污染当前受控 WebContents。
          targetUrl = await this.probeUrlLoadWithSearchFallback(targetUrl, abortSignal)
          didStartControlledPageLoad = true
          await this.pageWaiter.loadUrl(session.webContents, targetUrl, abortSignal)
        } catch (error) {
          const navigationError = AppError.from(error)
          if (!session.webContents.isDestroyed()) {
            if (
              navigationError.code !== 'EXECUTION_ABORTED' &&
              didStartControlledPageLoad &&
              this.getLoadedPageUrl(session) !== previousUrl
            ) {
              try {
                // 预探测通过后真实加载仍可能因网络竞态失败；必须恢复
                // 上一张已提交页面，不能只回滚 session.url 而把用户留在白屏。
                await this.pageWaiter.loadUrl(session.webContents, previousUrl)
              } catch (recoveryError) {
                this.log.warn('失败导航后恢复上一页失败', {
                  sessionId,
                  previousUrl,
                  targetUrl,
                  error: AppError.from(recoveryError).message,
                })
              }
            }
            session.url = this.getLoadedPageUrl(session) ?? previousUrl
          }

          throw navigationError
        }
        navigated = true
      } else if (options.action === 'reload') {
        const knownUrl = this.getKnownSessionUrl(session)
        if (!this.getLoadedPageUrl(session) && knownUrl) {
          await this.pageWaiter.loadUrl(session.webContents, knownUrl, abortSignal)
        } else {
          session.webContents.reload()
          await this.pageWaiter.waitForNavigationToSettle(session.webContents, abortSignal)
        }
        navigated = true
      } else if (options.action === 'back') {
        navigated = await this.navigateRenderableHistory(session, -1, abortSignal)
      } else if (options.action === 'forward') {
        navigated = await this.navigateRenderableHistory(session, 1, abortSignal)
      }

      const finalUrl = this.resolveCurrentPageUrl(session, context.url)
      session.url = finalUrl
      this.sessionManager.syncSessionSiteContext(sessionId, finalUrl)
      if (navigated) {
        this.targetRefs.clear(sessionId)
      }

      return this.buildNavigationResult(session, options.action, navigated)
    })
  }

  /** 用隐藏 BrowserWindow 预探测目标 URL 是否可加载。 */
  private async probeUrlLoad(url: string, abortSignal?: AbortSignal): Promise<void> {
    abortSignal?.throwIfAborted()
    const probeWindow = new electron.BrowserWindow({
      width: 960,
      height: 720,
      show: false,
      webPreferences: {
        devTools: !electron.app.isPackaged,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        javascript: true,
        backgroundThrottling: false,
      },
    })

    try {
      probeWindow.webContents.setAudioMuted(true)
      probeWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      await this.pageWaiter.loadUrl(probeWindow.webContents, url, abortSignal)
    } finally {
      if (!probeWindow.isDestroyed()) {
        probeWindow.destroy()
      }
    }
  }

  /** 查询页面元素。 */
  /** 列出当前 session 待处理的 dialog/download/permission 事件。 */
  public async listPendingEvents(
    sessionId: string,
    _context: BrowserSiteContext,
    abortSignal?: AbortSignal
  ): Promise<BrowserPendingEventsResult> {
    return this.actionQueue.runReadOnly(sessionId, async () => {
      abortSignal?.throwIfAborted()
      const externalSession = this.getExternalPageSession(sessionId)
      if (!externalSession) {
        await this.getLivePageSessionUnlocked(sessionId, abortSignal)
      }

      return {
        pending: this.sessionManager.getPendingEventsBroker().listPendingEvents(sessionId),
        capturedAt: Date.now(),
      }
    })
  }

  /** 处理待处理的 JS 弹窗。 */
  public async handleDialog(
    sessionId: string,
    _context: BrowserSiteContext,
    options: BrowserHandleDialogOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserHandleDialogResult> {
    return this.actionQueue.run(sessionId, async () => {
      abortSignal?.throwIfAborted()
      const externalSession = this.getExternalPageSession(sessionId)
      if (!externalSession) {
        await this.getLivePageSessionUnlocked(sessionId, abortSignal)
      }

      return this.sessionManager.getPendingEventsBroker().resolveDialog({
        sessionId,
        eventId: options.eventId,
        accept: options.accept,
        promptText: options.promptText,
      })
    })
  }

  /** 接受或取消待处理下载。 */
  public async handleDownload(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserHandleDownloadOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserHandleDownloadResult> {
    return this.actionQueue.run(sessionId, async () => {
      abortSignal?.throwIfAborted()
      const externalSession = this.getExternalPageSession(sessionId)
      if (!externalSession) {
        await this.getLivePageSessionUnlocked(sessionId, abortSignal)
      }

      const savePath =
        options.action === 'accept' && options.savePath
          ? resolveWorkspaceFilePath(context.workspaceRoot, options.savePath).path
          : options.savePath

      return this.sessionManager.getPendingEventsBroker().resolveDownload({
        sessionId,
        eventId: options.eventId,
        action: options.action,
        savePath,
      })
    })
  }

  /** 使用当前浏览器会话抓取远程资源并写入工作区。 */
  /** 枚举当前页面可下载的图片/视频/音频 URL。 */
  /** 枚举页面链接、iframe 与媒体数量概览。 */
  /** 将当前页面导出为 PDF 并写入工作区。 */
  /** 允许或拒绝待处理权限请求。 */
  public async handlePermission(
    sessionId: string,
    _context: BrowserSiteContext,
    options: BrowserHandlePermissionOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserHandlePermissionResult> {
    return this.actionQueue.run(sessionId, async () => {
      abortSignal?.throwIfAborted()
      const externalSession = this.getExternalPageSession(sessionId)
      if (!externalSession) {
        await this.getLivePageSessionUnlocked(sessionId, abortSignal)
      }

      return this.sessionManager.getPendingEventsBroker().resolvePermission({
        sessionId,
        eventId: options.eventId,
        grant: options.grant,
      })
    })
  }

  /** 向 file input 上传本地文件（CDP DOM.setFileInputFiles）。 */
  /** 读取页面诊断记录。 */
  /** 向当前焦点输入文本。 */
  /** 发送键盘事件。 */
  /** 发送鼠标点击坐标事件。 */
  /** 按两个目标元素中心点执行拖拽。 */
  /** 移动鼠标并更新虚拟指针。 */
  /** 等待 CSS selector 出现或可见。 */
  /** 等待页面 readyState 或短暂停顿，供异步渲染和轻量加载稳定。 */
  /** 设置目标视口大小。 */
  /** 设置页面缩放比例。 */
  /** 配置外部 CDP 浏览器页面网络状态。 */
  /** 读取当前外部 CDP 浏览器页面已捕获请求的响应体。 */
  /** 读取当前外部 CDP 浏览器页面已捕获请求的完整详情。 */
  /** 配置外部 CDP 浏览器页面环境模拟。 */
  /**
   * 开始录制性能 trace（吸收自 chrome-devtools-mcp 的 performance_start_trace 流程）。
   *
   * reload=true 时先跳 about:blank 清场再回跳原 URL，录出完整加载过程；
   * autoStopMs > 0 时在录制窗口结束后原地停止并直接返回分析结果。
   */
  public async startPerformanceTrace(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserPerformanceTraceStartOptions = {},
    abortSignal?: AbortSignal
  ): Promise<BrowserPerformanceTraceStartResult> {
    return this.actionQueue.run(sessionId, () =>
      this.performance.startTrace(sessionId, context, options, abortSignal)
    )
  }

  /** 停止性能 trace 录制，解析并返回摘要。 */
  public async stopPerformanceTrace(
    sessionId: string,
    context: BrowserSiteContext,
    abortSignal?: AbortSignal
  ): Promise<BrowserPerformanceTraceStopResult> {
    return this.actionQueue.run(sessionId, () =>
      this.performance.stopTrace(sessionId, context, abortSignal)
    )
  }

  /** 对最近一次 trace 的指定 insight 输出详细分析（纯内存读，不进队列）。 */
  public async analyzePerformanceInsight(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserPerformanceInsightOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserPerformanceInsightResult> {
    void context
    return this.performance.analyzeInsight(sessionId, options, abortSignal)
  }

  /** 采集 V8 堆快照并落盘（memory-leak 排查工作流；分析建议交给 memlab 等外部工具）。 */
  public async captureHeapSnapshot(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserHeapSnapshotOptions = {},
    abortSignal?: AbortSignal
  ): Promise<BrowserHeapSnapshotResult> {
    return this.actionQueue.run(sessionId, () =>
      this.performance.captureHeapSnapshot(sessionId, context, options, abortSignal)
    )
  }

  /** 开始页面录屏（GIF 产物）。 */
  public async startScreencast(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserScreencastStartOptions = {},
    abortSignal?: AbortSignal
  ): Promise<BrowserScreencastStartResult> {
    return this.actionQueue.run(sessionId, () =>
      this.screenshot.startScreencast(sessionId, context, options, abortSignal)
    )
  }

  /** 停止录屏，合成 GIF 并落盘。 */
  public async stopScreencast(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserScreencastStopOptions = {},
    abortSignal?: AbortSignal
  ): Promise<BrowserScreencastStopResult> {
    return this.actionQueue.run(sessionId, () =>
      this.screenshot.stopScreencast(sessionId, context, options, abortSignal)
    )
  }

  /** 读取页面 localStorage/sessionStorage/cookie。 */
  /** 在页面上下文执行自定义脚本。 */
  /** 获取可用会话，并刷新 session.url。 */
  private async getLivePageSessionUnlocked(
    sessionId: string,
    abortSignal?: AbortSignal
  ): Promise<BrowserSession> {
    abortSignal?.throwIfAborted()
    const session = await this.sessionManager.waitForSession(sessionId)
    session.url = this.getLoadedPageUrl(session) ?? session.url
    return session
  }

  private async ensureExternalContextPageUnlocked(
    sessionId: string,
    session: ExternalBrowserPageSession,
    context: BrowserSiteContext
  ): Promise<ExternalBrowserPageSession> {
    const targetUrl = this.normalizeUrl(context.url)
    const currentUrl = session.url || session.driver.getURL()
    if (currentUrl === targetUrl) return session

    const previousUrl = session.url
    const state = await session.driver.navigateTo(targetUrl)
    this.applyExternalPageState(session, state, targetUrl)
    if (session.url && session.url !== previousUrl) {
      this.sessionManager.syncExternalSessionSiteContext(sessionId, session.url)
    }
    this.targetRefs.clear(sessionId)

    return session
  }

  private async refreshExternalPageState(
    sessionId: string,
    session: ExternalBrowserPageSession,
    fallbackUrl?: LooseOptional<string>
  ): Promise<BrowserPageDriverState> {
    const previousUrl = session.url
    const state = await session.driver.refreshPageState()
    this.applyExternalPageState(session, state, fallbackUrl)
    if (session.url && session.url !== previousUrl) {
      this.sessionManager.syncExternalSessionSiteContext(sessionId, session.url)
    }

    return {
      url: session.url || '',
      title: session.title || '',
    }
  }

  private updateExternalPageStateFromInspection(
    sessionId: string,
    session: ExternalBrowserPageSession,
    inspection: BrowserPageInspection
  ): void {
    const previousUrl = session.url
    this.applyExternalPageState(session, {
      url: inspection.url || session.driver.getURL(),
      title: inspection.title || session.driver.getTitle(),
    })
    if (session.url && session.url !== previousUrl) {
      this.sessionManager.syncExternalSessionSiteContext(sessionId, session.url)
    }
  }

  private syncExternalPageStateFromScriptResult(
    sessionId: string,
    session: ExternalBrowserPageSession,
    result: unknown,
    fallbackUrl?: LooseOptional<string>
  ): void {
    const previousUrl = session.url
    const resultRecord = isObject(result) ? (result as { url?: unknown; title?: unknown }) : {}
    this.applyExternalPageState(
      session,
      {
        url: isNonBlankString(resultRecord.url) ? resultRecord.url : session.driver.getURL(),
        title: isString(resultRecord.title) ? resultRecord.title : session.driver.getTitle(),
      },
      fallbackUrl
    )
    if (session.url && session.url !== previousUrl) {
      this.sessionManager.syncExternalSessionSiteContext(sessionId, session.url)
    }
  }

  private async navigateExternalPage(
    sessionId: string,
    session: ExternalBrowserPageSession,
    context: BrowserSiteContext,
    options: BrowserPageNavigationOptions
  ): Promise<BrowserPageNavigationResult> {
    if (options.action === 'goto') {
      if (!options.url?.trim()) {
        throw new AppError('VALIDATION', 'goto 导航必须提供 URL。')
      }

      const targetUrl = this.normalizeUrl(options.url)
      const previousUrl = session.url || session.driver.getURL() || this.normalizeUrl(context.url)
      if (previousUrl === targetUrl)
        return this.buildExternalNavigationResult(session, options.action, false)

      const previousSessionUrl = session.url
      const state = await session.driver.navigateTo(targetUrl)
      this.applyExternalPageState(session, state, targetUrl)
      if (session.url && session.url !== previousSessionUrl) {
        this.sessionManager.syncExternalSessionSiteContext(sessionId, session.url)
      }
      this.sessionManager.notifyPageReady(sessionId, session.url || targetUrl)
      this.targetRefs.clear(sessionId)
      return this.buildExternalNavigationResult(session, options.action, true)
    }

    if (options.action === 'reload') {
      const targetUrl = session.url || session.driver.getURL() || this.normalizeUrl(context.url)
      const previousSessionUrl = session.url
      const state = await session.driver.navigateTo(targetUrl)
      this.applyExternalPageState(session, state, targetUrl)
      if (session.url && session.url !== previousSessionUrl) {
        this.sessionManager.syncExternalSessionSiteContext(sessionId, session.url)
      }
      this.sessionManager.notifyPageReady(sessionId, session.url || targetUrl)
      this.targetRefs.clear(sessionId)
      return this.buildExternalNavigationResult(session, options.action, true)
    }

    return this.buildExternalNavigationResult(session, options.action, false)
  }

  private applyExternalPageState(
    session: ExternalBrowserPageSession,
    state: BrowserPageDriverState,
    fallbackUrl?: LooseOptional<string>
  ): void {
    const nextUrl = state.url || fallbackUrl || session.url
    const nextTitle = state.title || session.title
    session.url = toNullable(nextUrl)
    session.title = toNullable(nextTitle)
  }

  /** 确保会话已打开到指定 context.url。 */
  private async ensureContextPageUnlocked(
    sessionId: string,
    context: BrowserSiteContext,
    abortSignal?: AbortSignal
  ): Promise<BrowserSession> {
    abortSignal?.throwIfAborted()
    const session = await this.sessionManager.waitForSession(sessionId)
    const url = this.normalizeUrl(context.url)
    const currentUrl = this.getLoadedPageUrl(session)

    if (currentUrl === url) {
      if (this.isWebContentsLoading(session.webContents)) {
        await this.pageWaiter.waitForNavigationToSettle(session.webContents, abortSignal)
      }

      session.url = currentUrl
      return session
    }

    // Page-driven navigations update session.url before React re-presents the same webview.
    // In that case, avoid a second loadURL that can interrupt the site's own redirect chain.
    if (
      currentUrl &&
      this.getKnownSessionUrl(session) === url &&
      this.isWebContentsLoading(session.webContents)
    ) {
      await this.pageWaiter.waitForNavigationToSettle(session.webContents, abortSignal)
      session.url = this.getLoadedPageUrl(session) ?? session.url
      return session
    }

    const loadedUrl = await this.loadUrlWithSearchFallback(session.webContents, url, abortSignal)
    session.url = this.getLoadedPageUrl(session) ?? loadedUrl
    return session
  }

  private async loadUrlWithSearchFallback(
    webContents: electron.WebContents,
    url: string,
    abortSignal?: AbortSignal
  ): Promise<string> {
    try {
      await this.pageWaiter.loadUrl(webContents, url, abortSignal)
      return url
    } catch (error) {
      const fallbackUrl = resolveBrowserSearchFallbackUrl(url)
      if (!fallbackUrl) throw error

      this.log.debug('浏览器搜索加载失败，回退到备用搜索引擎', {
        url,
        fallbackUrl,
        error: AppError.from(error).message,
      })
      await this.pageWaiter.loadUrl(webContents, fallbackUrl, abortSignal)
      return fallbackUrl
    }
  }

  private async probeUrlLoadWithSearchFallback(
    url: string,
    abortSignal?: AbortSignal
  ): Promise<string> {
    try {
      await this.probeUrlLoad(url, abortSignal)
      return url
    } catch (error) {
      const fallbackUrl = resolveBrowserSearchFallbackUrl(url)
      if (!fallbackUrl) throw error

      this.log.debug('浏览器搜索预探测失败，回退到备用搜索引擎', {
        url,
        fallbackUrl,
        error: AppError.from(error).message,
      })
      await this.probeUrlLoad(fallbackUrl, abortSignal)
      return fallbackUrl
    }
  }

  /** 根据会话构建窗口状态。 */
  private buildWindowState(session: BrowserSession): BrowserPageWindowState {
    if (session.webContents.isDestroyed())
      return {
        active: false,
        visible: false,
        driverKind: 'webview',
        url: null,
        title: null,
        canGoBack: false,
        canGoForward: false,
        viewport: null,
      }

    return {
      active: true,
      visible: session.visible,
      driverKind: 'webview',
      url: this.getLoadedPageUrl(session) ?? session.url,
      title: session.webContents.getTitle() || null,
      canGoBack: this.canNavigateRenderableHistory(session, -1),
      canGoForward: this.canNavigateRenderableHistory(session, 1),
      viewport: toNullable(session.viewport),
    }
  }

  private buildWebviewCurrentPageTarget(
    session: BrowserSession,
    fallbackUrl: string
  ): BrowserPageTargetInfo {
    return {
      id: 'current',
      type: 'page',
      url: this.getLoadedPageUrl(session) ?? session.url ?? fallbackUrl,
      title: session.webContents.getTitle() || '',
      active: true,
    }
  }

  private buildExternalWindowState(session: ExternalBrowserPageSession): BrowserPageWindowState {
    if (session.driver.isDestroyed())
      return {
        active: false,
        visible: false,
        driverKind: 'external',
        url: null,
        title: null,
        canGoBack: false,
        canGoForward: false,
        viewport: null,
      }

    return {
      active: true,
      visible: session.visible,
      driverKind: 'external',
      url: toNullable(session.url || session.driver.getURL()),
      title: toNullable(session.title || session.driver.getTitle()),
      canGoBack: false,
      canGoForward: false,
      viewport: toNullable(session.viewport),
    }
  }

  private buildExternalCurrentPageTarget(
    session: ExternalBrowserPageSession,
    state: BrowserPageDriverState
  ): BrowserPageTargetInfo {
    return {
      id: 'current',
      type: 'page',
      url: state.url || session.url || session.driver.getURL(),
      title: state.title || session.title || session.driver.getTitle(),
      active: true,
    }
  }

  /** 恢复 Electron navigation history。 */
  /** 尝试把历史快照恢复到占位 webContents；返回是否真的发起了恢复导航。 */
  private async restoreNavigationHistory(
    webContents: Electron.WebContents,
    navigationHistory?: BrowserNavigationHistoryRestore,
    abortSignal?: AbortSignal
  ): Promise<boolean> {
    abortSignal?.throwIfAborted()
    if (
      !navigationHistory ||
      navigationHistory.entries.length === 0 ||
      webContents.isDestroyed() ||
      !this.isPlaceholderUrl(webContents.getURL())
    )
      return false

    const entries = navigationHistory.entries
      .map((entry): Nullable<Electron.NavigationEntry> => {
        try {
          return {
            url: this.normalizeUrl(entry.url),
            title: entry.title ?? '',
            pageState: entry.pageState || undefined,
          }
        } catch (error) {
          this.log.debug('规范化恢复的浏览器历史条目失败', {
            url: entry.url,
            error: AppError.from(error).message,
          })
          return null
        }
      })
      .filter((entry): entry is Electron.NavigationEntry => !!entry)

    if (entries.length < 2) return false

    const index = clampInteger(navigationHistory.index, 0, entries.length - 1, entries.length - 1)

    try {
      await webContents.navigationHistory.restore({ entries, index })
      return true
    } catch (error) {
      this.log.debug('恢复浏览器导航历史失败，回退到加载页面', {
        error: AppError.from(error).message,
      })
      // History restore is a convenience; normal loading below remains the fallback.
      return false
    }
  }

  /** 把输入坐标锁定在当前浏览器 viewport 内。 */
  /** 外部 CDP 页面没有内嵌 viewport 可读时，仅清洗为合法 CSS 像素坐标。 */
  /** 读取页面可视 viewport 尺寸，失败时使用默认桌面尺寸。 */
  /** 计算新的页面缩放比例。 */
  /** 限制单次缩放步进。 */
  /** 页面内短暂显示缩放百分比，模拟浏览器触发缩放后的右上角提示。 */
  /** 构造页面缩放提示脚本。 */
  /** 生成从上一次位置到目标点的缓动路径，用于页面内光标轨迹。 */
  /** Electron 输入事件：移动鼠标。 */
  /** Electron 输入事件：点击坐标。 */
  /** 等待一小段时间，便于用户看到按压反馈。 */
  private delay(ms: number): Promise<void> {
    return TimerScope.sleep(ms, { label: 'ElectronBrowserRuntime.delay' })
  }

  /** 沿路径动画展示页面内 macOS 风格光标和鼠标轨迹。 */
  /** 在页面内渲染一个虚拟指针，用于截图可视化鼠标位置。 */
  /** 构建虚拟指针脚本。 */
  /** 构造导航结果。 */
  private buildNavigationResult(
    session: BrowserSession,
    action: BrowserPageNavigationOptions['action'],
    navigated: boolean
  ): BrowserPageNavigationResult {
    return {
      action,
      navigated,
      url: this.getLoadedPageUrl(session) ?? session.url ?? '',
      title: session.webContents.getTitle() || null,
      canGoBack: this.canNavigateRenderableHistory(session, -1),
      canGoForward: this.canNavigateRenderableHistory(session, 1),
      capturedAt: Date.now(),
    }
  }

  private buildExternalNavigationResult(
    session: ExternalBrowserPageSession,
    action: BrowserPageNavigationOptions['action'],
    navigated: boolean
  ): BrowserPageNavigationResult {
    return {
      action,
      navigated,
      url: session.url || session.driver.getURL() || '',
      title: toNullable(session.title || session.driver.getTitle()),
      canGoBack: false,
      canGoForward: false,
      capturedAt: Date.now(),
    }
  }

  /** 获取当前已加载页面 URL，排除 about:blank 等占位页。 */
  private getLoadedPageUrl(session: BrowserSession): Nullable<string> {
    const currentUrl = session.webContents.getURL()
    if (!currentUrl || this.isPlaceholderUrl(currentUrl)) return null

    try {
      return this.normalizeUrl(currentUrl)
    } catch (error) {
      this.log.debug('已加载浏览器 URL 规范化失败，保留原始地址', {
        url: currentUrl,
        error: AppError.from(error).message,
      })
      return currentUrl
    }
  }

  /** 获取会话记录的已知 URL。 */
  private getKnownSessionUrl(session: BrowserSession): Nullable<string> {
    if (!session.url || this.isPlaceholderUrl(session.url)) return null

    try {
      return this.normalizeUrl(session.url)
    } catch (error) {
      this.log.debug('已知浏览器 URL 规范化失败，保留原始地址', {
        url: session.url,
        error: AppError.from(error).message,
      })
      return session.url
    }
  }

  /** 寻找后退/前进时可展示的历史条目，跳过 about:blank 等占位页。 */
  private resolveRenderableHistoryIndex(
    session: BrowserSession,
    direction: -1 | 1
  ): Nullable<number> {
    try {
      if (session.webContents.isDestroyed()) return null

      const history = session.webContents.navigationHistory
      const entries = history.getAllEntries()
      const activeIndex = history.getActiveIndex()

      for (
        let index = activeIndex + direction;
        index >= 0 && index < entries.length;
        index += direction
      ) {
        const entry = entries[index]
        if (entry?.url && !this.isPlaceholderUrl(entry.url)) return index
      }
    } catch (error) {
      this.log.debug('读取浏览器可导航历史失败', {
        error: AppError.from(error).message,
      })
    }

    return null
  }

  private canNavigateRenderableHistory(session: BrowserSession, direction: -1 | 1): boolean {
    return isPresent(this.resolveRenderableHistoryIndex(session, direction))
  }

  private async navigateRenderableHistory(
    session: BrowserSession,
    direction: -1 | 1,
    abortSignal?: AbortSignal
  ): Promise<boolean> {
    const targetIndex = this.resolveRenderableHistoryIndex(session, direction)
    if (!isPresent(targetIndex)) return false

    session.webContents.navigationHistory.goToIndex(targetIndex)
    await this.pageWaiter.waitForNavigationToSettle(session.webContents, abortSignal)

    if (!this.getLoadedPageUrl(session)) {
      const targetEntry = session.webContents.navigationHistory.getEntryAtIndex(targetIndex)
      if (targetEntry?.url && !this.isPlaceholderUrl(targetEntry.url)) {
        await this.pageWaiter.loadUrl(
          session.webContents,
          this.normalizeUrl(targetEntry.url),
          abortSignal
        )
      }
    }

    return true
  }

  /** 安全判断 WebContents 是否正在加载。 */
  private isWebContentsLoading(webContents: Electron.WebContents): boolean {
    try {
      return !webContents.isDestroyed() && webContents.isLoading()
    } catch (error) {
      this.log.debug('检查 WebContents 加载状态失败', {
        error: AppError.from(error).message,
      })
      return false
    }
  }

  /** 解析当前页面 URL，必要时回退到 context.url。 */
  private resolveCurrentPageUrl(session: BrowserSession, fallbackUrl: string): string {
    return this.getLoadedPageUrl(session) ?? session.url ?? fallbackUrl
  }

  /** 判断占位或错误页 URL。 */
  private isPlaceholderUrl(url: LooseOptional<string>): boolean {
    return (
      url === 'about:blank' ||
      url === 'about:srcdoc' ||
      (!!url && url.startsWith('chrome-error://'))
    )
  }

  /** 尽力聚焦 WebContents。 */
  /** 解析截图保存路径，并限制在 browser workspace 内。 */
  /** 规范化用户输入 URL；本地地址默认 http，其它无协议地址默认 https。 */
  private normalizeUrl(rawUrl: string): string {
    const value = rawUrl.trim()
    const candidate = getBrowserUrlCandidate(value)

    try {
      return new URL(candidate).toString()
    } catch (error) {
      throw new AppError('VALIDATION', `无效的浏览器 URL：${rawUrl}`, error)
    }
  }
}

export { ElectronBrowserRuntime }
