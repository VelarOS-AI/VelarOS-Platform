import electron from 'electron'

import { toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { BrowserClickCoordinatesOptions, BrowserClickCoordinatesResult, BrowserDragOptions, BrowserDragResult, BrowserElementTargetHint, BrowserMoveMouseOptions, BrowserMoveMouseResult, BrowserPagePreviewPointerEvent, BrowserPageScrollOptions, BrowserPageScrollResult, BrowserPageZoomOptions, BrowserPageZoomResult, BrowserPressKeyOptions, BrowserPressKeyResult, BrowserSiteContext, BrowserTargetActionOptions, BrowserTargetActionResult, BrowserTypeTextOptions, BrowserTypeTextResult } from '../core'
import {
  type BrowserPageDriver,
  type BrowserPageScriptBuilder,
  type BrowserPointerPoint,
  type BrowserTargetRefStore,
  CdpInteractionEngine,
  clampInteger,
  clampZoomFactor,
  DEFAULT_BROWSER_VIEWPORT,
  normalizeBrowserPressKeyOptions,
} from '../core'

import type { BrowserPageWaiter } from './BrowserPageWaiter'
import type {
  BrowserRuntimeKernel,
  BrowserRuntimePageDriverSession,
} from './BrowserRuntimeInternals'
import type { BrowserSession } from './BrowserRuntimeTypes'
import { evaluateInWebContents } from './BrowserWebContentsEvaluator'

/**
 * 交互域执行体（Electron 宿主）：embedded 分支（WebContents 输入合成、虚拟指针浮层、
 * 缩放 HUD、目标高亮）+ 委托 external 核（`CdpInteractionEngine`）。
 *
 * 每个 public 方法先探 external 会话：命中 → `super`（driver 路径）；否则跑 embedded 分支。
 * DUAL 分支逻辑逐字节原样保留，只把 external 半迁进 core。方法默认在 runtime 的
 * actionQueue 内被调用。
 */
export class BrowserInteractionEngine extends CdpInteractionEngine {
  /** 记录每个 WebContents 的最新页面内指针位置，用于绘制连续轨迹。 */
  private readonly pointerPositions = new Map<number, BrowserPointerPoint>()

  constructor(
    private readonly electronKernel: BrowserRuntimeKernel,
    scripts: BrowserPageScriptBuilder,
    private readonly pageWaiter: BrowserPageWaiter,
    targetRefs: BrowserTargetRefStore,
    onPreviewPointer?: LooseOptional<(
      sessionId: string,
      pointer: BrowserPagePreviewPointerEvent
    ) => void>
  ) {
    super(electronKernel, scripts, targetRefs, onPreviewPointer)
  }

  /** 会话关闭时清理该 WebContents 的指针轨迹状态。 */
  public clearPointerState(webContentsId: number): void {
    this.pointerPositions.delete(webContentsId)
  }

  /** 运行时销毁时清空全部指针状态。 */
  public dispose(): void {
    this.pointerPositions.clear()
  }

  // ---- webview 专属 kernel 桥接 ----
  private getLivePageSessionUnlocked(
    sessionId: string,
    abortSignal?: AbortSignal
  ): Promise<BrowserSession> {
    return this.electronKernel.getLivePageSession(sessionId, abortSignal)
  }

  private getLivePageDriverSessionUnlocked(
    sessionId: string,
    abortSignal?: AbortSignal
  ): Promise<BrowserRuntimePageDriverSession> {
    return this.electronKernel.getLivePageDriverSession(sessionId, abortSignal)
  }

  private getPageDriver(sessionId: string, session: BrowserSession): BrowserPageDriver {
    return this.electronKernel.wrapPageDriver(sessionId, session)
  }

  private resolveCurrentPageUrl(session: BrowserSession, fallbackUrl: string): string {
    return this.electronKernel.resolveCurrentPageUrl(session, fallbackUrl)
  }

  private syncSessionSiteContext(sessionId: string, url: string): void {
    this.electronKernel.syncSessionSiteContext(sessionId, url)
  }

  public override async performTargetAction(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserTargetActionOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserTargetActionResult> {
    abortSignal?.throwIfAborted()
    const externalSession = this.getExternalPageSession(sessionId)
    if (externalSession) return super.performTargetAction(sessionId, context, options, abortSignal)

    const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)
    const hydratedOptions = this.targetRefs.hydrate(sessionId, options)
    const driver = this.getPageDriver(sessionId, session)
    const clickMode = this.resolveTargetActionClickMode(driver, hydratedOptions)
    const beforeEffectSnapshot = await this.captureTargetActionEffectSnapshot(driver)
    const initialActionResult = await driver.executeJavaScript<BrowserTargetActionResult>(
      this.scripts.buildTargetActionScript(hydratedOptions, { clickMode }),
      true
    )
    const healedActionResult = await this.selfHealTargetActionAfterNotFound({
      sessionId,
      driver,
      options: hydratedOptions,
      result: initialActionResult,
      clickMode,
    })
    const actionResult = await this.dispatchCoordinateTargetActionIfNeeded({
      sessionId,
      driver,
      options: hydratedOptions,
      result: healedActionResult,
    })

    if (actionResult.matched) {
      void this.highlightTarget(
        session,
        hydratedOptions.target,
        actionResult.selector ?? hydratedOptions.target.css
      )
    }

    if (actionResult.matched && options.action === 'click') {
      // 点击可能触发导航或 SPA 路由，等它稳定后再回传最终 URL。
      // 显式 waitForNavigation=true 时按完整导航稳定窗口等待，而不是短暂 settle。
      await (options.waitForNavigation
        ? this.pageWaiter.waitForNavigationToSettle(session.webContents, abortSignal)
        : this.pageWaiter.waitForTargetActionToSettle(session.webContents, abortSignal))
      this.targetRefs.clear(sessionId)
    }

    const afterEffectSnapshot = actionResult.matched
      ? await this.captureTargetActionEffectSnapshot(driver)
      : null
    const effect = this.buildTargetActionEffect(beforeEffectSnapshot, afterEffectSnapshot)
    const finalUrl = driver.getURL() || actionResult.url || context.url
    session.url = finalUrl
    this.syncSessionSiteContext(sessionId, finalUrl)

    return {
      ...actionResult,
      url: finalUrl,
      effect: toOptional(effect),
      capturedAt: Date.now(),
    }
  }

  public override async typeText(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserTypeTextOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserTypeTextResult> {
    abortSignal?.throwIfAborted()
    const externalSession = this.getExternalPageSession(sessionId)
    if (externalSession) return super.typeText(sessionId, context, options, abortSignal)

    const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)

    await session.webContents.insertText(options.text)

    return {
      url: this.resolveCurrentPageUrl(session, context.url),
      textLength: options.text.length,
      capturedAt: Date.now(),
    }
  }

  public override async pressKey(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserPressKeyOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserPressKeyResult> {
    abortSignal?.throwIfAborted()
    const externalSession = this.getExternalPageSession(sessionId)
    if (externalSession) return super.pressKey(sessionId, context, options, abortSignal)

    const normalized = normalizeBrowserPressKeyOptions(options)
    const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)
    const repeat = clampInteger(normalized.repeat, 1, 50, 1)
    const modifiers = normalized.modifiers ?? []

    for (let index = 0; index < repeat; index += 1) {
      abortSignal?.throwIfAborted()
      session.webContents.sendInputEvent({
        type: 'keyDown',
        keyCode: normalized.key,
        modifiers,
      })
      session.webContents.sendInputEvent({
        type: 'keyUp',
        keyCode: normalized.key,
        modifiers,
      })
    }

    if (options.waitForNavigation) {
      // Enter 等按键可能提交表单，按需等待页面稳定。
      await this.pageWaiter.waitForTargetActionToSettle(session.webContents, abortSignal)
    }

    const finalUrl = this.resolveCurrentPageUrl(session, context.url)
    session.url = finalUrl
    this.syncSessionSiteContext(sessionId, finalUrl)

    return {
      url: finalUrl,
      key: options.key,
      repeat,
      capturedAt: Date.now(),
    }
  }

  public override async clickCoordinates(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserClickCoordinatesOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserClickCoordinatesResult> {
    abortSignal?.throwIfAborted()
    const externalSession = this.getExternalPageSession(sessionId)
    if (externalSession) return super.clickCoordinates(sessionId, context, options, abortSignal)

    const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)
    const point = await this.clampViewportPoint(session, options.x, options.y)
    const { x, y } = point
    const button = options.button ?? 'left'
    const clickCount = clampInteger(options.clickCount, 1, 5, 1)
    const pointerPath = this.buildPointerPath(session, x, y)

    // 页面内虚拟指针完全受控；实际输入经 driver（CDP 优先）投递，不受外部遮挡影响。
    await this.animateVirtualPointer(session, pointerPath, false)
    this.focusWebContents(session)
    await this.getPageDriver(sessionId, session).clickCoordinates?.({
      x,
      y,
      button,
      clickCount,
    })

    await this.updateVirtualPointer(session, x, y, true)
    await this.delay(90)
    await this.updateVirtualPointer(session, x, y, false)

    if (options.waitForNavigation ?? true) {
      await this.pageWaiter.waitForTargetActionToSettle(session.webContents, abortSignal)
    }

    const finalUrl = this.resolveCurrentPageUrl(session, context.url)
    session.url = finalUrl
    this.syncSessionSiteContext(sessionId, finalUrl)

    return {
      url: finalUrl,
      x,
      y,
      button,
      clickCount,
      capturedAt: Date.now(),
    }
  }

  public override async dragTargets(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserDragOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserDragResult> {
    abortSignal?.throwIfAborted()
    const steps = clampInteger(options.steps, 1, 60, 10)
    const externalSession = this.getExternalPageSession(sessionId)
    if (externalSession) return super.dragTargets(sessionId, context, options, abortSignal)

    const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)
    const driver = this.getPageDriver(sessionId, session)

    if (!driver.dragCoordinates) {
      throw new AppError('VALIDATION', '当前浏览器 driver 不支持拖拽。')
    }

    const resolved = await driver.executeJavaScript<BrowserDragResult>(
      this.scripts.buildDragTargetScript(options),
      true
    )
    if (!resolved.matched) return {
        ...resolved,
        steps,
        capturedAt: Date.now(),
      }

    const sourcePoint = this.readBrowserPointerPoint(resolved.source.point)
    const targetPoint = this.readBrowserPointerPoint(resolved.target.point)
    if (!sourcePoint || !targetPoint) return {
        ...resolved,
        matched: false,
        startX: sourcePoint ? sourcePoint.x : null,
        startY: sourcePoint ? sourcePoint.y : null,
        endX: targetPoint ? targetPoint.x : null,
        endY: targetPoint ? targetPoint.y : null,
        steps,
        failureReason: 'not-interactable',
        capturedAt: Date.now(),
      }

    const source = await this.clampViewportPoint(session, sourcePoint.x, sourcePoint.y)
    const target = await this.clampViewportPoint(session, targetPoint.x, targetPoint.y)

    await driver.dragCoordinates({
      startX: source.x,
      startY: source.y,
      endX: target.x,
      endY: target.y,
      steps,
    })

    if (options.waitForNavigation) {
      await this.pageWaiter.waitForTargetActionToSettle(session.webContents, abortSignal)
    }

    const finalUrl = driver.getURL() || resolved.url || context.url
    session.url = finalUrl
    this.syncSessionSiteContext(sessionId, finalUrl)

    return {
      ...resolved,
      url: finalUrl,
      startX: source.x,
      startY: source.y,
      endX: target.x,
      endY: target.y,
      steps,
      failureReason: null,
      capturedAt: Date.now(),
    }
  }

  public override async moveMouse(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserMoveMouseOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserMoveMouseResult> {
    abortSignal?.throwIfAborted()
    const externalSession = this.getExternalPageSession(sessionId)
    if (externalSession) return super.moveMouse(sessionId, context, options, abortSignal)

    const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)
    const point = await this.clampViewportPoint(session, options.x, options.y)
    const { x, y } = point
    const pointerPath = this.buildPointerPath(session, x, y)

    await this.animateVirtualPointer(session, pointerPath, false)
    this.focusWebContents(session)
    await this.getPageDriver(sessionId, session).moveMouse?.({ x, y })

    return {
      url: this.resolveCurrentPageUrl(session, context.url),
      x,
      y,
      capturedAt: Date.now(),
    }
  }

  public async highlightTarget(
    session: BrowserSession,
    target: BrowserElementTargetHint,
    label?: LooseOptional<string>
  ): Promise<void> {
    if (session.webContents.isDestroyed()) return

    try {
      await evaluateInWebContents(
        session.webContents,
        label && target.css
          ? this.scripts.buildTargetHighlightScript({ selector: target.css, label })
          : this.scripts.buildTargetHighlightFromTargetScript(target, toOptional(label)),
        true
      )
    } catch (error) {
      this.log.debug('目标元素高亮失败', { error: AppError.from(error).message })
    }
  }

  private async clampViewportPoint(
    session: BrowserSession,
    x: number,
    y: number
  ): Promise<BrowserPointerPoint> {
    const fallback = {
      width: DEFAULT_BROWSER_VIEWPORT.width,
      height: DEFAULT_BROWSER_VIEWPORT.height,
    }
    const viewport = await this.readViewportSize(session, fallback)
    const maxX = Math.max(0, viewport.width - 1)
    const maxY = Math.max(0, viewport.height - 1)

    return {
      x: clampInteger(x, 0, maxX, 0),
      y: clampInteger(y, 0, maxY, 0),
    }
  }

  private buildPointerPath(session: BrowserSession, x: number, y: number): BrowserPointerPoint[] {
    const webContentsId = session.webContents.id
    const previous = this.pointerPositions.get(webContentsId)
    this.pointerPositions.set(webContentsId, { x, y })

    if (!previous) return [{ x, y }]

    const distance = Math.hypot(x - previous.x, y - previous.y)
    const steps = clampInteger(Math.ceil(distance / 34), 6, 36, 12)
    const path: BrowserPointerPoint[] = []

    for (let index = 0; index <= steps; index += 1) {
      const progress = index / steps
      const eased = 1 - Math.pow(1 - progress, 3)
      path.push({
        x: Math.round(previous.x + (x - previous.x) * eased),
        y: Math.round(previous.y + (y - previous.y) * eased),
      })
    }

    return path
  }

  private async animateVirtualPointer(
    session: BrowserSession,
    path: BrowserPointerPoint[],
    pressed: boolean
  ): Promise<void> {
    if (session.webContents.isDestroyed() || path.length === 0) return

    try {
      await evaluateInWebContents(
        session.webContents,
        this.buildVirtualPointerScript(path, pressed),
        true
      )
    } catch (error) {
      this.log.debug('更新浏览器虚拟指针浮层失败', {
        error: AppError.from(error).message,
      })
      // 即使浮层渲染失败，鼠标输入也应继续执行。
    }
  }

  private async updateVirtualPointer(
    session: BrowserSession,
    x: number,
    y: number,
    pressed: boolean
  ): Promise<void> {
    if (session.webContents.isDestroyed()) return

    try {
      await evaluateInWebContents(
        session.webContents,
        this.buildVirtualPointerScript([{ x, y }], pressed),
        true
      )
    } catch (error) {
      this.log.debug('更新浏览器虚拟指针浮层失败', {
        error: AppError.from(error).message,
      })
      // 即使浮层渲染失败，鼠标输入也应继续执行。
    }
  }

  private buildVirtualPointerScript(path: BrowserPointerPoint[], pressed: boolean): string {
    const payload = JSON.stringify({
      path,
      pressed,
      durationMs: path.length > 1 ? Math.min(420, Math.max(150, path.length * 14)) : 0,
    })

    return `(() => {
  const payload = ${payload};
  const pointerId = '__velaros_virtual_pointer__';
  const pulseId = '__velaros_virtual_pointer_pulse__';
  const trailId = '__velaros_virtual_pointer_trail__';
  const hotspotX = 5;
  const hotspotY = 3;
  const svgNamespace = 'http://www.w3.org/2000/svg';
  const ensureTrail = () => {
    let trail = document.getElementById(trailId);
    if (!trail) {
      trail = document.createElementNS(svgNamespace, 'svg');
      trail.id = trailId;
      trail.setAttribute('aria-hidden', 'true');
      Object.assign(trail.style, {
        position: 'fixed',
        inset: '0',
        width: '100vw',
        height: '100vh',
        overflow: 'visible',
        zIndex: '2147483646',
        pointerEvents: 'none',
      });
      (document.body || document.documentElement).appendChild(trail);
    }
    return trail;
  };
  let pointer = document.getElementById(pointerId);
  if (!pointer) {
    pointer = document.createElement('div');
    pointer.id = pointerId;
    pointer.setAttribute('aria-hidden', 'true');
    pointer.innerHTML = '<svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 3L5.85 22.4L11.3 16.95L15.15 25.35L18.75 23.68L14.9 15.5L23.25 15.38L5 3Z" fill="white" stroke="rgba(0,0,0,0.42)" stroke-width="3.8" stroke-linejoin="round"/><path d="M5 3L5.85 22.4L11.3 16.95L15.15 25.35L18.75 23.68L14.9 15.5L23.25 15.38L5 3Z" fill="#111111" stroke="white" stroke-width="1.35" stroke-linejoin="round"/></svg><span id="' + pulseId + '"></span>';
    Object.assign(pointer.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '28px',
      height: '28px',
      zIndex: '2147483647',
      pointerEvents: 'none',
      opacity: '0.98',
      transformOrigin: hotspotX + 'px ' + hotspotY + 'px',
      transition: 'opacity 110ms ease',
      filter: 'drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3))'
    });
    const pulse = pointer.querySelector('#' + pulseId);
    Object.assign(pulse.style, {
      position: 'absolute',
      left: (hotspotX - 11) + 'px',
      top: (hotspotY - 11) + 'px',
      width: '22px',
      height: '22px',
      borderRadius: '999px',
      border: '1.5px solid rgba(255, 255, 255, 0.86)',
      background: 'rgba(10, 132, 255, 0.28)',
      boxShadow: '0 0 0 1px rgba(10, 132, 255, 0.35)',
      opacity: '0',
      transform: 'scale(0.85)',
      transition: 'opacity 100ms ease, transform 120ms ease'
    });
    (document.body || document.documentElement).appendChild(pointer);
  }
  const points = Array.isArray(payload.path) ? payload.path : [];
  const lastPoint = points[points.length - 1];
  if (!lastPoint) return false;
  if (points.length > 1) {
    const trail = ensureTrail();
    const line = document.createElementNS(svgNamespace, 'polyline');
    line.setAttribute('points', points.map((point) => point.x + ',' + point.y).join(' '));
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', 'rgba(10, 132, 255, 0.72)');
    line.setAttribute('stroke-width', '2.4');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-linejoin', 'round');
    Object.assign(line.style, {
      filter: 'drop-shadow(0 1px 2px rgba(15, 23, 42, 0.18))',
      transition: 'opacity 420ms ease 760ms, stroke-dashoffset ' + payload.durationMs + 'ms cubic-bezier(0.16, 1, 0.3, 1)',
    });
    trail.appendChild(line);
    const length = typeof line.getTotalLength === 'function' ? line.getTotalLength() : 0;
    if (length > 0) {
      line.style.strokeDasharray = String(length);
      line.style.strokeDashoffset = String(length);
      requestAnimationFrame(() => {
        line.style.strokeDashoffset = '0';
      });
    }
    window.setTimeout(() => {
      line.style.opacity = '0';
      window.setTimeout(() => line.remove(), 520);
    }, Math.max(240, payload.durationMs));
  }
  const pulse = pointer.querySelector('#' + pulseId);
  const setPointer = (point, isPressed) => {
    pointer.style.transform =
      'translate(' + (point.x - hotspotX) + 'px, ' + (point.y - hotspotY) + 'px) scale(' + (isPressed ? '0.92' : '1') + ')';
    pointer.dataset.x = String(point.x);
    pointer.dataset.y = String(point.y);
    pointer.dataset.pressed = isPressed ? 'true' : 'false';
    if (pulse) {
      pulse.style.opacity = isPressed ? '1' : '0';
      pulse.style.transform = isPressed ? 'scale(1.55)' : 'scale(0.85)';
    }
  };
  if (points.length === 1 || payload.durationMs <= 0) {
    setPointer(lastPoint, payload.pressed);
    return true;
  }

  const ease = (value) => 1 - Math.pow(1 - value, 3);
  const duration = payload.durationMs;
  const startedAt = performance.now();
  return new Promise((resolve) => {
    const frame = () => {
      const rawProgress = Math.min(1, (performance.now() - startedAt) / duration);
      const segmentPosition = rawProgress * (points.length - 1);
      const segmentIndex = Math.min(points.length - 2, Math.floor(segmentPosition));
      const localProgress = ease(segmentPosition - segmentIndex);
      const current = points[segmentIndex];
      const next = points[segmentIndex + 1];
      setPointer({
        x: Math.round(current.x + (next.x - current.x) * localProgress),
        y: Math.round(current.y + (next.y - current.y) * localProgress),
      }, false);
      if (rawProgress < 1) {
        requestAnimationFrame(frame);
        return;
      }
      setPointer(lastPoint, payload.pressed);
      resolve(true);
    };
    frame();
  });
})()`
  }

  public focusWebContents(session: BrowserSession): void {
    try {
      if (!session.webContents.isDestroyed()) {
        const ownerWindow = session.webContents.hostWebContents
          ? electron.BrowserWindow.fromWebContents(session.webContents.hostWebContents)
          : null
        if (ownerWindow && !ownerWindow.isDestroyed()) {
          ownerWindow.focus()
        }
        session.webContents.focus()
      }
    } catch (error) {
      this.log.debug('聚焦浏览器 WebContents 失败', {
        error: AppError.from(error).message,
      })
      // Embedded webview focus is best-effort.
    }
  }

  public override async setPageZoom(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserPageZoomOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserPageZoomResult> {
    abortSignal?.throwIfAborted()
    const pageSession = await this.getLivePageDriverSessionUnlocked(sessionId, abortSignal)
    if (!pageSession.driver.setPageZoomFactor) {
      throw new AppError('VALIDATION', '当前浏览器 driver 不支持页面缩放。')
    }

    const previousZoomFactor = clampZoomFactor(pageSession.driver.getPageZoomFactor?.(), 1)
    const zoomFactor = this.resolvePageZoomFactor(options, previousZoomFactor)
    await pageSession.driver.setPageZoomFactor(zoomFactor)
    if (pageSession.browserSession) {
      await this.showPageZoomHud(pageSession.browserSession, zoomFactor)
    }
    const state = await this.refreshPageDriverSessionState(sessionId, pageSession, context.url)

    return {
      url: state.url || context.url,
      zoomFactor,
      previousZoomFactor,
      capturedAt: Date.now(),
    }
  }

  private async readViewportSize(
    session: BrowserSession,
    fallback: { width: number; height: number }
  ): Promise<{ width: number; height: number }> {
    if (session.webContents.isDestroyed()) return fallback

    try {
      const size = (await evaluateInWebContents(
        session.webContents,
        `(() => ({
  width: Math.max(1, Math.round(window.innerWidth || document.documentElement.clientWidth || ${fallback.width})),
  height: Math.max(1, Math.round(window.innerHeight || document.documentElement.clientHeight || ${fallback.height})),
}))()`,
        true
      )) as { width?: number; height?: number }

      return {
        width: clampInteger(size.width, 1, 3840, fallback.width),
        height: clampInteger(size.height, 1, 2160, fallback.height),
      }
    } catch (error) {
      this.log.debug('读取浏览器 viewport 尺寸失败，使用默认边界锁定鼠标', {
        error: AppError.from(error).message,
      })
      return fallback
    }
  }

  private async showPageZoomHud(session: BrowserSession, zoomFactor: number): Promise<void> {
    if (session.webContents.isDestroyed()) return

    try {
      await evaluateInWebContents(session.webContents, this.buildPageZoomHudScript(zoomFactor), true)
    } catch (error) {
      this.log.debug('显示浏览器缩放提示失败', {
        error: AppError.from(error).message,
      })
    }
  }

  private buildPageZoomHudScript(zoomFactor: number): string {
    const percent = Math.round(zoomFactor * 100)

    return `(() => {
  const id = '__velaros_page_zoom_hud__';
  const existing = document.getElementById(id);
  if (existing) existing.remove();
  const hud = document.createElement('div');
  hud.id = id;
  hud.setAttribute('aria-hidden', 'true');
  hud.textContent = '${percent}%';
  Object.assign(hud.style, {
    position: 'fixed',
    top: '14px',
    right: '14px',
    zIndex: '2147483647',
    minWidth: '56px',
    height: '34px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 12px',
    borderRadius: '8px',
    background: '#ffffff',
    color: '#111111',
    font: '600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    boxShadow: '0 10px 28px rgba(15, 15, 15, 0.16), inset 0 0 0 1px rgba(15, 15, 15, 0.08)',
    pointerEvents: 'none',
    opacity: '1',
    transition: 'opacity 180ms ease, transform 180ms ease',
  });
  (document.body || document.documentElement).appendChild(hud);
  window.setTimeout(() => {
    hud.style.opacity = '0';
    hud.style.transform = 'translateY(-4px)';
    window.setTimeout(() => hud.remove(), 220);
  }, 2200);
  return true;
})()`
  }

  public override async scrollPage(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserPageScrollOptions = {},
    abortSignal?: AbortSignal
  ): Promise<BrowserPageScrollResult> {
    abortSignal?.throwIfAborted()
    const externalSession = this.getExternalPageSession(sessionId)
    if (externalSession) return super.scrollPage(sessionId, context, options, abortSignal)

    const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)

    // 滚动脚本返回滚动位置和最大滚动范围。
    return evaluateInWebContents(
      session.webContents,
      this.scripts.buildScrollScript(options),
      true
    ) as Promise<BrowserPageScrollResult>
  }
}
