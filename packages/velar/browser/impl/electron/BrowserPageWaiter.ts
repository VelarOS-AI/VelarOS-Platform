import type {
  Event as ElectronEvent,
  LoadURLOptions,
  WebContents,
} from "electron";

import {
  isFalse,
  isFunction,
} from "@velaros-ai/core";
import { AppError } from "@velaros-ai/core/error";
import { Log } from "@velaros-ai/core/logger";
import { type TimerLease, TimerScope } from "@velaros-ai/core/utils/TimerScope";

import type { BrowserDomStabilityOptions, BrowserPageStabilityResult } from "../../types/browser";
import type { SharedWebContentsEvent, WebContentsListener } from '../../types/electron.js'
import { buildDomAndLayoutStableScript, clearTimer, createUnavailableStabilityResult, createWindowClosedError, isLiveWebContents, isNavigationAbort, normalizeStabilityResult, readWebRequestId } from '../../utils/electron/page-wait'
import { safeWebContentsOff, stopLoading } from '../../utils/electron/page-wait'
import { clampInteger } from '../../utils/numbers.js'
import { BrowserTuning } from '../../utils/tuning'

/** Electron 导航被取消时的错误码。 */
const log = Log.tag("BrowserPageWaiter");
/**
 * 浏览器页面等待器。
 *
 * 封装 WebContents 的加载、导航 settle、动作后等待和 network idle 等待，
 * 统一处理窗口关闭、abortSignal、超时和 ERR_ABORTED。
 */
export interface BrowserPageWaiterApi {
  /** 加载指定 URL，直到 did-finish-load 或可接受的 abort/stop。 */
  loadUrl(webContents: WebContents, url: string, abortSignal?: AbortSignal, loadOptions?: LoadURLOptions): Promise<void>
  /** 点击/填充等动作后等待页面可能发生的导航或短暂稳定窗口。 */
  waitForTargetActionToSettle(webContents: WebContents, abortSignal?: AbortSignal): Promise<void>
  /** 等待普通导航稳定。 */
  waitForNavigationToSettle(webContents: WebContents, abortSignal?: AbortSignal): Promise<void>
  /** E1: network idle 等待 — SPA 渲染完成后再操作，避免报到旧 DOM
   * 在 idleMs 内没有新的网络请求，则认为 idle
   */
  waitForNetworkIdle(webContents: WebContents, idleMs?: number, maxWaitMs?: number): Promise<boolean>
  /** 等待 DOM 和主要布局连续多帧稳定，适合 SPA、骨架屏和短动画后的截图。 */
  waitForDomAndLayoutStable(webContents: WebContents, options?: BrowserDomStabilityOptions, abortSignal?: AbortSignal): Promise<BrowserPageStabilityResult>
}

class BrowserPageWaiter implements BrowserPageWaiterApi {
  private readonly sharedEvents = new WeakMap<
    WebContents,
    Map<string, SharedWebContentsEvent>
  >();

  /** 加载指定 URL，直到 did-finish-load 或可接受的 abort/stop。 */
  public loadUrl(
    webContents: WebContents,
    url: string,
    abortSignal?: AbortSignal,
    loadOptions?: LoadURLOptions,
  ): Promise<void> {
    return new Promise((resolveLoad, rejectLoad) => {
      if (!isLiveWebContents(webContents)) {
        rejectLoad(createWindowClosedError());
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
        clearTimer(timeout);
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

        if (isNavigationAbort(errorCode)) {
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
        stopLoading(webContents);
        rejectOnce(new AppError("EXECUTION_ABORTED", "浏览器页面加载已取消。"));
      };
      const handleClosed = (): void => {
        rejectOnce(createWindowClosedError());
      };
      timeout = timers.after(30_000, () => {
        stopLoading(webContents);
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
        void webContents.loadURL(url, loadOptions).catch((error) => {
          if (isNavigationAbort(error)) {
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
      if (!isLiveWebContents(webContents)) {
        rejectWait(createWindowClosedError());
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
        clearTimer(timeout);
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

        if (isNavigationAbort(errorCode)) return;

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
        stopLoading(webContents);
        rejectOnce(new AppError("EXECUTION_ABORTED", "浏览器动作等待已取消。"));
      };
      const handleClosed = (): void => {
        rejectOnce(createWindowClosedError());
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
      if (!isLiveWebContents(webContents)) {
        rejectWait(createWindowClosedError());
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
        clearTimer(timeout);
        clearTimer(idleTimeout);
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

        if (isNavigationAbort(errorCode)) return;

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
        stopLoading(webContents);
        rejectOnce(new AppError("EXECUTION_ABORTED", "浏览器导航等待已取消。"));
      };
      const handleClosed = (): void => {
        rejectOnce(createWindowClosedError());
      };
      timeout = timers.after(30_000, settle);
      idleTimeout = timers.after(500, () => {
        if (!isLiveWebContents(webContents)) {
          rejectOnce(createWindowClosedError());
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

      safeWebContentsOff(webContents, eventName, sharedEvent!.dispatch);
      events!.delete(eventName);
      if (events!.size === 0) this.sharedEvents.delete(webContents);
    };
  }

  

  

  

  

  /** E1: network idle 等待 — SPA 渲染完成后再操作，避免报到旧 DOM
   * 在 idleMs 内没有新的网络请求，则认为 idle
   */
  public waitForNetworkIdle(
    webContents: WebContents,
    idleMs: number = BrowserTuning.page.networkIdleMs,
    maxWaitMs: number = BrowserTuning.page.networkIdleTimeoutMs,
  ): Promise<boolean> {
    // 交回等没等到：空闲了是 true，到了 maxWaitMs 还有请求在飞是 false（页面没了也算没等到）。
    return new Promise<boolean>((resolve) => {
      if (!isLiveWebContents(webContents)) {
        resolve(false);
        return;
      }

      const pendingRequestIds = new Set<string>();
      let anonymousPendingRequests = 0;
      const timers = new TimerScope({ name: "BrowserPageWaiter.networkIdle" });
      let idleTimer: Nullable<TimerLease> = null;
      let maxTimer: Nullable<TimerLease> = timers.after(maxWaitMs, () => {
        cleanup();
        resolve(false);
      });

      const hasPendingRequests = (): boolean =>
        pendingRequestIds.size > 0 || anonymousPendingRequests > 0;
      const scheduleIdle = (): void => {
        if (hasPendingRequests()) return;
        cancelIdle();
        // 没有请求持续 idleMs 后认为网络空闲。
        idleTimer = timers.after(idleMs, () => {
          cleanup();
          resolve(true);
        });
      };
      const cancelIdle = (): void => {
        idleTimer?.cancel();
        idleTimer = null;
      };
      const onStart = (details: unknown): void => {
        const requestId = readWebRequestId(details);
        if (requestId) {
          pendingRequestIds.add(requestId);
        } else {
          anonymousPendingRequests++;
        }
        cancelIdle();
      };
      const onEnd = (details: unknown): void => {
        const requestId = readWebRequestId(details);
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
        // 量不了就不拦着：当作已经空闲。
        log.debug("安装网络空闲 webRequest 钩子失败", { error });
        resolve(true);
        return;
      }
      scheduleIdle();
    });
  }

  

  /** 等待 DOM 和主要布局连续多帧稳定，适合 SPA、骨架屏和短动画后的截图。 */
  public async waitForDomAndLayoutStable(
    webContents: WebContents,
    options: BrowserDomStabilityOptions = {},
    abortSignal?: AbortSignal,
  ): Promise<BrowserPageStabilityResult> {
    if (!isLiveWebContents(webContents))
      return createUnavailableStabilityResult();

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
        buildDomAndLayoutStableScript({
          stableFrames,
          sampleIntervalMs,
          maxWaitMs,
        }),
        true,
      )) as Partial<BrowserPageStabilityResult>;

      abortSignal?.throwIfAborted();
      return normalizeStabilityResult(result);
    } catch (error) {
      if (abortSignal?.aborted) {
        throw new AppError("EXECUTION_ABORTED", "浏览器 DOM 稳定等待已取消。");
      }

      log.debug("等待浏览器 DOM/layout 稳定失败，继续截图", {
        error: AppError.from(error).message,
      });
      return createUnavailableStabilityResult();
    }
  }

  

  

  
}

export { BrowserPageWaiter };
