import electron from 'electron'

import { isEmpty, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { BrowserPageDriver } from '../../contract/requires.js'
import type {
  BrowserClickCoordinatesOptions,
  BrowserClickCoordinatesResult,
  BrowserDragOptions,
  BrowserDragResult,
  BrowserElementTargetHint,
  BrowserInsertTextOptions,
  BrowserInsertTextResult,
  BrowserKeyInput,
  BrowserKeyResult,
  BrowserMouseButtonInput,
  BrowserMouseResult,
  BrowserMoveMouseOptions,
  BrowserPagePreviewPointerEvent,
  BrowserPageZoomOptions,
  BrowserPageZoomResult,
  BrowserPressKeyOptions,
  BrowserPressKeyResult,
  BrowserSiteContext,
  BrowserTargetActionOptions,
  BrowserTargetActionResult,
  BrowserWheelInput,
} from '../../types/browser'
import type { BrowserSession } from '../../types/electron'
import type { BrowserRuntimeKernel, BrowserRuntimePageDriverSession } from '../../types/electron.js'
import type { BrowserPointerPoint } from '../../types/runtime.js'
import { buildTargetActionEffect, readBrowserPointerPoint, resolvePageZoomFactor, resolveTargetActionClickMode } from '../../utils/cdp/interaction.js'
import { evaluateInWebContents } from '../../utils/electron/evaluate'
import { buildPageZoomHudScript, buildVirtualPointerScript } from '../../utils/electron/interaction'
import { clampInteger, clampZoomFactor } from '../../utils/numbers.js'
import { buildDragTargetScript } from '../../utils/page-scripts/drag'
import { buildTargetActionScript } from '../../utils/page-scripts/target-action'
import { buildHighlightFromTargetScript, buildHighlightScript } from '../../utils/page-scripts/target-highlight'
import { DEFAULT_BROWSER_VIEWPORT } from '../../utils/viewport.js'
import { CdpInteractionEngine } from '../engines/CdpInteractionEngine'
import type { BrowserTargetRefStore } from '../session/BrowserTargetRefStore'

import type { BrowserPageWaiter } from './BrowserPageWaiter'

/**
 * 交互域执行体（Electron 宿主）：embedded 分支（WebContents 输入合成、虚拟指针浮层、
 * 缩放 HUD、目标高亮）+ 委托 external 核（`CdpInteractionEngine`）。
 *
 * 每个 public 方法先探 external 会话：命中 → `super`（driver 路径）；否则跑 embedded 分支。
 * DUAL 分支逻辑逐字节原样保留，只把 external 半迁进 core。方法默认在 runtime 的
 * actionQueue 内被调用。
 */
export interface BrowserInteractionEngineApi {
  /** 会话关闭时清理该 WebContents 的指针轨迹状态。 */
  clearPointerState(webContentsId: number): void
  /** 运行时销毁时清空全部指针状态。 */
  dispose(): void
  /** 按目标元素描述做一步（点击、悬停、聚焦、全选），比坐标点击稳。 */
  performTargetAction(sessionId: string, context: BrowserSiteContext, options: BrowserTargetActionOptions, abortSignal?: AbortSignal): Promise<BrowserTargetActionResult>
  /** 在当前焦点处插入文字（像输入法上屏，不发按键事件）。 */
  insertText(sessionId: string, context: BrowserSiteContext, options: BrowserInsertTextOptions, abortSignal?: AbortSignal): Promise<BrowserInsertTextResult>
  /** 按一个键（按下再抬起），可连按、可带修饰键；按住的修饰键照样带上。 */
  pressKey(sessionId: string, context: BrowserSiteContext, options: BrowserPressKeyOptions, abortSignal?: AbortSignal): Promise<BrowserPressKeyResult>
  /** 按下一个键并记在会话上，直到 keyUp。 */
  keyDown(sessionId: string, context: BrowserSiteContext, input: BrowserKeyInput, abortSignal?: AbortSignal): Promise<BrowserKeyResult>
  /** 抬起一个按着的键。 */
  keyUp(sessionId: string, context: BrowserSiteContext, input: BrowserKeyInput, abortSignal?: AbortSignal): Promise<BrowserKeyResult>
  /** 在指针现在的位置按下一个鼠标键。 */
  mouseDown(sessionId: string, context: BrowserSiteContext, input: BrowserMouseButtonInput, abortSignal?: AbortSignal): Promise<BrowserMouseResult>
  /** 在指针现在的位置松开一个鼠标键。 */
  mouseUp(sessionId: string, context: BrowserSiteContext, input: BrowserMouseButtonInput, abortSignal?: AbortSignal): Promise<BrowserMouseResult>
  /** 在指针现在的位置滚一下滚轮。 */
  mouseWheel(sessionId: string, context: BrowserSiteContext, input: BrowserWheelInput, abortSignal?: AbortSignal): Promise<BrowserMouseResult>
  /** 会话关闭时丢掉它的输入状态（按着的键、鼠标键与指针位置）。 */
  clearInputState(sessionId: string): void
  /** 在视口坐标上点一下，作为目标点击失败后的兜底。 */
  clickCoordinates(sessionId: string, context: BrowserSiteContext, options: BrowserClickCoordinatesOptions, abortSignal?: AbortSignal): Promise<BrowserClickCoordinatesResult>
  /** 把一个目标拖到另一个目标上。 */
  dragTargets(sessionId: string, context: BrowserSiteContext, options: BrowserDragOptions, abortSignal?: AbortSignal): Promise<BrowserDragResult>
  /** 把鼠标移到某个位置，可拆成几步；按着鼠标键时就是拖。 */
  moveMouse(sessionId: string, context: BrowserSiteContext, options: BrowserMoveMouseOptions, abortSignal?: AbortSignal): Promise<BrowserMouseResult>
  /** 在页面上给目标元素画一个短暂的高亮框，方便用户看清 agent 在操作哪里。 */
  highlightTarget(session: BrowserSession, target: BrowserElementTargetHint, label?: LooseOptional<string>): Promise<void>
  /** 把输入焦点交给受控页面。 */
  focusWebContents(session: BrowserSession): void
  /** 改页面缩放比例。 */
  setPageZoom(sessionId: string, context: BrowserSiteContext, options: BrowserPageZoomOptions, abortSignal?: AbortSignal): Promise<BrowserPageZoomResult>
}

export class BrowserInteractionEngine extends CdpInteractionEngine implements BrowserInteractionEngineApi {
  /** 记录每个 WebContents 的最新页面内指针位置，用于平滑移动虚拟指针。 */
  private readonly pointerPositions = new Map<number, BrowserPointerPoint>()

  constructor(
    private readonly electronKernel: BrowserRuntimeKernel,
    private readonly pageWaiter: BrowserPageWaiter,
    targetRefs: BrowserTargetRefStore,
    onPreviewPointer?: LooseOptional<(
      sessionId: string,
      pointer: BrowserPagePreviewPointerEvent
    ) => void>
  ) {
    super(electronKernel, targetRefs, onPreviewPointer)
  }

  /** 会话关闭时清理该 WebContents 的指针轨迹状态。 */
  public clearPointerState(webContentsId: number): void {
    this.pointerPositions.delete(webContentsId)
  }

  /** 运行时销毁时清空全部指针状态与输入状态。 */
  public override dispose(): void {
    super.dispose()
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
    const clickMode = resolveTargetActionClickMode(driver, hydratedOptions)
    const beforeEffectSnapshot = await this.captureTargetActionEffectSnapshot(driver)
    const initialActionResult = await driver.executeJavaScript<BrowserTargetActionResult>(
      buildTargetActionScript(hydratedOptions, { clickMode }),
      true
    )
    const healedActionResult = await this.selfHealTargetActionAfterNotFound({
      sessionId,
      driver,
      options: hydratedOptions,
      result: initialActionResult,
      clickMode,
    })
    const targetPointerPoint =
      (hydratedOptions.action === 'click' || hydratedOptions.action === 'hover') &&
      healedActionResult.matched &&
      healedActionResult.clickMethod === 'coordinate'
        ? readBrowserPointerPoint(healedActionResult.clickPoint)
        : null
    const targetPointer = targetPointerPoint
      ? await this.clampViewportPoint(session, targetPointerPoint.x, targetPointerPoint.y)
      : null
    if (targetPointer) {
      await this.animateVirtualPointer(
        session,
        this.buildPointerPath(session, targetPointer.x, targetPointer.y),
        false
      )
      this.focusWebContents(session)
      if (hydratedOptions.action === 'click') {
        await this.updateVirtualPointer(session, targetPointer.x, targetPointer.y, true)
      }
    }
    let actionResult: BrowserTargetActionResult
    try {
      actionResult = await this.dispatchCoordinateTargetActionIfNeeded({
        sessionId,
        driver,
        options: hydratedOptions,
        result: healedActionResult,
      })
    } finally {
      if (targetPointer && hydratedOptions.action === 'click') {
        await this.delay(90)
        await this.updateVirtualPointer(session, targetPointer.x, targetPointer.y, false)
      }
    }

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
    const effect = buildTargetActionEffect(beforeEffectSnapshot, afterEffectSnapshot)
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

  public override async insertText(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserInsertTextOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserInsertTextResult> {
    abortSignal?.throwIfAborted()
    const externalSession = this.getExternalPageSession(sessionId)
    if (externalSession) return super.insertText(sessionId, context, options, abortSignal)

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

    const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)
    this.focusWebContents(session)
    const repeat = await this.pressWithDriver(this.getPageDriver(sessionId, session), sessionId, options)

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
      modifiers: this.heldModifiers(sessionId),
    })
    this.rememberPointer(sessionId, point)

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
    const hydratedOptions = this.targetRefs.hydrateDrag(sessionId, options)
    const driver = this.getPageDriver(sessionId, session)

    if (!driver.dragCoordinates) {
      throw new AppError('VALIDATION', '当前浏览器 driver 不支持拖拽。')
    }

    const resolved = await driver.executeJavaScript<BrowserDragResult>(
      buildDragTargetScript(hydratedOptions),
      true
    )
    if (!resolved.matched) return {
        ...resolved,
        steps,
        capturedAt: Date.now(),
      }

    const sourcePoint = readBrowserPointerPoint(resolved.source.point)
    const targetPoint = readBrowserPointerPoint(resolved.target.point)
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

    await this.animateVirtualPointer(
      session,
      this.buildPointerPath(session, source.x, source.y),
      false
    )
    this.focusWebContents(session)
    await this.updateVirtualPointer(session, source.x, source.y, true)
    const dragPointerPath = this.buildPointerPath(session, target.x, target.y)
    try {
      await Promise.all([
        driver.dragCoordinates({
          startX: source.x,
          startY: source.y,
          endX: target.x,
          endY: target.y,
          steps,
          modifiers: this.heldModifiers(sessionId),
        }),
        this.animateVirtualPointer(session, dragPointerPath, true),
      ])
    } finally {
      await this.updateVirtualPointer(session, target.x, target.y, false)
    }
    this.rememberPointer(sessionId, target)

    if (hydratedOptions.waitForNavigation) {
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
  ): Promise<BrowserMouseResult> {
    abortSignal?.throwIfAborted()
    const externalSession = this.getExternalPageSession(sessionId)
    if (externalSession) return super.moveMouse(sessionId, context, options, abortSignal)

    const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)
    const point = await this.clampViewportPoint(session, options.x, options.y)
    const pressed = this.inputState(sessionId).buttons.size > 0

    await this.animateVirtualPointer(session, this.buildPointerPath(session, point.x, point.y), pressed)
    this.focusWebContents(session)
    await this.mouseMoveWithDriver(this.getPageDriver(sessionId, session), sessionId, point, clampInteger(options.steps, 1, 60, 1))
    return this.mouseSnapshot(sessionId, this.resolveCurrentPageUrl(session, context.url))
  }

  public override async keyDown(
    sessionId: string,
    context: BrowserSiteContext,
    input: BrowserKeyInput,
    abortSignal?: AbortSignal
  ): Promise<BrowserKeyResult> {
    abortSignal?.throwIfAborted()
    if (this.getExternalPageSession(sessionId)) return super.keyDown(sessionId, context, input, abortSignal)

    const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)
    this.focusWebContents(session)
    const held = await this.keyDownWithDriver(this.getPageDriver(sessionId, session), sessionId, input.key)
    return { url: this.resolveCurrentPageUrl(session, context.url), key: input.key, held }
  }

  public override async keyUp(
    sessionId: string,
    context: BrowserSiteContext,
    input: BrowserKeyInput,
    abortSignal?: AbortSignal
  ): Promise<BrowserKeyResult> {
    abortSignal?.throwIfAborted()
    if (this.getExternalPageSession(sessionId)) return super.keyUp(sessionId, context, input, abortSignal)

    const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)
    const held = await this.keyUpWithDriver(this.getPageDriver(sessionId, session), sessionId, input.key)
    return { url: this.resolveCurrentPageUrl(session, context.url), key: input.key, held }
  }

  public override async mouseDown(
    sessionId: string,
    context: BrowserSiteContext,
    input: BrowserMouseButtonInput,
    abortSignal?: AbortSignal
  ): Promise<BrowserMouseResult> {
    abortSignal?.throwIfAborted()
    if (this.getExternalPageSession(sessionId)) return super.mouseDown(sessionId, context, input, abortSignal)

    const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)
    const state = this.inputState(sessionId)
    this.focusWebContents(session)
    await this.mouseButtonWithDriver(this.getPageDriver(sessionId, session), sessionId, 'mousePressed', input)
    await this.updateVirtualPointer(session, state.x, state.y, true)
    return this.mouseSnapshot(sessionId, this.resolveCurrentPageUrl(session, context.url))
  }

  public override async mouseUp(
    sessionId: string,
    context: BrowserSiteContext,
    input: BrowserMouseButtonInput,
    abortSignal?: AbortSignal
  ): Promise<BrowserMouseResult> {
    abortSignal?.throwIfAborted()
    if (this.getExternalPageSession(sessionId)) return super.mouseUp(sessionId, context, input, abortSignal)

    const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)
    const state = this.inputState(sessionId)
    await this.mouseButtonWithDriver(this.getPageDriver(sessionId, session), sessionId, 'mouseReleased', input)
    await this.updateVirtualPointer(session, state.x, state.y, state.buttons.size > 0)
    return this.mouseSnapshot(sessionId, this.resolveCurrentPageUrl(session, context.url))
  }

  public override async mouseWheel(
    sessionId: string,
    context: BrowserSiteContext,
    input: BrowserWheelInput,
    abortSignal?: AbortSignal
  ): Promise<BrowserMouseResult> {
    abortSignal?.throwIfAborted()
    if (this.getExternalPageSession(sessionId)) return super.mouseWheel(sessionId, context, input, abortSignal)

    const session = await this.getLivePageSessionUnlocked(sessionId, abortSignal)
    this.focusWebContents(session)
    await this.mouseWheelWithDriver(this.getPageDriver(sessionId, session), sessionId, input)
    return this.mouseSnapshot(sessionId, this.resolveCurrentPageUrl(session, context.url))
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
          ? buildHighlightScript({ selector: target.css, label })
          : buildHighlightFromTargetScript(target, toOptional(label)),
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
    if (session.webContents.isDestroyed() || isEmpty(path)) return

    const durationMs = path.length > 1 ? Math.min(420, Math.max(150, path.length * 14)) : 0
    const lastPoint = path.at(-1)
    if (!lastPoint) return

    try {
      this.focusWebContents(session)
      await evaluateInWebContents(
        session.webContents,
        buildVirtualPointerScript(path, pressed, durationMs),
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
    return this.animateVirtualPointer(session, [{ x, y }], pressed)
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
      // 内嵌 webview 的聚焦只是尽力而为。
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
    const zoomFactor = resolvePageZoomFactor(options, previousZoomFactor)
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
      await evaluateInWebContents(session.webContents, buildPageZoomHudScript(zoomFactor), true)
    } catch (error) {
      this.log.debug('显示浏览器缩放提示失败', {
        error: AppError.from(error).message,
      })
    }
  }
}
