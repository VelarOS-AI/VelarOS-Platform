import type electron from 'electron'

import { isNumber, isPlainObject, isString,isTrue, numberOrNull, toNullable, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'
import { type TimerLease, TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { BrowserNavigationHistoryRestore, BrowserPageDiagnosticEntry, BrowserPageDiagnosticKind, BrowserPageDiagnosticLevel, BrowserUserActivityKind, BrowserViewportOptions } from '../core'
import {
  BrowserPendingEventsBroker,
  buildSameViewNavigationBridgeScript,
} from '../core'

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

const BrowserUserActivityConsolePrefix = '__VELAROS_BROWSER_USER_ACTIVITY__:'

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
        if (remainingWaiters.length > 0) {
          this.attachWaiters.set(sessionId, remainingWaiters)
        } else {
          this.attachWaiters.delete(sessionId)
        }
        reject(
          new AppError(
            'VALIDATION',
            '内嵌浏览器页面还没有准备好，请等页面区域出现后再执行浏览器操作。'
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

  /** 给 WebContents 绑定导航、console 和销毁事件。 */
  private bindWebContentsEvents(
    sessionId: string,
    session: BrowserSession,
    webContents: electron.WebContents
  ): void {
    const isCurrentWebContents = (): boolean =>
      this.sessions.get(sessionId)?.webContents === webContents

    webContents.setWindowOpenHandler((details) => {
      this.recordBrowserEvent(session, {
        kind: 'popup',
        level: 'info',
        message: `页面请求打开新窗口：${details.url}`,
        url: details.url || webContents.getURL() || session.url,
        details: {
          url: details.url,
          frameName: details.frameName,
          disposition: details.disposition,
          referrer: toNullable(details.referrer?.url),
          routedToCurrentView: true,
        },
      })
      // 新窗口统一改为当前内嵌 view 导航，避免页面逃出受控 WebContents。
      try {
        void this.pageWaiter.loadUrl(webContents, this.normalizeUrl(details.url)).catch((error) => {
          this.log.warn('failed to route browser popup into controlled window', {
            sessionId,
            url: details.url,
            error: AppError.from(error).message,
          })
        })
      } catch (error) {
        this.log.warn('failed to normalize browser popup URL', {
          sessionId,
          url: details.url,
          error: AppError.from(error).message,
        })
      }

      return { action: 'deny' }
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

      // 每次 DOM ready 都重新安装 bridge，因为页面脚本环境会随导航重建。
      void this.installSameViewNavigationBridge(sessionId, webContents)
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
      if (!lookup) return

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
    callback: (credentialId?: string | null) => void
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

      if (entries.length === 0) return null

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

  /** 安装同视图导航 bridge。 */
  private async installSameViewNavigationBridge(
    sessionId: string,
    webContents: electron.WebContents
  ): Promise<void> {
    try {
      if (webContents.isDestroyed()) return

      await webContents.executeJavaScript(buildSameViewNavigationBridgeScript(), true)
    } catch (error) {
      this.log.warn('failed to install browser same-view navigation bridge', {
        sessionId,
        url: webContents.isDestroyed() ? null : webContents.getURL(),
        error: AppError.from(error).message,
      })
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
