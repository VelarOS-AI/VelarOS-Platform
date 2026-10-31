/** Electron 运行时装配里用不着实例状态的那部分：入参归一与会话身份的计算。 */

import { toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { BrowserPageDriver } from '../../contract/requires.js'
import type { BrowserUserScriptRecord } from '../../types/browser'
import type {
  BrowserPageNavigationOptions,
  BrowserPageNavigationResult,
  BrowserPageTargetInfo,
  BrowserPageWindowState,
} from '../../types/browser'
import type { BrowserPageDriverState } from '../../types/driver'
import type { ExternalBrowserPageSession } from '../../types/runtime.js'
import { getBrowserUrlCandidate } from '../address'

/** 释放一个外部页面驱动；已经没了就什么都不做。 */
export function disposeExternalPageDriver(driver?: LooseOptional<BrowserPageDriver>): void {
  const disposable = driver as LooseOptional<{ dispose?: () => void }>
  disposable?.dispose?.()
}

/** 把页面驱动回报的状态写回外部页面会话。 */
export function applyExternalPageState(
  session: ExternalBrowserPageSession,
  state: BrowserPageDriverState,
  fallbackUrl?: LooseOptional<string>
): void {
  const nextUrl = state.url || fallbackUrl || session.url
  // 空标题是 about:blank 等页面的真实状态，不能沿用上一个站点的标题。
  const nextTitle = state.title
  session.url = toNullable(nextUrl)
  session.title = toNullable(nextTitle)
}

/** 拼出外部浏览器窗口的状态回执。 */
export function buildExternalWindowState(
  session: ExternalBrowserPageSession
): BrowserPageWindowState {
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

/** 拼出「当前受控的是哪一页」的回执。 */
export function buildExternalCurrentPageTarget(
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

/** 等待一小段时间，便于用户看到按压反馈。 */
export function delay(ms: number): Promise<void> {
  return TimerScope.sleep(ms, { label: 'ElectronBrowserRuntime.delay' })
}

/** 拼出外部浏览器一次导航的回执。 */
export function buildExternalNavigationResult(
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

/** 判断占位或错误页 URL。 */
export function isPlaceholderUrl(url: LooseOptional<string>): boolean {
  return (
    url === 'about:blank' || url === 'about:srcdoc' || (!!url && url.startsWith('chrome-error://'))
  )
}

/** 规范化用户输入 URL；本地地址默认 http，其它无协议地址默认 https。 */
export function normalizeUrl(rawUrl: string): string {
  const value = rawUrl.trim()
  const candidate = getBrowserUrlCandidate(value)

  try {
    return new URL(candidate).toString()
  } catch (error) {
    throw new AppError('VALIDATION', `无效的浏览器 URL：${rawUrl}`, error)
  }
}

/** 释放一个外部页面会话：断驱动、清状态。 */
export function disposeExternalPageSession(
  session?: LooseOptional<ExternalBrowserPageSession>,
  options: { disposeHost?: boolean } = {}
): void {
  if (!session) return

  session.unsubscribeDownloads?.()
  disposeExternalPageDriver(session.driver)
  if (options.disposeHost ?? true) {
    session.disposeHost?.()
  }
}

/** 把一段用户脚本包成可注入的源码：带上幂等标记与失败隔离。 */
export function buildBrowserUserScriptExecutionSource(
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
