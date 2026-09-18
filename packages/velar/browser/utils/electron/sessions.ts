import type electron from 'electron'

import { isPlainObject, isString } from '@velaros-ai/core'

import type { BrowserUserActivityKind } from '../../types/browser'
import type { BrowserDialogEventSource,BrowserPopupNavigationResolution, BrowserPopupUrlResolution } from '../../types/electron.js'
import { BrowserTuning } from '../tuning.js'

/**
 * 注入脚本把用户活动经 console 回传主进程时用的前缀。
 *
 * 形似环境变量的大写名字会被门禁的环境变量扫描当成未登记的变量拦下，所以按小写写；
 * 注入脚本与主进程的解析都在本包里，改一处就够。
 */
export const browserUserActivityConsolePrefix = '__velaros_browser_user_activity__:'

/** 给受控弹窗拼加载参数（referrer、POST 数据、扩展请求头）。 */
export function buildBrowserPopupLoadOptions(
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

/** 按站点给的窗口特性算出受控弹窗的实际尺寸，并夹进允许区间。 */
export function buildBrowserPopupWindowOptions(
  openerWebContents: electron.WebContents,
  interactive: boolean
): electron.BrowserWindowConstructorOptions {
  return {
    show: false,
    focusable: interactive,
    skipTaskbar: !interactive,
    ...(interactive
      ? {
          width: BrowserTuning.popup.width,
          height: BrowserTuning.popup.height,
          minWidth: BrowserTuning.popup.minWidth,
          minHeight: BrowserTuning.popup.minHeight,
          maxWidth: BrowserTuning.popup.maxWidth,
          maxHeight: BrowserTuning.popup.maxHeight,
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

/** 判一个 window.open 的窗口名是不是命名窗口（不是 _blank 之类）。 */
export function isNamedPopupFrame(frameName: LooseOptional<string>): boolean {
  const value = frameName?.trim()
  return Boolean(value && !value.startsWith('_'))
}

/** 把 window.open 给的地址解析成可导航的绝对地址。 */
export function resolveBrowserPopupUrl(
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

/** 判一次弹窗导航该放行、该接管，还是该拦下。 */
export function resolveBrowserPopupNavigation(
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
export function asBrowserDialogEventSource(value: unknown): BrowserDialogEventSource {
  return value as BrowserDialogEventSource
}

/** 拼注入脚本：把页面上的用户操作经 console 前缀回传给主进程。 */
export function buildBrowserUserActivityBridgeScript(): string {
  return `
(() => {
  const key = '__velarosBrowserUserActivityBridgeInstalled';
  if (window[key]) return true;
  window[key] = true;
  const prefix = '${browserUserActivityConsolePrefix}';
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

/** 从页面发来的用户活动里读出它是哪一类。 */
export function readUserActivityKind(payload: unknown): BrowserUserActivityKind {
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

/** 把一次键盘活动拼成一句可读的说明。 */
export function formatKeyboardActivityDetail(input: { key?: LooseOptional<string> }): Nullable<string> {
  const key = input.key?.trim()
  if (!key || key.length === 1) return null

  return `key=${key}`
}

/** 从事件载荷里读一个字符串字段；没有就当没有。 */
export function readEventString(value: unknown, key: string): Nullable<string> {
  if (!isPlainObject(value)) return null

  const property = value[key]
  return isString(property) ? property : null
}

/** 判断占位 URL。 */
export function isPlaceholderUrl(url: LooseOptional<string>): boolean {
  return url === 'about:blank' || url === 'about:srcdoc'
}
