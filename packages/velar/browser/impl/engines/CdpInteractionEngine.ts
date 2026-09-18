import { isFiniteNumber, toNullable, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { Log } from '@velaros-ai/core/logger'

import type { BrowserPageDriver, BrowserSystemPointerDriver } from '../../contract/requires.js'
import type { BrowserClickCoordinatesOptions, BrowserClickCoordinatesResult, BrowserDragOptions, BrowserDragResult, BrowserElementTargetHint, BrowserMoveMouseOptions, BrowserMoveMouseResult, BrowserPageInspection, BrowserPagePreviewPointerEvent, BrowserPageScrollOptions, BrowserPageScrollResult, BrowserPageZoomOptions, BrowserPageZoomResult, BrowserPressKeyOptions, BrowserPressKeyResult, BrowserSiteContext, BrowserTargetActionOptions, BrowserTargetActionResult, BrowserTypeTextOptions, BrowserTypeTextResult, BrowserViewportOptions, BrowserViewportResult } from '../../types/browser.js'
import type { BrowserPageDriverPointerListener, BrowserPageDriverState } from '../../types/driver'
import type { BrowserPageDriverKernel, BrowserPageDriverSession, BrowserPointerPoint, BrowserTargetActionClickMode, BrowserTargetActionInternalEffectSnapshot, BrowserViewportScreenMetrics,ExternalBrowserPageSession } from '../../types/runtime.js'
import { clampExternalViewportPoint, normalizeTargetActionEffectSnapshot, normalizeTargetIdentityValue, readBrowserPointerPoint, resolveTargetActionClickMode } from '../../utils/cdp/interaction'
import { resolvePageZoomFactor } from '../../utils/cdp/interaction'
import { buildTargetActionEffect, scoreSelfHealingTarget } from '../../utils/cdp/interaction'
import { normalizeBrowserPressKeyOptions } from '../../utils/keyboard'
import { clampInteger, clampZoomFactor } from '../../utils/numbers.js'
import { buildActionEffectSnapshotScript } from '../../utils/page-scripts/action-effect'
import { buildDragTargetScript } from '../../utils/page-scripts/drag'
import { buildInspectionScript } from '../../utils/page-scripts/inspection'
import { buildScrollScript } from '../../utils/page-scripts/scroll'
import { buildTargetActionScript } from '../../utils/page-scripts/target-action'
import { BrowserTuning } from '../../utils/tuning'
import { DEFAULT_BROWSER_VIEWPORT } from '../../utils/viewport.js'
import type { BrowserTargetRefStore } from '../session/BrowserTargetRefStore'

/**
 * 交互域执行体的 host 无关外部核（走 CDP driver）。
 *
 * 承载 target action 与自愈、动作效果指纹、坐标点击/拖拽/hover 的 driver 流程、
 * viewport 与页面缩放，以及全部纯计算助手。Electron 宿主的
 * `BrowserInteractionEngine` 继承本类：external 分支交给 `super`，embedded 分支
 * （webContents 输入合成、虚拟指针浮层、HUD、高亮）由子类补齐。
 *
 * 方法默认在 runtime 的 actionQueue 内被调用。
 */
export interface CdpInteractionEngineApi {
  /** 宿主可在装配完成或运行期设置变化后替换系统指针驱动。 */
  setSystemPointerDriver(driver: LooseOptional<BrowserSystemPointerDriver>): void
  /** 按目标元素描述执行动作（点击、填值、选项），比坐标点击稳。 */
  performTargetAction(sessionId: string, context: BrowserSiteContext, options: BrowserTargetActionOptions, abortSignal?: AbortSignal): Promise<BrowserTargetActionResult>
  /** 往当前焦点或指定目标输入文本。 */
  typeText(sessionId: string, context: BrowserSiteContext, options: BrowserTypeTextOptions, _abortSignal?: AbortSignal): Promise<BrowserTypeTextResult>
  /** 发一次键盘按键。 */
  pressKey(sessionId: string, context: BrowserSiteContext, options: BrowserPressKeyOptions, _abortSignal?: AbortSignal): Promise<BrowserPressKeyResult>
  /** 在视口坐标上点一下，作为目标点击失败后的兜底。 */
  clickCoordinates(sessionId: string, context: BrowserSiteContext, options: BrowserClickCoordinatesOptions, _abortSignal?: AbortSignal): Promise<BrowserClickCoordinatesResult>
  /** 把一个目标拖到另一个目标上。 */
  dragTargets(sessionId: string, context: BrowserSiteContext, options: BrowserDragOptions, _abortSignal?: AbortSignal): Promise<BrowserDragResult>
  /** 把鼠标移到某个位置（用于 hover）。 */
  moveMouse(sessionId: string, context: BrowserSiteContext, options: BrowserMoveMouseOptions, _abortSignal?: AbortSignal): Promise<BrowserMoveMouseResult>
  /** 改受控页面的视口尺寸与设备像素比。 */
  setViewport(sessionId: string, context: BrowserSiteContext, options: BrowserViewportOptions, abortSignal?: AbortSignal): Promise<BrowserViewportResult>
  /** 改页面缩放比例。 */
  setPageZoom(sessionId: string, context: BrowserSiteContext, options: BrowserPageZoomOptions, abortSignal?: AbortSignal): Promise<BrowserPageZoomResult>
  /** 滚动页面。 */
  scrollPage(sessionId: string, context: BrowserSiteContext, options?: BrowserPageScrollOptions, _abortSignal?: AbortSignal): Promise<BrowserPageScrollResult>
}

export class CdpInteractionEngine implements CdpInteractionEngineApi {

  protected readonly log = Log.tag('BrowserInteractionEngine')
  private systemPointerDriver: Nullable<BrowserSystemPointerDriver> = null

  constructor(
    protected readonly kernel: BrowserPageDriverKernel,
    protected readonly targetRefs: BrowserTargetRefStore,
    protected readonly onPreviewPointer?: LooseOptional<(
      sessionId: string,
      pointer: BrowserPagePreviewPointerEvent
    ) => void>
  ) {}

  /** 宿主可在装配完成或运行期设置变化后替换系统指针驱动。 */
  public setSystemPointerDriver(driver: LooseOptional<BrowserSystemPointerDriver>): void {
    this.systemPointerDriver = toNullable(driver)
  }

  // ---- kernel 桥接 ----
  // 这些 protected 一行方法是 runtime 拆分期的搬运脚手架（“方法体零改写”地平移进 engine）。
  // 现在拆分已定形，它们的**退场条件**是：把 engine 内的调用点直接改成 `this.kernel.X(...)`，
  // 然后整段删除。在那之前别逐个删——半删会让同一个 engine 里两种取会话写法并存（§0.1 条 2）。
  protected getExternalPageSession(sessionId: string): Nullable<ExternalBrowserPageSession> {
    return this.kernel.getExternalPageSession(sessionId)
  }

  protected refreshPageDriverSessionState(
    sessionId: string,
    pageSession: BrowserPageDriverSession,
    fallbackUrl: string
  ): Promise<BrowserPageDriverState> {
    return this.kernel.refreshPageDriverSessionState(sessionId, pageSession, fallbackUrl)
  }

  protected refreshExternalPageState(
    sessionId: string,
    session: ExternalBrowserPageSession,
    fallbackUrl: string
  ): Promise<BrowserPageDriverState> {
    return this.kernel.refreshExternalPageState(sessionId, session, fallbackUrl)
  }

  protected updateExternalPageStateFromInspection(
    sessionId: string,
    session: ExternalBrowserPageSession,
    inspection: BrowserPageInspection
  ): void {
    this.kernel.updateExternalPageStateFromInspection(sessionId, session, inspection)
  }

  protected syncExternalPageStateFromScriptResult(
    sessionId: string,
    session: ExternalBrowserPageSession,
    result: unknown,
    fallbackUrl: string
  ): void {
    this.kernel.syncExternalPageStateFromScriptResult(sessionId, session, result, fallbackUrl)
  }

  protected delay(ms: number): Promise<void> {
    return this.kernel.delay(ms)
  }

  /**
   * 把页面 CSS 坐标换算为桌面逻辑坐标并尝试移动原生系统指针。
   *
   * 外部浏览器需要扣除窗口边框和浏览器工具栏；Electron webview 的 screenX/screenY 已由
   * Chromium 映射到 guest viewport 原点。任何探测或权限失败都返回 false，由调用方继续走
   * 合成输入和统一兜底箭头，不能让可视化能力影响真实页面动作。
   */
  protected async tryMoveSystemPointer(
    driver: BrowserPageDriver,
    point: BrowserPointerPoint,
    visible: boolean,
    durationMs: number
  ): Promise<boolean> {
    const systemPointerDriver = this.systemPointerDriver
    if (!visible || !systemPointerDriver) return false

    try {
      await driver.bringToFront()
      const metrics = await driver.executeJavaScript<BrowserViewportScreenMetrics>(`(() => ({
  focused: document.hasFocus(),
  screenX: Number(window.screenX || window.screenLeft || 0),
  screenY: Number(window.screenY || window.screenTop || 0),
  outerWidth: Number(window.outerWidth || window.innerWidth || 0),
  outerHeight: Number(window.outerHeight || window.innerHeight || 0),
  innerWidth: Number(window.innerWidth || document.documentElement.clientWidth || 0),
  innerHeight: Number(window.innerHeight || document.documentElement.clientHeight || 0),
}))()`)
      if (!metrics.focused) return false
      if (
        !isFiniteNumber(metrics.screenX) ||
        !isFiniteNumber(metrics.screenY) ||
        !isFiniteNumber(metrics.outerWidth) ||
        !isFiniteNumber(metrics.outerHeight) ||
        !isFiniteNumber(metrics.innerWidth) ||
        !isFiniteNumber(metrics.innerHeight)
      ) return false

      const horizontalInset = driver.kind === 'external'
        ? Math.max(0, (metrics.outerWidth - metrics.innerWidth) / 2)
        : 0
      const verticalInset = driver.kind === 'external'
        ? Math.max(0, metrics.outerHeight - metrics.innerHeight - horizontalInset)
        : 0

      // 必须 await：不 await 就是把 promise 原样返回，异步拒绝会绕过下面的 catch，
      // 「系统指针不可用 → 改用浏览器兜底指针」这条降级根本不会执行。
      return await systemPointerDriver.move({
        x: Math.round(metrics.screenX + horizontalInset + point.x),
        y: Math.round(metrics.screenY + verticalInset + point.y),
        durationMs: clampInteger(durationMs, 0, 800, 0),
      })
    } catch (error) {
      this.log.debug('系统指针不可用，改用浏览器兜底指针', {
        driverKind: driver.kind,
        error: AppError.from(error).message,
      })
      return false
    }
  }

  private requireExternalPageSession(sessionId: string): ExternalBrowserPageSession {
    const externalSession = this.getExternalPageSession(sessionId)
    if (!externalSession) {
      throw new AppError('NOT_FOUND', `外部浏览器会话不存在：${sessionId}`)
    }
    return externalSession
  }

  public async performTargetAction(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserTargetActionOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserTargetActionResult> {
    abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    const hydratedOptions = this.targetRefs.hydrate(sessionId, options)
    const clickMode = resolveTargetActionClickMode(externalSession.driver, hydratedOptions)
    const beforeEffectSnapshot = await this.captureTargetActionEffectSnapshot(
      externalSession.driver
    )
    const initialActionResult =
      await externalSession.driver.executeJavaScript<BrowserTargetActionResult>(
        buildTargetActionScript(hydratedOptions, { clickMode }),
        true
      )
    const healedActionResult = await this.selfHealTargetActionAfterNotFound({
      sessionId,
      driver: externalSession.driver,
      options: hydratedOptions,
      result: initialActionResult,
      clickMode,
      externalSession,
    })
    const actionResult = await this.dispatchCoordinateTargetActionIfNeeded({
      sessionId,
      externalSession,
      driver: externalSession.driver,
      options: hydratedOptions,
      result: healedActionResult,
    })
    const state = await this.refreshExternalPageState(
      sessionId,
      externalSession,
      actionResult.url || context.url
    )
    const afterEffectSnapshot = actionResult.matched
      ? await this.captureTargetActionEffectSnapshot(externalSession.driver)
      : null
    const effect = buildTargetActionEffect(
      beforeEffectSnapshot,
      afterEffectSnapshot
    )
    if (actionResult.matched && options.action === 'click') {
      this.targetRefs.clear(sessionId)
    }

    return {
      ...actionResult,
      url: state.url || actionResult.url || context.url,
      effect: toOptional(effect),
      capturedAt: Date.now(),
    }
  }

  protected async inspectPageForTargetActionSelfHeal(input: {
    sessionId: string
    driver: BrowserPageDriver
    externalSession?: LooseOptional<ExternalBrowserPageSession>
  }): Promise<BrowserPageInspection> {
    const inspection = await input.driver.executeJavaScript<BrowserPageInspection>(
      buildInspectionScript({
        includeHtml: false,
        maxTextChars: BrowserTuning.page.selfHealTextChars,
        maxHtmlChars: BrowserTuning.page.selfHealHtmlChars,
        maxElements: BrowserTuning.page.selfHealElements,
      }),
      true
    )
    // 这是 action 失败后的内部探测，不会作为 observation 返回给模型。不得把它发布到
    // ref store，否则模型仍持有的上一次 inspect refs 会被一个不可见 generation 换代。
    if (input.externalSession) {
      this.updateExternalPageStateFromInspection(input.sessionId, input.externalSession, inspection)
    }

    return inspection
  }

  protected async selfHealTargetActionAfterNotFound(input: {
    sessionId: string
    driver: BrowserPageDriver
    options: BrowserTargetActionOptions
    result: BrowserTargetActionResult
    clickMode: BrowserTargetActionClickMode
    externalSession?: LooseOptional<ExternalBrowserPageSession>
  }): Promise<BrowserTargetActionResult> {
    if (input.result.matched || input.result.failureReason !== 'not-found') return input.result

    const inspection = await this.inspectPageForTargetActionSelfHeal({
      sessionId: input.sessionId,
      driver: input.driver,
      externalSession: input.externalSession,
    })
    const healedTarget = this.findSelfHealingTarget(input.options, inspection)
    if (!healedTarget) return input.result

    return input.driver.executeJavaScript<BrowserTargetActionResult>(
      buildTargetActionScript({
        ...input.options,
        target: healedTarget,
      }, {
        clickMode: input.clickMode,
      }),
      true
    )
  }

  private findSelfHealingTarget(
    options: BrowserTargetActionOptions,
    inspection: BrowserPageInspection
  ): Nullable<BrowserElementTargetHint> {
    const candidates: Array<{
      target: BrowserElementTargetHint
      index: number
    }> = []
    let index = 0
    const addTarget = (target: Nullable<BrowserElementTargetHint>): void => {
      if (!target) return
      candidates.push({ target, index })
      index += 1
    }

    inspection.formFields.forEach((entry) => addTarget(entry.target))
    inspection.actions.forEach((entry) => addTarget(entry.target))
    inspection.links.forEach((entry) => addTarget(entry.target))

    const ranked = candidates
      .map((candidate) => {
        const score = scoreSelfHealingTarget(options.target, candidate.target)
        return score ? { ...candidate, ...score } : null
      })
      .filter((candidate): candidate is NonNullable<typeof candidate> => !!candidate)
      .sort((left, right) => right.totalScore - left.totalScore || left.index - right.index)

    const best = ranked[0]
    if (!best || this.isSameBrowserTargetSelector(options.target, best.target)) return null

    // 相同强度的身份信号命中多个不同元素时，页面类别或出现顺序都不能替 agent
    // 猜目标。重复出现在 links/actions 的同一 selector 不算歧义。
    const ambiguous = ranked.slice(1).some((candidate) =>
      candidate.totalScore === best.totalScore &&
      !this.isSameBrowserTargetSelector(best.target, candidate.target)
    )
    if (ambiguous) return null

    return best.target
  }

  

  

  

  

  private isSameBrowserTargetSelector(
    staleTarget: BrowserElementTargetHint,
    freshTarget: BrowserElementTargetHint
  ): boolean {
    const staleCss = normalizeTargetIdentityValue(staleTarget.css)
    const freshCss = normalizeTargetIdentityValue(freshTarget.css)
    if (staleCss && freshCss && staleCss !== freshCss) return false

    const staleRef = this.targetRefs.normalizeRef(staleTarget.ref)
    const freshRef = this.targetRefs.normalizeRef(freshTarget.ref)
    if (staleRef && freshRef && staleRef !== freshRef) return false

    return !!staleCss && staleCss === freshCss
  }

  protected async captureTargetActionEffectSnapshot(
    driver: BrowserPageDriver
  ): Promise<Nullable<BrowserTargetActionInternalEffectSnapshot>> {
    try {
      const value = await driver.executeJavaScript<unknown>(
        buildActionEffectSnapshotScript()
      )

      return normalizeTargetActionEffectSnapshot(value)
    } catch (error) {
      this.log.debug('读取浏览器动作效果指纹失败', {
        error: AppError.from(error).message,
      })
      return null
    }
  }

  

  

  

  

  

  

  protected async dispatchCoordinateTargetActionIfNeeded(input: {
    sessionId: string
    externalSession?: LooseOptional<ExternalBrowserPageSession>
    driver: BrowserPageDriver
    options: BrowserTargetActionOptions
    result: BrowserTargetActionResult
  }): Promise<BrowserTargetActionResult> {
    if (input.options.action === 'hover') return this.dispatchCoordinateTargetHoverIfNeeded(input)
    if (input.options.action !== 'click') return input.result
    if (!input.result.matched || input.result.clickMethod !== 'coordinate') return input.result

    const clickPoint = readBrowserPointerPoint(input.result.clickPoint)
    if (!clickPoint || !input.driver.clickCoordinates) return {
        ...input.result,
        matched: false,
        failureReason: 'not-interactable',
      }

    try {
      if (input.externalSession) {
        await this.tryMoveSystemPointer(
          input.driver,
          clickPoint,
          input.externalSession.visible,
          220
        )
      }
      await input.driver.clickCoordinates({
        x: clickPoint.x,
        y: clickPoint.y,
        button: 'left',
        clickCount: 1,
        waitForNavigation: false,
        onPointerEvent: input.externalSession
          ? this.createPreviewPointerListener(input.sessionId, input.externalSession, 'click')
          : undefined,
      })

      return input.result
    } catch (error) {
      this.log.debug('坐标目标点击失败，回退 DOM click', {
        error: AppError.from(error).message,
      })

      return input.driver.executeJavaScript<BrowserTargetActionResult>(
        buildTargetActionScript(input.options, { clickMode: 'dom' }),
        true
      )
    }
  }

  private async dispatchCoordinateTargetHoverIfNeeded(input: {
    sessionId: string
    externalSession?: LooseOptional<ExternalBrowserPageSession>
    driver: BrowserPageDriver
    result: BrowserTargetActionResult
  }): Promise<BrowserTargetActionResult> {
    if (!input.result.matched || input.result.clickMethod !== 'coordinate') return input.result

    const hoverPoint = readBrowserPointerPoint(input.result.clickPoint)
    if (!hoverPoint || !input.driver.moveMouse) return {
        ...input.result,
        matched: false,
        failureReason: 'not-interactable',
      }

    if (input.externalSession) {
      await this.tryMoveSystemPointer(
        input.driver,
        hoverPoint,
        input.externalSession.visible,
        220
      )
    }
    await input.driver.moveMouse({
      x: hoverPoint.x,
      y: hoverPoint.y,
      onPointerEvent: input.externalSession
        ? this.createPreviewPointerListener(input.sessionId, input.externalSession, 'hover')
        : undefined,
    })

    return input.result
  }

  

  

  public async typeText(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserTypeTextOptions,
    _abortSignal?: AbortSignal
  ): Promise<BrowserTypeTextResult> {
    _abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    if (!externalSession.driver.typeText) {
      throw new AppError('VALIDATION', '当前外部浏览器 driver 不支持文本输入。')
    }
    await externalSession.driver.typeText(options)
    const state = await this.refreshExternalPageState(sessionId, externalSession, context.url)
    return {
      url: state.url || context.url,
      textLength: options.text.length,
      capturedAt: Date.now(),
    }
  }

  public async pressKey(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserPressKeyOptions,
    _abortSignal?: AbortSignal
  ): Promise<BrowserPressKeyResult> {
    _abortSignal?.throwIfAborted()
    const normalized = normalizeBrowserPressKeyOptions(options)
    const externalSession = this.requireExternalPageSession(sessionId)
    if (!externalSession.driver.pressKey) {
      throw new AppError('VALIDATION', '当前外部浏览器 driver 不支持键盘输入。')
    }
    const repeat = clampInteger(normalized.repeat, 1, 50, 1)
    await externalSession.driver.pressKey({
      ...normalized,
      repeat,
    })
    const state = await this.refreshExternalPageState(sessionId, externalSession, context.url)
    return {
      url: state.url || context.url,
      key: options.key,
      repeat,
      capturedAt: Date.now(),
    }
  }

  public async clickCoordinates(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserClickCoordinatesOptions,
    _abortSignal?: AbortSignal
  ): Promise<BrowserClickCoordinatesResult> {
    _abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    if (!externalSession.driver.clickCoordinates) {
      throw new AppError('VALIDATION', '当前外部浏览器 driver 不支持坐标点击。')
    }
    const point = clampExternalViewportPoint(options.x, options.y)
    const button = options.button ?? 'left'
    const clickCount = clampInteger(options.clickCount, 1, 5, 1)
    await this.tryMoveSystemPointer(
      externalSession.driver,
      point,
      externalSession.visible,
      220
    )
    await externalSession.driver.clickCoordinates({
      ...options,
      x: point.x,
      y: point.y,
      button,
      clickCount,
      onPointerEvent: this.createPreviewPointerListener(
        sessionId,
        externalSession,
        'click'
      ),
    })
    const state = await this.refreshExternalPageState(sessionId, externalSession, context.url)
    return {
      url: state.url || context.url,
      x: point.x,
      y: point.y,
      button,
      clickCount,
      capturedAt: Date.now(),
    }
  }

  public async dragTargets(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserDragOptions,
    _abortSignal?: AbortSignal
  ): Promise<BrowserDragResult> {
    _abortSignal?.throwIfAborted()
    const hydratedOptions = this.targetRefs.hydrateDrag(sessionId, options)
    const steps = clampInteger(hydratedOptions.steps, 1, 60, 10)
    const externalSession = this.requireExternalPageSession(sessionId)
    return this.dragTargetsWithExternalDriver({
      sessionId,
      context,
      driver: externalSession.driver,
      options: hydratedOptions,
      steps,
      externalSession,
    })
  }

  private async dragTargetsWithExternalDriver(input: {
    sessionId: string
    context: BrowserSiteContext
    driver: BrowserPageDriver
    options: BrowserDragOptions
    steps: number
    externalSession: ExternalBrowserPageSession
  }): Promise<BrowserDragResult> {
    if (!input.driver.dragCoordinates) {
      throw new AppError('VALIDATION', '当前浏览器 driver 不支持拖拽。')
    }

    const resolved = await input.driver.executeJavaScript<BrowserDragResult>(
      buildDragTargetScript(input.options),
      true
    )
    if (!resolved.matched) return {
        ...resolved,
        steps: input.steps,
        capturedAt: Date.now(),
      }

    const sourcePoint = readBrowserPointerPoint(resolved.source.point)
    const targetPoint = readBrowserPointerPoint(resolved.target.point)
    if (!sourcePoint || !targetPoint) return {
        ...resolved,
        matched: false,
        startX: toNullable(sourcePoint?.x),
        startY: toNullable(sourcePoint?.y),
        endX: toNullable(targetPoint?.x),
        endY: toNullable(targetPoint?.y),
        steps: input.steps,
        failureReason: 'not-interactable',
        capturedAt: Date.now(),
      }

    const source = clampExternalViewportPoint(sourcePoint.x, sourcePoint.y)
    const target = clampExternalViewportPoint(targetPoint.x, targetPoint.y)

    const usesSystemPointer = await this.tryMoveSystemPointer(
      input.driver,
      source,
      input.externalSession.visible,
      180
    )
    await Promise.all([
      input.driver.dragCoordinates({
        startX: source.x,
        startY: source.y,
        endX: target.x,
        endY: target.y,
        steps: input.steps,
        onPointerEvent: this.createPreviewPointerListener(input.sessionId, input.externalSession, 'drag'),
      }),
      usesSystemPointer
        ? this.tryMoveSystemPointer(
            input.driver,
            target,
            input.externalSession.visible,
            Math.min(520, Math.max(180, input.steps * 24))
          )
        : Promise.resolve(false),
    ])

    const state = await this.refreshExternalPageState(
      input.sessionId,
      input.externalSession,
      resolved.url || input.context.url
    )
    const finalUrl = state?.url || input.driver.getURL() || resolved.url || input.context.url

    return {
      ...resolved,
      url: finalUrl,
      startX: source.x,
      startY: source.y,
      endX: target.x,
      endY: target.y,
      steps: input.steps,
      failureReason: null,
      capturedAt: Date.now(),
    }
  }

  public async moveMouse(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserMoveMouseOptions,
    _abortSignal?: AbortSignal
  ): Promise<BrowserMoveMouseResult> {
    _abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    if (!externalSession.driver.moveMouse) {
      throw new AppError('VALIDATION', '当前外部浏览器 driver 不支持鼠标移动。')
    }
    const point = clampExternalViewportPoint(options.x, options.y)
    await this.tryMoveSystemPointer(
      externalSession.driver,
      point,
      externalSession.visible,
      220
    )
    await externalSession.driver.moveMouse({
      ...point,
      onPointerEvent: this.createPreviewPointerListener(
        sessionId,
        externalSession,
        'move'
      ),
    })
    const state = await this.refreshExternalPageState(sessionId, externalSession, context.url)
    return {
      url: state.url || context.url,
      x: point.x,
      y: point.y,
      capturedAt: Date.now(),
    }
  }

  

  protected createPreviewPointerListener(
    sessionId: string,
    externalSession: ExternalBrowserPageSession,
    action: BrowserPagePreviewPointerEvent['action']
  ): BrowserPageDriverPointerListener {
    const viewport = externalSession.viewport ?? DEFAULT_BROWSER_VIEWPORT
    const width = Math.max(1, viewport.width)
    const height = Math.max(1, viewport.height)

    return (event): void => {
      const x = Math.max(0, Math.min(width - 1, Math.round(event.x)))
      const y = Math.max(0, Math.min(height - 1, Math.round(event.y)))
      this.onPreviewPointer?.(sessionId, {
        x,
        y,
        xRatio: Math.min(1, Math.max(0, x / width)),
        yRatio: Math.min(1, Math.max(0, y / height)),
        action,
        phase: event.phase,
        button: toNullable(event.button),
        capturedAt: Date.now(),
      })
    }
  }

  public async setViewport(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserViewportOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserViewportResult> {
    abortSignal?.throwIfAborted()
    const width = clampInteger(options.width, 320, 3840, DEFAULT_BROWSER_VIEWPORT.width)
    const height = clampInteger(options.height, 240, 2160, DEFAULT_BROWSER_VIEWPORT.height)
    const mobile = Boolean(options.mobile)
    const pageSession = await this.kernel.getLivePageDriverSession(sessionId, abortSignal)
    if (!pageSession.driver.setViewport) {
      throw new AppError('VALIDATION', '当前浏览器 driver 不支持 viewport 调整。')
    }

    await pageSession.driver.setViewport({ width, height, mobile })
    const state = await this.refreshPageDriverSessionState(sessionId, pageSession, context.url)

    return {
      url: state.url || context.url,
      width,
      height,
      mobile,
      capturedAt: Date.now(),
    }
  }

  public async setPageZoom(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserPageZoomOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserPageZoomResult> {
    abortSignal?.throwIfAborted()
    const pageSession = await this.kernel.getLivePageDriverSession(sessionId, abortSignal)
    if (!pageSession.driver.setPageZoomFactor) {
      throw new AppError('VALIDATION', '当前浏览器 driver 不支持页面缩放。')
    }

    const previousZoomFactor = clampZoomFactor(pageSession.driver.getPageZoomFactor?.(), 1)
    const zoomFactor = resolvePageZoomFactor(options, previousZoomFactor)
    await pageSession.driver.setPageZoomFactor(zoomFactor)
    // 缩放 HUD 是 webview 专属浮层，外部 CDP driver 无对应；Electron 子类覆盖时补 HUD。
    const state = await this.refreshPageDriverSessionState(sessionId, pageSession, context.url)

    return {
      url: state.url || context.url,
      zoomFactor,
      previousZoomFactor,
      capturedAt: Date.now(),
    }
  }

  

  

  public async scrollPage(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserPageScrollOptions = {},
    _abortSignal?: AbortSignal
  ): Promise<BrowserPageScrollResult> {
    _abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    const result = await externalSession.driver.executeJavaScript<BrowserPageScrollResult>(
      buildScrollScript(options),
      true
    )
    this.syncExternalPageStateFromScriptResult(sessionId, externalSession, result, context.url)
    return result
  }
}
