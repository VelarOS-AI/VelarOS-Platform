// 域：浏览器会话表与 WebContents 事件面——会话生命周期、站点上下文同步、权限与对话框门。
//
// ## 会话生命周期（状态机）
//   （renderer 建 webview）→ `attachWebContents` 登记 → 事件桥注入 → `notifyPageReady`
//   → `syncSessionSiteContext` 持续跟随导航 → `closeSession` / `dispose` 摘除
// `waitForSession` 存在是因为**工具调用可能早于 renderer 挂载**：agent 先发 navigate、webview
// 还没 attach。所以取会话是「等一小会儿」而不是「立即失败」，超时才报错。
//
// ## 安全门：权限请求（失败方向）
// 页面发起的权限请求（摄像头 / 麦克风 / 剪贴板 / 通知…）一律经 `handlePermissionRequest`：
//  - **有归属会话** → 挂进 `pendingEvents`，由上层（模型或用户）裁决后再 callback；
//  - **无归属会话**（不受管的 webContents）→ 走 `resolveUnmanagedPermissionRequest`；
//  - **宿主没注入策略、或策略自身抛异常 → 一律 deny**（`isTrue(undefined) === false`）。
// 这条 deny 地板是刻意的：默认允许的门在「忘了接线」时看起来一切正常，直到出事。改成
// `?? true` 之类的回落等于把整个权限面关掉。每次裁决都写一条诊断事件——降级必须留痕。
//
// ## 时序坑
//  - 用户活动 bridge 必须在**每次导航后**重注入：document 换了就没了；新窗口导航只能由
//    主进程处理，禁止再从页面 capture 阶段抢走站点 click handler；
//  - `failedMainFrameNavigations` 记住主框架失败，避免把失败页当成「已就绪」继续跑动作。
import type electron from 'electron'

import { isEmpty, isNumber, isPlainObject, isString, isTrue, numberOrNull, toNullable, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'
import { type TimerLease, TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { BrowserNavigationHistoryRestore, BrowserPageDiagnosticEntry, BrowserPageDiagnosticKind, BrowserPageDiagnosticLevel, BrowserUserActivityKind, BrowserViewportOptions } from '../core'
import { BrowserPendingEventsBroker, BrowserViewNotAttachedReason } from '../core'

import { type BrowserDiagnosticsRecorder } from './BrowserDiagnosticsRecorder'
import { type BrowserPageWaiter } from './BrowserPageWaiter'
import {
  type BrowserPermissionRequestHandler,
  type BrowserSession,
  type BrowserUnmanagedPermissionRequest,
  type BrowserWebAuthnAccountSelectionRequest,
  type ElectronBrowserRuntimeOptions,
} from './BrowserRuntimeTypes'

export interface BrowserSessionManagerOptions {
  diagnostics: BrowserDiagnosticsRecorder
  pageWaiter: BrowserPageWaiter
  normalizeUrl: (rawUrl: string) => string
  callbacks?: ElectronBrowserRuntimeOptions
}

interface BrowserSessionLookup {
  sessionId: string
  session: BrowserSession
}

interface BrowserJavaScriptDialogDetails {
  type?: string
  message?: string
  title?: string
  defaultPromptText?: string
}

interface BrowserDialogEventSource {
  on(
    eventName: 'dialog',
    listener: (
      event: electron.Event,
      details: BrowserJavaScriptDialogDetails,
      callback: (response: boolean, input?: string) => void
    ) => void
  ): void
}

type BrowserPopupNavigationResolution =
  | { kind: 'route'; url: string; loadOptions?: electron.LoadURLOptions }
  | { kind: 'bootstrap' }
  | { kind: 'deny'; reason: string }

type BrowserPopupUrlResolution =
  | { kind: 'route'; url: string }
  | { kind: 'bootstrap' }
  | { kind: 'deny'; reason: string }

interface BrowserPopupBootstrapLease {
  release: () => void
}

const BrowserUserActivityConsolePrefix = '__VELAROS_BROWSER_USER_ACTIVITY__:'
const BrowserPopupBootstrapLifetimeMs = 30_000
const BrowserPopupBootstrapRetryDelayMs = 250
const MaxBrowserPopupBootstrapsPerSession = 4
const ControlledNamedPopupWidth = 900
const ControlledNamedPopupHeight = 700
const ControlledNamedPopupMinWidth = 480
const ControlledNamedPopupMinHeight = 320
const ControlledNamedPopupMaxWidth = 1_600
const ControlledNamedPopupMaxHeight = 1_200

function buildBrowserPopupLoadOptions(
  details: electron.HandlerDetails
): electron.LoadURLOptions | undefined {
  const loadOptions: electron.LoadURLOptions = {}
  let hasOptions = false

  if (details.referrer?.url) {
    loadOptions.httpReferrer = details.referrer
    hasOptions = true
  }

  if (details.postBody) {
    const rawContentType = details.postBody.contentType.replace(/[\r\n]+/g, '').trim()
    const rawBoundary = details.postBody.boundary?.replace(/[\r\n]+/g, '').trim()
    const contentType =
      rawBoundary && /^multipart\/form-data\b/i.test(rawContentType) && !/;\s*boundary=/i.test(rawContentType)
        ? `${rawContentType}; boundary=${rawBoundary}`
        : rawContentType

    loadOptions.postData = details.postBody.data
    if (contentType) loadOptions.extraHeaders = `Content-Type: ${contentType}\n`
    hasOptions = true
  }

  return hasOptions ? loadOptions : undefined
}

function buildBrowserPopupWindowOptions(
  openerWebContents: electron.WebContents,
  interactive: boolean
): electron.BrowserWindowConstructorOptions {
  return {
    show: false,
    focusable: interactive,
    skipTaskbar: !interactive,
    ...(interactive
      ? {
          width: ControlledNamedPopupWidth,
          height: ControlledNamedPopupHeight,
          minWidth: ControlledNamedPopupMinWidth,
          minHeight: ControlledNamedPopupMinHeight,
          maxWidth: ControlledNamedPopupMaxWidth,
          maxHeight: ControlledNamedPopupMaxHeight,
          center: true,
          frame: true,
          titleBarStyle: 'default' as const,
          transparent: false,
          opacity: 1,
          modal: false,
          fullscreen: false,
          kiosk: false,
          alwaysOnTop: false,
          resizable: true,
          movable: true,
          minimizable: true,
          maximizable: true,
          closable: true,
          fullscreenable: true,
        }
      : {}),
    webPreferences: {
      session: openerWebContents.session,
      preload: undefined,
      zoomFactor: 1,
      javascript: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      disableDialogs: true,
    },
  }
}

function isNamedPopupFrame(frameName: LooseOptional<string>): boolean {
  const value = frameName?.trim()
  return Boolean(value && !value.startsWith('_'))
}

function resolveBrowserPopupUrl(
  rawUrl: LooseOptional<string>,
  disposition: LooseOptional<string>,
  openerUrl?: LooseOptional<string>
): BrowserPopupUrlResolution {
  if (disposition === 'save-to-disk') return { kind: 'deny', reason: 'download-disposition' }

  const value = rawUrl?.trim()
  if (!value) return { kind: 'bootstrap' }

  try {
    const url = new URL(value)
    if (url.protocol === 'about:' && url.pathname === 'blank') return { kind: 'bootstrap' }
    if (url.protocol === 'blob:') {
      try {
        const opener = new URL(openerUrl ?? '')
        if (url.origin === opener.origin && url.origin !== 'null')
          return { kind: 'route', url: url.toString() }
      } catch {
        // arch-guard:silent-catch-ok opener 不是标准 URL 时，blob 按不受支持协议拒绝。
      }
      return { kind: 'deny', reason: 'unsupported-blob-origin' }
    }
    if (url.protocol === 'file:') {
      try {
        if (new URL(openerUrl ?? '').protocol === 'file:')
          return { kind: 'route', url: url.toString() }
      } catch {
        // arch-guard:silent-catch-ok 发起页来源不合法时按跨信任域 file 导航拒绝。
      }
      return { kind: 'deny', reason: 'untrusted-file-navigation' }
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      return { kind: 'deny', reason: `unsupported-protocol:${url.protocol}` }

    return {
      kind: 'route',
      url: url.toString(),
    }
  } catch {
    return { kind: 'deny', reason: 'invalid-url' }
  }
}

function resolveBrowserPopupNavigation(
  details: electron.HandlerDetails,
  openerUrl?: LooseOptional<string>
): BrowserPopupNavigationResolution {
  const initiatorUrl = details.referrer?.url || openerUrl
  const resolution = resolveBrowserPopupUrl(
    details.url,
    String(details.disposition),
    initiatorUrl
  )
  if (resolution.kind !== 'route') return resolution

  return {
    ...resolution,
    loadOptions: buildBrowserPopupLoadOptions(details),
  }
}

/**
 * Electron 的 `WebContents` 类型里没有 `dialog` 事件（它是运行时存在、d.ts 未声明的一条），
 * 这里把断言收在**一个具名点**上（§1.4 白名单②：无泛型的原生驱动面）。
 * 不做运行时校验是刻意的：真缺这个事件时页面会因 alert 卡死，那是必须暴露的故障，
 * 不该被一个"看起来能跑"的降级掩盖。
 */
function asBrowserDialogEventSource(value: unknown): BrowserDialogEventSource {
  return value as BrowserDialogEventSource
}

function buildBrowserUserActivityBridgeScript(): string {
  return `
(() => {
  const key = '__velarosBrowserUserActivityBridgeInstalled';
  if (window[key]) return true;
  window[key] = true;
  const prefix = '${BrowserUserActivityConsolePrefix}';
  const emit = (kind, event) => {
    try {
      const target = event && event.target;
      const tagName = target && target.tagName ? String(target.tagName).toLowerCase() : null;
      const role = target && target.getAttribute ? target.getAttribute('role') : null;
      const type = target && target.getAttribute ? target.getAttribute('type') : null;
      const detailParts = [];
      if (tagName) detailParts.push(tagName);
      if (role) detailParts.push('role=' + role);
      if (type) detailParts.push('type=' + type);
      console.info(prefix + JSON.stringify({
        kind,
        url: window.location.href,
        detail: detailParts.join(' ')
      }));
    } catch (_error) {
      console.info(prefix + JSON.stringify({ kind: 'unknown', url: window.location.href }));
    }
  };
  document.addEventListener('pointerdown', (event) => emit('click', event), true);
  document.addEventListener('wheel', (event) => emit('scroll', event), { capture: true, passive: true });
  document.addEventListener('input', (event) => emit('input', event), true);
  document.addEventListener('change', (event) => emit('input', event), true);
  document.addEventListener('focusin', (event) => emit('focus', event), true);
  return true;
})()
`
}

/**
 * 浏览器会话管理器。
 *
 * 负责接管 renderer 提供的 WebContents、绑定导航/console/崩溃事件、
 * 同步 session URL 上下文，并让等待 attach 的操作在页面出现后继续。
 */
class BrowserSessionManager {
  /** 当前活跃浏览器会话。 */
  private readonly sessions = new Map<string, BrowserSession>()
  /** 主框架加载失败记录，用于过滤失败后紧跟的 did-finish-load 噪音。 */
  private readonly failedMainFrameNavigations = new Map<
    string,
    {
      url: string
      ignoreNextFinish: boolean
    }
  >()
  /** 等待 renderer 把 webContents attach 进来的调用。 */
  private readonly attachWaiters = new Map<
    string,
    Array<{
      resolve: (session: BrowserSession) => void
      reject: (error: AppError) => void
      timeout: TimerLease
    }>
  >()
  /** Electron Session 是共享对象，下载/权限监听只安装一次。 */
  private readonly instrumentedElectronSessions = new WeakSet<electron.Session>()
  /** 权限 gateway 的反注册函数，runtime 终止时不得留下指向已释放 broker 的 handler。 */
  private readonly permissionHandlerDisposers = new Set<() => void>()
  /** 普通 Session Event 监听器的反注册函数。 */
  private readonly electronSessionEventDisposers = new Set<() => void>()
  /** `window.open('')` 的真实子页面；命名窗口保留原生提交，未命名窗口短暂承接赋 URL。 */
  private readonly popupBootstraps = new Map<string, Set<BrowserPopupBootstrapLease>>()
  /** 受控 popup 仍归属于 opener 会话，下载/权限必须继续走同一治理链。 */
  private readonly popupSessionOwners = new WeakMap<electron.WebContents, BrowserSessionLookup>()
  private readonly timers = new TimerScope({ name: 'BrowserSessionManager' })
  private readonly diagnostics: BrowserDiagnosticsRecorder
  private readonly pageWaiter: BrowserPageWaiter
  private readonly pendingEvents: BrowserPendingEventsBroker
  private readonly normalizeUrl: (rawUrl: string) => string
  private readonly log = logRuntime.tag('BrowserSessionManager')
  private callbacks: ElectronBrowserRuntimeOptions

  constructor(options: BrowserSessionManagerOptions) {
    this.diagnostics = options.diagnostics
    this.pageWaiter = options.pageWaiter
    this.pendingEvents = new BrowserPendingEventsBroker()
    this.normalizeUrl = options.normalizeUrl
    this.callbacks = options.callbacks ?? {}
  }

  /** 更新运行时回调，通常在服务组合重新绑定 session 回调时调用。 */
  public setCallbacks(callbacks: ElectronBrowserRuntimeOptions): void {
    this.callbacks = callbacks
  }

  /** viewport 属于运行时会话状态，同时要推给固定外框内的 renderer 投影。 */
  public notifyViewportChanged(sessionId: string, viewport: BrowserViewportOptions): void {
    this.callbacks.onSessionViewportChange?.(sessionId, viewport)
  }

  /** 暴露待处理浏览器事件 broker，供 runtime 工具层处理 dialog/download/permission。 */
  public getPendingEventsBroker(): BrowserPendingEventsBroker {
    return this.pendingEvents
  }

  /** 获取未销毁的会话。 */
  public getSession(sessionId: string): BrowserSession | undefined {
    const session = this.sessions.get(sessionId)
    if (!session || session.webContents.isDestroyed()) return undefined

    return session
  }

  /** 等待会话 WebContents attach 完成。 */
  public waitForSession(sessionId: string, timeoutMs = 5_000): Promise<BrowserSession> {
    const existing = this.getSession(sessionId)
    if (existing) return Promise.resolve(existing)

    return new Promise((resolve, reject) => {
      const timeout = this.timers.after(timeoutMs, () => {
        const waiters = this.attachWaiters.get(sessionId) ?? []
        const remainingWaiters = waiters.filter((waiter) => waiter.resolve !== resolve)
        if (!isEmpty(remainingWaiters)) {
          this.attachWaiters.set(sessionId, remainingWaiters)
        } else {
          this.attachWaiters.delete(sessionId)
        }
        reject(
          new AppError(
            'VALIDATION',
            // 不写「请等页面区域出现」：页面区域不会自己出现，干等是死路——历史事故是模型
            // 照着这句话把同一个工具重试了三分半钟，最后靠公开知识编了个答案。
            // 宿主壳才知道该怎么补救，所以这里只陈述事实并打机器标记，由宿主翻译成可执行指引。
            '内嵌浏览器视图没有接入：承载页面区域的会话界面没有挂载，重试同一操作不会让它出现。',
            undefined,
            { reason: BrowserViewNotAttachedReason, sessionId, timeoutMs }
          )
        )
      })

      // 同一个 session 可能有多个操作同时等页面区域出现，全部挂到 waiters。
      const waiters = this.attachWaiters.get(sessionId) ?? []
      waiters.push({ resolve, reject, timeout })
      this.attachWaiters.set(sessionId, waiters)
    })
  }

  /** 接管 renderer 创建的 WebContents。 */
  public attachWebContents(sessionId: string, webContents: electron.WebContents): BrowserSession {
    const existing = this.getSession(sessionId)
    if (existing?.webContents === webContents) {
      // 同一个 WebContents 重新展示，只恢复 visible。
      existing.visible = true
      return existing
    }

    this.closePopupBootstraps(sessionId)

    const currentUrl = webContents.getURL()
    // about:blank 不能覆盖已有会话 URL，否则会丢失 site context。
    const sessionUrl = currentUrl && !this.isPlaceholderUrl(currentUrl) ? currentUrl : existing?.url
    const session: BrowserSession = existing
      ? {
          ...existing,
          webContents,
          visible: true,
          url: sessionUrl ?? existing.url,
        }
      : {
          webContents,
          visible: true,
          url: toNullable(sessionUrl),
          diagnostics: [],
          lastNavigation: null,
          lastNavigationError: null,
        }

    this.sessions.set(sessionId, session)
    this.installElectronSessionEventHandlers(webContents.session)
    this.bindWebContentsEvents(sessionId, session, webContents)
    this.resolveAttachWaiters(sessionId, session)

    return session
  }

  /** 关闭并清理某个浏览器会话。 */
  public closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    this.closePopupBootstraps(sessionId)
    if (!session) return

    this.sessions.delete(sessionId)
    this.failedMainFrameNavigations.delete(sessionId)
    this.pendingEvents.clearSession(sessionId)
    void this.clearWebContents(session.webContents)
    this.rejectAttachWaiters(sessionId, new AppError('VALIDATION', '浏览器页面会话已关闭。'))
    this.callbacks.onSessionClosed?.(sessionId)
  }

  /** 关闭当前窗口的全部会话，保留 manager 以便 macOS 重开主窗口时复用。 */
  public closeAllSessions(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.closeSession(sessionId)
    }
    for (const sessionId of [...this.popupBootstraps.keys()]) {
      this.closePopupBootstraps(sessionId)
    }

    this.failedMainFrameNavigations.clear()
    this.attachWaiters.forEach((waiters) => {
      waiters.forEach((waiter) => {
        waiter.timeout.cancel()
        waiter.reject(new AppError('VALIDATION', '浏览器页面会话已关闭。'))
      })
    })
    this.attachWaiters.clear()
    this.pendingEvents.clearAll()
  }

  /** 释放全部会话和等待者。 */
  public dispose(): void {
    this.closeAllSessions()
    for (const unregister of this.permissionHandlerDisposers) {
      unregister()
    }
    this.permissionHandlerDisposers.clear()
    for (const unregister of this.electronSessionEventDisposers) {
      unregister()
    }
    this.electronSessionEventDisposers.clear()
    this.pendingEvents.dispose()
    this.timers.dispose()
  }

  /** 同步页面 URL 到上层 workspace/session context。 */
  public syncSessionSiteContext(sessionId: string, rawUrl: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || !rawUrl) return

    let normalizedUrl = rawUrl
    try {
      normalizedUrl = this.normalizeUrl(rawUrl)
    } catch (error) {
      this.log.debug('浏览器会话 URL 规范化失败，保留原始地址', {
        sessionId,
        url: rawUrl,
        error: AppError.from(error).message,
      })
      // 非标准但 Electron 仍可打开的地址保留原始值。
    }

    const previousUrl = session.url
    session.url = normalizedUrl

    if (previousUrl === normalizedUrl) {
      // URL 没变化时不触发上层回调，避免重复自动快照。
      return
    }

    try {
      this.callbacks.onSessionSiteChange?.(
        sessionId,
        normalizedUrl,
        this.getNavigationHistorySnapshot(session)
      )
    } catch (error) {
      this.log.warn('同步浏览器站点上下文失败', {
        sessionId,
        url: normalizedUrl,
        error: AppError.from(error).message,
      })
    }
  }

  /** 同步外部浏览器 driver 的页面 URL 到上层 workspace/session context。 */
  public syncExternalSessionSiteContext(sessionId: string, rawUrl: string): void {
    if (!rawUrl) return

    let normalizedUrl = rawUrl
    try {
      normalizedUrl = this.normalizeUrl(rawUrl)
    } catch (error) {
      this.log.debug('外部浏览器会话 URL 规范化失败，保留原始地址', {
        sessionId,
        url: rawUrl,
        error: AppError.from(error).message,
      })
    }

    try {
      this.callbacks.onSessionSiteChange?.(sessionId, normalizedUrl)
    } catch (error) {
      this.log.warn('同步外部浏览器站点上下文失败', {
        sessionId,
        url: normalizedUrl,
        error: AppError.from(error).message,
      })
    }
  }

  /** 通知上层页面 ready，通常触发自动快照。 */
  public notifyPageReady(sessionId: string, rawUrl: string): void {
    if (!rawUrl) return

    let normalizedUrl = rawUrl
    try {
      normalizedUrl = this.normalizeUrl(rawUrl)
    } catch (error) {
      this.log.debug('浏览器就绪 URL 规范化失败，保留原始地址', {
        sessionId,
        url: rawUrl,
        error: AppError.from(error).message,
      })
      // 非标准但 Electron 仍可打开的地址保留原始值。
    }

    try {
      this.callbacks.onSessionPageReady?.(sessionId, normalizedUrl)
    } catch (error) {
      this.log.warn('通知浏览器页面就绪失败', {
        sessionId,
        url: normalizedUrl,
        error: AppError.from(error).message,
      })
    }
  }

  /**
   * 新窗口请求的唯一裁决点。
   *
   * 普通 HTTP(S) 链接与表单折叠进当前受控页面；file 只允许由本地 file 页面继续发起；
   * 空白 bootstrap 保留一个受限的真实子 WebContents，让站点可先拿 WindowProxy、稍后赋 URL。
   */
  private handleWindowOpenRequest(
    sessionId: string,
    session: BrowserSession,
    webContents: electron.WebContents,
    details: electron.HandlerDetails
  ): electron.WindowOpenHandlerResponse {
    if (this.sessions.get(sessionId)?.webContents !== webContents) return { action: 'deny' }

    const resolution = resolveBrowserPopupNavigation(details, webContents.getURL())
    const diagnosticDetails = {
      url: details.url,
      frameName: details.frameName,
      disposition: details.disposition,
      referrer: toNullable(details.referrer?.url),
      method: details.postBody ? 'POST' : 'GET',
    }

    if (resolution.kind === 'route') {
      this.recordBrowserEvent(session, {
        kind: 'popup',
        level: 'info',
        message: `页面请求在当前视图打开链接：${resolution.url}`,
        url: resolution.url,
        details: {
          ...diagnosticDetails,
          routedToCurrentView: false,
          routingStatus: 'queued',
        },
      })
      this.routePopupNavigation(
        sessionId,
        session,
        webContents,
        resolution.url,
        diagnosticDetails,
        resolution.loadOptions
      )
      return { action: 'deny' }
    }

    if (resolution.kind === 'bootstrap') {
      const nativeNamedPopup = isNamedPopupFrame(details.frameName)
      if ((this.popupBootstraps.get(sessionId)?.size ?? 0) >= MaxBrowserPopupBootstrapsPerSession) {
        this.recordBrowserEvent(session, {
          kind: 'popup',
          level: 'warning',
          message: '页面同时创建了过多空白新窗口，请求已拒绝。',
          url: webContents.getURL() || session.url,
          details: {
            ...diagnosticDetails,
            routedToCurrentView: false,
            routingStatus: 'blocked',
            reason: 'bootstrap-limit',
          },
        })
        return { action: 'deny' }
      }

      this.recordBrowserEvent(session, {
        kind: 'popup',
        level: 'info',
        message: '页面创建空白跳转上下文，等待目标地址。',
        url: webContents.getURL() || session.url,
        details: {
          ...diagnosticDetails,
          routedToCurrentView: false,
          routingStatus: 'bootstrap',
        },
      })
      return {
        action: 'allow',
        outlivesOpener: false,
        overrideBrowserWindowOptions: buildBrowserPopupWindowOptions(
          webContents,
          nativeNamedPopup
        ),
      }
    }

    this.recordBrowserEvent(session, {
      kind: 'popup',
      level: 'warning',
      message: `页面新窗口请求被拒绝：${details.url || 'about:blank'}`,
      url: details.url || webContents.getURL() || session.url,
      details: {
        ...diagnosticDetails,
        routedToCurrentView: false,
        routingStatus: 'blocked',
        reason: resolution.reason,
      },
    })
    return { action: 'deny' }
  }

  /** 立即执行用户触发的 popup 导航，并只在真实完成后记录 routed=true。 */
  private routePopupNavigation(
    sessionId: string,
    session: BrowserSession,
    webContents: electron.WebContents,
    url: string,
    diagnosticDetails: Record<string, unknown>,
    loadOptions?: electron.LoadURLOptions,
    onSettled?: () => void
  ): void {
    void (async () => {
      try {
        // 页面点击与普通同视图链接一样属于用户优先导航，不能排在 Agent 动作队列后面；
        // 新 loadURL 会自然中止旧导航，等待器负责把结果归因给各自调用方。
        await this.pageWaiter.loadUrl(webContents, url, undefined, loadOptions)
        if (this.sessions.get(sessionId)?.webContents !== webContents) return

        this.recordBrowserEvent(session, {
          kind: 'popup',
          level: 'info',
          message: `页面链接已在当前视图打开：${url}`,
          url,
          details: {
            ...diagnosticDetails,
            routedToCurrentView: true,
            routingStatus: 'completed',
          },
        })
      } catch (error) {
        const message = AppError.from(error).message
        if (this.sessions.get(sessionId)?.webContents === webContents) {
          this.recordBrowserEvent(session, {
            kind: 'popup',
            level: 'warning',
            message: `页面链接未能在当前视图打开：${url}`,
            url,
            details: {
              ...diagnosticDetails,
              routedToCurrentView: false,
              routingStatus: 'failed',
              error: message,
            },
          })
        }
        this.log.warn('failed to route browser popup into controlled window', {
          sessionId,
          url,
          error: message,
        })
      } finally {
        onSettled?.()
      }
    })()
  }

  /** 接管 Electron 原生创建的子窗，承接延迟赋 URL 或命名表单的原生提交。 */
  private bindPopupBootstrapWindow(
    sessionId: string,
    session: BrowserSession,
    openerWebContents: electron.WebContents,
    popupWindow: electron.BrowserWindow,
    details: electron.DidCreateWindowDetails
  ): void {
    const initiatorUrl = details.referrer?.url || openerWebContents.getURL()
    const nativeNamedPopup = isNamedPopupFrame(details.frameName)
    const initialResolution = resolveBrowserPopupUrl(
      details.url,
      String(details.disposition),
      initiatorUrl
    )
    if (
      initialResolution.kind !== 'bootstrap' ||
      this.sessions.get(sessionId)?.webContents !== openerWebContents
    ) {
      if (!popupWindow.isDestroyed()) popupWindow.destroy()
      return
    }

    const popupWebContents = popupWindow.webContents
    const leases = this.popupBootstraps.get(sessionId) ?? new Set<BrowserPopupBootstrapLease>()
    this.popupBootstraps.set(sessionId, leases)

    let released = false
    let releasing = false
    let releaseRetryCount = 0
    let routingStarted = false
    let navigationHandlingStarted = false
    let nativePopupActivated = false
    let timeout: Nullable<TimerLease> = null
    const release = (): void => {
      if (released || releasing) return
      releasing = true
      timeout?.cancel()
      timeout = null

      try {
        if (!popupWindow.isDestroyed()) popupWindow.destroy()
      } catch (error) {
        releasing = false
        this.log.debug('清理浏览器空白 popup 失败', {
          sessionId,
          error: AppError.from(error).message,
        })
        if (releaseRetryCount < 2) {
          releaseRetryCount += 1
          timeout = this.timers.after(BrowserPopupBootstrapRetryDelayMs, release, {
            label: 'browser.popup-bootstrap.release-retry',
          })
        }
        return
      }

      released = true
      releasing = false
      this.popupSessionOwners.delete(popupWebContents)
      leases.delete(lease)
      if (leases.size === 0) this.popupBootstraps.delete(sessionId)
    }
    const lease: BrowserPopupBootstrapLease = { release }
    leases.add(lease)
    this.popupSessionOwners.set(popupWebContents, { sessionId, session })

    const routeBootstrapUrl = (
      rawUrl: string,
      loadOptions?: electron.LoadURLOptions,
      details: Record<string, unknown> = {}
    ): void => {
      if (routingStarted) return

      const resolution = resolveBrowserPopupUrl(
        rawUrl,
        'default',
        initiatorUrl
      )
      if (resolution.kind === 'bootstrap') return
      if (resolution.kind === 'deny') {
        this.recordBrowserEvent(session, {
          kind: 'popup',
          level: 'warning',
          message: `空白新窗口的目标地址被拒绝：${rawUrl}`,
          url: rawUrl || openerWebContents.getURL() || session.url,
          details: {
            ...details,
            routedToCurrentView: false,
            routingStatus: 'blocked',
            reason: resolution.reason,
          },
        })
        release()
        return
      }

      routingStarted = true
      const diagnosticDetails = {
        ...details,
        source: 'blank-popup-bootstrap',
      }
      this.recordBrowserEvent(session, {
        kind: 'popup',
        level: 'info',
        message: `空白新窗口请求在当前视图打开链接：${resolution.url}`,
        url: resolution.url,
        details: {
          ...diagnosticDetails,
          routedToCurrentView: false,
          routingStatus: 'queued',
        },
      })
      this.routePopupNavigation(
        sessionId,
        session,
        openerWebContents,
        resolution.url,
        diagnosticDetails,
        loadOptions,
        release
      )
    }

    popupWebContents.on('will-navigate', (event, url) => {
      const currentPopupUrl = popupWebContents.getURL()
      const currentPopupResolution = resolveBrowserPopupUrl(
        currentPopupUrl,
        'default',
        initiatorUrl
      )
      const navigationInitiatorUrl =
        currentPopupUrl && currentPopupResolution.kind !== 'bootstrap'
          ? currentPopupUrl
          : initiatorUrl
      const resolution = resolveBrowserPopupUrl(url, 'default', navigationInitiatorUrl)
      if (resolution.kind === 'bootstrap') return

      if (nativeNamedPopup) {
        if (resolution.kind === 'deny') {
          event.preventDefault()
          this.recordBrowserEvent(session, {
            kind: 'popup',
            level: 'warning',
            message: `命名新窗口的目标地址被拒绝：${url}`,
            url: url || openerWebContents.getURL() || session.url,
            details: {
              url,
              source: 'named-popup',
              routedToCurrentView: false,
              routingStatus: 'blocked',
              reason: resolution.reason,
            },
          })
          if (!nativePopupActivated) release()
          return
        }

        if (!nativePopupActivated) {
          try {
            popupWindow.setMaximumSize(
              ControlledNamedPopupMaxWidth,
              ControlledNamedPopupMaxHeight
            )
            popupWindow.setMinimumSize(
              ControlledNamedPopupMinWidth,
              ControlledNamedPopupMinHeight
            )
            popupWindow.setSize(
              ControlledNamedPopupWidth,
              ControlledNamedPopupHeight,
              false
            )
            popupWindow.center()
            popupWindow.show()
          } catch (error) {
            event.preventDefault()
            this.log.warn('failed to show controlled named browser popup', {
              sessionId,
              url,
              error: AppError.from(error).message,
            })
            release()
            return
          }

          nativePopupActivated = true
          timeout?.cancel()
          timeout = null
          this.recordBrowserEvent(session, {
            kind: 'popup',
            level: 'info',
            message: `命名新窗口已按页面原始提交语义打开：${resolution.url}`,
            url: resolution.url,
            details: {
              url: resolution.url,
              frameName: details.frameName,
              source: 'named-popup',
              routedToCurrentView: false,
              routingStatus: 'opened-controlled-popup',
              method: 'preserved-by-browser',
            },
          })
        }
        return
      }

      event.preventDefault()
      if (navigationHandlingStarted) return
      navigationHandlingStarted = true
      const referrer = details.referrer?.url ? details.referrer : undefined
      routeBootstrapUrl(
        url,
        referrer ? { httpReferrer: referrer } : undefined,
        { url, method: 'GET' }
      )
    })
    popupWebContents.setWindowOpenHandler((details) => {
      const resolution = resolveBrowserPopupNavigation(
        details,
        nativeNamedPopup ? popupWebContents.getURL() : initiatorUrl
      )
      if (resolution.kind === 'route') {
        if (nativeNamedPopup) {
          void popupWebContents.loadURL(resolution.url, resolution.loadOptions).catch((error) => {
            this.log.warn('failed to route nested browser popup in its controlled window', {
              sessionId,
              url: resolution.url,
              error: AppError.from(error).message,
            })
          })
          return { action: 'deny' }
        }
        routeBootstrapUrl(resolution.url, resolution.loadOptions, {
          url: resolution.url,
          method: details.postBody ? 'POST' : 'GET',
        })
      } else if (resolution.kind === 'deny') {
        routeBootstrapUrl(details.url, undefined, {
          url: details.url,
          method: details.postBody ? 'POST' : 'GET',
        })
      }
      return { action: 'deny' }
    })
    popupWebContents.on('destroyed', release)
    timeout = this.timers.after(BrowserPopupBootstrapLifetimeMs, release, {
      label: 'browser.popup-bootstrap.expire',
    })
  }

  private closePopupBootstraps(sessionId: string): void {
    const leases = this.popupBootstraps.get(sessionId)
    if (!leases) return

    for (const lease of [...leases]) lease.release()
  }

  /** 给 WebContents 绑定导航、console 和销毁事件。 */
  private bindWebContentsEvents(
    sessionId: string,
    session: BrowserSession,
    webContents: electron.WebContents
  ): void {
    const isCurrentWebContents = (): boolean =>
      this.sessions.get(sessionId)?.webContents === webContents

    webContents.setWindowOpenHandler((details) =>
      this.handleWindowOpenRequest(sessionId, session, webContents, details)
    )
    webContents.on('did-create-window', (popupWindow, details) => {
      this.bindPopupBootstrapWindow(sessionId, session, webContents, popupWindow, details)
    })
    const dialogEvents = asBrowserDialogEventSource(webContents)

    dialogEvents.on('dialog', (_event, details, callback) => {
      if (!isCurrentWebContents()) {
        callback(false)
        return
      }

      const type = details.type ?? 'unknown'
      this.recordUserActivity(sessionId, 'dialog', {
        url: webContents.getURL() || session.url,
        detail: details.message ?? type,
      })
      this.recordBrowserEvent(session, {
        kind: 'dialog',
        level: type === 'alert' ? 'info' : 'warning',
        message: `页面弹窗等待处理：${details.message ?? type}`,
        url: webContents.getURL() || session.url,
        details: {
          type,
          title: toNullable(details.title),
          message: toNullable(details.message),
          defaultPromptText: toNullable(details.defaultPromptText),
          pending: true,
          handledBy: 'velaros-browser-runtime',
        },
      })

      this.pendingEvents.handleIncomingDialog({
        sessionId,
        details,
        callback: (response, promptText) => {
          this.recordBrowserEvent(session, {
            kind: 'dialog',
            level: 'info',
            message: `页面弹窗已${response ? '确认' : '取消'}：${details.message ?? type}`,
            url: webContents.getURL() || session.url,
            details: {
              type,
              title: toNullable(details.title),
              message: toNullable(details.message),
              defaultPromptText: toNullable(details.defaultPromptText),
              response,
              promptText: toNullable(promptText),
              pending: false,
              handledBy: 'velaros-browser-runtime',
            },
          })
          callback(response, promptText ?? '')
        },
      })
    })
    webContents.on('dom-ready', () => {
      if (!isCurrentWebContents()) return

      // 页面侧只观察活动，不再捕获/改写 click 或 window.open；新窗口策略由主进程唯一持有。
      void this.installUserActivityBridge(sessionId, webContents)
    })
    webContents.on('before-input-event', (_event, input) => {
      if (!isCurrentWebContents()) return
      if (!input || (input.type !== 'keyDown' && input.type !== 'rawKeyDown')) return

      this.recordUserActivity(sessionId, 'keyboard', {
        url: webContents.getURL() || session.url,
        detail: this.formatKeyboardActivityDetail(input),
      })
    })
    webContents.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
      if (!isCurrentWebContents() || !isMainFrame) return

      this.clearFailedNavigationIfDifferent(sessionId, url)
    })
    webContents.on('did-navigate', (_event, url, httpResponseCode) => {
      if (!isCurrentWebContents()) return
      if (this.isPlaceholderUrl(url)) return

      // B2: 记录导航历史
      session.lastNavigation = { url, type: 'load' }
      // B3: HTTP 4xx/5xx 记录为错误
      if (isNumber(httpResponseCode) && httpResponseCode >= 400) {
        session.lastNavigationError = {
          url,
          errorCode: httpResponseCode,
          errorDescription: `HTTP ${httpResponseCode}`,
          failedAt: Date.now(),
        }
      } else {
        session.lastNavigationError = null
      }
    })
    webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isCurrentWebContents()) return

        // B3: did-fail-load (-3=ERR_ABORTED 用户取消，忽略)
        if (errorCode !== -3) {
          session.lastNavigationError = {
            url: validatedURL || session.url || '',
            errorCode,
            errorDescription: errorDescription || `error ${errorCode}`,
            failedAt: Date.now(),
          }
        }

        if (!isMainFrame) return

        if (errorCode !== -3) {
          this.rememberFailedMainFrameNavigation(sessionId, validatedURL || session.url || '')
        }

        this.diagnostics.record(session, {
          kind: 'load-error',
          level: 'error',
          message: errorDescription || `load failed with code ${errorCode}`,
          url: validatedURL || webContents.getURL() || null,
          line: null,
          column: null,
          code: errorCode,
          capturedAt: Date.now(),
        })
      }
    )
    webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isCurrentWebContents()) return
      if (this.isPlaceholderUrl(url)) return

      if (isMainFrame) {
        if (this.isFailedMainFrameNavigation(sessionId, url)) {
          // 失败导航可能也触发 in-page 事件，不要把失败 URL 当成 ready。
          return
        }

        this.syncSessionSiteContext(sessionId, url)
        this.recordUserActivity(sessionId, 'navigation', { url })
        this.notifyPageReady(sessionId, url)
      }
    })
    webContents.on('did-finish-load', () => {
      if (!isCurrentWebContents()) return

      const currentUrl = webContents.getURL()
      if (currentUrl && !this.isPlaceholderUrl(currentUrl)) {
        if (this.isFailedMainFrameNavigation(sessionId, currentUrl, { consumeFinish: true })) {
          // did-fail-load 后可能跟一个 did-finish-load，过滤掉这次完成事件。
          return
        }

        this.syncSessionSiteContext(sessionId, currentUrl)
        this.recordUserActivity(sessionId, 'navigation', { url: currentUrl })
        this.notifyPageReady(sessionId, currentUrl)
      }
    })
    webContents.on('console-message', (details) => {
      if (!isCurrentWebContents()) return
      if (this.tryRecordConsoleUserActivity(sessionId, details.message, details.sourceId)) return
      if (!this.diagnostics.shouldRecordConsoleMessage(details.message, details.sourceId)) return

      this.diagnostics.record(session, {
        kind: 'console',
        level: this.diagnostics.normalizeConsoleLevel(details.level),
        message: details.message,
        url: details.sourceId || webContents.getURL() || null,
        line: numberOrNull(details.lineNumber),
        column: null,
        code: null,
        capturedAt: Date.now(),
      })
    })
    webContents.on('render-process-gone', (_event, details) => {
      if (!isCurrentWebContents()) return

      this.diagnostics.record(session, {
        kind: 'render-process-gone',
        level: 'error',
        message: details.reason,
        url: webContents.getURL() || session.url,
        line: null,
        column: null,
        code: details.exitCode,
        capturedAt: Date.now(),
      })
    })
    webContents.on('destroyed', () => {
      if (isCurrentWebContents()) {
        this.sessions.delete(sessionId)
        this.failedMainFrameNavigations.delete(sessionId)
        this.closePopupBootstraps(sessionId)
      }
    })
  }

  /** 安装 Electron Session 级事件：下载、权限请求和 WebAuthn 账号选择。 */
  private installElectronSessionEventHandlers(
    electronSession: LooseOptional<electron.Session>
  ): void {
    if (!electronSession) return

    if (this.instrumentedElectronSessions.has(electronSession)) return

    this.instrumentedElectronSessions.add(electronSession)
    electronSession.on('select-webauthn-account', this.handleWebAuthnAccountSelection)
    this.electronSessionEventDisposers.add(() => {
      electronSession.off('select-webauthn-account', this.handleWebAuthnAccountSelection)
    })
    electronSession.on('will-download', (_event, item, downloadWebContents) => {
      const lookup = this.findSessionByWebContents(downloadWebContents)
      if (!lookup) {
        if (downloadWebContents && this.popupSessionOwners.has(downloadWebContents)) {
          try {
            item.cancel()
          } catch (error) {
            this.log.debug('取消失去 opener 的 popup 下载失败', {
              error: AppError.from(error).message,
            })
          }
        }
        return
      }

      const filename = item.getFilename()
      const totalBytes = item.getTotalBytes()
      const url = item.getURL() || lookup.session.url
      this.recordUserActivity(lookup.sessionId, 'download', {
        url,
        detail: filename || null,
      })
      this.recordBrowserEvent(lookup.session, {
        kind: 'download',
        level: 'info',
        message: `页面下载等待处理：${filename || url || 'unknown'}`,
        url,
        details: {
          state: 'pending',
          filename,
          mimeType: item.getMimeType(),
          totalBytes,
          receivedBytes: item.getReceivedBytes(),
          savePath: item.getSavePath() || null,
          pending: true,
        },
      })

      this.pendingEvents.handleIncomingDownload({
        sessionId: lookup.sessionId,
        item,
        url,
      })

      item.once('done', (_doneEvent, state) => {
        this.recordBrowserEvent(lookup.session, {
          kind: 'download',
          level: state === 'completed' ? 'info' : 'warning',
          message: `页面下载${state === 'completed' ? '完成' : '结束'}：${filename || state}`,
          url,
          details: {
            state,
            filename,
            mimeType: item.getMimeType(),
            totalBytes: item.getTotalBytes(),
            receivedBytes: item.getReceivedBytes(),
            savePath: item.getSavePath() || null,
            pending: false,
          },
        })
      })
    })

    const unregisterPermissionHandler = this.callbacks.registerPermissionRequestHandler?.(
      electronSession,
      this.handlePermissionRequest
    )
    if (unregisterPermissionHandler) {
      this.permissionHandlerDisposers.add(unregisterPermissionHandler)
    }
  }

  private readonly handleWebAuthnAccountSelection = (
    _event: electron.Event,
    details: electron.SelectWebauthnAccountDetails,
    callback: (credentialId?: LooseOptional<string>) => void
  ): void => {
    let settled = false
    const settle = (credentialId?: string): void => {
      if (settled) return
      settled = true
      callback(credentialId)
    }

    const request: BrowserWebAuthnAccountSelectionRequest = {
      relyingPartyId: details.relyingPartyId,
      accounts: details.accounts.map((account) => ({ ...account })),
    }
    const validCredentialIds = new Set(request.accounts.map((account) => account.credentialId))
    if (validCredentialIds.size === 1) {
      settle(request.accounts[0]?.credentialId)
      return
    }

    const selector = this.callbacks.selectWebAuthnAccount
    if (!selector) {
      settle()
      return
    }

    void selector(request)
      .then((credentialId) => {
        if (credentialId && validCredentialIds.has(credentialId)) settle(credentialId)
        else settle()
      })
      .catch((error) => {
        this.log.warn('WebAuthn Passkey 账号选择失败，取消当前验证', {
          relyingPartyId: request.relyingPartyId,
          error: AppError.from(error).message,
        })
        settle()
      })
  }

  private readonly handlePermissionRequest: BrowserPermissionRequestHandler = (
    requestingWebContents,
    permission,
    callback,
    details
  ) => {
    const lookup = this.findSessionByWebContents(requestingWebContents)
    const requestingUrl = this.readEventString(details, 'requestingUrl')
    const embeddingOrigin = this.readEventString(details, 'embeddingOrigin')
    const url = requestingWebContents?.getURL() || lookup?.session.url || null

    if (!lookup) {
      if (requestingWebContents && this.popupSessionOwners.has(requestingWebContents)) {
        callback(false)
        return
      }
      const granted = this.resolveUnmanagedPermissionRequest({
        permission,
        url,
        requestingUrl,
        embeddingOrigin,
      })
      callback(granted)
      return
    }

    this.recordUserActivity(lookup.sessionId, 'permission', {
      url,
      detail: permission,
    })
    this.recordBrowserEvent(lookup.session, {
      kind: 'permission',
      level: 'info',
      message: `页面请求权限等待处理：${permission}`,
      url,
      details: {
        permission,
        requestingUrl,
        embeddingOrigin,
        pending: true,
      },
    })

    this.pendingEvents.handleIncomingPermission({
      sessionId: lookup.sessionId,
      permission,
      url,
      requestingUrl,
      embeddingOrigin,
      callback: (granted) => {
        this.recordBrowserEvent(lookup.session, {
          kind: 'permission',
          level: 'info',
          message: `页面请求权限并已${granted ? '允许' : '拒绝'}：${permission}`,
          url,
          details: {
            permission,
            requestingUrl,
            embeddingOrigin,
            granted,
            pending: false,
          },
        })
        callback(granted)
      },
    })
  }

  private resolvePermissionRequest(input: {
    sessionId: string
    permission: string
    url: Nullable<string>
    requestingUrl: Nullable<string>
    embeddingOrigin: Nullable<string>
  }): boolean {
    try {
      return isTrue(this.callbacks.resolvePermissionRequest?.(input))
    } catch (error) {
      this.log.warn('浏览器权限策略执行失败，默认拒绝权限请求', {
        sessionId: input.sessionId,
        permission: input.permission,
        url: input.url,
        error: AppError.from(error).message,
      })
      return false
    }
  }

  private resolveUnmanagedPermissionRequest(input: BrowserUnmanagedPermissionRequest): boolean {
    try {
      return isTrue(this.callbacks.resolveUnmanagedPermissionRequest?.(input))
    } catch (error) {
      this.log.warn('默认浏览器权限策略执行失败，默认拒绝权限请求', {
        permission: input.permission,
        url: input.url,
        error: AppError.from(error).message,
      })
      return false
    }
  }

  private findSessionByWebContents(
    webContents: LooseOptional<electron.WebContents>
  ): Nullable<BrowserSessionLookup> {
    if (!webContents) return null

    for (const [sessionId, session] of this.sessions) {
      if (session.webContents === webContents) return { sessionId, session }
    }

    const popupOwner = this.popupSessionOwners.get(webContents)
    if (popupOwner && this.sessions.get(popupOwner.sessionId) === popupOwner.session)
      return popupOwner

    return null
  }

  private recordBrowserEvent(
    session: BrowserSession,
    event: {
      kind: BrowserPageDiagnosticKind
      level: BrowserPageDiagnosticLevel
      message: string
      url?: LooseOptional<string>
      details?: Record<string, unknown>
    }
  ): void {
    const entry: BrowserPageDiagnosticEntry = {
      kind: event.kind,
      level: event.level,
      message: event.message,
      url: toNullable(event.url),
      line: null,
      column: null,
      code: null,
      capturedAt: Date.now(),
      details: toOptional(event.details),
    }

    this.diagnostics.record(session, entry)
  }

  private recordUserActivity(
    sessionId: string,
    kind: BrowserUserActivityKind,
    input: {
      url?: LooseOptional<string>
      detail?: LooseOptional<string>
      occurredAt?: LooseOptional<number>
    } = {}
  ): void {
    this.callbacks.onUserActivity?.({
      sessionId,
      kind,
      url: toOptional(input.url),
      detail: toOptional(input.detail),
      occurredAt: toOptional(input.occurredAt),
    })
  }

  private tryRecordConsoleUserActivity(
    sessionId: string,
    message: LooseOptional<string>,
    sourceId: LooseOptional<string>
  ): boolean {
    if (!message?.startsWith(BrowserUserActivityConsolePrefix)) return false

    const rawPayload = message.slice(BrowserUserActivityConsolePrefix.length)
    try {
      const payload = JSON.parse(rawPayload)
      const kind = this.readUserActivityKind(payload)
      this.recordUserActivity(sessionId, kind, {
        url: this.readEventString(payload, 'url') ?? sourceId,
        detail: this.readEventString(payload, 'detail'),
      })
      return true
    } catch (error) {
      this.log.debug('浏览器用户活动 bridge 事件解析失败', {
        sessionId,
        sourceId,
        error: AppError.from(error).message,
      })
      this.recordUserActivity(sessionId, 'unknown', { url: sourceId })
      return true
    }
  }

  private readUserActivityKind(payload: unknown): BrowserUserActivityKind {
    if (!isPlainObject(payload)) return 'unknown'

    const kind = payload['kind']
    switch (kind) {
      case 'click':
      case 'keyboard':
      case 'scroll':
      case 'input':
      case 'navigation':
      case 'dialog':
      case 'download':
      case 'permission':
      case 'focus':
        return kind
      default:
        return 'unknown'
    }
  }

  private formatKeyboardActivityDetail(input: { key?: LooseOptional<string> }): Nullable<string> {
    const key = input.key?.trim()
    if (!key || key.length === 1) return null

    return `key=${key}`
  }

  private readEventString(value: unknown, key: string): Nullable<string> {
    if (!isPlainObject(value)) return null

    const property = value[key]
    return isString(property) ? property : null
  }

  /** 记录失败主框架导航。 */
  private rememberFailedMainFrameNavigation(sessionId: string, rawUrl: string): void {
    if (!rawUrl) return

    this.failedMainFrameNavigations.set(sessionId, {
      url: this.normalizeComparableUrl(rawUrl),
      ignoreNextFinish: true,
    })
  }

  /** 判断当前 URL 是否对应刚刚失败的主框架导航。 */
  private isFailedMainFrameNavigation(
    sessionId: string,
    rawUrl: string,
    options: { consumeFinish?: boolean } = {}
  ): boolean {
    const failedNavigation = this.failedMainFrameNavigations.get(sessionId)
    if (!failedNavigation) return false

    const currentUrl = this.normalizeComparableUrl(rawUrl)
    if (failedNavigation.url === currentUrl) return true

    if (options.consumeFinish && failedNavigation.ignoreNextFinish) {
      // 消耗一次 did-finish-load 后清理失败记录。
      this.failedMainFrameNavigations.delete(sessionId)
      return true
    }

    this.failedMainFrameNavigations.delete(sessionId)
    return false
  }

  /** 新导航开始时，如果 URL 已变化，清理旧失败记录。 */
  private clearFailedNavigationIfDifferent(sessionId: string, rawUrl: string): void {
    const failedNavigation = this.failedMainFrameNavigations.get(sessionId)
    if (!failedNavigation) return

    if (failedNavigation.url !== this.normalizeComparableUrl(rawUrl)) {
      this.failedMainFrameNavigations.delete(sessionId)
    }
  }

  /** 用于失败导航比较的 URL 规范化。 */
  private normalizeComparableUrl(rawUrl: string): string {
    try {
      return this.normalizeUrl(rawUrl)
    } catch (error) {
      this.log.debug('可比较浏览器 URL 规范化失败，保留原始地址', {
        url: rawUrl,
        error: AppError.from(error).message,
      })
      return rawUrl
    }
  }

  /** 从 Electron navigationHistory 生成可恢复快照。 */
  private getNavigationHistorySnapshot(
    session: BrowserSession
  ): Nullable<BrowserNavigationHistoryRestore> {
    try {
      if (session.webContents.isDestroyed()) return null

      const rawEntries = session.webContents.navigationHistory.getAllEntries()
      const activeIndex = session.webContents.navigationHistory.getActiveIndex()
      const entries: BrowserNavigationHistoryRestore['entries'] = []
      let normalizedIndex = -1

      rawEntries.forEach((entry, index) => {
        if (!entry.url || this.isPlaceholderUrl(entry.url)) return

        let url = entry.url
        try {
          url = this.normalizeUrl(entry.url)
        } catch (error) {
          this.log.debug('浏览器历史条目规范化失败，保留 Electron 地址', {
            url: entry.url,
            error: AppError.from(error).message,
          })
          // Keep Electron's URL if it is valid for the webview but outside our normalizer.
        }

        if (index === activeIndex) {
          // 过滤 about:blank 后 active index 需要重新映射到 entries 数组。
          normalizedIndex = entries.length
        }

        entries.push({
          url,
          title: entry.title || null,
          pageState: isString(entry.pageState) ? entry.pageState : null,
        })
      })

      if (isEmpty(entries)) return null

      return {
        entries,
        index: normalizedIndex >= 0 ? normalizedIndex : entries.length - 1,
      }
    } catch (error) {
      this.log.debug('快照浏览器导航历史失败', {
        error: AppError.from(error).message,
      })
      return null
    }
  }

  /** 解析等待 attach 的调用。 */
  private resolveAttachWaiters(sessionId: string, session: BrowserSession): void {
    const waiters = this.attachWaiters.get(sessionId)
    if (!waiters?.length) return

    this.attachWaiters.delete(sessionId)
    waiters.forEach((waiter) => {
      waiter.timeout.cancel()
      waiter.resolve(session)
    })
  }

  /** 拒绝等待 attach 的调用。 */
  private rejectAttachWaiters(sessionId: string, error: AppError): void {
    const waiters = this.attachWaiters.get(sessionId)
    if (!waiters?.length) return

    this.attachWaiters.delete(sessionId)
    waiters.forEach((waiter) => {
      waiter.timeout.cancel()
      waiter.reject(error)
    })
  }

  /** 尽量把 WebContents 清回空白页。 */
  private async clearWebContents(webContents: electron.WebContents): Promise<void> {
    try {
      if (!webContents.isDestroyed()) {
        await webContents.loadURL('about:blank')
      }
    } catch (error) {
      this.log.debug('清理浏览器 WebContents 失败', {
        error: AppError.from(error).message,
      })
      // The embedded webview may already be tearing down with its React owner.
    }
  }

  /** 安装用户活动 bridge，用 console marker 回传无敏感文本的页面操作摘要。 */
  private async installUserActivityBridge(
    sessionId: string,
    webContents: electron.WebContents
  ): Promise<void> {
    try {
      if (webContents.isDestroyed()) return

      await webContents.executeJavaScript(buildBrowserUserActivityBridgeScript(), true)
    } catch (error) {
      this.log.warn('failed to install browser user activity bridge', {
        sessionId,
        url: webContents.isDestroyed() ? null : webContents.getURL(),
        error: AppError.from(error).message,
      })
    }
  }

  /** 判断占位 URL。 */
  private isPlaceholderUrl(url: LooseOptional<string>): boolean {
    return url === 'about:blank' || url === 'about:srcdoc'
  }
}

export { BrowserSessionManager }
