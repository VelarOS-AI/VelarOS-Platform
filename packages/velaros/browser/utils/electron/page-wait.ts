/** 内嵌页面等待里用不着实例状态的那部分：等待条件与超时的计算。 */

import type { WebContents } from 'electron'

import { isBlank, isNumber, isPlainObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { TimerLease } from '@velaros-ai/core/utils/TimerScope'

import type { BrowserDomStabilityOptions, BrowserPageStabilityResult } from '../../types/browser'
import { clampInteger } from '../numbers.js'
import { BrowserTuning } from '../tuning'

/** 清理定时器。 */
export function clearTimer(timer: Nullable<TimerLease>): void {
  timer?.cancel()
}

/** 判断 WebContents 是否仍可访问。 */
export function isLiveWebContents(webContents: WebContents): boolean {
  try {
    return !webContents.isDestroyed()
  } catch {
    // arch-guard:silent-catch-ok 拿不到状态就当它已经不在了，交给调用方走「页面没了」那条路。
    return false
  }
}

/** 构造窗口关闭错误。 */
export function createWindowClosedError(): AppError {
  return new AppError('EXECUTION_ABORTED', '浏览器窗口已关闭。')
}

/** 判断错误是否是 Electron 导航取消。 */
export function isNavigationAbort(errorCodeOrError: unknown): boolean {
  if (errorCodeOrError === BrowserTuning.electron.navigationAbortErrorCode) return true

  const appError = AppError.from(errorCodeOrError)
  return (
    appError.context.errorCode === BrowserTuning.electron.navigationAbortErrorCode ||
    /\bERR_ABORTED\b|\(-3\)/.test(appError.message)
  )
}

/** 从 Electron 的请求回调里读出这条请求的 id。 */
export function readWebRequestId(details: unknown): Nullable<string> {
  if (!isPlainObject(details)) return null

  const id = details.id
  if (isString(id) && !isBlank(id)) return id
  if (isNumber(id)) return String(id)

  return null
}

/** 拼一段在页面里判 DOM 与布局是否稳定的脚本。 */
export function buildDomAndLayoutStableScript(
  options: Required<BrowserDomStabilityOptions>
): string {
  const payload = JSON.stringify(options)

  return `(() => {
const payload = ${payload};
const startedAt = performance.now();
const stableFramesTarget = payload.stableFrames;
const sampleIntervalMs = payload.sampleIntervalMs;
const maxWaitMs = payload.maxWaitMs;
const selectors = [
  'main',
  '[role="main"]',
  'form',
  'dialog',
  '[role="dialog"]',
  '[aria-busy="true"]',
  '[data-loading]',
  '[data-testid*="loading" i]',
  '[class*="skeleton" i]',
  '[class*="spinner" i]',
  'button',
  'a[href]',
  'input:not([type="hidden"])',
  'select',
  'textarea'
];
const round = (value) => Math.round(Number(value) || 0);
const rectOf = (element) => {
  const rect = element.getBoundingClientRect();
  return [
    round(rect.left),
    round(rect.top),
    round(rect.width),
    round(rect.height)
  ];
};
const visible = (element) => {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.02;
};
const sample = () => {
  const documentElement = document.documentElement;
  const body = document.body || documentElement;
  const elements = [];
  for (const selector of selectors) {
    for (const element of Array.from(document.querySelectorAll(selector)).slice(0, 24)) {
      if (elements.length >= 48) break;
      if (element instanceof Element && visible(element)) {
        elements.push(element);
      }
    }
    if (elements.length >= 48) break;
  }
  return JSON.stringify({
    readyState: document.readyState,
    viewport: [round(window.innerWidth), round(window.innerHeight)],
    scroll: [round(window.scrollX), round(window.scrollY)],
    height: Math.max(
      round(documentElement.scrollHeight),
      round(body.scrollHeight),
      round(documentElement.offsetHeight),
      round(body.offsetHeight)
    ),
    busy: document.querySelectorAll('[aria-busy="true"], [data-loading="true"], [data-state="loading"]').length,
    elements: elements.map((element) => [
      element.tagName,
      element.id || '',
      element.getAttribute('role') || '',
      element.getAttribute('data-testid') || '',
      rectOf(element).join(',')
    ])
  });
};

return new Promise((resolve) => {
  let previousSignature = '';
  let stableFrames = 0;
  let frames = 0;
  const finish = (reason) => {
    resolve({
      stable: reason === 'stable',
      reason,
      durationMs: Math.round(performance.now() - startedAt),
      frames
    });
  };
  const tick = () => {
    frames += 1;
    const signature = sample();
    if (signature === previousSignature) {
      stableFrames += 1;
    } else {
      stableFrames = 1;
      previousSignature = signature;
    }
    if (stableFrames >= stableFramesTarget) {
      finish('stable');
      return;
    }
    if (performance.now() - startedAt >= maxWaitMs) {
      finish('timeout');
      return;
    }
    window.setTimeout(() => window.requestAnimationFrame(tick), sampleIntervalMs);
  };
  window.requestAnimationFrame(tick);
});
})()`
}

/** 页面脚本给的稳定性结果归一成完整形状。 */
export function normalizeStabilityResult(
  result: Partial<BrowserPageStabilityResult>
): BrowserPageStabilityResult {
  const reason =
    result.reason === 'stable' || result.reason === 'timeout' || result.reason === 'unavailable'
      ? result.reason
      : 'unavailable'

  return {
    stable: reason === 'stable',
    reason,
    durationMs: clampInteger(result.durationMs, 0, 60_000, 0),
    frames: clampInteger(result.frames, 0, 10_000, 0),
  }
}

/** 给一份「这条路径判不了稳定性」的结果，如实上报而不是假装稳定。 */
export function createUnavailableStabilityResult(): BrowserPageStabilityResult {
  return {
    stable: false,
    reason: 'unavailable',
    durationMs: 0,
    frames: 0,
  }
}

/** 安全解绑 WebContents 事件。 */
export function safeWebContentsOff(
  webContents: WebContents,
  eventName: string,
  listener: (...args: any[]) => void
): void {
  try {
    if (!isLiveWebContents(webContents) && eventName !== 'destroyed') return

    const eventEmitter = webContents as {
      off(eventName: string, listener: (...args: any[]) => void): void
    }
    eventEmitter.off(eventName, listener)
  } catch {
    // arch-guard:silent-catch-ok 原生 WebContents 可能已经销毁，清理只能尽力而为。
  }
}

/** 尽力停止页面加载。 */
export function stopLoading(webContents: WebContents): void {
  try {
    if (isLiveWebContents(webContents)) {
      webContents.stop()
    }
  } catch {
    // arch-guard:silent-catch-ok 页面可能正在销毁，停不下来就算了。
  }
}
