import { isFiniteNumber, toNullable, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { Log } from '@velaros-ai/core/logger'

import type { BrowserPageDriver, BrowserSystemPointerDriver } from '../../contract/requires.js'
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
  BrowserMouseButton,
  BrowserMouseButtonInput,
  BrowserMouseResult,
  BrowserMoveMouseOptions,
  BrowserPageInspection,
  BrowserPagePreviewPointerEvent,
  BrowserPageZoomOptions,
  BrowserPageZoomResult,
  BrowserPressKeyOptions,
  BrowserPressKeyResult,
  BrowserSiteContext,
  BrowserTargetActionOptions,
  BrowserTargetActionResult,
  BrowserViewportOptions,
  BrowserViewportResult,
  BrowserWheelInput,
} from '../../types/browser.js'
import type { BrowserPageDriverPointerListener, BrowserPageDriverState } from '../../types/driver'
import type {
  BrowserInputState,
  BrowserPageDriverKernel,
  BrowserPageDriverSession,
  BrowserPointerPoint,
  BrowserTargetActionClickMode,
  BrowserTargetActionInternalEffectSnapshot,
  BrowserViewportScreenMetrics,
  ExternalBrowserPageSession,
} from '../../types/runtime.js'
import {
  clampExternalViewportPoint,
  normalizeTargetActionEffectSnapshot,
  normalizeTargetIdentityValue,
  readBrowserPointerPoint,
  resolveTargetActionClickMode,
} from '../../utils/cdp/interaction'
import { resolvePageZoomFactor } from '../../utils/cdp/interaction'
import { buildTargetActionEffect, scoreSelfHealingTarget } from '../../utils/cdp/interaction'
import {
  buildKeyDownEvent,
  buildKeyUpEvent,
  modifierKeyName,
  modifiersMask,
  normalizeBrowserPressKeyOptions,
  resolveKeyDefinition,
} from '../../utils/keyboard'
import { clampInteger, clampZoomFactor } from '../../utils/numbers.js'
import { buildActionEffectSnapshotScript } from '../../utils/page-scripts/action-effect'
import { buildDragTargetScript } from '../../utils/page-scripts/drag'
import { buildInspectionScript } from '../../utils/page-scripts/inspection'
import { buildTargetActionScript } from '../../utils/page-scripts/target-action'
import { mouseButtonsMask } from '../../utils/pointer.js'
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
  /** 按目标元素描述做一步（点击、悬停、聚焦、全选），比坐标点击稳。 */
  performTargetAction(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserTargetActionOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserTargetActionResult>
  /** 在当前焦点处插入文字（像输入法上屏，不发按键事件）。 */
  insertText(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserInsertTextOptions,
    _abortSignal?: AbortSignal
  ): Promise<BrowserInsertTextResult>
  /** 按一个键（按下再抬起），可连按、可带修饰键；按住的修饰键照样带上。 */
  pressKey(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserPressKeyOptions,
    _abortSignal?: AbortSignal
  ): Promise<BrowserPressKeyResult>
  /** 按下一个键并记在会话上，直到 keyUp。 */
  keyDown(
    sessionId: string,
    context: BrowserSiteContext,
    input: BrowserKeyInput,
    abortSignal?: AbortSignal
  ): Promise<BrowserKeyResult>
  /** 抬起一个按着的键。 */
  keyUp(
    sessionId: string,
    context: BrowserSiteContext,
    input: BrowserKeyInput,
    abortSignal?: AbortSignal
  ): Promise<BrowserKeyResult>
  /** 在指针现在的位置按下一个鼠标键。 */
  mouseDown(
    sessionId: string,
    context: BrowserSiteContext,
    input: BrowserMouseButtonInput,
    abortSignal?: AbortSignal
  ): Promise<BrowserMouseResult>
  /** 在指针现在的位置松开一个鼠标键。 */
  mouseUp(
    sessionId: string,
    context: BrowserSiteContext,
    input: BrowserMouseButtonInput,
    abortSignal?: AbortSignal
  ): Promise<BrowserMouseResult>
  /** 在指针现在的位置滚一下滚轮。 */
  mouseWheel(
    sessionId: string,
    context: BrowserSiteContext,
    input: BrowserWheelInput,
    abortSignal?: AbortSignal
  ): Promise<BrowserMouseResult>
  /** 会话关闭时丢掉它的输入状态（按着的键、鼠标键与指针位置）。 */
  clearInputState(sessionId: string): void
  /** 运行时销毁或全部会话关闭时清空全部输入状态。 */
  dispose(): void
  /** 在视口坐标上点一下，作为目标点击失败后的兜底。 */
  clickCoordinates(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserClickCoordinatesOptions,
    _abortSignal?: AbortSignal
  ): Promise<BrowserClickCoordinatesResult>
  /** 把一个目标拖到另一个目标上。 */
  dragTargets(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserDragOptions,
    _abortSignal?: AbortSignal
  ): Promise<BrowserDragResult>
  /** 把鼠标移到某个位置，可拆成几步；按着鼠标键时就是拖。 */
  moveMouse(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserMoveMouseOptions,
    _abortSignal?: AbortSignal
  ): Promise<BrowserMouseResult>
  /** 改受控页面的视口尺寸与设备像素比。 */
  setViewport(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserViewportOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserViewportResult>
  /** 改页面缩放比例。 */
  setPageZoom(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserPageZoomOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserPageZoomResult>
}

export class CdpInteractionEngine implements CdpInteractionEngineApi {
  protected readonly log = Log.tag('BrowserInteractionEngine')
  private systemPointerDriver: Nullable<BrowserSystemPointerDriver> = null
  /** 每个会话的输入状态：按着的键、鼠标键与指针位置；会话关闭时由运行时清掉。 */
  private readonly inputStates = new Map<string, BrowserInputState>()

  constructor(
    protected readonly kernel: BrowserPageDriverKernel,
    protected readonly targetRefs: BrowserTargetRefStore,
    protected readonly onPreviewPointer?: LooseOptional<
      (sessionId: string, pointer: BrowserPagePreviewPointerEvent) => void
    >
  ) {}

  /** 宿主可在装配完成或运行期设置变化后替换系统指针驱动。 */
  public setSystemPointerDriver(driver: LooseOptional<BrowserSystemPointerDriver>): void {
    this.systemPointerDriver = toNullable(driver)
  }

  /** 会话关闭时丢掉它的输入状态（按着的键、鼠标键与指针位置）。 */
  public clearInputState(sessionId: string): void {
    this.inputStates.delete(sessionId)
  }

  /** 运行时销毁或全部会话关闭时清空全部输入状态。 */
  public dispose(): void {
    this.inputStates.clear()
  }

  // ---- 输入原子：按着的键与鼠标键记在会话上，带到之后的每个输入事件里 ----

  /** 这个会话的输入状态；第一次用到时是「什么都没按、指针在左上角」。 */
  protected inputState(sessionId: string): BrowserInputState {
    const existing = this.inputStates.get(sessionId)
    if (existing) return existing
    const created: BrowserInputState = { held: new Set(), buttons: new Set(), x: 0, y: 0 }
    this.inputStates.set(sessionId, created)
    return created
  }

  /** 记下指针现在的位置：点击、悬停、拖拽之后，mouseDown 这类原子就落在这里。 */
  protected rememberPointer(sessionId: string, point: BrowserPointerPoint): void {
    const state = this.inputState(sessionId)
    state.x = point.x
    state.y = point.y
  }

  /** 按着的修饰键折成 CDP 位掩码，点击、拖拽时带上。 */
  protected heldModifiers(sessionId: string): number {
    return modifiersMask(this.inputState(sessionId).held)
  }

  /** 鼠标现在的样子：位置与按着的鼠标键。 */
  protected mouseSnapshot(sessionId: string, url: string): BrowserMouseResult {
    const state = this.inputState(sessionId)
    return { url, x: state.x, y: state.y, buttons: [...state.buttons] }
  }

  /** 按下一个键：照键位表拼 CDP 事件发出去，记进按着的键里；交回现在还按着的键。 */
  protected async keyDownWithDriver(
    driver: BrowserPageDriver,
    sessionId: string,
    key: string
  ): Promise<string[]> {
    const definition = resolveKeyDefinition(key)
    if (!definition) throw new AppError('VALIDATION', `不认识这个键：${key}`)
    if (!driver.dispatchKeyEvent)
      throw new AppError('VALIDATION', '当前浏览器 driver 不支持键盘事件。')
    const state = this.inputState(sessionId)
    await driver.dispatchKeyEvent(
      buildKeyDownEvent(definition, state.held, process.platform === 'darwin')
    )
    state.held.add(definition.key)
    return [...state.held]
  }

  /** 抬起一个键：从按着的键里拿掉，再发 CDP 事件；交回现在还按着的键。 */
  protected async keyUpWithDriver(
    driver: BrowserPageDriver,
    sessionId: string,
    key: string
  ): Promise<string[]> {
    const definition = resolveKeyDefinition(key)
    if (!definition) throw new AppError('VALIDATION', `不认识这个键：${key}`)
    if (!driver.dispatchKeyEvent)
      throw new AppError('VALIDATION', '当前浏览器 driver 不支持键盘事件。')
    const state = this.inputState(sessionId)
    state.held.delete(definition.key)
    await driver.dispatchKeyEvent(buildKeyUpEvent(definition, state.held))
    return [...state.held]
  }

  /** 按一个键：入参里的修饰键这一次按下、按完抬起（已经按着的不动），主键按下再抬起 repeat 次；交回实际按了几次。 */
  protected async pressWithDriver(
    driver: BrowserPageDriver,
    sessionId: string,
    options: BrowserPressKeyOptions
  ): Promise<number> {
    const normalized = normalizeBrowserPressKeyOptions(options)
    const repeat = clampInteger(normalized.repeat, 1, 50, 1)
    const state = this.inputState(sessionId)
    const modifiers = (normalized.modifiers ?? [])
      .map(modifierKeyName)
      .filter((name) => !state.held.has(name))
    for (const modifier of modifiers) await this.keyDownWithDriver(driver, sessionId, modifier)
    try {
      for (let index = 0; index < repeat; index += 1) {
        await this.keyDownWithDriver(driver, sessionId, normalized.key)
        await this.keyUpWithDriver(driver, sessionId, normalized.key)
      }
    } finally {
      for (const modifier of modifiers.reverse())
        await this.keyUpWithDriver(driver, sessionId, modifier)
    }
    return repeat
  }

  /** 把指针从现在的位置分 steps 步移到 (x, y)，按着的鼠标键与修饰键都带上（按着键时就是拖）。 */
  protected async mouseMoveWithDriver(
    driver: BrowserPageDriver,
    sessionId: string,
    point: BrowserPointerPoint,
    steps: number
  ): Promise<void> {
    if (!driver.dispatchMouseEvent)
      throw new AppError('VALIDATION', '当前浏览器 driver 不支持鼠标事件。')
    const state = this.inputState(sessionId)
    const from = { x: state.x, y: state.y }
    const button = [...state.buttons].at(0) ?? 'none'
    for (let index = 1; index <= steps; index += 1) {
      const progress = index / steps
      await driver.dispatchMouseEvent({
        type: 'mouseMoved',
        x: Math.round(from.x + (point.x - from.x) * progress),
        y: Math.round(from.y + (point.y - from.y) * progress),
        button,
        buttons: mouseButtonsMask(state.buttons),
        modifiers: modifiersMask(state.held),
      })
    }
    this.rememberPointer(sessionId, point)
  }

  /** 在指针现在的位置按下或松开一个鼠标键，记进（或拿出）按着的鼠标键。 */
  protected async mouseButtonWithDriver(
    driver: BrowserPageDriver,
    sessionId: string,
    type: 'mousePressed' | 'mouseReleased',
    input: BrowserMouseButtonInput
  ): Promise<void> {
    if (!driver.dispatchMouseEvent)
      throw new AppError('VALIDATION', '当前浏览器 driver 不支持鼠标事件。')
    const state = this.inputState(sessionId)
    const button: BrowserMouseButton = input.button ?? 'left'
    if (type === 'mousePressed') state.buttons.add(button)
    else state.buttons.delete(button)
    await driver.dispatchMouseEvent({
      type,
      x: state.x,
      y: state.y,
      button,
      buttons: mouseButtonsMask(state.buttons),
      clickCount: clampInteger(input.clickCount, 1, 5, 1),
      modifiers: modifiersMask(state.held),
    })
  }

  /** 在指针现在的位置滚一下滚轮。 */
  protected async mouseWheelWithDriver(
    driver: BrowserPageDriver,
    sessionId: string,
    input: BrowserWheelInput
  ): Promise<void> {
    if (!driver.dispatchMouseEvent)
      throw new AppError('VALIDATION', '当前浏览器 driver 不支持鼠标事件。')
    const state = this.inputState(sessionId)
    await driver.dispatchMouseEvent({
      type: 'mouseWheel',
      x: state.x,
      y: state.y,
      button: 'none',
      buttons: mouseButtonsMask(state.buttons),
      modifiers: modifiersMask(state.held),
      deltaX: input.deltaX ?? 0,
      deltaY: input.deltaY ?? 0,
    })
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
      )
        return false

      const horizontalInset =
        driver.kind === 'external' ? Math.max(0, (metrics.outerWidth - metrics.innerWidth) / 2) : 0
      const verticalInset =
        driver.kind === 'external'
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
    const effect = buildTargetActionEffect(beforeEffectSnapshot, afterEffectSnapshot)
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
      buildTargetActionScript(
        {
          ...input.options,
          target: healedTarget,
        },
        {
          clickMode: input.clickMode,
        }
      ),
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
    const ambiguous = ranked
      .slice(1)
      .some(
        (candidate) =>
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
      const value = await driver.executeJavaScript<unknown>(buildActionEffectSnapshotScript())

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
    if (!clickPoint || !input.driver.clickCoordinates)
      return {
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
        button: input.options.button ?? 'left',
        clickCount: input.options.clickCount ?? 1,
        modifiers: this.heldModifiers(input.sessionId),
        waitForNavigation: false,
        onPointerEvent: input.externalSession
          ? this.createPreviewPointerListener(input.sessionId, input.externalSession, 'click')
          : undefined,
      })
      this.rememberPointer(input.sessionId, clickPoint)

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
    if (!hoverPoint || !input.driver.moveMouse)
      return {
        ...input.result,
        matched: false,
        failureReason: 'not-interactable',
      }

    if (input.externalSession) {
      await this.tryMoveSystemPointer(input.driver, hoverPoint, input.externalSession.visible, 220)
    }
    await input.driver.moveMouse({
      x: hoverPoint.x,
      y: hoverPoint.y,
      onPointerEvent: input.externalSession
        ? this.createPreviewPointerListener(input.sessionId, input.externalSession, 'hover')
        : undefined,
    })
    this.rememberPointer(input.sessionId, hoverPoint)

    return input.result
  }

  public async insertText(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserInsertTextOptions,
    _abortSignal?: AbortSignal
  ): Promise<BrowserInsertTextResult> {
    _abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    if (!externalSession.driver.insertText) {
      throw new AppError('VALIDATION', '当前外部浏览器 driver 不支持文本输入。')
    }
    await externalSession.driver.insertText(options)
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
    const externalSession = this.requireExternalPageSession(sessionId)
    const repeat = await this.pressWithDriver(externalSession.driver, sessionId, options)
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
    await this.tryMoveSystemPointer(externalSession.driver, point, externalSession.visible, 220)
    await externalSession.driver.clickCoordinates({
      ...options,
      x: point.x,
      y: point.y,
      button,
      clickCount,
      modifiers: this.heldModifiers(sessionId),
      onPointerEvent: this.createPreviewPointerListener(sessionId, externalSession, 'click'),
    })
    this.rememberPointer(sessionId, point)
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
    if (!resolved.matched)
      return {
        ...resolved,
        steps: input.steps,
        capturedAt: Date.now(),
      }

    const sourcePoint = readBrowserPointerPoint(resolved.source.point)
    const targetPoint = readBrowserPointerPoint(resolved.target.point)
    if (!sourcePoint || !targetPoint)
      return {
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
        modifiers: this.heldModifiers(input.sessionId),
        onPointerEvent: this.createPreviewPointerListener(
          input.sessionId,
          input.externalSession,
          'drag'
        ),
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

    this.rememberPointer(input.sessionId, target)
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
  ): Promise<BrowserMouseResult> {
    _abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    const point = clampExternalViewportPoint(options.x, options.y)
    await this.tryMoveSystemPointer(externalSession.driver, point, externalSession.visible, 220)
    await this.mouseMoveWithDriver(
      externalSession.driver,
      sessionId,
      point,
      clampInteger(options.steps, 1, 60, 1)
    )
    this.createPreviewPointerListener(
      sessionId,
      externalSession,
      'move'
    )({ x: point.x, y: point.y, phase: 'move' })
    const state = await this.refreshExternalPageState(sessionId, externalSession, context.url)
    return this.mouseSnapshot(sessionId, state.url || context.url)
  }

  public async keyDown(
    sessionId: string,
    context: BrowserSiteContext,
    input: BrowserKeyInput,
    abortSignal?: AbortSignal
  ): Promise<BrowserKeyResult> {
    abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    const held = await this.keyDownWithDriver(externalSession.driver, sessionId, input.key)
    const state = await this.refreshExternalPageState(sessionId, externalSession, context.url)
    return { url: state.url || context.url, key: input.key, held }
  }

  public async keyUp(
    sessionId: string,
    context: BrowserSiteContext,
    input: BrowserKeyInput,
    abortSignal?: AbortSignal
  ): Promise<BrowserKeyResult> {
    abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    const held = await this.keyUpWithDriver(externalSession.driver, sessionId, input.key)
    const state = await this.refreshExternalPageState(sessionId, externalSession, context.url)
    return { url: state.url || context.url, key: input.key, held }
  }

  public async mouseDown(
    sessionId: string,
    context: BrowserSiteContext,
    input: BrowserMouseButtonInput,
    abortSignal?: AbortSignal
  ): Promise<BrowserMouseResult> {
    abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    await this.mouseButtonWithDriver(externalSession.driver, sessionId, 'mousePressed', input)
    return this.mouseSnapshot(sessionId, externalSession.driver.getURL() || context.url)
  }

  public async mouseUp(
    sessionId: string,
    context: BrowserSiteContext,
    input: BrowserMouseButtonInput,
    abortSignal?: AbortSignal
  ): Promise<BrowserMouseResult> {
    abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    await this.mouseButtonWithDriver(externalSession.driver, sessionId, 'mouseReleased', input)
    const state = await this.refreshExternalPageState(sessionId, externalSession, context.url)
    return this.mouseSnapshot(sessionId, state.url || context.url)
  }

  public async mouseWheel(
    sessionId: string,
    context: BrowserSiteContext,
    input: BrowserWheelInput,
    abortSignal?: AbortSignal
  ): Promise<BrowserMouseResult> {
    abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    await this.mouseWheelWithDriver(externalSession.driver, sessionId, input)
    return this.mouseSnapshot(sessionId, externalSession.driver.getURL() || context.url)
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
}
