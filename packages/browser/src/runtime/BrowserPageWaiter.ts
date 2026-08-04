import type { Event as ElectronEvent, WebContents } from "electron";

import {
  isBlank,
  isFalse,
  isFunction,
  isNumber,
  isPlainObject,
  isString,
} from "@velaros-ai/core";
import { AppError } from "@velaros-ai/core/error";
import { logRuntime } from "@velaros-ai/core/logger";
import { type TimerLease, TimerScope } from "@velaros-ai/core/utils/TimerScope";

import {
  type BrowserDomStabilityOptions,
  type BrowserPageStabilityResult,
  clampInteger,
} from "../core";

/** Electron 导航被取消时的错误码。 */
const BrowserNavigationAbortErrorCode = -3;
const log = logRuntime.tag("BrowserPageWaiter");
type WebContentsListener = (...args: any[]) => void;

interface SharedWebContentsEvent {
  readonly dispatch: WebContentsListener;
  readonly subscribers: Set<WebContentsListener>;
}

/**
 * 浏览器页面等待器。
 *
 * 封装 WebContents 的加载、导航 settle、动作后等待和 network idle 等待，
 * 统一处理窗口关闭、abortSignal、超时和 ERR_ABORTED。
 */
class BrowserPageWaiter {
  private readonly sharedEvents = new WeakMap<
    WebContents,
    Map<string, SharedWebContentsEvent>
  >();

  /** 加载指定 URL，直到 did-finish-load 或可接受的 abort/stop。 */
  public loadUrl(
    webContents: WebContents,
    url: string,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    return new Promise((resolveLoad, rejectLoad) => {
      if (!this.isLiveWebContents(webContents)) {
        rejectLoad(this.createWindowClosedError());
        return;
      }

      const timers = new TimerScope({ name: "BrowserPageWaiter.loadUrl" });
      const subscriptions: Array<() => void> = [];
      let timeout: Nullable<TimerLease> = null;
      let settled = false;
      let cleanedUp = false;
      let sawNavigationAbort = false;
      const cleanup = (): void => {
        if (cleanedUp) return;

        cleanedUp = true;
        this.clearTimer(timeout);
        for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
        abortSignal?.removeEventListener("abort", handleAbort);
        timers.dispose();
      };

      const resolveOnce = (): void => {
        if (settled) return;

        settled = true;
        cleanup();
        resolveLoad();
      };

      const rejectOnce = (error: unknown): void => {
        if (settled) return;

        settled = true;
        cleanup();
        rejectLoad(error);
      };

      const handleFinish = (): void => {
        resolveOnce();
      };
      const handleStopLoading = (): void => {
        if (sawNavigationAbort) {
          // loadURL 被新导航打断时 Electron 会报 -3；如果随后停止加载，视为已稳定。
          resolveOnce();
        }
      };
      const handleFail = (
        _event: ElectronEvent,
        errorCode: number,
        errorDescription: string,
        _validatedURL?: string,
        isMainFrame?: boolean,
      ): void => {
        if (isFalse(isMainFrame)) {
          // 子资源失败不代表页面导航失败。
          return;
        }

        if (this.isNavigationAbort(errorCode)) {
          sawNavigationAbort = true;
          return;
        }

        rejectOnce(
          new AppError(
            "NETWORK",
            `浏览器页面加载失败：${errorDescription || errorCode}`,
            undefined,
            { url, errorCode },
          ),
        );
      };
      const handleAbort = (): void => {
        // 外部取消时主动停止加载，避免继续占用会话。
        this.stopLoading(webContents);
        rejectOnce(new AppError("EXECUTION_ABORTED", "浏览器页面加载已取消。"));
      };
      const handleClosed = (): void => {
        rejectOnce(this.createWindowClosedError());
      };
      timeout = timers.after(30_000, () => {
        this.stopLoading(webContents);
        rejectOnce(new AppError("TIMEOUT", `浏览器页面加载超时：${url}`));
      });

      try {
        subscriptions.push(
          this.subscribeWebContentsEvent(
            webContents,
            "did-finish-load",
            handleFinish,
          ),
          this.subscribeWebContentsEvent(
            webContents,
            "did-fail-load",
            handleFail,
          ),
          this.subscribeWebContentsEvent(
            webContents,
            "did-stop-loading",
            handleStopLoading,
          ),
          this.subscribeWebContentsEvent(
            webContents,
            "destroyed",
            handleClosed,
          ),
        );
        abortSignal?.addEventListener("abort", handleAbort, { once: true });
        void webContents.loadURL(url).catch((error) => {
          if (this.isNavigationAbort(error)) {
            sawNavigationAbort = true;
            return;
          }

          rejectOnce(AppError.from(error));
        });
      } catch (error) {
        rejectOnce(AppError.from(error));
      }
    });
  }

  /** 点击/填充等动作后等待页面可能发生的导航或短暂稳定窗口。 */
  public waitForTargetActionToSettle(
    webContents: WebContents,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    return new Promise((resolveWait, rejectWait) => {
      if (!this.isLiveWebContents(webContents)) {
        rejectWait(this.createWindowClosedError());
        return;
      }

      const timers = new TimerScope({
        name: "BrowserPageWaiter.targetActionSettle",
      });
      const subscriptions: Array<() => void> = [];
      let timeout: Nullable<TimerLease> = null;
      let settled = false;
      let cleanedUp = false;
      const cleanup = (): void => {
        if (cleanedUp) return;

        cleanedUp = true;
        this.clearTimer(timeout);
        for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
        abortSignal?.removeEventListener("abort", handleAbort);
        timers.dispose();
      };

      const settle = (): void => {
        if (settled) return;

        settled = true;
        cleanup();
        resolveWait();
      };

      const rejectOnce = (error: unknown): void => {
        if (settled) return;

        settled = true;
        cleanup();
        rejectWait(error);
      };

      const handleFinish = (): void => {
        settle();
      };
      const handleFail = (
        _event: ElectronEvent,
        errorCode: number,
        errorDescription: string,
        validatedURL?: string,
        isMainFrame?: boolean,
      ): void => {
        if (isFalse(isMainFrame)) return;

        if (this.isNavigationAbort(errorCode)) return;

        rejectOnce(
          new AppError(
            "NETWORK",
            `浏览器动作后的页面加载失败：${errorDescription || errorCode}`,
            undefined,
            { url: validatedURL, errorCode },
          ),
        );
      };
      const handleInPageNavigate = (
        _event: ElectronEvent,
        _url: string,
        isMainFrame: boolean,
      ): void => {
        if (isMainFrame) {
          // SPA 路由变化通常只触发 did-navigate-in-page。
          settle();
        }
      };
      const handleAbort = (): void => {
        this.stopLoading(webContents);
        rejectOnce(new AppError("EXECUTION_ABORTED", "浏览器动作等待已取消。"));
      };
      const handleClosed = (): void => {
        rejectOnce(this.createWindowClosedError());
      };
      // 不是每个点击都会导航；短暂等待后默认认为动作已完成。
      timeout = timers.after(1_200, settle);

      try {
        subscriptions.push(
          this.subscribeWebContentsEvent(
            webContents,
            "did-finish-load",
            handleFinish,
          ),
          this.subscribeWebContentsEvent(
            webContents,
            "did-fail-load",
            handleFail,
          ),
          this.subscribeWebContentsEvent(
            webContents,
            "did-navigate-in-page",
            handleInPageNavigate,
          ),
          this.subscribeWebContentsEvent(
            webContents,
            "destroyed",
            handleClosed,
          ),
        );
        abortSignal?.addEventListener("abort", handleAbort, { once: true });
      } catch (error) {
        rejectOnce(AppError.from(error));
      }
    });
  }

  /** 等待普通导航稳定。 */
  public waitForNavigationToSettle(
    webContents: WebContents,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    return new Promise((resolveWait, rejectWait) => {
      if (!this.isLiveWebContents(webContents)) {
        rejectWait(this.createWindowClosedError());
        return;
      }

      const timers = new TimerScope({
        name: "BrowserPageWaiter.navigationSettle",
      });
      const subscriptions: Array<() => void> = [];
      let timeout: Nullable<TimerLease> = null;
      let idleTimeout: Nullable<TimerLease> = null;
      let settled = false;
      let cleanedUp = false;
      const cleanup = (): void => {
        if (cleanedUp) return;

        cleanedUp = true;
        this.clearTimer(timeout);
        this.clearTimer(idleTimeout);
        for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
        abortSignal?.removeEventListener("abort", handleAbort);
        timers.dispose();
      };

      const settle = (): void => {
        if (settled) return;

        settled = true;
        cleanup();
        resolveWait();
      };

      const rejectOnce = (error: unknown): void => {
        if (settled) return;

        settled = true;
        cleanup();
        rejectWait(error);
      };

      const handleFinish = (): void => {
        settle();
      };
      const handleStopLoading = (): void => {
        settle();
      };
      const handleInPageNavigate = (
        _event: ElectronEvent,
        _url: string,
        isMainFrame: boolean,
      ): void => {
        if (isMainFrame) {
          settle();
        }
      };
      const handleFail = (
        _event: ElectronEvent,
        errorCode: number,
        errorDescription: string,
        validatedURL?: string,
        isMainFrame?: boolean,
      ): void => {
        if (isFalse(isMainFrame)) return;

        if (this.isNavigationAbort(errorCode)) return;

        rejectOnce(
          new AppError(
            "NETWORK",
            `浏览器导航失败：${errorDescription || errorCode}`,
            undefined,
            {
              url: validatedURL,
              errorCode,
            },
          ),
        );
      };
      const handleAbort = (): void => {
        this.stopLoading(webContents);
        rejectOnce(new AppError("EXECUTION_ABORTED", "浏览器导航等待已取消。"));
      };
      const handleClosed = (): void => {
        rejectOnce(this.createWindowClosedError());
      };
      timeout = timers.after(30_000, settle);
      idleTimeout = timers.after(500, () => {
        if (!this.isLiveWebContents(webContents)) {
          rejectOnce(this.createWindowClosedError());
          return;
        }

        if (!webContents.isLoading()) {
          // 如果绑定事件前页面已经完成加载，用 idle 检查兜底。
          settle();
        }
      });

      try {
        subscriptions.push(
          this.subscribeWebContentsEvent(
            webContents,
            "did-finish-load",
            handleFinish,
          ),
          this.subscribeWebContentsEvent(
            webContents,
            "did-fail-load",
            handleFail,
          ),
          this.subscribeWebContentsEvent(
            webContents,
            "did-navigate-in-page",
            handleInPageNavigate,
          ),
          this.subscribeWebContentsEvent(
            webContents,
            "did-stop-loading",
            handleStopLoading,
          ),
          this.subscribeWebContentsEvent(
            webContents,
            "destroyed",
            handleClosed,
          ),
        );
        abortSignal?.addEventListener("abort", handleAbort, { once: true });
      } catch (error) {
        rejectOnce(AppError.from(error));
      }
    });
  }

  /** 清理定时器。 */
  private clearTimer(timer: Nullable<TimerLease>): void {
    timer?.cancel();
  }

  /** 判断 WebContents 是否仍可访问。 */
  private isLiveWebContents(webContents: WebContents): boolean {
    try {
      return !webContents.isDestroyed();
    } catch (error) {
      log.debug("检查 WebContents 存活状态失败", { error });
      return false;
    }
  }

  /**
   * 同一 WebContents 的同一原生事件只注册一个分发器。
   *
   * 页面恢复、截图和工具动作可能同时等待同一次导航；逐等待器直接 `once` 会很快超过
   * EventEmitter 的监听上限，而且子 frame 的首个事件还会提前消耗 `once`。共享分发器把
   * 原生监听数量固定为 1，各等待器仍独立清理和结算。
   */
  private subscribeWebContentsEvent(
    webContents: WebContents,
    eventName: string,
    listener: WebContentsListener,
  ): () => void {
    let events = this.sharedEvents.get(webContents);
    if (!events) {
      events = new Map();
      this.sharedEvents.set(webContents, events);
    }

    let sharedEvent = events.get(eventName);
    if (!sharedEvent) {
      const subscribers = new Set<WebContentsListener>();
      const dispatch: WebContentsListener = (...args) => {
        for (const subscriber of [...subscribers]) subscriber(...args);
      };
      const eventEmitter = webContents as {
        on(eventName: string, listener: WebContentsListener): void;
      };
      eventEmitter.on(eventName, dispatch);
      sharedEvent = { dispatch, subscribers };
      events.set(eventName, sharedEvent);
    }

    sharedEvent.subscribers.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;

      sharedEvent!.subscribers.delete(listener);
      if (sharedEvent!.subscribers.size > 0) return;

      this.safeWebContentsOff(webContents, eventName, sharedEvent!.dispatch);
      events!.delete(eventName);
      if (events!.size === 0) this.sharedEvents.delete(webContents);
    };
  }

  /** 安全解绑 WebContents 事件。 */
  private safeWebContentsOff(
    webContents: WebContents,
    eventName: string,
    listener: (...args: any[]) => void,
  ): void {
    try {
      if (!this.isLiveWebContents(webContents) && eventName !== "destroyed")
        return;

      const eventEmitter = webContents as {
        off(eventName: string, listener: (...args: any[]) => void): void;
      };
      eventEmitter.off(eventName, listener);
    } catch (error) {
      log.debug("清理时移除 WebContents 监听器失败", {
        eventName,
        error,
      });
      // The native WebContents may already be gone; cleanup must remain best-effort.
    }
  }

  /** 尽力停止页面加载。 */
  private stopLoading(webContents: WebContents): void {
    try {
      if (this.isLiveWebContents(webContents)) {
        webContents.stop();
      }
    } catch (error) {
      log.debug("清理时停止 WebContents 加载失败", { error });
      // Ignore native teardown races.
    }
  }

  /** 构造窗口关闭错误。 */
  private createWindowClosedError(): AppError {
    return new AppError("EXECUTION_ABORTED", "浏览器窗口已关闭。");
  }

  /** 判断错误是否是 Electron 导航取消。 */
  private isNavigationAbort(errorCodeOrError: unknown): boolean {
    if (errorCodeOrError === BrowserNavigationAbortErrorCode) return true;

    const appError = AppError.from(errorCodeOrError);
    return (
      appError.context.errorCode === BrowserNavigationAbortErrorCode ||
      /\bERR_ABORTED\b|\(-3\)/.test(appError.message)
    );
  }

  /** E1: network idle 等待 — SPA 渲染完成后再操作，避免报到旧 DOM
   * 在 idleMs 内没有新的网络请求，则认为 idle
   */
  public waitForNetworkIdle(
    webContents: WebContents,
    idleMs = 500,
    maxWaitMs = 5000,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.isLiveWebContents(webContents)) {
        resolve();
        return;
      }

      const pendingRequestIds = new Set<string>();
      let anonymousPendingRequests = 0;
      const timers = new TimerScope({ name: "BrowserPageWaiter.networkIdle" });
      let idleTimer: Nullable<TimerLease> = null;
      let maxTimer: Nullable<TimerLease> = timers.after(maxWaitMs, () => {
        cleanup();
        resolve();
      });

      const hasPendingRequests = (): boolean =>
        pendingRequestIds.size > 0 || anonymousPendingRequests > 0;
      const scheduleIdle = (): void => {
        if (hasPendingRequests()) return;
        cancelIdle();
        // 没有请求持续 idleMs 后认为网络空闲。
        idleTimer = timers.after(idleMs, () => {
          cleanup();
          resolve();
        });
      };
      const cancelIdle = (): void => {
        idleTimer?.cancel();
        idleTimer = null;
      };
      const onStart = (details: unknown): void => {
        const requestId = this.readWebRequestId(details);
        if (requestId) {
          pendingRequestIds.add(requestId);
        } else {
          anonymousPendingRequests++;
        }
        cancelIdle();
      };
      const onEnd = (details: unknown): void => {
        const requestId = this.readWebRequestId(details);
        if (requestId) {
          pendingRequestIds.delete(requestId);
        } else {
          anonymousPendingRequests = Math.max(0, anonymousPendingRequests - 1);
        }
        if (!hasPendingRequests()) scheduleIdle();
      };
      function cleanup(): void {
        cancelIdle();
        maxTimer?.cancel();
        maxTimer = null;
        timers.dispose();
        try {
          webContents?.session?.webRequest?.onBeforeRequest(null);
        } catch (error) {
          log.debug("清理网络空闲 onBeforeRequest 钩子失败", { error });
          /* ignore */
        }
        try {
          webContents?.session?.webRequest?.onCompleted(null);
        } catch (error) {
          log.debug("清理网络空闲 onCompleted 钩子失败", { error });
          /* ignore */
        }
        try {
          webContents?.session?.webRequest?.onErrorOccurred(null);
        } catch (error) {
          log.debug("清理网络空闲 onErrorOccurred 钩子失败", { error });
          /* ignore */
        }
      }

      try {
        webContents.session.webRequest.onBeforeRequest((details, callback) => {
          onStart(details);
          if (isFunction(callback)) callback({});
        });
        webContents.session.webRequest.onCompleted((details) => onEnd(details));
        webContents.session.webRequest.onErrorOccurred((details) =>
          onEnd(details),
        );
      } catch (error) {
        log.debug("安装网络空闲 webRequest 钩子失败", { error });
        resolve();
        return;
      }
      scheduleIdle();
    });
  }

  private readWebRequestId(details: unknown): Nullable<string> {
    if (!isPlainObject(details)) return null;

    const id = details.id;
    if (isString(id) && !isBlank(id)) return id;
    if (isNumber(id)) return String(id);

    return null;
  }

  /** 等待 DOM 和主要布局连续多帧稳定，适合 SPA、骨架屏和短动画后的截图。 */
  public async waitForDomAndLayoutStable(
    webContents: WebContents,
    options: BrowserDomStabilityOptions = {},
    abortSignal?: AbortSignal,
  ): Promise<BrowserPageStabilityResult> {
    if (!this.isLiveWebContents(webContents))
      return this.createUnavailableStabilityResult();

    abortSignal?.throwIfAborted();

    const stableFrames = clampInteger(options.stableFrames, 3, 16, 5);
    const sampleIntervalMs = clampInteger(
      options.sampleIntervalMs,
      16,
      250,
      80,
    );
    const maxWaitMs = clampInteger(options.maxWaitMs, 250, 8000, 2500);

    try {
      const result = (await webContents.executeJavaScript(
        this.buildDomAndLayoutStableScript({
          stableFrames,
          sampleIntervalMs,
          maxWaitMs,
        }),
        true,
      )) as Partial<BrowserPageStabilityResult>;

      abortSignal?.throwIfAborted();
      return this.normalizeStabilityResult(result);
    } catch (error) {
      if (abortSignal?.aborted) {
        throw new AppError("EXECUTION_ABORTED", "浏览器 DOM 稳定等待已取消。");
      }

      log.debug("等待浏览器 DOM/layout 稳定失败，继续截图", {
        error: AppError.from(error).message,
      });
      return this.createUnavailableStabilityResult();
    }
  }

  private buildDomAndLayoutStableScript(
    options: Required<BrowserDomStabilityOptions>,
  ): string {
    const payload = JSON.stringify(options);

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
})()`;
  }

  private normalizeStabilityResult(
    result: Partial<BrowserPageStabilityResult>,
  ): BrowserPageStabilityResult {
    const reason =
      result.reason === "stable" ||
      result.reason === "timeout" ||
      result.reason === "unavailable"
        ? result.reason
        : "unavailable";

    return {
      stable: reason === "stable",
      reason,
      durationMs: clampInteger(result.durationMs, 0, 60_000, 0),
      frames: clampInteger(result.frames, 0, 10_000, 0),
    };
  }

  private createUnavailableStabilityResult(): BrowserPageStabilityResult {
    return {
      stable: false,
      reason: "unavailable",
      durationMs: 0,
      frames: 0,
    };
  }
}

export { BrowserPageWaiter };
